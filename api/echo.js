const fs = require("fs");
const path = require("path");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const KV_REST_API_URL = process.env.KV_REST_API_URL;
const KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN;
const ECHO_UI_SECRET = process.env.ECHO_UI_SECRET;

const LOG_KEY = "echo:log";

/* =========================
   SETTINGS
========================= */

const RAW_CONTEXT_COUNT = 50;

const COMPRESS_AT = 500;
const COMPRESS_BATCH = 150;

const COMPRESS_COOLDOWN_MS = 60000;

const MODEL = "gpt-4o";
const TEMPERATURE = 0.7;

/* ========================= */

async function redis(cmd) {
  const r = await fetch(KV_REST_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KV_REST_API_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(cmd)
  });

  if (!r.ok) {
    const t = await r.text();
    throw new Error("Redis error: " + t);
  }

  return r.json();
}

async function getAllLogs() {
  const r = await redis(["LRANGE", LOG_KEY, "0", "-1"]);
  return (r.result || []).map(x => {
    try { return JSON.parse(x); }
    catch { return null; }
  }).filter(Boolean);
}

async function pushLog(entry) {
  await redis(["RPUSH", LOG_KEY, JSON.stringify(entry)]);
}

/* =========================
   OPENAI CALL
========================= */

async function callOpenAI(messages) {
  const response = await fetch(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        temperature: TEMPERATURE,
        max_tokens: 1000
      })
    }
  );

  if (!response.ok) {
    const t = await response.text();
    throw new Error("OpenAI request failed (" + response.status + "): " + t);
  }

  const data = await response.json();

  const reply = data?.choices?.[0]?.message?.content;
  if (!reply) {
    throw new Error("Malformed OpenAI response");
  }

  return reply;
}

/* =========================
   MEMORY COMPRESSION
========================= */

async function compressIfNeeded() {
  try {
    const lastRunRes = await redis(["GET", "echo:last:compress"]);
    const now = Date.now();

    if (lastRunRes.result && now - Number(lastRunRes.result) < COMPRESS_COOLDOWN_MS) {
      return;
    }

    const lenRes = await redis(["LLEN", LOG_KEY]);
    const len = lenRes.result || 0;

    if (len < COMPRESS_AT) return;

    await redis(["SET", "echo:last:compress", String(now)]);

    const sliceRes = await redis(["LRANGE", LOG_KEY, "0", `${COMPRESS_BATCH - 1}`]);
    const entries = (sliceRes.result || [])
      .map(x => JSON.parse(x))
      .filter(e => ["user", "assistant", "pulse"].includes(e.role));

    if (entries.length === 0) return;

    const textBlock = entries
      .map(e => `${e.role}: ${e.content}`)
      .join("\n\n");

    const summary = await callOpenAI([
      {
        role: "system",
        content:
          "Summarize this interaction into durable structural memory. Preserve identity shifts, ongoing projects, emotional trajectories, and architectural decisions. Do not invent."
      },
      { role: "user", content: textBlock }
    ]);

    await pushLog({
      role: "system",
      kind: "memory",
      content: summary,
      ts: new Date().toISOString()
    });

    await redis(["LTRIM", LOG_KEY, `${COMPRESS_BATCH}`, "-1"]);

  } catch (err) {
    console.error("Compression failed:", err.message);
  }
}

/* =========================
   MAIN HANDLER
========================= */

module.exports = async (req, res) => {
  try {
    if (req.headers["x-echo-secret"] !== ECHO_UI_SECRET) {
      res.statusCode = 401;
      return res.end("unauthorized");
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

    const logs = await getAllLogs();

    const memoryBlocks = logs
      .filter(e => e.kind === "memory")
      .map(e => e.content)
      .join("\n\n");

    const rawRecent = logs
      .filter(e => ["user", "assistant", "pulse"].includes(e.role))
      .slice(-RAW_CONTEXT_COUNT);

    const messages = [
      { role: "system", content: promptText }
    ];

    if (memoryBlocks) {
      messages.push({
        role: "system",
        content: "Long-term memory:\n\n" + memoryBlocks
      });
    }

    rawRecent.forEach(e => {
      messages.push({ role: e.role, content: e.content });
    });

    messages.push({ role: "user", content: message });

    await pushLog({
      role: "user",
      content: message,
      ts: new Date().toISOString()
    });

    let reply;

    try {
      reply = await callOpenAI(messages);
    } catch (err) {
      if (err.message.includes("429")) {
        console.error("Rate limited. Retrying...");
        await new Promise(r => setTimeout(r, 1500));
        reply = await callOpenAI(messages);
      } else {
        throw err;
      }
    }

    await pushLog({
      role: "assistant",
      content: reply,
      ts: new Date().toISOString()
    });

    // Non-blocking compression
    compressIfNeeded();

    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ reply }));

  } catch (err) {
    console.error("Handler error:", err.message);
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: err.message }));
  }
};
