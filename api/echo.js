const fs = require("fs");
const path = require("path");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const KV_REST_API_URL = process.env.KV_REST_API_URL;
const KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN;
const ECHO_UI_SECRET = process.env.ECHO_UI_SECRET;

const LOG_KEY = "echo:log";

// --- MEMORY SETTINGS ---
const COMPRESS_AT = 10;     // when to compress
const COMPRESS_BATCH = 3;   // how many to compress

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

// --- AUTO COMPRESSION ---
async function compressMemoryIfNeeded() {

  const lenRes = await redis(["LLEN", LOG_KEY]);
  const len = lenRes.result || 0;

  if (len < COMPRESS_AT) return;

  console.log("Memory compression triggered");

  // get oldest entries
  const slice = await redis(["LRANGE", LOG_KEY, "0", `${COMPRESS_BATCH-1}`]);
  const entries = (slice.result || []).map(x => JSON.parse(x));

  // build text block
  const textBlock = entries
    .filter(e => e.role === "user" || e.role === "assistant")
    .map(e => `${e.role}: ${e.content}`)
    .join("\n");

  if (!textBlock) return;

  // summarize
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
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content: "You compress interaction history into faithful long-term memory."
          },
          {
            role: "user",
            content:
              `Summarize this for persistent memory. Preserve core values, themes, and identity. Be faithful and neutral.\n\n${textBlock}`
          }
        ]
      })
    }
  );

  const out = await ai.json();
  const summary = out.choices?.[0]?.message?.content || "";

  if (!summary) return;

  // store memory summary
  await pushLog({
    role: "memory",
    content: summary,
    ts: new Date().toISOString(),
    kind: "summary"
  });

  // delete compressed entries
  await redis(["LTRIM", LOG_KEY, `${COMPRESS_BATCH}`, "-1"]);
}

module.exports = async (req, res) => {
  try {

    // --- AUTH ---
    if (req.headers["x-echo-secret"] !== ECHO_UI_SECRET) {
      res.statusCode = 401;
      return res.end("unauthorized");
    }

    const url = new URL(req.url, `https://${req.headers.host}`);

    // --- GET LOGS ---
    if (req.method === "GET" && url.searchParams.get("logs") === "1") {
      const limit = Number(url.searchParams.get("limit")) || 50;
      const logs = await getRecent(limit);
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ logs }));
    }

    // --- POST MESSAGE ---
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
      { role: "system", content: "The interaction log is persistent memory." }
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

    // get reply
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
    const reply = out.choices?.[0]?.message?.content || "";

    // log assistant
    await pushLog({
      role: "assistant",
      content: reply,
      ts: new Date().toISOString()
    });

    // --- trigger compression if needed ---
    compressMemoryIfNeeded().catch(console.error);

    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ reply }));

  } catch (err) {
    res.statusCode = 500;
    res.end(err.message);
  }
};
