// api/stripe-webhook.js
import { buffer } from "micro";

export const config = {
  api: {
    bodyParser: false, // raw body für Stripe-Signatur
  },
};
export const runtime = 'nodejs';

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end("Method Not Allowed");

  const stripeSecret = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripeSecret || !webhookSecret) {
    console.error("[WH] missing env");
    return res.status(500).json({ error: "missing_env" });
  }
  const stripe = (await import("stripe")).default(stripeSecret);

  let event;
  try {
    const sig = req.headers["stripe-signature"];
    const raw = await buffer(req);
    event = stripe.webhooks.constructEvent(raw, sig, webhookSecret);
  } catch (err) {
    console.error("[WH] signature error", err?.message);
    return res.status(400).json({ error: "sig_error" });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleSessionCompleted(stripe, event.data.object);
        break;

      case "invoice.created":
        await ensureInvoiceHasCompanyAndTax(stripe, event.data.object);
        break;

      case "invoice.finalized":
      case "invoice.payment_succeeded":
        await ensureInvoiceHasCompanyAndTax(stripe, event.data.object, { asLastResort: true });
        break;

      default:
        // ignore others
        break;
    }
    return res.json({ received: true });
  } catch (err) {
    console.error("[WH] handler error", err);
    return res.status(500).json({ error: "webhook_handler_error" });
  }
}

/**
 * 1) Direkt nach Checkout: Custom-Felder aus Session lesen,
 *    auf Customer-Metadaten schreiben; wenn es bereits eine Invoice gibt,
 *    auch auf Invoice.metadata setzen.
 */
async function handleSessionCompleted(stripe, session) {
  const customerId = session.customer;
  if (!customerId) return;

  // Custom fields (embedded checkout)
  const getField = (key) => {
    try {
      const f = (session.custom_fields || []).find(x => x.key === key);
      return f?.text?.value?.trim() || "";
    } catch { return ""; }
  };
  const company = getField("company_name");
  const taxno   = getField("company_tax_number");

  // Auf Customer-Metadaten persistieren (für nachgelagerte Events)
  const metaUpdates = {};
  if (company) metaUpdates.company_name = company;
  if (taxno)   metaUpdates.company_tax_number = taxno;
  if (Object.keys(metaUpdates).length) {
    await stripe.customers.update(customerId, { metadata: metaUpdates });
    // Optional: wenn Firma angegeben wurde, Customer.name ersetzen (damit steht sie im "Bill to")
    try {
      if (company) await stripe.customers.update(customerId, { name: company });
    } catch (e) {
      console.warn("[WH] set customer.name failed (non-blocking)", e?.message);
    }
  }

  // Falls für Einmalzahlung sofort eine Invoice an der Session hängt, gleich befüllen
  if (session.invoice) {
    try {
      await patchInvoiceWithCompanyAndTax(stripe, session.invoice, { company, taxno, customerId });
    } catch (e) {
      console.warn("[WH] patch session.invoice failed (will retry later)", e?.message);
    }
  }
}

/**
 * 2) Bei invoice.created / finalized / payment_succeeded:
 *    Falls Felder fehlen, aus Customer.metadata lesen und auf die Invoice schreiben.
 */
async function ensureInvoiceHasCompanyAndTax(stripe, invoiceObj, { asLastResort = false } = {}) {
  const invoiceId  = typeof invoiceObj === "string" ? invoiceObj : invoiceObj.id;
  const invoice    = typeof invoiceObj === "string" ? await stripe.invoices.retrieve(invoiceObj) : invoiceObj;
  const customerId = invoice.customer;

  // Prüfen ob schon gesetzt
  const meta = invoice.metadata || {};
  const hasCompany = !!meta.company_name;
  const hasTax     = !!meta.company_tax_number;

  if (hasCompany && hasTax) return; // alles gut

  // Aus Customer ziehen
  let company = meta.company_name || "";
  let taxno   = meta.company_tax_number || "";
  if (customerId && (!company || !taxno)) {
    const cust = await stripe.customers.retrieve(customerId);
    const cm   = cust.metadata || {};
    if (!company) company = cm.company_name || "";
    if (!taxno)   taxno   = cm.company_tax_number || "";
    // Optional: Firmenname in Customer.name spiegeln (für "Bill to")
    try {
      if (company && cust.name !== company) {
        await stripe.customers.update(customerId, { name: company });
      }
    } catch (e) {
      console.warn("[WH] late set customer.name failed", e?.message);
    }
  }

  // Nur wenn wir wirklich was haben, Invoice updaten
  if (company || taxno) {
    await patchInvoiceWithCompanyAndTax(stripe, invoiceId, { company, taxno, customerId });
  } else if (asLastResort) {
    // Letzte Eskalationsstufe: nichts zu tun – Felder kamen nie an
    console.warn("[WH] no company/tax found to set on invoice", invoiceId);
  }
}

/** Hilfsfunktion: schreibt die Felder sicher auf die Rechnung */
async function patchInvoiceWithCompanyAndTax(stripe, invoiceId, { company, taxno, customerId }) {
  const inv = await stripe.invoices.retrieve(invoiceId);

  // Bestehendes Metadata mergen
  const newMeta = { ...(inv.metadata || {}) };
  if (company) newMeta.company_name = company;
  if (taxno)   newMeta.company_tax_number = taxno;

  await stripe.invoices.update(invoiceId, { metadata: newMeta });
}
