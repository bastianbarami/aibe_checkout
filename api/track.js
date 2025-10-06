export default async function handler(req, res) {
  const ALLOWED = [
    "https://ai-business-engine.com",
    "https://baramiai-c98bd4c508b71b1b1c91ae95c029fc.webflow.io"
  ];
  const origin = req.headers.origin || "";
  if (ALLOWED.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end("Method Not Allowed");

  const webhookUrl = process.env.WEBHOOK_URL;
  if (!webhookUrl) return res.status(500).json({ error: "Missing WEBHOOK_URL" });

  try {
    const body = await readJson(req);
    const r = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project:"aibe-checkout", receivedAt:Date.now(), ...body })
    });
    return res.status(200).json({ ok: true, status: r.status });
  } catch (e) {
    console.error("track relay error", e);
    return res.status(500).json({ ok:false, error: e.message });
  }
}
async function readJson(req){ const c=[]; for await (const x of req) c.push(x); return JSON.parse(Buffer.concat(c).toString("utf8")||"{}"); }
