const assert = require("assert");
const Assistant = require("../models/Assistant");
const Definer = require("../lib/mistake");

let assistantController = module.exports;

const MAX_TURNS = 12;
const MAX_TEXT = 600;
const ID_FORMAT = /^[a-f0-9]{24}$/i;

assistantController.ask = async (req, res) => {
  try {
    console.log("POST: cont/assistant");
    const input = req.body?.messages;
    assert.ok(
      Array.isArray(input) && input.length && input.length <= MAX_TURNS,
      Definer.assistant_err1
    );

    const messages = input.map((message) => {
      const text = typeof message?.text === "string" ? message.text.trim() : "";
      assert.ok(
        ["user", "model"].includes(message?.role) && text && text.length <= MAX_TEXT,
        Definer.assistant_err1
      );
      const items = (Array.isArray(message.items) ? message.items : [])
        .slice(0, 6)
        .filter((item) => ID_FORMAT.test(item?.id))
        .map((item) => ({ id: item.id, quantity: Math.floor(item.quantity) || 1 }));
      const budget = message.budget > 0 ? Number(message.budget) : 0;
      return { role: message.role, text: text, items: items, budget: budget };
    });
    assert.ok(messages[messages.length - 1].role === "user", Definer.assistant_err1);
    while (messages[0].role === "model") messages.shift();

    // behind nginx every visitor would share the proxy address; the last entry is
    // the one nginx wrote, the ones before it come from the client
    const forwarded =
      process.env.ASSISTANT_TRUST_PROXY === "1"
        ? String(req.headers["x-forwarded-for"] ?? "").split(",").pop().trim()
        : "";
    const assistant = new Assistant();
    assistant.takeTurn(forwarded || req.ip || "unknown");
    const result = await assistant.answerData(messages);

    res.json({ state: "success", data: result });
  } catch (err) {
    console.log(`ERROR, cont/assistant, ${err.message}`);
    res.json({ state: "fail", message: err.message });
  }
};
