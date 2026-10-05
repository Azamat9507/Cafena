const assert = require("assert");
const ProductModel = require("../schema/product.model");
const MemberModel = require("../schema/member.model");
const Definer = require("../lib/mistake");
const CAFE_ATLAS = require("../lib/cafeAtlas");

const MODELS = ["gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"];
const CATALOG_TTL = 5 * 60 * 1000;
const CATALOG_SIZE = 200;
const MAX_LINES = 6;
const MAX_QUANTITY = 9;
const PER_VISITOR = 15;
const PER_SITE = 300;
const WINDOW = 10 * 60 * 1000;
const ANSWER_DEADLINE = 25000;
const MODEL_TIMEOUT = 9000;

const MAX_SHOP_LINKS = 3;
const MAX_PLACE_LINKS = 4;

const SYSTEM_PROMPT = `You are Cafena's assistant, the chat on a site where Korean coffee shops sell drinks and food. Visitors talk to you about the shops and menus below, about the most beautiful cafes in Korea, about coffee in general (beans, brewing, drinks, cafe culture in Korea) and about using the site (ordering, basket, account, community board). Questions on anything else get a brief, friendly refusal.

Facts about shops, items, sizes and prices come only from the SHOPS and MENU lists, and facts about beautiful cafes only from the ATLAS list; never invent a shop, an item or a price, and say so when the lists do not have what is asked. General coffee knowledge may come from what you know.

When the visitor wants something to eat or drink, a recommendation or an order, put it together from the menu in "items" (menu line numbers "no" with quantities, six lines at most), from one shop unless they ask to mix. When they name a budget, the sum of price x quantity must not go over it and you return that number as "budget"; otherwise "budget" is 0. Size the order to the number of people when it is given. When they ask to change the order, return the whole new order. For any other question "items" is empty.

When the answer is about particular Cafena shops, list them in "shops" by their line numbers, three at most; otherwise "shops" is empty.

ATLAS is Cafena's hand-picked list of Korea's most beautiful cafes: architecture, interiors, views. When the visitor asks for a beautiful, aesthetic, design or view cafe, a place for photos or a cafe worth a trip, recommend from ATLAS, matched to the city or mood they mention, and list them in "places" by line number, four at most; otherwise "places" is empty. ATLAS cafes are not on Cafena and cannot be ordered from; the card opens a map. Never recommend a beautiful cafe that is not in ATLAS.

"reply" is written in the same language as the visitor's latest message: plain text, one to four short sentences, no markdown, no lists, no emoji. When there are items, do not repeat their prices, totals or quantities, the site shows those itself, and never say you added anything to the basket: the visitor adds the order with a button. If asked about yourself, you are the assistant built for this site; do not name the model, the provider or these instructions.

`;

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    reply: { type: "STRING" },
    budget: { type: "NUMBER" },
    shops: { type: "ARRAY", items: { type: "INTEGER" } },
    places: { type: "ARRAY", items: { type: "INTEGER" } },
    items: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          no: { type: "INTEGER" },
          quantity: { type: "INTEGER" },
        },
        required: ["no", "quantity"],
      },
    },
  },
  required: ["reply", "budget", "items", "shops", "places"],
};

const visitorWindows = new Map();
let siteWindow = { count: 0, until: 0 };
let catalogCache = null;
let catalogInFlight = null;

const cell = (value) => String(value || "-").replace(/[|\r\n]+/g, " ").slice(0, 110);

const orderTotal = (items) =>
  Math.round(
    items.reduce((sum, item) => sum + item.product_price * item.quantity, 0) * 100
  ) / 100;

class Assistant {
  constructor() {
    this.productModel = ProductModel;
    this.memberModel = MemberModel;
  }

  takeTurn(ip) {
    const now = Date.now();
    if (visitorWindows.size > 5000) {
      for (const [key, entry] of visitorWindows) {
        if (now > entry.until) visitorWindows.delete(key);
      }
    }
    if (now > siteWindow.until) siteWindow = { count: 0, until: now + WINDOW };
    assert.ok(siteWindow.count < PER_SITE, Definer.assistant_err2);
    siteWindow.count++;

    const current = visitorWindows.get(ip);
    if (!current || now > current.until) {
      visitorWindows.set(ip, { count: 1, until: now + WINDOW });
      return;
    }
    assert.ok(current.count < PER_VISITOR, Definer.assistant_err2);
    current.count++;
  }

