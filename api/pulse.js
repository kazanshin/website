// /api/pulse.js
const fs = require("fs");
const path = require("path");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const KV_REST_API_URL = process.env.KV_REST_API_URL;
const KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN;
const ECHO_CRON_SECRET = process.env.ECHO_CRON_SECRET;

const LOG_KEY = "echo:log";
const PULSE_MESSAGE = "Perform a reflective semantic pulse.";

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

function toChatMessages(promptText, recentEntries) {
  const msgs = [{ role: "system", content: promptText }];

  for (const e of recentEntries) {
    if (!e || typeof e.content !== "string") continue;
    if (e.role === "user") msgs.push({ role: "user", content: e.content });
    else if (e.role === "assistant") msgs.push({ role: "assistant", content: e.content });
    else if (e.role === "pulse") msgs.push({ role: "assistant", content: `[PULSE] ${e.content}` });
  }

  msgs.push({ role: "user", content: PULSE_MESSAGE });
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
    if (req.method !== "GET") return json(res, 405, { error: "method_not_allowed" });

    const secret = req.headers["x-echo-cron-secret"];
    if (!secret || secret !== ECHO_CRON_SECRET) return json(res, 401, { error: "unauthorized" });

    const promptText = loadPromptText();
    const recent = await getRecentLog(20);
    const messages = toChatMessages(promptText, recent);

    const pulseText = await callOpenAI(messages);

    const ts = new Date().toISOString();
    await appendLog({ role: "pulse", content: pulseText, ts });

    return json(res, 200, { pulse: pulseText });
  } catch (err) {
    return json(res, 500, { error: "server_error", detail: String(err && err.message ? err.message : err) });
  }
};
