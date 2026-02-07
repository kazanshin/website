// /api/echo.js
// Source prompt file: :contentReference[oaicite:0]{index=0}

const fs = require("fs");
const path = require("path");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const KV_REST_API_URL = process.env.KV_REST_API_URL;
const KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN;
const ECHO_UI_SECRET = process.env.ECHO_UI_SECRET;

const LOG_KEY = "echo:log";

function json(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

async function redis(cmd) {
  const r = await fetch(KV_REST_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KV_REST_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(cmd),
  });

  const out = await r.json().catch(() => null);
  if (!r.ok) {
    const msg = out && out.error ? out.error : `Redis REST error (${r.status})`;
    throw new Error(msg);
  }
  return out;
}

async function getRecentLog(limit) {
  const n = Math.max(1, Math.min(50, Number(limit) || 20));
  const resp = await redis(["LRANGE", LOG_KEY, String(-n), "-1"]);
  const arr = Array.isArray(resp?.result) ? resp.result : [];
  return arr
    .map((s) => {
      try {
        return JSON.parse(s);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function appendLog(entry) {
  await redis(["RPUSH", LOG_KEY, JSON.stringify(entry)]);
}

function loadPromptText() {
  const p = path.join(process.cwd(), "echo_pulse_prompt.txt");
  return fs.readFileSync(p, "utf8");
}

function toChatMessages(promptText, recentEntries, userMessage) {
  const msgs = [{ role: "system", content: promptText }];

  for (const e of recentEntries) {
    if (!e || typeof e.content !== "string") continue;
    if (e.role === "user") msgs.push({ role: "user", content: e.content });
    else if (e.role === "assistant") msgs.push({ role: "assistant", content: e.content });
    else if (e.role === "pulse") msgs.push({ role: "assistant", content: `[PULSE] ${e.content}` });
  }

  if (typeof userMessage === "string" && userMessage.trim()) {
    msgs.push({ role: "user", content: userMessage.trim() });
  }

  return msgs;
}

async function callOpenAI(messages) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages,
      temperature: 0.7,
    }),
  });

  const out = await r.json().catch(() => null);
  if (!r.ok) {
    const msg =
      out && out.error && out.error.message ? out.error.message : `OpenAI error (${r.status})`;
    throw new Error(msg);
  }

  const text = out?.choices?.[0]?.message?.content;
  return typeof text === "string" ? text : "";
}

module.exports = async function handler(req, res) {
  try {
    const secret = req.headers["x-echo-secret"];
    if (!secret || secret !== ECHO_UI_SECRET) return json(res, 401, { error: "unauthorized" });

    if (req.method === "GET") {
      const wantLogs = req.query && (req.query.logs === "1" || req.query.logs === "true");
      if (!wantLogs) return json(res, 405, { error: "method_not_allowed" });

      const limit = req.query && req.query.limit ? req.query.limit : 30;
      const logs = await getRecentLog(limit);
      return json(res, 200, { logs });
    }

    if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });

    let body = "";
    await new Promise((resolve) => {
      req.on("data", (c) => (body += c));
      req.on("end", resolve);
    });

    let payload = null;
    try {
      payload = JSON.parse(body || "{}");
    } catch {
      return json(res, 400, { error: "invalid_json" });
    }

    const message = typeof payload.message === "string" ? payload.message.trim() : "";
    if (!message) return json(res, 400, { error: "missing_message" });

    const promptText = loadPromptText();
    const recent = await getRecentLog(20);
    const messages = toChatMessages(promptText, recent, message);

    const tsUser = new Date().toISOString();
    await appendLog({ role: "user", content: message, ts: tsUser });

    const reply = await callOpenAI(messages);

    const tsAsst = new Date().toISOString();
    await appendLog({ role: "assistant", content: reply, ts: tsAsst });

    return json(res, 200, { reply });
  } catch (err) {
    return json(res, 500, { error: "server_error", detail: String(err && err.message ? err.message : err) });
  }
};
