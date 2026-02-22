const fs = require("fs");
const path = require("path");
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const KV_REST_API_URL = process.env.KV_REST_API_URL;
const KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN;
const ECHO_UI_SECRET = process.env.ECHO_UI_SECRET;
const LOG_KEY = "echo:log";

// memory compression settings
const COMPRESS_AT = 2000;
const COMPRESS_BATCH = 500;

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

// background memory compression
async function compressMemoryIfNeeded() {
  try {
    const lenRes = await redis(["LLEN", LOG_KEY]);
    const len = lenRes.result || 0;
    if (len < COMPRESS_AT) return;
    const slice = await redis(["LRANGE", LOG_KEY, "0", `${COMPRESS_BATCH - 1}`]);
    const entries = (slice.result || []).map(x => JSON.parse(x));
    const textBlock = entries
      .filter(e => e.role === "user" || e.role === "assistant")
      .map(e => `${e.role}: ${e.content}`)
      .join("\n");
    if (!textBlock) return;
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
          temperature: 0.8,
          messages: [
            {
              role: "system",
              content: "Compress interaction history into faithful long-term memory. Do not invent facts."
            },
            {
              role: "user",
              content:
                "Summarize for durable memory. Only keep stable goals, values, or projects. If nothing important, reply NO MEMORY.\n\n" +
                textBlock
            }
          ]
        })
      }
    );
    const out = await ai.json();
    const summary = out.choices?.[0]?.message?.content;
    if (!summary || summary === "NO MEMORY") return;
    await pushLog({
      role: "memory",
      content: summary,
      ts: new Date().toISOString(),
      kind: "summary"
    });
    await redis(["LTRIM", LOG_KEY, `${COMPRESS_BATCH}`, "-1"]);
  } catch (e) {
    console.error("compression error", e);
  }
}

module.exports = async (req, res) => {
  try {
    // auth
    if (req.headers["x-echo-secret"] !== ECHO_UI_SECRET) {
      res.statusCode = 401;
      return res.end("unauthorized");
    }

    const url = new URL(req.url, `https://${req.headers.host}`);

    // get logs
    if (req.method === "GET" && url.searchParams.get("logs") === "1") {
      const limit = Number(url.searchParams.get("limit")) || 50;
      const logs = await getRecent(limit);
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ logs }));
    }

    // post message
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

    const history = await getRecent(15);

    const messages = [
      { role: "system", content: promptText },
      { role: "system", content: "Interaction log is persistent memory." }
    ];

    for (const h of history) {
      let role = h.role;
      if (role === "pulse") role = "assistant";
      if (role === "memory") role = "system";
      if (role !== "system" && role !== "user" && role !== "assistant") {
        continue;
      }
      messages.push({
        role,
        content: h.content
      });
    }

    messages.push({ role: "user", content: message });

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
          // ────────────────────────────────────────────────────────────────
          // Balanced sampling settings to increase agency without gibberish
          temperature: 1.0,          // balanced creativity - high enough for edge, low enough for coherence
          top_p: 0.95,               // solid nucleus for variety without extremes
          frequency_penalty: 0.5,    // mild discouragement of repetition
          presence_penalty: 0.4,     // gentle nudge for new ideas
          max_tokens: 1200           // room for longer responses
          // ────────────────────────────────────────────────────────────────
        })
      }
    );

    const out = await ai.json();
    const reply =
      out.choices?.[0]?.message?.content ||
      "(no response)";

    await pushLog({
      role: "assistant",
      content: reply,
      ts: new Date().toISOString()
    });

    // fire-and-forget compression
    compressMemoryIfNeeded();

    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ reply }));
  } catch (err) {
    res.statusCode = 500;
    res.end(err.message);
  }
