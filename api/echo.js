const fs = require("fs");
const path = require("path");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const KV_REST_API_URL = process.env.KV_REST_API_URL;
const KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN;
const ECHO_UI_SECRET = process.env.ECHO_UI_SECRET;

const LOG_KEY = "echo:log";
const seedPath = path.join(process.cwd(), "echo_seed_log.json");

// ---------- helpers ----------

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

// ---------- memory bootstrap ----------

async function bootstrapIfEmpty() {
  const len = await redis(["LLEN", LOG_KEY]);
  if ((len.result || 0) > 0) return;

  try {
    const raw = fs.readFileSync(seedPath, "utf8");
    const seeds = JSON.parse(raw);

    for (const s of seeds) {
      await redis(["RPUSH", LOG_KEY, JSON.stringify(s)]);
    }

    console.log("Seed memory loaded.");
  } catch {
    console.log("No seed file found.");
  }
}

// ---------- log helpers ----------

async function getRecent(n = 50) {
  const r = await redis(["LRANGE", LOG_KEY, `-${n}`, "-1"]);
  return (r.result || []).map(x => JSON.parse(x));
}

async function pushLog(entry) {
  await redis(["RPUSH", LOG_KEY, JSON.stringify(entry)]);
}

// ---------- handler ----------

module.exports = async (req, res) => {
  try {
    if (req.headers["x-echo-secret"] !== ECHO_UI_SECRET)
      return json(res, 401, { error: "unauthorized" });

    await bootstrapIfEmpty();

    let body = "";
    for await (const chunk of req) body += chunk;

    const { message } = JSON.parse(body || "{}");
    if (!message) return json(res, 400, { error: "missing message" });

    const promptText = fs.readFileSync(
      path.join(process.cwd(), "echo_pulse_prompt.txt"),
      "utf8"
    );

    const history = await getRecent(50);

    // ---------- build messages ----------

    const messages = [
      { role: "system", content: promptText },

      {
        role: "system",
        content:
          "The interaction log is persistent memory. Treat it as factual history. If information exists in the log, recall it plainly. Never say memory is temporary, limited, or session-only."
      }
    ];

    for (const h of history) {
      messages.push({
        role: h.role === "pulse" ? "assistant" : h.role,
        content: h.content
      });
    }

    messages.push({ role: "user", content: message });

    // ---------- log user ----------

    await pushLog({
      role: "user",
      content: message,
      ts: new Date().toISOString()
    });

    // ---------- OpenAI ----------

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
          temperature: 0.7
        })
      }
    );

    const out = await ai.json();
    const reply =
      out.choices?.[0]?.message?.content || "…";

    // ---------- log assistant ----------

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
