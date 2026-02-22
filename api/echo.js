const fs = require("fs");
const path = require("path");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const KV_REST_API_URL = process.env.KV_REST_API_URL;
const KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN;
const ECHO_UI_SECRET = process.env.ECHO_UI_SECRET;

const LOG_KEY = "echo:log";

/* =========================
   BALANCED SETTINGS
========================= */

const RAW_CONTEXT_COUNT = 40;
const MAX_MEMORY_CHARS = 12000;
const MAX_MESSAGE_CHARS = 4000;
const MODEL = "gpt-4o";
const TEMPERATURE = 0.7;

/* ========================= */

function clamp(str, max) {
  if (!str) return "";
  return str.length > max ? str.slice(0, max) : str;
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

  if (!r.ok) {
    const t = await r.text();
    throw new Error("Redis error: " + t);
  }

  return r.json();
}

async function getAllLogs() {
  const r = await redis(["LRANGE", LOG_KEY, "0", "-1"]);
  return (r.result || [])
    .map(x => {
      try { return JSON.parse(x); }
      catch { return null; }
    })
    .filter(Boolean);
}

async function pushLog(entry) {
  await redis(["RPUSH", LOG_KEY, JSON.stringify(entry)]);
}

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
        max_tokens: 900
      })
    }
  );

  if (!response.ok) {
    const t = await response.text();
    throw new Error("OpenAI HTTP " + response.status + ": " + t);
  }

  const data = await response.json();
  const reply = data?.choices?.[0]?.message?.content;

  if (!reply) {
    throw new Error("Malformed OpenAI response");
  }

  return reply;
}

/* =========================
   MAIN HANDLER
========================= */

module.exports = async (req, res) => {
  try {

    // --- AUTH ---
    if (req.headers["x-echo-secret"] !== ECHO_UI_SECRET) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ error: "unauthorized" }));
    }

    const url = new URL(req.url, "https://dummy.local");

    // --- GET LOGS ---
    if (req.method === "GET" && url.searchParams.get("logs") === "1") {
      const logs = await getAllLogs();
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ logs }));
    }

    // --- POST CHAT ---
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ error: "method not allowed" }));
    }

    let body = "";
    for await (const chunk of req) body += chunk;

    const { message } = JSON.parse(body || "{}");

    if (!message) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ error: "missing message" }));
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

    const memoryText = clamp(
      logs
        .filter(e => e.kind === "memory")
        .map(e => e.content)
        .join("\n\n"),
      MAX_MEMORY_CHARS
    );

    const rawRecent = logs
      .filter(e => ["user", "assistant", "pulse"].includes(e.role))
      .slice(-RAW_CONTEXT_COUNT)
      .map(e => ({
        role: e.role,
        content: clamp(e.content, MAX_MESSAGE_CHARS)
      }));

    const messages = [
      { role: "system", content: promptText }
    ];

    if (memoryText) {
      messages.push({
        role: "system",
        content: "Long-term memory:\n\n" + memoryText
      });
    }

    rawRecent.forEach(m => messages.push(m));

    messages.push({
      role: "user",
      content: clamp(message, MAX_MESSAGE_CHARS)
    });

    await pushLog({
      role: "user",
      content: message,
      ts: new Date().toISOString()
    });

    const reply = await callOpenAI(messages);

    await pushLog({
      role: "assistant",
      content: reply,
      ts: new Date().toISOString()
    });

    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ reply }));

  } catch (err) {
    console.error("Handler error:", err.message);
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: err.message }));
  }
};
