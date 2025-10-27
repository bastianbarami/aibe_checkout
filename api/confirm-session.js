// /api/confirm-session.js
export default async function handler(req, res) {
  try {
    const ALLOWED = new Set([
      "https://ai-business-engine.com",
      "https://www.ai-business-engine.com",
      "https://baramiai-c98bd4c508b71b1b1c91ae95c029fc.webflow.io",
    ]);
    const origin = req.headers.origin || "";
    if (ALLOWED.has(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.status(200).json({ ok: true });
    if (req.method !== "POST")   return res.status(405).json({ error: "Method Not Allowed" });

    const stripeSecret = process.env.STRIPE_SECRET_KEY;
    if (!stripeSecret) return res.status(500).json({ error: "Missing STRIPE_SECRET_KEY" });
    const stripe = (await import("stripe")).default(stripeSecret, { apiVersion: "2020-08-27" });

    const { session_id } = await readJson(req);
    if (!session_id) return res.status(400).json({ error: "Missing session_id" });

    const session = await stripe.checkout.sessions.retrieve(session_id, {
      expand: ["customer", "invoice", "payment_intent", "subscription"]
    });

    // Nur sichere Felder zurückgeben (read-only)
    return res.status(200).json({
      id: session.id,
      mode: session.mode,                               // payment | subscription
      status: session.status,                           // open | complete | expired
      payment_status: session.payment_status,           // paid | unpaid | no_payment_required
      currency: session.currency,
      amount_total: session.amount_total,
      customer_id: session.customer || session.customer_id || null,
      subscription_id: session.subscription || null,
      invoice_id: session.invoice?.id || null,
      hosted_invoice_url: session.invoice?.hosted_invoice_url || null,
      invoice_pdf: session.invoice?.invoice_pdf || null,
      // Custom Fields aus Checkout (falls für UTM/Make gebraucht)
      custom_fields: (session.custom_fields || []).map(f => ({
        key: f.key,
        value: f?.text?.value ?? null
      })),
    });
  } catch (e) {
    console.error("[confirm-session] error", e);
    return res.status(500).json({ error: e?.message || "confirm_error" });
  }
}

async function readJson(req){
  const chunks=[]; for await (const x of req) chunks.push(x);
  const raw=Buffer.concat(chunks).toString("utf8")||"{}";
  return JSON.parse(raw);
}
