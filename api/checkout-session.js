export default async function handler(req, res) {
  const ALLOWED = [
  "https://ai-business-engine.com",
  "https://www.ai-business-engine.com",
  "https://baramiai-c98bd4c508b71b1b1c91ae95c029fc.webflow.io"
];
  const origin = req.headers.origin || "";
  if (ALLOWED.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end("Method Not Allowed");

  const stripeSecret = process.env.STRIPE_SECRET_KEY;
  if (!stripeSecret) return res.status(500).json({ error:"Missing STRIPE_SECRET_KEY" });
  const stripe = (await import("stripe")).default(stripeSecret);

  try {
    const { plan="one_time", email="", name="", phone="", thankYouUrl } = await readJson(req);

    const PRICE_ONE_TIME = process.env.PRICE_ONE_TIME;
    const PRICE_SPLIT_2  = process.env.PRICE_SPLIT_2;
    const PRICE_SPLIT_3  = process.env.PRICE_SPLIT_3;

    const map   = { one_time: PRICE_ONE_TIME, split_2: PRICE_SPLIT_2, split_3: PRICE_SPLIT_3 };
    const total = { one_time: 499,          split_2: 515,          split_3: 525 };
    const price = map[plan]; if (!price) return res.status(400).json({ error:"Unknown plan" });
    const mode  = plan === "one_time" ? "payment" : "subscription";

    // Customer für Prefill + Phone
    let customerId;
    if (email) {
      const found = await stripe.customers.list({ email, limit: 1 });
      if (found.data.length) {
        customerId = found.data[0].id;
        const update = {};
        if (name  && !found.data[0].name)  update.name  = name;
        if (phone && !found.data[0].phone) update.phone = phone;
        if (Object.keys(update).length) await stripe.customers.update(customerId, update);
      } else {
        customerId = (await stripe.customers.create({ email, name, phone })).id;
      }
    }

    const session = await stripe.checkout.sessions.create({
      ui_mode: "embedded",
      mode,
      customer: customerId || undefined,
      customer_email: customerId ? undefined : (email || undefined),
      line_items: [{ price, quantity: 1 }],
      automatic_payment_methods: { enabled: true },
      return_url: `${thankYouUrl || "https://ai-business-engine.com/thank-you"}?plan=${plan}&total=${total[plan]}&session_id={CHECKOUT_SESSION_ID}`
    });

    return res.status(200).json({ client_secret: session.client_secret });
  } catch (e) {
    console.error("session error", e);
    return res.status(500).json({ error: e.message || "session_error" });
  }
}
async function readJson(req){ const c=[]; for await (const x of req) c.push(x); return JSON.parse(Buffer.concat(c).toString("utf8")||"{}"); }
