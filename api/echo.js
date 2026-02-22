const fs = require("fs");
const path = require("path");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const KV_REST_API_URL = process.env.KV_REST_API_URL;
const KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN;
const ECHO_UI_SECRET = process.env.ECHO_UI_SECRET;

const LOG_KEY = "echo:log";

async function redis(cmd) {
  const r = await fetch(KV_REST_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KV_REST_API_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(cmd)
  });
  return r.json();
}

async function getRecent(n = 50) {
  const r = await redis(["LRANGE", LOG_KEY, `-${n}`, "-1"]);
  return (r.result || []).map(x => JSON.parse(x));
}

async function pushLog(entry) {
  await redis(["RPUSH", LOG_KEY, JSON.stringify(entry)]);
}

module.exports = async (req, res) => {
  try {
    if (req.headers["x-echo-secret"] !== ECHO_UI_SECRET) {
      res.statusCode = 401;
      return res.end("unauthorized");
    }

    const url = new URL(req.url, "https://dummy.local");

    if (req.method === "GET" && url.searchParams.get("logs") === "1") {
      const limit = Number(url.searchParams.get("limit")) || 50;
      const logs = await getRecent(limit);
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ logs }));
    }

    if (req.method !== "POST") {
      res.statusCode = 405;
      return res.end("method not allowed");
    }

    let body = "";
    for await (const chunk of req) body += chunk;
    const { message } = JSON.parse(body || "{}");

    if (!message) {
      res.statusCode = 400;
      return res.end("missing message");
    }

    let promptText = "";
    try {
      promptText = fs.readFileSync(
        path.join(process.cwd(), "echo_pulse_prompt.txt"),
        "utf8"
      );
    } catch {
      promptText = "Echo default prompt.";
    }

    const history = await getRecent(15);

    const messages = [
      { role: "system", content: promptText },
      { role: "system", content: "Interaction log is persistent memory." }
    ];

    for (const h of history) {
      if (!["system", "user", "assistant"].includes(h.role)) continue;
      messages.push({ role: h.role, content: h.content });
    }

    messages.push({ role: "user", content: message });

    await pushLog({
      role: "user",
      content: message,
      ts: new Date().toISOString()
    });

    const ai = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages,
        temperature: 1,
        top_p: 0.95,
        max_tokens: 1000
      })
    });

    const out = await ai.json();
    const reply = out.choices?.[0]?.message?.content || "(no response)";

    await pushLog({
      role: "assistant",
      content: reply,
      ts: new Date().toISOString()
    });

    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ reply }));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: err.message }));
  }
};
