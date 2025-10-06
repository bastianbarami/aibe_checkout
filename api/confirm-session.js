export default async function handler(req, res) {
  const ALLOWED = [
    "https://ai-business-engine.com",
    "https://DEIN-STAGING.webflow.io"
  ];
  const origin = req.headers.origin || "";
  if (ALLOWED.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end("Method Not Allowed");

  const stripeSecret = process.env.STRIPE_SECRET_KEY;
  const webhookUrl   = process.env.WEBHOOK_URL;
  if (!stripeSecret || !webhookUrl) return res.status(500).json({ error:"Missing server envs" });

  const stripe = (await import("stripe")).default(stripeSecret);
  try {
    const { session_id } = await readJson(req);
    if (!session_id) return res.status(400).json({ error:"Missing session_id" });

    const s = await stripe.checkout.sessions.retrieve(session_id, { expand: ["customer"] });
    const ok = s.status === "complete" && s.payment_status === "paid";
    if (!ok) return res.status(200).json({ ok:false, status:s.status, payment_status:s.payment_status });

    await fetch(webhookUrl, {
      method: "POST", headers: { "Content-Type":"application/json" },
      body: JSON.stringify({
        type: "purchase_success",
        data: {
          session_id: s.id,
          amount_total: s.amount_total,
          currency: s.currency,
          mode: s.mode,
          email: s.customer_details?.email || s.customer?.email || null,
          customer_id: s.customer || null
        }
      })
    });

    return res.status(200).json({ ok:true });
  } catch (e) {
    console.error("confirm error", e);
    return res.status(500).json({ error: e.message });
  }
}
async function readJson(req){ const c=[]; for await (const x of req) c.push(x); return JSON.parse(Buffer.concat(c).toString("utf8")||"{}"); }
