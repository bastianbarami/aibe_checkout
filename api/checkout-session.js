// api/checkout-session.js
export default async function handler(req, res) {
  // --- CORS ---
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
  if (req.method !== "POST")   return res.status(405).end("Method Not Allowed");

  // --- Stripe init (fixe API-Version) ---
  const stripeSecret = process.env.STRIPE_SECRET_KEY;
  if (!stripeSecret) return res.status(500).json({ error: "Missing STRIPE_SECRET_KEY" });

  const { default: Stripe } = await import("stripe");
  const stripe = new Stripe(stripeSecret, { apiVersion: "2024-06-20" });

  try {
    // --- Request-Body ---
    const { plan = "one_time", email = "", name = "", phone = "", thankYouUrl } = await readJson(req);

    // --- Price-IDs aus Env ---
    const PRICE_ONE_TIME = process.env.PRICE_ONE_TIME;
    const PRICE_SPLIT_2  = process.env.PRICE_SPLIT_2;
    const PRICE_SPLIT_3  = process.env.PRICE_SPLIT_3;

    // --- Mapping (Frontend -> Stripe Prices) ---
    const priceMap = {
      one_time:     PRICE_ONE_TIME,
      split_2:      PRICE_SPLIT_2,
      split_3:      PRICE_SPLIT_3,
      aibe_pif:     PRICE_ONE_TIME,
      aibe_split_2: PRICE_SPLIT_2,
      aibe_split_3: PRICE_SPLIT_3,
    };

    // --- Anzeigenwert (nur für Redirect-URL) ---
    const totalMap = {
      one_time:     499,
      split_2:      515,
      split_3:      525,
      aibe_pif:     499,
      aibe_split_2: 515,
      aibe_split_3: 525,
    };

    const price = priceMap[plan];
    if (!price) return res.status(400).json({ error: "Unknown plan" });

    // --- Modus bestimmen ---
    const subscriptionPlans = new Set(["split_2", "aibe_split_2", "split_3", "aibe_split_3"]);
    const mode = subscriptionPlans.has(plan) ? "subscription" : "payment";

    // --- Optional: Customer für Prefill/Phone ---
    let customerId;
    if (email) {
      const found = await stripe.customers.list({ email, limit: 1 });
      if (found.data.length) {
        customerId = found.data[0].id;
        const upd = {};
        if (name  && !found.data[0].name)  upd.name  = name;
        if (phone && !found.data[0].phone) upd.phone = phone;
        if (Object.keys(upd).length) await stripe.customers.update(customerId, upd);
      } else {
        customerId = (await stripe.customers.create({ email, name, phone })).id;
      }
    }

    // --- Checkout Session (Embedded) ---
    const session = await stripe.checkout.sessions.create({
      ui_mode: "embedded",
      mode,
      customer: customerId || undefined,
      customer_email: customerId ? undefined : (email || undefined),
      line_items: [{ price, quantity: 1 }],

      // 1) Rechnungs-/Firmendaten einsammeln (Name/Adresse auffordern)
      billing_address_collection: "auto",              // fragt Adresse nur, wenn sinnvoll
      customer_update: { name: "auto", address: "auto" },

      // 2) USt-ID optional einsammeln (z. B. EU VAT)
      tax_id_collection: { enabled: true },           // optionales Feld im Checkout

      // 3) Rechnung automatisch erzeugen und Template setzen
      //    WICHTIG: KEIN automatic_tax (Reverse-Charge machst du separat)
      invoice_creation: {
        enabled: true,
        invoice_data: {
          // Template für das PDF/Hosted Invoice auswählen:
          // (ID aus deinem Stripe-Dashboard)
          rendering: { template: "inrtem_1SIQGBGB35pnerjHYPK16rJx" },

          // Optional: eigene Metadaten/Fußzeile für RC-Hinweis etc.
          // footer: "Reverse-Charge: Steuerschuldnerschaft des Leistungsempfängers.",
          // metadata: { product: "AIBE", plan },
        },
      },

      // -> Nach Abschluss zurück zur Thank-You-Seite
      return_url: `${thankYouUrl || "https://ai-business-engine.com/thank-you"}?plan=${encodeURIComponent(plan)}&total=${totalMap[plan]}&session_id={CHECKOUT_SESSION_ID}`,
    });

    return res.status(200).json({ client_secret: session.client_secret });
  } catch (e) {
    console.error("session error", e);
    return res.status(500).json({ error: e.message || "session_error" });
  }
}

async function readJson(req) {
  const chunks = [];
  for await (const x of req) chunks.push(x);
  const raw = Buffer.concat(chunks).toString("utf8") || "{}";
  return JSON.parse(raw);
}
