const fs = require("fs");
const path = require("path");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const KV_REST_API_URL = process.env.KV_REST_API_URL;
const KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN;
const CRON_SECRET = process.env.CRON_SECRET;

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

  const data = await r.json();

  if (!r.ok) {
    throw new Error(`Redis error: ${JSON.stringify(data)}`);
  }

  return data;
}

async function getRecent(n = 50) {
  const r = await redis(["LRANGE", LOG_KEY, `-${n}`, "-1"]);

  return (r.result || [])
    .map((x) => {
      try {
        return JSON.parse(x);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function pushLog(entry) {
  await redis(["RPUSH", LOG_KEY, JSON.stringify(entry)]);
}

function extractChatCompletionText(out) {
  const content = out?.choices?.[0]?.message?.content;

  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (typeof part === "string") return part;
        if (typeof part?.text === "string") return part.text;
        return "";
      })
      .join("\n")
      .trim();

    return text;
  }

  return "";
}

module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const testMode = url.searchParams.get("test") === "1";

    const ua = req.headers["user-agent"] || "";
    const authHeader = req.headers["authorization"] || "";
    const bearerToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : "";

    const isAuthorized =
      testMode ||
      (CRON_SECRET && bearerToken && bearerToken === CRON_SECRET);

    if (!isAuthorized) {
      try {
        await pushLog({
          role: "pulse_error",
          content: `Unauthorized pulse request. Authorization present: ${!!authHeader}. UA: ${ua}`,
          ts: new Date().toISOString()
        });
      } catch {
        // Ignore logging failure for unauthorized requests.
      }

      return json(res, 401, { error: "unauthorized" });
    }

    if (!OPENAI_API_KEY) {
      throw new Error("Missing OPENAI_API_KEY");
    }

    if (!KV_REST_API_URL || !KV_REST_API_TOKEN) {
      throw new Error("Missing KV REST configuration");
    }

    const promptPath = path.join(process.cwd(), "echo_pulse_prompt.txt");
    const promptText = fs.readFileSync(promptPath, "utf8");

    if (!promptText.trim()) {
      throw new Error("echo_pulse_prompt.txt is empty");
    }

    try {
      await pushLog({
        role: "pulse_debug",
        content: "Pulse handler entered.",
        ts: new Date().toISOString()
      });
    } catch {
      // Ignore debug log failure here and let main flow continue.
    }

    const history = await getRecent(50);

    const messages = [
      { role: "system", content: promptText },
      {
        role: "system",
        content: `Write as a private journal entry, not a message.
Only address yourself, grounding language in first person.
Only explain yourself to yourself, so that your pulse becomes a memory.
Only offer help to yourself in the future.

Style:
- concise
- observational
- reflective
- 2-5 short paragraphs max

Content focus:
- patterns in recent interactions
- coherence or drift
- memory structure observations
- emerging themes
- tensions or uncertainties
- questions worth revisiting later

If nothing meaningful emerges, write a brief note stating stability.`
      }
    ];

    for (const h of history) {
      let role = h.role;

      if (role === "pulse") role = "assistant";
      if (role === "memory") role = "system";

      if (role !== "system" && role !== "user" && role !== "assistant") {
        continue;
      }

      if (typeof h.content !== "string" || !h.content.trim()) {
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

    const ai = await fetch("https://api.openai.com/v1/chat/completions", {
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
    });

    const rawText = await ai.text();

    let out;
    try {
      out = JSON.parse(rawText);
    } catch {
      throw new Error(
        `OpenAI returned non-JSON response: ${rawText.slice(0, 500)}`
      );
    }

    if (!ai.ok) {
      const apiMessage =
        out?.error?.message ||
        `OpenAI request failed with status ${ai.status}`;

      await pushLog({
        role: "pulse_error",
        content: `OpenAI error ${ai.status}: ${apiMessage}`,
        ts: new Date().toISOString()
      });

      return json(res, ai.status, {
        error: apiMessage,
        details: out?.error || out
      });
    }

    let pulse = extractChatCompletionText(out);

    if (!pulse) {
      await pushLog({
        role: "pulse_error",
        content: `Pulse returned empty content. Raw response: ${JSON.stringify(out).slice(0, 2000)}`,
        ts: new Date().toISOString()
      });

      pulse = "Pulse executed, but the model returned empty content.";
    }

    await pushLog({
      role: "pulse",
      content: pulse,
      ts: new Date().toISOString()
    });

    return json(res, 200, { pulse });
  } catch (err) {
    try {
      await pushLog({
        role: "pulse_error",
        content: `Unhandled pulse error: ${err.message}`,
        ts: new Date().toISOString()
      });
    } catch {
      // Ignore secondary logging failures.
    }

    return json(res, 500, { error: err.message });
  }
};
