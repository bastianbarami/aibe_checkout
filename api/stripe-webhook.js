// api/stripe-webhook.js
import { buffer } from "micro";

// WICHTIG für Vercel Edge/Node:
export const runtime = 'nodejs';
export const config = {
  api: { bodyParser: false }, // raw body für Stripe-Signatur
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).end("Method Not Allowed");
  }

  const stripeSecret = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripeSecret || !webhookSecret) {
    console.error("[WH] missing env STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET");
    return res.status(500).json({ error: "missing_env" });
  }

  const stripe = (await import("stripe")).default(stripeSecret);

  let event;
  try {
    const raw = await buffer(req);
    const sig = req.headers["stripe-signature"];
    event = stripe.webhooks.constructEvent(raw, sig, webhookSecret);
  } catch (err) {
    console.error("[WH] signature error:", err?.message);
    return res.status(400).json({ error: "invalid_signature" });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = await stripe.checkout.sessions.retrieve(event.data.object.id, {
          expand: ["customer", "invoice", "subscription.latest_invoice"],
        });

        // 1) Daten aus Custom Fields ziehen
        const { companyName, taxNumber } = readCompanyAndVatFromSession(session);

        // 2) Kunde anreichern (metadata + invoice_settings für künftige Rechnungen)
        if (session.customer) {
          await upsertCustomerInvoiceDefaults(stripe, session.customer, { companyName, taxNumber });
        }

        // 3) Bestehende Rechnung (falls vorhanden & noch nicht final) sofort anreichern
        const candidateInvoiceId =
          session?.invoice?.id ??
          session?.subscription?.latest_invoice ??
          null;

        if (candidateInvoiceId) {
          await ensureInvoiceHasCompanyAndVat(stripe, candidateInvoiceId, {
            companyName,
            taxNumber,
          });
        }
        break;
      }

      case "invoice.created": {
        const inv = event.data.object;

        // Nur reagieren, wenn noch bearbeitbar
        if (inv.status === "draft" || inv.status === "open") {
          // Werte bevorzugt vom Customer nehmen (falls Session-Rennen schon vorbei)
          let companyName = null;
          let taxNumber = null;

          if (inv.customer) {
            const customer = await stripe.customers.retrieve(inv.customer);
            if (customer?.metadata?.company_name) companyName = customer.metadata.company_name;
            if (customer?.metadata?.tax_number) taxNumber = customer.metadata.tax_number;

            // Falls im Customer bereits invoice_settings.custom_fields gepflegt sind,
            // müssen wir nur noch customer_name für die Anzeige setzen.
            const hasInvoiceCustomFields = Array.isArray(customer?.invoice_settings?.custom_fields)
              ? customer.invoice_settings.custom_fields.length > 0
              : false;

            await ensureInvoiceHasCompanyAndVat(
              stripe,
              inv.id,
              { companyName, taxNumber },
              { skipCustomFieldsIfAlreadyOnCustomer: hasInvoiceCustomFields }
            );
          }
        }
        break;
      }

      // Optional: Nur Logging – keine mutierenden Operationen nach Finalisierung.
      case "invoice.finalized": {
        // Prüfen & loggen, ob Felder drauf sind – andernfalls nur warnen.
        const inv = event.data.object;
        if (!hasCustomFields(inv)) {
          console.warn("[WH] invoice.finalized without custom_fields; id=", inv.id);
        }
        if (!inv.customer_name) {
          console.warn("[WH] invoice.finalized without customer_name; id=", inv.id);
        }
        break;
      }

      default:
        // bewusst ignorieren
        break;
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    // Robust: niemals Stack nach außen geben, aber intern loggen
    console.error("[WH] handler error:", err);
    return res.status(200).json({ received: true }); // 200 zurück, damit Stripe nicht retry-stürmt
  }
}

/* ---------------------- Hilfsfunktionen ---------------------- */

function readCompanyAndVatFromSession(session) {
  let companyName = null;
  let taxNumber = null;

  const list = Array.isArray(session?.custom_fields) ? session.custom_fields : [];
  for (const f of list) {
    try {
      const k = (f?.key || "").toLowerCase();
      const v = f?.text?.value?.trim?.() ?? "";
      if (!v) continue;
      if (k === "company_name" || k === "company" || k === "firmenname") companyName = v;
      if (k === "tax_number" || k === "vat" || k === "steuernummer") taxNumber = v;
    } catch {}
  }
  return { companyName, taxNumber };
}

async function upsertCustomerInvoiceDefaults(stripe, customerObj, { companyName, taxNumber }) {
  const customerId = typeof customerObj === "string" ? customerObj : customerObj.id;

  // Hole aktuellen Zustand, um idempotent zu mergen
  const customer = await stripe.customers.retrieve(customerId);

  const metadata = { ...(customer.metadata || {}) };
  if (companyName) metadata.company_name = companyName;
  if (taxNumber) metadata.tax_number = taxNumber;

  // invoice_settings.custom_fields immer gepflegt – so erben ALLE künftigen Rechnungen die Infos
  const customFields = Array.isArray(customer?.invoice_settings?.custom_fields)
    ? [...customer.invoice_settings.custom_fields]
    : [];

  const upsert = (name, value) => {
    if (!value) return;
    const i = customFields.findIndex((x) => x?.name === name);
    if (i >= 0) customFields[i] = { name, value };
    else customFields.push({ name, value });
  };

  upsert("Company", companyName || "");
  upsert("VAT", taxNumber || "");

  await stripe.customers.update(customerId, {
    metadata,
    invoice_settings: { custom_fields: customFields },
  });
}

async function ensureInvoiceHasCompanyAndVat(
  stripe,
  invoiceId,
  { companyName, taxNumber },
  opts = {}
) {
  const { skipCustomFieldsIfAlreadyOnCustomer = false } = opts;
  const inv = await stripe.invoices.retrieve(invoiceId);

  // Nach Finalisierung nichts mehr mutieren
  if (inv.status === "paid" || inv.status === "void" || inv.status === "uncollectible" || inv.finalized_at) {
    return;
  }

  const patches = {};

  // a) „Bill to“: Firmenname in customer_name setzen, falls vorhanden und noch nicht gesetzt
  if (companyName && !inv.customer_name) {
    patches.customer_name = companyName;
  }

  // b) Kopfzeilen-Felder (Custom Fields) auf der Rechnung
  if (!skipCustomFieldsIfAlreadyOnCustomer) {
    const current = Array.isArray(inv.custom_fields) ? [...inv.custom_fields] : [];
    const upsert = (name, value) => {
      if (!value) return;
      const i = current.findIndex((x) => x?.name === name);
      if (i >= 0) current[i] = { name, value };
      else current.push({ name, value });
    };

    if (companyName) upsert("Company", companyName);
    if (taxNumber) upsert("VAT", taxNumber);

    patches.custom_fields = current;
  }

  // Nur updaten, wenn es etwas zu setzen gibt
  if (Object.keys(patches).length > 0) {
    await stripe.invoices.update(invoiceId, patches);
  }
}

function hasCustomFields(inv) {
  return Array.isArray(inv?.custom_fields) && inv.custom_fields.length > 0;
}
