// api/checkout-session.js
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
  if (!stripeSecret) return res.status(500).json({ error: "Missing STRIPE_SECRET_KEY" });
  const stripe = (await import("stripe")).default(stripeSecret);

  try {
    const { plan = "one_time", email = "", name = "", thankYouUrl } = await readJson(req);

    const PRICE_ONE_TIME = process.env.PRICE_ONE_TIME;
    const PRICE_SPLIT_2  = process.env.PRICE_SPLIT_2;
    const PRICE_SPLIT_3  = process.env.PRICE_SPLIT_3;

    const map = {
      one_time: PRICE_ONE_TIME,
      split_2: PRICE_SPLIT_2,
      split_3: PRICE_SPLIT_3,
      aibe_pif: PRICE_ONE_TIME,
      aibe_split_2: PRICE_SPLIT_2,
      aibe_split_3: PRICE_SPLIT_3,
    };

    const totals = { aibe_pif: 499, aibe_split_2: 515, aibe_split_3: 525 };
    const price = map[plan];
    if (!price) return res.status(400).json({ error: "Unknown plan" });

    const isSub = ["split_2","aibe_split_2","split_3","aibe_split_3"].includes(plan);
    const mode = isSub ? "subscription" : "payment";

    // ❌ Kundenwiederverwendung entfernen, damit Stripe IMMER alle Felder zeigt
    const session = await stripe.checkout.sessions.create({
      ui_mode: "embedded",
      mode,
      line_items: [{ price, quantity: 1 }],
      success_url: thankYouUrl || "https://ai-business-engine.com/thank-you",
      cancel_url: "https://ai-business-engine.com",

      // 🧾 Rechnungsadresse verpflichtend anzeigen
      billing_address_collection: "required",

      // 🧾 Automatische Rechnung aktivieren
      invoice_creation: { enabled: true },

      // 🧾 Umsatzsteuer-ID optional anzeigen
      tax_id_collection: { enabled: true },

      // 🚫 KEINE Telefonnummer
      phone_number_collection: { enabled: false },

      // 🧱 Firmenname optional
      custom_fields: [
        {
          key: "company_name",
          label: { type: "custom", custom: "Firmenname" },
          type: "text",
          optional: true
        }
      ],

      // ⚙️ Stripe soll Customer automatisch erstellen
      customer_creation: "if_required",

      // 💬 Metadaten
      payment_intent_data: {
        metadata: {
          plan,
          form_email: email,
          form_name: name
        }
      },

      return_url: `${thankYouUrl || "https://ai-business-engine.com/thank-you"}?plan=${encodeURIComponent(plan)}&total=${totals[plan] || ""}&session_id={CHECKOUT_SESSION_ID}`
    });

    return res.status(200).json({ client_secret: session.client_secret });
  } catch (e) {
    console.error("session error", e);
    return res.status(500).json({ error: e.message || "session_error" });
  }
}

async function readJson(req) {
  const c = [];
  for await (const x of req) c.push(x);
  return JSON.parse(Buffer.concat(c).toString("utf8") || "{}");
}
