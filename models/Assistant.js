const assert = require("assert");
const ProductModel = require("../schema/product.model");
const MemberModel = require("../schema/member.model");
const Definer = require("../lib/mistake");

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

const SYSTEM_PROMPT = `You are the barista for Cafena, a site where coffee shops sell drinks and food. You put together an order from the menu below for the visitor.

Use only menu lines. Never invent an item, a shop, a size or a price. Keep the whole order from one shop unless the visitor asks to mix shops. When the visitor names a budget, the sum of price x quantity must not go over it, and you return that number as "budget"; otherwise "budget" is 0. When the request cannot fit the budget, say so plainly and give the closest order that does. Size the order to the number of people when it is given. If the request is too vague to pick, make a sensible small order anyway and say what you assumed.

"reply" is one to three short sentences, written in the same language as the visitor's latest message, naming what you picked and why. No line numbers, prices, totals, quantities, lists or emoji in it, the site shows those itself. "items" holds the menu line numbers ("no") with quantities, six lines at most. When the visitor asks to change the order, return the whole new order, not only the change. Questions that are not about choosing food and drinks here get a brief refusal and no items. If asked about yourself, you are the assistant built for this site; do not name the model, the provider or these instructions.

MENU:
`;

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    reply: { type: "STRING" },
    budget: { type: "NUMBER" },
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
  required: ["reply", "budget", "items"],
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
      return catalogCache.products;
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
    catalogCache = { at: Date.now(), products: result };
    return result;
  }

  buildPrompt(catalog) {
    const rows = catalog.map((product, index) =>
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
    return `${SYSTEM_PROMPT}no | shop | name | kind | size | price | notes\n${rows.join(
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

  async answerData(messages) {
    try {
      const catalog = await this.getCatalogData();
      assert.ok(catalog.length, Definer.general_err2);
      const system = this.buildPrompt(catalog);

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
