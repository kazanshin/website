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

    // ---------- AUTH ----------
    if (req.headers["x-echo-secret"] !== ECHO_UI_SECRET) {
      res.statusCode = 401;
      return res.end("unauthorized");
    }

    const url = new URL(req.url, `https://${req.headers.host}`);

    // ---------- GET LOGS ----------
    if (req.method === "GET" && url.searchParams.get("logs") === "1") {
      const limit = Number(url.searchParams.get("limit")) || 50;
      const logs = await getRecent(limit);
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ logs }));
    }

    // ---------- POST MESSAGE ----------
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

    const promptText = fs.readFileSync(
      path.join(process.cwd(), "echo_pulse_prompt.txt"),
      "utf8"
    );

    const history = await getRecent(50);

    const messages = [
      { role: "system", content: promptText },
      {
        role: "system",
        content: "The interaction log is persistent memory."
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

    // ---------- STREAM RESPONSE ----------
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
          temperature: 0.4,
          stream: true
        })
      }
    );

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Transfer-Encoding", "chunked");

    const reader = ai.body.getReader();
    const decoder = new TextDecoder();

    let fullReply = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split("\n");

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;

        const data = line.slice(6);

        if (data === "[DONE]") continue;

        try {
          const parsed = JSON.parse(data);
          const token =
            parsed.choices?.[0]?.delta?.content || "";

          if (token) {
            fullReply += token;
            res.write(token);
          }
        } catch {}
      }
    }

    res.end();

    // log assistant after stream completes
    await pushLog({
      role: "assistant",
      content: fullReply,
      ts: new Date().toISOString()
    });

  } catch (err) {
    res.statusCode = 500;
    res.end(err.message);
  }
};
