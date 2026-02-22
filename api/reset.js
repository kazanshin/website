export default async function handler(req, res) {
  const KV_REST_API_URL = process.env.KV_REST_API_URL;
  const KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN;

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

  try {
    await redis(["DEL", "echo:log"]);
    res.status(200).json({ status: "log cleared" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
