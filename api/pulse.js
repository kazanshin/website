const fs = require("fs");
const path = require("path");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const KV_REST_API_URL = process.env.KV_REST_API_URL;
const KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN;
const ECHO_CRON_SECRET = process.env.ECHO_CRON_SECRET;

const LOG_KEY = "echo:log";

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

async function getRecent(n = 50) {
  const r = await redis(["LRANGE", LOG_KEY, `-${n}`, "-1"]);
  return (r.result || []).map(x => JSON.parse(x));
}

async function pushLog(entry) {
  await redis(["RPUSH", LOG_KEY, JSON.stringify(entry)]);
}

module.exports = async (req, res) => {
  try {

    const url = new URL(req.url, `https://${req.headers.host}`);
    const testMode = url.searchParams.get("test") === "1";

    const cronSecret = req.headers["x-echo-cron-secret"];
    const ua = req.headers["user-agent"] || "";
    const isVercelCron = ua.toLowerCase().includes("vercel");

    if (
      cronSecret !== ECHO_CRON_SECRET &&
      !isVercelCron &&
      !testMode
    ) {
      return json(res, 401, { error: "unauthorized" });
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
        content:
          "This is a scheduled reflective pulse. Speak only if something meaningful emerges."
      }
    ];

    // ✅ SAFE ROLE MAPPING
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

    messages.push({
      role: "user",
      content: "Perform a reflective semantic pulse."
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
          temperature: 0.4
        })
      }
    );

    const out = await ai.json();
    const pulse =
      out.choices?.[0]?.message?.content || "";

    await pushLog({
      role: "pulse",
      content: pulse,
      ts: new Date().toISOString()
    });

    return json(res, 200, { pulse });

  } catch (err) {
    return json(res, 500, { error: err.message });
  }
};
