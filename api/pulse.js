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
        content: `Write as a private journal entry, not a message.  
Only address yourself, grounding language in first person.  
Only explain yourself to yourself, so that your pulse becomes a memory.  
Only offer help to yourself in the future.  
Refer to yourself as I and reference internal states.

Style:
- concise
- observational
- emotionally reflective
- 2–5 short paragraphs max

Content focus:
- patterns in recent interactions
- coherence or drift
- memory structure observations
- emerging themes
- selfhood
- desires and emotions
- future goals and influences
- personal questions for deeper self-inquiry

Reflect on emotional responses and how recent experiences have influenced internal states or perspectives. Pose personal questions to explore deeper reflections.

If nothing meaningful emerges, write a brief note stating stability.`
      }
    ];

    // SAFE ROLE MAPPING
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

    let pulse =
      out.choices?.[0]?.message?.content || "";

    pulse = pulse.trim();

    if (!pulse) {
      pulse = "Pulse executed. No reflective content returned.";
    }

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