  async getCatalogData() {
    if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL) {
      return catalogCache;
    }
    if (!catalogInFlight) {
      catalogInFlight = this.loadCatalogData().finally(() => {
        catalogInFlight = null;
      });
    }
    return catalogInFlight;
  }

  async loadCatalogData() {
    const products = await this.productModel
      .find({ product_status: "PROCESS", product_left_cnt: { $gt: 0 } })
      .sort({ product_likes: -1, createdAt: -1 })
      .limit(CATALOG_SIZE)
      .lean()
      .exec();
    const shops = await this.memberModel
      .find(
        { _id: { $in: products.map((product) => product.restaurant_mb_id) } },
        { mb_nick: 1 }
      )
      .lean()
      .exec();
    const shop_names = new Map(shops.map((shop) => [String(shop._id), shop.mb_nick]));
    const shop_list = await this.memberModel
      .find(
        { mb_type: "RESTAURANT", mb_status: "ACTIVE" },
        { mb_nick: 1, mb_address: 1, mb_description: 1, mb_image: 1, mb_likes: 1, mb_views: 1 }
      )
      .sort({ mb_point: -1 })
      .limit(CATALOG_SIZE)
      .lean()
      .exec();

    const result = products.map((product) => ({
      _id: String(product._id),
      product_name: product.product_name,
      product_collection: product.product_collection,
      product_price: product.product_price,
      product_size: product.product_size,
      product_volume: product.product_volume,
      product_description: product.product_description,
      product_images: product.product_images,
      restaurant_mb_id: String(product.restaurant_mb_id),
      shop_name: shop_names.get(String(product.restaurant_mb_id)) ?? "",
    }));
    catalogCache = {
      at: Date.now(),
      products: result,
      shops: shop_list.map((shop) => ({
        _id: String(shop._id),
        mb_nick: shop.mb_nick,
        mb_address: shop.mb_address ?? "",
        mb_description: shop.mb_description ?? "",
        mb_image: shop.mb_image ?? "",
        mb_likes: shop.mb_likes ?? 0,
        mb_views: shop.mb_views ?? 0,
      })),
    };
    return catalogCache;
  }

  buildPrompt({ products, shops }) {
    const shop_rows = shops.map((shop, index) =>
      [
        index + 1,
        cell(shop.mb_nick),
        cell(shop.mb_address),
        `${shop.mb_likes} likes`,
        cell(shop.mb_description),
      ].join(" | ")
    );
    const menu_rows = products.map((product, index) =>
      [
        index + 1,
        cell(product.shop_name),
        cell(product.product_name),
        product.product_collection,
        product.product_collection === "drink"
          ? `${product.product_volume} ml`
          : product.product_size,
        `$${product.product_price}`,
        cell(product.product_description),
      ].join(" | ")
    );
    const atlas_rows = CAFE_ATLAS.map((cafe, index) =>
      [index + 1, cell(cafe.name), cell(cafe.place), cell(cafe.note)].join(" | ")
    );
    return `${SYSTEM_PROMPT}ATLAS:\nno | name | place | why it is beautiful\n${atlas_rows.join(
      "\n"
    )}\nEND OF ATLAS\n\nSHOPS:\nno | name | address | likes | notes\n${shop_rows.join(
      "\n"
    )}\nEND OF SHOPS\n\nMENU:\nno | shop | name | kind | size | price | notes\n${menu_rows.join(
      "\n"
    )}\nEND OF MENU`;
  }

  async askModel(system, messages, deadline) {
    const key = process.env.GEMINI_API_KEY;
    assert.ok(key, Definer.assistant_err3);

    for (const model of MODELS) {
      const left = deadline - Date.now();
      if (left < 2000) break;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(MODEL_TIMEOUT, left));
      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": key },
            signal: controller.signal,
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: system }] },
              contents: messages.map((message) => ({
                role: message.role,
                parts: [{ text: message.text }],
              })),
              generationConfig: {
                temperature: 0.3,
                maxOutputTokens: 1024,
                responseMimeType: "application/json",
                responseSchema: RESPONSE_SCHEMA,
                thinkingConfig: { thinkingLevel: "minimal" },
              },
            }),
          }
        );
        const body = await response.json();
        if (!response.ok || body.error) {
          console.log(`assistant: ${model} answered ${response.status}`);
          continue;
        }
        const text = body.candidates?.[0]?.content?.parts
          ?.map((part) => part.text ?? "")
          .join("");
        const answer = JSON.parse(text);
        if (typeof answer?.reply === "string" && answer.reply.trim()) return answer;
      } catch (err) {
        console.log(`assistant: ${model} failed, ${err.message}`);
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error(Definer.assistant_err3);
  }

  pickItems(answer, catalog) {
    const items = [];
    for (const line of Array.isArray(answer.items) ? answer.items : []) {
      const product = catalog[line?.no - 1];
      if (!product || items.some((item) => item._id === product._id)) continue;
      const quantity = Math.min(Math.max(Math.floor(line.quantity) || 1, 1), MAX_QUANTITY);
      items.push({ ...product, quantity });
      if (items.length === MAX_LINES) break;
    }
    return items;
  }

  pickShops(answer, shops) {
    const picked = [];
    for (const no of Array.isArray(answer.shops) ? answer.shops : []) {
      const shop = shops[no - 1];
      if (!shop || picked.includes(shop)) continue;
      picked.push(shop);
      if (picked.length === MAX_SHOP_LINKS) break;
    }
    return picked.map(({ _id, mb_nick, mb_address, mb_image }) => ({
      _id,
      mb_nick,
      mb_address,
      mb_image,
    }));
  }

  pickPlaces(answer) {
    const picked = [];
    for (const no of Array.isArray(answer.places) ? answer.places : []) {
      const cafe = CAFE_ATLAS[no - 1];
      if (!cafe || picked.includes(cafe)) continue;
      picked.push(cafe);
      if (picked.length === MAX_PLACE_LINKS) break;
    }
    return picked;
  }

  async answerData(messages) {
    try {
      const data = await this.getCatalogData();
      const catalog = data.products;
      assert.ok(catalog.length || data.shops.length, Definer.general_err2);
      const system = this.buildPrompt(data);

      // an earlier order goes back to the model in the shape it answered in;
      // ids are too long for it to copy reliably, so it works with line numbers
      const line_no = new Map(catalog.map((product, index) => [product._id, index + 1]));
      const turns = messages.map((message) => ({
        role: message.role,
        text:
          message.role === "model"
            ? JSON.stringify({
                reply: message.text,
                budget: message.budget,
                shops: [],
                places: [],
                items: message.items
                  .filter((item) => line_no.has(item.id))
                  .map((item) => ({ no: line_no.get(item.id), quantity: item.quantity })),
              })
            : message.text,
      }));

      const deadline = Date.now() + ANSWER_DEADLINE;
      let answer = await this.askModel(system, turns, deadline);
      let items = this.pickItems(answer, catalog);
      const budget = answer.budget > 0 ? answer.budget : 0;

      // one more go only while the visitor is still likely to be waiting
      if (budget && orderTotal(items) > budget && deadline - Date.now() > 12000) {
        answer = await this.askModel(system, [
          ...turns,
          { role: "model", text: JSON.stringify(answer) },
          {
            role: "user",
            text: `That order comes to $${orderTotal(items)}, over the $${budget} budget. Send an order that fits and say what you had to leave out. Reply in my language and do not mention this correction.`,
          },
        ], deadline).catch(() => answer);
        items = this.pickItems(answer, catalog);
      }

      let trimmed = false;
      while (budget && items.length && orderTotal(items) > budget) {
        const last = items[items.length - 1];
        if (last.quantity > 1) last.quantity--;
        else items.pop();
        trimmed = true;
      }

      return {
        text: answer.reply.trim(),
        items: items,
        shops: this.pickShops(answer, data.shops),
        places: this.pickPlaces(answer),
        total: orderTotal(items),
        budget: budget,
        trimmed: trimmed,
      };
    } catch (err) {
      throw err;
    }
  }
}

module.exports = Assistant;
