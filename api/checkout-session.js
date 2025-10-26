// api/checkout-session.js
export default async function handler(req, res) {
  // --- CORS erlaubte Origins ---
  const ALLOWED = [
    "https://ai-business-engine.com",
    "https://www.ai-business-engine.com",
    "https://baramiai-c98bd4c508b71b1b1c91ae95c029fc.webflow.io",
  ];
  const origin = req.headers.origin || "";
  if (ALLOWED.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end("Method Not Allowed");

  // --- Stripe init ---
  const stripeSecret = process.env.STRIPE_SECRET_KEY;
  if (!stripeSecret) return res.status(500).json({ error: "Missing STRIPE_SECRET_KEY" });
  const stripe = (await import("stripe")).default(stripeSecret, { apiVersion: "2020-08-27" });

  try {
    // Wir lesen nur plan & Ziel-URL. E-Mail/Name werden NICHT an Stripe durchgereicht (SOP 3.1).
    // Frontend kann 'thankYouUrl' oder 'successUrl' schicken – wir mappen beides.
    const { plan = "one_time", thankYouUrl, successUrl } = await readJson(req);

    const PRICE_ONE_TIME = process.env.PRICE_ONE_TIME;
    const PRICE_SPLIT_2  = process.env.PRICE_SPLIT_2;
    const PRICE_SPLIT_3  = process.env.PRICE_SPLIT_3;

    const priceMap = {
      one_time: PRICE_ONE_TIME,
      split_2:  PRICE_SPLIT_2,
      split_3:  PRICE_SPLIT_3,
      aibe_pif: PRICE_ONE_TIME,
      aibe_split_2: PRICE_SPLIT_2,
      aibe_split_3: PRICE_SPLIT_3,
    };
    const totals = { aibe_pif: 499, aibe_split_2: 515, aibe_split_3: 525 };
    const price = priceMap[plan];
    if (!price) return res.status(400).json({ error: "Unknown plan" });

    const isSub = ["split_2", "aibe_split_2", "split_3", "aibe_split_3"].includes(plan);
    const mode = isSub ? "subscription" : "payment";

    // --- Session-Payload (ohne customer_email) ---
    const sessionParams = {
      ui_mode: "embedded",
      mode,
      line_items: [{ price, quantity: 1 }],
      // Embedded-Flow nutzt return_url (successUrl/thankYouUrl werden unterstützt)
      return_url:
        `${(thankYouUrl || successUrl || "https://ai-business-engine.com/thank-you")}`
        + `?plan=${encodeURIComponent(plan)}&total=${totals[plan] || ""}&session_id={CHECKOUT_SESSION_ID}`,
      billing_address_collection: "required",
      tax_id_collection: { enabled: false },
      phone_number_collection: { enabled: false },

      // Custom Fields für Rechnung (optional)
      custom_fields: [
        {
          key: "company_name",
          label: { type: "custom", custom: "Firmenname (optional)" },
          type: "text",
          optional: true,
        },
        {
          key: "company_tax_number",
          label: { type: "custom", custom: "Steuernummer / VAT (optional)" },
          type: "text",
          optional: true,
        },
      ],
    };

    // SOP 3.1: harte Absicherung – niemals customer_email/customer an Stripe senden
    delete sessionParams.customer_email;
    delete sessionParams.customer;

    // Metadaten nur fürs spätere Mapping/Debugging – ohne Checkout-Felder zu beeinflussen
    if (mode === "payment") {
      sessionParams.invoice_creation = {
        enabled: true,
        // KEIN invoice_data.auto_advance hier (SOP 3.2)!
        invoice_data: {
          footer: "Reverse Charge – Die Steuerschuldnerschaft liegt beim Leistungsempfänger.",
          // Nur Debug/Mapping – keine Checkout-Felder
          metadata: { plan },
        },
      };
      sessionParams.payment_intent_data = {
        metadata: { plan },
      };
    } else {
      sessionParams.subscription_data = {
        metadata: { plan },
      };
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    // Frontend erwartet client_secret; ver-Marker hilft bei Live-Diagnose (SOP 3.1)
    return res.status(200).json({
      client_secret: session.client_secret,
      ver: "no-email-guard-20251024",
    });
  } catch (e) {
    console.error("[session] error", e);
    return res.status(500).json({ error: e.message || "session_error" });
  }
}

async function readJson(req) {
  const chunks = [];
  for await (const x of req) chunks.push(x);
  const raw = Buffer.concat(chunks).toString("utf8") || "{}";
  return JSON.parse(raw);
}
