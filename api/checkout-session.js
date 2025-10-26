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
  if (req.method !== "POST") return res.status(405).end("Method Not Allowed");

  // --- Stripe init ---
  const stripeSecret = process.env.STRIPE_SECRET_KEY;
  if (!stripeSecret) return res.status(500).json({ error: "Missing STRIPE_SECRET_KEY" });
  const stripe = (await import("stripe")).default(stripeSecret, { apiVersion: "2020-08-27" });

  try {
    // Eingaben lesen (Company-Felder sind optional!)
    const body = await readJson(req);
    const plan        = (body.plan || "one_time").trim();
    const thankYouUrl = (body.thankYouUrl || "https://ai-business-engine.com/thank-you").trim();

    // Optional vorbelegte Unternehmensfelder (nur wenn du sie VOR dem Checkout im eigenen Formular abfragst)
    const companyName = trimOrNull(body.companyName);
    const taxNumber   = trimOrNull(body.taxNumber);

    // Price Mapping
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

    // -------------------------------------------------------------
    // (A) Optional: Customer anlegen, WENN Company-Felder vorhanden
    // -------------------------------------------------------------
    let customerId = null;
    if (companyName || taxNumber) {
      const customFields = [
        ...(companyName ? [{ name: "Company", value: companyName }] : []),
        ...(taxNumber   ? [{ name: "Tax ID", value: taxNumber }]   : []),
      ];
      const customer = await stripe.customers.create({
        // bewusst KEINE Email/Name → vermeidet "Invalid email address" & SOP-Fehler
        invoice_settings: { custom_fields: customFields },
        // optional: für spätere Fallbacks
        metadata: {
          company_name_from_prefill: companyName || "",
          company_tax_number_from_prefill: taxNumber || ""
        }
      });
      customerId = customer.id;
    }

    // -------------------------------------------------------------
    // (B) Checkout-Session aufsetzen (Embedded) – SOP-konform
    // -------------------------------------------------------------
    const sessionParams = {
      ui_mode: "embedded",
      mode,
      line_items: [{ price, quantity: 1 }],
      return_url: `${thankYouUrl}?plan=${encodeURIComponent(plan)}&total=${totals[plan] || ""}&session_id={CHECKOUT_SESSION_ID}`,
      billing_address_collection: "required",
      tax_id_collection: { enabled: false },
      phone_number_collection: { enabled: false },

      // Diese Custom Fields bleiben im UI bestehen (kein Konflikt).
      // Sie sind nicht notwendig für Option A, aber schaden nicht.
      custom_fields: [
        { key: "company_name",       label: { type:"custom", custom:"Firmenname (optional)" },        type:"text", optional:true },
        { key: "company_tax_number", label: { type:"custom", custom:"Steuernummer / VAT (optional)" }, type:"text", optional:true },
      ],
    };

    // Hardening: niemals dieses Feld setzen (SOP §3.1)
    delete sessionParams.customer_email;

    // Nur setzen, wenn wir VORHER einen Customer mit Defaults erstellt haben!
    if (customerId) sessionParams.customer = customerId;

    if (mode === "payment") {
      sessionParams.invoice_creation = {
        enabled: true,
        invoice_data: {
          // KEIN auto_advance → nicht dokumentiert in Sessions-invoice_data
          footer: "Reverse Charge – Die Steuerschuldnerschaft liegt beim Leistungsempfänger.",
          metadata: { plan },
        },
      };
      sessionParams.payment_intent_data = { metadata: { plan } };
    } else {
      sessionParams.subscription_data = { metadata: { plan } };
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    return res.status(200).json({ client_secret: session.client_secret, ver: "optA-customer-defaults" });
  } catch (e) {
    console.error("[session] error", e);
    return res.status(500).json({ error: e.message || "session_error" });
  }
}

function trimOrNull(v) {
  const s = (v ?? "").toString().trim();
  return s.length ? s : null;
}
async function readJson(req) {
  const chunks = [];
  for await (const x of req) chunks.push(x);
  const raw = Buffer.concat(chunks).toString("utf8") || "{}";
  return JSON.parse(raw);
}
