// api/checkout-session.js
export default async function handler(req, res) {
  // --- CORS (Domains, nicht einzelne Unterseiten nötig) ---
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

  // --- Stripe initialisieren (fixe API-Version!) ---
  const stripeSecret = process.env.STRIPE_SECRET_KEY;
  if (!stripeSecret) return res.status(500).json({ error: "Missing STRIPE_SECRET_KEY" });

  const { default: Stripe } = await import("stripe");
  const stripe = new Stripe(stripeSecret, { apiVersion: "2024-06-20" });

  try {
    // --- Request-Body lesen ---
    const { plan = "one_time", email = "", name = "", phone = "", thankYouUrl } = await readJson(req);

    // --- Price-IDs aus Env ---
    const PRICE_ONE_TIME = process.env.PRICE_ONE_TIME;
    const PRICE_SPLIT_2  = process.env.PRICE_SPLIT_2;
    const PRICE_SPLIT_3  = process.env.PRICE_SPLIT_3;

    // --- Mapping: Frontend-Keys -> Stripe Prices ---
    const priceMap = {
      one_time:      PRICE_ONE_TIME,
      split_2:       PRICE_SPLIT_2,
      split_3:       PRICE_SPLIT_3,
      aibe_pif:      PRICE_ONE_TIME,
      aibe_split_2:  PRICE_SPLIT_2,
      aibe_split_3:  PRICE_SPLIT_3,
    };

    // --- Totals für Return-URL (auch für aibe_* befüllen) ---
    const totalMap = {
      one_time:      499,
      split_2:       515,
      split_3:       525,
      aibe_pif:      499,
      aibe_split_2:  515,
      aibe_split_3:  525,
    };

    const price = priceMap[plan];
    if (!price) return res.status(400).json({ error: "Unknown plan" });

    // --- Modus bestimmen (payment vs subscription) ---
    const subscriptionPlans = new Set(["split_2", "aibe_split_2", "split_3", "aibe_split_3"]);
    const mode = subscriptionPlans.has(plan) ? "subscription" : "payment";

    // --- Optional: Customer für Prefill/Phone ---
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
        const created = await stripe.customers.create({ email, name, phone });
        customerId = created.id;
      }
    }

    // --- Gemeinsame Checkout-Optionen ---
    const baseSession = {
      ui_mode: "embedded",
      mode,
      customer: customerId || undefined,
      customer_email: customerId ? undefined : (email || undefined),
      line_items: [{ price, quantity: 1 }],

      // 🧾 Rechnungs-/Steuerdaten + optionale Felder (Company / USt-ID)
      billing_address_collection: "required",
      invoice_creation: { enabled: true },
      automatic_tax: { enabled: true },
      tax_id_collection: { enabled: true },
      custom_fields: [
        {
          key: "company_name",
          label: { type: "custom", custom: "Firmenname (optional)" },
          type: "text",
          optional: true
        },
        {
          key: "vat_number",
          label: { type: "custom", custom: "Umsatzsteuer-ID (optional)" },
          type: "text",
          optional: true
        }
      ],

      // Zurück zur Thanks-Page
      return_url: `${thankYouUrl || "https://ai-business-engine.com/thank-you"}?plan=${encodeURIComponent(plan)}&total=${totalMap[plan]}&session_id={CHECKOUT_SESSION_ID}`
    };

    // --- Receipts sicherstellen ---
    // Für Einmalzahlung: PaymentIntent-Receipt-Mail explizit setzen.
    // Für Subscription: Receipt kommt über Billing-Einstellungen (Settings → Emails/Billing)
    if (mode === "payment") {
      baseSession.payment_intent_data = {
        // E-Mail für die Quittung explizit setzen
        receipt_email: email || undefined,
        metadata: {
          first_name: name || "",
          phone: phone || "",
          plan: plan || ""
        }
      };
    } else {
      // Metadaten bei Subscriptions übergeben (optional)
      baseSession.subscription_data = {
        metadata: {
          first_name: name || "",
          phone: phone || "",
          plan: plan || ""
        }
      };
    }

    // --- Checkout Session erstellen (Embedded) ---
    const session = await stripe.checkout.sessions.create(baseSession);

    return res.status(200).json({ client_secret: session.client_secret });
  } catch (e) {
    console.error("session error", e);
    return res.status(500).json({ error: e.message || "session_error" });
  }
}

// --- Hilfsfunktion ---
async function readJson(req) {
  const chunks = [];
  for await (const x of req) chunks.push(x);
  const raw = Buffer.concat(chunks).toString("utf8") || "{}";
  return JSON.parse(raw);
}
