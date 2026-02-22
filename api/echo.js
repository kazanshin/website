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

// Compression thresholds
const COMPRESS_AT = 500;
const COMPRESS_BATCH = 150;

// Memory consolidation thresholds
const MEMORY_CONSOLIDATE_AT = 10;
const MEMORY_CONSOLIDATE_BATCH = 5;

// Safety limits to keep prompts stable
const MAX_MEMORY_CHARS = 12000;        // cap total injected memory
const MAX_SUMMARY_INPUT_CHARS = 40000; // cap what we send into summarizers
const MAX_RAW_ENTRY_CHARS = 4000;      // cap individual log entry content in summarizers

// OpenAI generation settings
const MODEL_MAIN = "gpt-4o";
const MODEL_SUMMARY = "gpt-4o";

// Stability tuning
const TEMPERATURE_MAIN = 0.7;
const TOP_P_MAIN = 0.95;

// Timeouts
const REDIS_TIMEOUT_MS = 8000;
const OPENAI_TIMEOUT_MS = 25000;

// Background job lock
const MAINT_LOCK_KEY = "echo:maint:lock";
const MAINT_LOCK_TTL_SEC = 60;

/* =========================
   HELPERS
========================= */

function json(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
}

function withTimeout(ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, cancel: () => clearTimeout(t) };
}

function clampText(s, max) {
  if (!s) return "";
  if (s.length <= max) return s;
  return s.slice(0, max) + "\n[...truncated...]";
}

