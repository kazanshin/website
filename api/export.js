const KV_REST_API_URL = process.env.KV_REST_API_URL;
const KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN;
const ECHO_CRON_SECRET = process.env.ECHO_CRON_SECRET;

const LOG_KEY = "echo:log";

function json(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data, null, 2));
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

module.exports = async (req, res) => {
  try {

    const url = new URL(req.url, `https://${req.headers.host}`);
    const secret = url.searchParams.get("secret");

    if (secret !== ECHO_CRON_SECRET) {
      return json(res, 401, { error: "unauthorized" });
    }

    const r = await redis(["LRANGE", LOG_KEY, "0", "-1"]);
    const entries = (r.result || []).map(x => JSON.parse(x));

    return json(res, 200, entries);

  } catch (err) {
    return json(res, 500, { error: err.message });
  }
};
