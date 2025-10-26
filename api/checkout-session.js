// api/checkout-session.js
export default async function handler(req, res) {
  try {
    // --- CORS (robust + garantiert JSON) ---
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
    if (req.method !== "POST")  return res.status(405).json({ error: "Method Not Allowed" });

    // --- Stripe init ---
    const stripeSecret = process.env.STRIPE_SECRET_KEY;
    if (!stripeSecret) return res.status(500).json({ error: "Missing STRIPE_SECRET_KEY" });
    const stripe = (await import("stripe")).default(stripeSecret, { apiVersion: "2020-08-27" });

    // --- Body lesen ---
    const body = await readJson(req);
    const plan           = (body.plan || "one_time").trim();
    const thankYouUrl    = (body.thankYouUrl || "https://ai-business-engine.com/thank-you").trim();
    const companyName    = trimOrNull(body.companyName);
    const taxNumber      = trimOrNull(body.taxNumber);
    const promotionCode  = trimOrNull(body.promotionCode); // z. B. "AIBE-100TEST"

    // --- Prices ---
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

    // --- Optional: Customer mit Invoice-Defaults (nur wenn Company-Felder da sind)
    let customerId = null;
    if (companyName || taxNumber) {
      const customFields = [
        ...(companyName ? [{ name: "Company", value: companyName }] : []),
        ...(taxNumber   ? [{ name: "Tax ID",  value: taxNumber   }] : []),
      ];
      const customer = await stripe.customers.create({
        invoice_settings: { custom_fields: customFields },
        metadata: {
          company_name_from_prefill: companyName || "",
          company_tax_number_from_prefill: taxNumber || ""
        }
      });
      customerId = customer.id;
    }

    // --- Session Params (KEINE automatische Rechnungserstellung) ---
    const sessionParams = {
      ui_mode: "embedded",
      mode,
      line_items: [{ price, quantity: 1 }],
      return_url: `${thankYouUrl}?plan=${encodeURIComponent(plan)}&total=${totals[plan] || ""}&session_id={CHECKOUT_SESSION_ID}`,
      billing_address_collection: "required",
      tax_id_collection: { enabled: false },
      phone_number_collection: { enabled: false },
      allow_promotion_codes: true, // Eingabefeld für Promo-Codes im Checkout anzeigen
      custom_fields: [
        { key: "company_name",       label: { type:"custom", custom:"Firmenname (optional)" },        type:"text", optional:true },
        { key: "company_tax_number", label: { type:"custom", custom:"Steuernummer / VAT (optional)" }, type:"text", optional:true },
      ],
    };

    // Guards (SOP)
    delete sessionParams.customer_email; // niemals senden
    if (customerId) sessionParams.customer = customerId; // optional – erzeugt KEINE Rechnung

    // One-time vs. Subscription – nur Metadaten, KEINE invoice_creation
    if (mode === "payment") {
  sessionParams.payment_intent_data = { metadata: { plan } };
} else {
  sessionParams.subscription_data = { metadata: { plan } };
}

    // --- Optional: Promotion Code automatisch anwenden (wenn übergeben) ---
    if (promotionCode) {
      // Achtung: Stripe erwartet die promotion_code-ID, wir suchen sie per Code-Text
      const pcs = await stripe.promotionCodes.list({ code: promotionCode, active: true, limit: 1 });
      const pc = pcs.data?.[0];
      if (pc?.id) {
        sessionParams.discounts = [{ promotion_code: pc.id }];
      }
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    return res.status(200).json({ client_secret: session.client_secret, ver: "live-100pct-coupon-ready" });
  } catch (e) {
    console.error("[session] error", e);
    const msg = e?.message || "session_error";
    return res.status(500).json({ error: msg, code: e?.type || null });
  }
}

// --- Helpers ---
function trimOrNull(v) { const s = (v ?? "").toString().trim(); return s.length ? s : null; }
async function readJson(req) {
  const chunks = [];
  for await (const x of req) chunks.push(x);
  const raw = Buffer.concat(chunks).toString("utf8") || "{}";
  return JSON.parse(raw);
}