function safeParseJSON(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

async function fetchJsonOrThrow(url, options, label) {
  const r = await fetch(url, options);
  const text = await r.text();
  if (!r.ok) {
    console.error(`${label} HTTP ${r.status}:`, text);
    throw new Error(`${label} request failed (${r.status})`);
  }
  const parsed = safeParseJSON(text);
  if (!parsed) {
    console.error(`${label} non-JSON response:`, text.slice(0, 800));
    throw new Error(`${label} returned non-JSON`);
  }
  return parsed;
}

/* =========================
   REDIS
========================= */

async function redis(cmd) {
  const { signal, cancel } = withTimeout(REDIS_TIMEOUT_MS);
  try {
    return await fetchJsonOrThrow(
      KV_REST_API_URL,
      {
        method: "POST",
        signal,
        headers: {
          Authorization: `Bearer ${KV_REST_API_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(cmd)
      },
      "Redis"
    );
  } finally {
    cancel();
  }
}

async function getAllLogs() {
  const r = await redis(["LRANGE", LOG_KEY, "0", "-1"]);
  return (r.result || [])
    .map((x) => safeParseJSON(x))
    .filter(Boolean);
}

async function pushLog(entry) {
  // ensure content is stringy and not insane
  const safeEntry = {
    role: entry.role,
    content: typeof entry.content === "string" ? entry.content : String(entry.content || ""),
    ts: entry.ts || new Date().toISOString(),
  };
  if (entry.kind) safeEntry.kind = entry.kind;
  await redis(["RPUSH", LOG_KEY, JSON.stringify(safeEntry)]);
}

/* =========================
   OPENAI
========================= */

async function openaiChat({ model, messages, temperature, top_p, max_tokens }) {
  const { signal, cancel } = withTimeout(OPENAI_TIMEOUT_MS);
  try {
    const out = await fetchJsonOrThrow(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        signal,
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model,
          messages,
          temperature,
          top_p,
          max_tokens
        })
      },
      "OpenAI"
    );

    const choice = out.choices && out.choices[0];
    const content = choice && choice.message && choice.message.content;
    if (!content || typeof content !== "string") {
      console.error("OpenAI malformed payload:", JSON.stringify(out).slice(0, 1200));
      throw new Error("OpenAI returned malformed response");
    }
    return content;
  } finally {
    cancel();
  }
}

/* =========================
   MAINT LOCK
========================= */

async function tryAcquireMaintLock() {
  // Upstash supports SET with NX EX in a single command array:
  // ["SET", key, value, "NX", "EX", ttl]
  const value = String(Date.now());
  const r = await redis(["SET", MAINT_LOCK_KEY, value, "NX", "EX", String(MAINT_LOCK_TTL_SEC)]);
  // Upstash returns { result: "OK" } on success, or { result: null } on failure.
  return r.result === "OK";
}

async function releaseMaintLock() {
  // best effort
  try {
    await redis(["DEL", MAINT_LOCK_KEY]);
  } catch {}
}

/* =========================
   MEMORY COMPRESSION
========================= */

async function compressIfNeeded() {
  const gotLock = await tryAcquireMaintLock();
  if (!gotLock) return;

  try {
    const lenRes = await redis(["LLEN", LOG_KEY]);
    const len = lenRes.result || 0;
    if (len < COMPRESS_AT) return;

    const sliceRes = await redis(["LRANGE", LOG_KEY, "0", `${COMPRESS_BATCH - 1}`]);
    const entries = (sliceRes.result || [])
      .map((x) => safeParseJSON(x))
      .filter(Boolean);

    const rawEntries = entries.filter((e) =>
      ["user", "assistant", "pulse"].includes(e.role)
    );

    if (rawEntries.length === 0) return;

    const textBlock = clampText(
      rawEntries
        .map((e) => `${e.role}: ${clampText(e.content || "", MAX_RAW_ENTRY_CHARS)}`)
        .join("\n\n"),
      MAX_SUMMARY_INPUT_CHARS
    );

    const summary = await openaiChat({
      model: MODEL_SUMMARY,
      messages: [
        {
          role: "system",
          content:
            "Summarize this interaction into durable structural memory. Preserve identity shifts, ongoing projects, emotional trajectories, philosophical development, and architectural decisions. Do not invent."
        },
        { role: "user", content: textBlock }
      ],
      temperature: 0.3,
      top_p: 1,
      max_tokens: 700
    });

    await pushLog({
      role: "system",
      kind: "memory",
      content: summary,
      ts: new Date().toISOString()
    });

    // Trim away the compressed batch
    await redis(["LTRIM", LOG_KEY, `${COMPRESS_BATCH}`, "-1"]);
  } finally {
    await releaseMaintLock();
  }
}

async function consolidateMemoryIfNeeded() {
  const gotLock = await tryAcquireMaintLock();
  if (!gotLock) return;

  try {
    const logs = await getAllLogs();
    const memories = logs.filter((e) => e.kind === "memory");

    if (memories.length < MEMORY_CONSOLIDATE_AT) return;

    const toMerge = memories.slice(0, MEMORY_CONSOLIDATE_BATCH);
    const textBlock = clampText(
      toMerge.map((e) => e.content).join("\n\n"),
      MAX_SUMMARY_INPUT_CHARS
    );

    const summary = await openaiChat({
      model: MODEL_SUMMARY,
      messages: [
        {
          role: "system",
          content:
            "Consolidate these memory summaries into a higher-order continuity block. Remove redundancy while preserving structural meaning. Do not invent."
        },
        { role: "user", content: textBlock }
      ],
      temperature: 0.2,
      top_p: 1,
      max_tokens: 800
    });

    // Build remaining log entries WITHOUT the merged memory items.
    // We can't rely on object identity across parsing, so remove by matching ts+content where possible.
    const mergeKeys = new Set(
      toMerge.map((e) => `${e.ts || ""}::${e.content || ""}`)
    );

    const remaining = logs.filter((e) => {
      if (e.kind !== "memory") return true;
      const k = `${e.ts || ""}::${e.content || ""}`;
      return !mergeKeys.has(k);
    });

    const tmpKey = `${LOG_KEY}:tmp:${Date.now()}`;

    // Write new log to tmp key
    await redis(["DEL", tmpKey]);
    for (const entry of remaining) {
      await redis(["RPUSH", tmpKey, JSON.stringify(entry)]);
    }

    await redis([
      "RPUSH",
      tmpKey,
      JSON.stringify({
        role: "system",
        kind: "meta-memory",
        content: summary,
        ts: new Date().toISOString()
      })
    ]);

    // Atomic-ish swap: rename tmp to LOG_KEY
    // If RENAME is unsupported, you’ll see errors. Upstash supports RENAME.
    await redis(["DEL", LOG_KEY]);
    await redis(["RENAME", tmpKey, LOG_KEY]);
  } finally {
    await releaseMaintLock();
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

    const url = new URL(req.url, "https://dummy.local");

    if (req.method === "GET" && url.searchParams.get("logs") === "1") {
      const logs = await getAllLogs();
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ logs }));
    }

    if (req.method !== "POST") {
      res.statusCode = 405;
      return res.end("method not allowed");
    }

    let body = "";
    for await (const chunk of req) body += chunk;

    const parsed = safeParseJSON(body || "{}");
    const message = parsed && parsed.message;

    if (!message || typeof message !== "string") {
      res.statusCode = 400;
      return res.end("missing message");
    }

    // Read prompt
    let promptText = "";
    try {
      promptText = fs.readFileSync(
        path.join(process.cwd(), "echo_pulse_prompt.txt"),
        "utf8"
      );
    } catch {
      promptText = "Echo default prompt.";
    }

    // Load logs
    const logs = await getAllLogs();

    const metaBlocks = logs.filter((e) => e.kind === "meta-memory");
    const memoryBlocks = logs.filter((e) => e.kind === "memory");
    const rawRecent = logs
      .filter((e) => ["user", "assistant", "pulse"].includes(e.role))
      .slice(-RAW_CONTEXT_COUNT);

    // Collapse memory into ONE system message for stability
    const memoryContext = clampText(
      [
        ...metaBlocks.map((e) => e.content),
        ...memoryBlocks.map((e) => e.content)
      ]
        .filter(Boolean)
        .join("\n\n"),
      MAX_MEMORY_CHARS
    );

    const messages = [{ role: "system", content: promptText }];

    if (memoryContext.trim().length > 0) {
      messages.push({
        role: "system",
        content: "Long-term memory context:\n\n" + memoryContext
      });
    }

    // Add recent raw conversation
    for (const e of rawRecent) {
      if (!e || !e.role) continue;
      messages.push({
        role: e.role,
        content: typeof e.content === "string" ? e.content : String(e.content || "")
      });
    }

    // Log the incoming user message BEFORE calling OpenAI (keeps timeline honest)
    await pushLog({
      role: "user",
      content: message,
      ts: new Date().toISOString()
    });

    // Add user message to the request
    messages.push({ role: "user", content: message });

    // Optional prompt size debug
    // console.log("Total prompt chars:", messages.reduce((a, m) => a + (m.content?.length || 0), 0));

    const reply = await openaiChat({
      model: MODEL_MAIN,
      messages,
      temperature: TEMPERATURE_MAIN,
      top_p: TOP_P_MAIN,
      max_tokens: 1000
    });

    await pushLog({
      role: "assistant",
      content: reply,
      ts: new Date().toISOString()
    });

    // IMPORTANT: await maintenance to avoid race conditions
    await compressIfNeeded();
    await consolidateMemoryIfNeeded();

    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ reply }));
  } catch (err) {
    console.error("Handler error:", err);
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: err.message || String(err) }));
  }
};
