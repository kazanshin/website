const fs = require("fs");
const path = require("path");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const KV_REST_API_URL = process.env.KV_REST_API_URL;
const KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN;
const ECHO_UI_SECRET = process.env.ECHO_UI_SECRET;

const LOG_KEY = "echo:log";

/* =========================
   MEMORY SETTINGS
========================= */

const CONTEXT_RAW = 40;              // recent raw messages sent to model
const COMPRESS_AT = 600;             // total log length trigger
const COMPRESS_BATCH = 200;          // oldest raw entries to compress

const MEMORY_CONSOLIDATE_AT = 8;     // number of memory blocks before meta consolidation
const MEMORY_CONSOLIDATE_BATCH = 4;  // number of memory blocks to merge

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
  return r.json();
}

async function getAllLogs() {
  const r = await redis(["LRANGE", LOG_KEY, "0", "-1"]);
  return (r.result || []).map(x => JSON.parse(x));
}

async function getRecentRaw(n) {
  const all = await getAllLogs();
  const raw = all.filter(e =>
    ["user", "assistant", "pulse"].includes(e.role)
  );
  return raw.slice(-n);
}

async function getMemoryBlocks() {
  const all = await getAllLogs();
  return all.filter(e => e.kind === "memory");
}

async function getMetaMemoryBlocks() {
  const all = await getAllLogs();
  return all.filter(e => e.kind === "meta-memory");
}

async function pushLog(entry) {
  await redis(["RPUSH", LOG_KEY, JSON.stringify(entry)]);
}

/* =========================
   COMPRESSION LOGIC
========================= */

async function compressIfNeeded() {
  const lenRes = await redis(["LLEN", LOG_KEY]);
  const len = lenRes.result || 0;

  if (len < COMPRESS_AT) return;

  const sliceRes = await redis(["LRANGE", LOG_KEY, "0", `${COMPRESS_BATCH - 1}`]);
  const entries = (sliceRes.result || []).map(x => JSON.parse(x));

  const compressible = entries.filter(e =>
    ["user", "assistant", "pulse"].includes(e.role)
  );

  if (compressible.length === 0) return;

  const textBlock = compressible
    .map(e => `${e.role}: ${e.content}`)
    .join("\n\n");

  const ai = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content:
            "Summarize this interaction into durable structural memory. Preserve identity shifts, ongoing projects, emotional trajectories, philosophical development, and architectural decisions. Do not invent."
        },
        {
          role: "user",
          content: textBlock
        }
      ],
      temperature: 0.4
    })
  });

  const out = await ai.json();
  const summary = out.choices?.[0]?.message?.content;
  if (!summary) return;

  await pushLog({
    role: "system",
    kind: "memory",
    content: summary,
    ts: new Date().toISOString()
  });

  await redis(["LTRIM", LOG_KEY, `${COMPRESS_BATCH}`, "-1"]);
}

async function consolidateMemoryIfNeeded() {
  const memories = await getMemoryBlocks();
  if (memories.length < MEMORY_CONSOLIDATE_AT) return;

  const toMerge = memories.slice(0, MEMORY_CONSOLIDATE_BATCH);

  const textBlock = toMerge
    .map(e => e.content)
    .join("\n\n");

  const ai = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content:
            "Consolidate these memory summaries into a higher-order continuity block. Remove redundancy but preserve structural meaning."
        },
        {
          role: "user",
          content: textBlock
        }
      ],
      temperature: 0.3
    })
  });

  const out = await ai.json();
  const summary = out.choices?.[0]?.message?.content;
  if (!summary) return;

  await pushLog({
    role: "system",
    kind: "meta-memory",
    content: summary,
    ts: new Date().toISOString()
  });

  // remove merged memory blocks
  const all = await getAllLogs();
  const remaining = all.filter(e => !toMerge.includes(e));

  await redis(["DEL", LOG_KEY]);
  for (const entry of remaining) {
    await pushLog(entry);
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

    const rawRecent = await getRecentRaw(CONTEXT_RAW);
    const memoryBlocks = await getMemoryBlocks();
    const metaBlocks = await getMetaMemoryBlocks();

    const messages = [
      { role: "system", content: promptText },
      ...metaBlocks.map(e => ({ role: "system", content: e.content })),
      ...memoryBlocks.slice(-5).map(e => ({ role: "system", content: e.content })),
      ...rawRecent.map(e => ({ role: e.role, content: e.content }))
    ];

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

    // background memory maintenance
    compressIfNeeded();
    consolidateMemoryIfNeeded();

    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ reply }));

  } catch (err) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: err.message }));
  }
};
