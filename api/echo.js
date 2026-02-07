const fs = require("fs");
const path = require("path");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const KV_REST_API_URL = process.env.KV_REST_API_URL;
const KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN;
const ECHO_UI_SECRET = process.env.ECHO_UI_SECRET;

const LOG_KEY = "echo:log";

function json(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
}

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
    // ---------- AUTH ----------
    if (req.headers["x-echo-secret"] !== ECHO_UI_SECRET) {
      return json(res, 401, { error: "unauthorized" });
    }

    const url = new URL(req.url, `https://${req.headers.host}`);

    // ---------- GET LOGS ----------
    if (req.method === "GET" && url.searchParams.get("logs") === "1") {
      const limit = Number(url.searchParams.get("limit")) || 50;
      const logs = await getRecent(limit);
      return json(res, 200, { logs });
    }

    // ---------- POST MESSAGE ----------
    if (req.method !== "POST") {
      return json(res, 405, { error: "method not allowed" });
    }

    let body = "";
    for await (const chunk of req) body += chunk;

    const { message } = JSON.parse(body || "{}");
    if (!message) return json(res, 400, { error: "missing message" });

    const promptText = fs.readFileSync(
      path.join(process.cwd(), "echo_pulse_prompt.txt"),
      "utf8"
    );

    const history = await getRecent(50);

    const messages = [
      { role: "system", content: promptText },
      {
        role: "system",
        content:
          "The interaction log is persistent memory. Treat it as factual history."
      }
    ];

    for (const h of history) {
      messages.push({
        role: h.role === "pulse" ? "assistant" : h.role,
        content: h.content
      });
    }

    messages.push({ role: "user", content: message });

    // log user
    await pushLog({
      role: "user",
      content: message,
      ts: new Date().toISOString()
    });

    const ai = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "gpt-4o",
          messages,
          temperature: 0.4
        })
      }
    );

    const out = await ai.json();
    const reply =
      out.choices?.[0]?.message?.content || "";

    // log assistant
    await pushLog({
      role: "assistant",
      content: reply,
      ts: new Date().toISOString()
    });

    return json(res, 200, { reply });

  } catch (err) {
    return json(res, 500, { error: err.message });
  }
};
