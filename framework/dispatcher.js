// Framework: self-storage-regional-operator
// Action layer. Five simulated tools + runToolsForRouting(tag) switch, plus two
// real integrations on QUALIFIED lead tags: a mock SMS confirmation and a
// HubSpot CRM lead — both routed through the Cloudflare Worker (which holds all
// secrets).
//
// Lead quality rule: a lead is only pushed to the CRM if it carries at least
// one piece of reachable contact info (phone OR email). A name-only "lead" is
// not actionable and would clutter the pipeline, so it is logged and skipped.
//
// FIX (2026-06-04): contact info supplied in natural language (e.g.
// "my email is fred@gmail.com, name is fred") was not being parsed into
// ctx.contact_email / ctx.contact_phone, so qualified leads were wrongly
// skipped or sent to HubSpot with empty properties (→ 400). We now recover
// email/phone from the transcript before the qualification check.
//
// FIX (2026-08-11): same class of bug for names. ctx.contact_name was never
// recovered from natural language ("my name is fred"), so HubSpot contacts
// were being created with null firstname/lastname and the Name column in
// HubSpot fell back to displaying the raw email. We now (a) extract
// contact_name from the transcript alongside email/phone, (b) split it into
// contact_firstname / contact_lastname before sending to the Worker so the
// HubSpot proxy can map to HubSpot's real property shape, and (c) derive a
// best-effort name from the email local-part when no name is spoken, so the
// Name column never renders as the raw email again.

import { isValidTag, DEFAULT_FALLBACK_TAG } from "./routing.js";

const WORKER_BASE = "https://christine-proxy.prods-balustre-0h.workers.dev";
const SMS_ENDPOINT = `${WORKER_BASE}/sms`;
const HUBSPOT_ENDPOINT = `${WORKER_BASE}/hubspot`;

// Tags that represent genuine leads -> SMS confirmation + HubSpot contact.
const LEAD_TAGS = new Set(["RES_HOT", "RES_WARM", "VEHICLE", "BUSINESS"]);

// ---- Contact-info extraction --------------------------------------------
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
// US phone: optional +1, then 10 digits with common separators.
const PHONE_RE = /(?:\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}\b/;

// Name capture: match a leading phrase, then 1–4 capitalized/word tokens.
// Handles: "my name is X", "name: X", "name is X", "this is X",
// "I'm X", "I am X", "call me X". Case-insensitive on the phrase; the captured
// name is preserved as written and cleaned up afterwards.
const NAME_RES = [
  /\bmy\s+name\s+is\s+([A-Za-z][A-Za-z'’\-]*(?:\s+[A-Za-z][A-Za-z'’\-]*){0,3})/i,
  /\bname\s*(?:is|[:\-])\s*([A-Za-z][A-Za-z'’\-]*(?:\s+[A-Za-z][A-Za-z'’\-]*){0,3})/i,
  /\bthis\s+is\s+([A-Za-z][A-Za-z'’\-]*(?:\s+[A-Za-z][A-Za-z'’\-]*){0,3})/i,
  /\bi(?:'|’)?m\s+([A-Za-z][A-Za-z'’\-]*(?:\s+[A-Za-z][A-Za-z'’\-]*){0,3})/i,
  /\bi\s+am\s+([A-Za-z][A-Za-z'’\-]*(?:\s+[A-Za-z][A-Za-z'’\-]*){0,3})/i,
  /\bcall\s+me\s+([A-Za-z][A-Za-z'’\-]*(?:\s+[A-Za-z][A-Za-z'’\-]*){0,3})/i,
];

// Words that show up right after "I'm ..." but aren't names. Prevents
// "I'm looking for a unit" from being captured as name "looking".
const NAME_STOPWORDS = new Set([
  "a", "an", "the", "looking", "trying", "interested", "calling", "here",
  "asking", "wondering", "hoping", "needing", "just", "still", "not",
  "sorry", "good", "ok", "okay", "fine", "great", "really", "very",
  "in", "on", "at", "with", "for", "from", "about"
]);

function collectText(ctx) {
  // Prefer a structured transcript; fall back to single message fields.
  if (Array.isArray(ctx.transcript)) {
    return ctx.transcript
      .map((m) => (typeof m === "string" ? m : m?.content || m?.text || ""))
      .join("\n");
  }
  return [ctx.message, ctx.user_message, ctx.last_message]
    .filter(Boolean)
    .join("\n");
}

function cleanName(raw) {
  if (!raw) return "";
  // Strip trailing punctuation ("fred.", "Fred,") and collapse whitespace.
  const trimmed = raw.replace(/[.,;!?]+$/g, "").trim().replace(/\s+/g, " ");
  if (!trimmed) return "";
  // Reject if the first token is a stopword like "looking" or "just".
  const first = trimmed.split(" ")[0].toLowerCase();
  if (NAME_STOPWORDS.has(first)) return "";
  return trimmed;
}

function titleCase(s) {
  return s
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

// Best-effort last-resort: derive a display name from an email's local-part
// so HubSpot's Name column doesn't render as the raw email.
// Examples: "ada.lovelace@x.com" -> "Ada Lovelace"
//           "jimjam42@gmail.com"  -> "Jimjam42"
function deriveNameFromEmail(email) {
  if (!email || typeof email !== "string") return "";
  const local = email.split("@")[0] || "";
  // Drop plus-address suffix ("ada+promo" -> "ada").
  const base = local.split("+")[0];
  const spaced = base.replace(/[._\-]+/g, " ").trim();
  if (!spaced) return "";
  return titleCase(spaced);
}

function splitName(fullName) {
  if (!fullName || typeof fullName !== "string") return { first: "", last: "" };
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: "", last: "" };
  if (parts.length === 1) return { first: parts[0], last: "" };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

// Recovers name/email/phone from free text when structured fields are missing.
// Never overwrites a value that was already explicitly provided.
function extractContactInfo(ctx = {}) {
  const out = { ...ctx };
  const needsAny = !out.contact_email || !out.contact_phone || !out.contact_name;
  if (!needsAny) return out;

  const text = collectText(ctx);
  if (!text) return out;

  if (!out.contact_email) {
    const m = text.match(EMAIL_RE);
    if (m) out.contact_email = m[0].toLowerCase();
  }
  if (!out.contact_phone) {
    const m = text.match(PHONE_RE);
    if (m) out.contact_phone = m[0];
  }
  if (!out.contact_name) {
    for (const re of NAME_RES) {
      const m = text.match(re);
      const candidate = cleanName(m?.[1]);
      if (candidate) {
        out.contact_name = candidate;
        break;
      }
    }
  }

  // Last-resort derivation from the email so HubSpot's Name column is never
  // just the email. Marked as derived so reps/analytics can distinguish.
  if (!out.contact_name && out.contact_email) {
    const derived = deriveNameFromEmail(out.contact_email);
    if (derived) {
      out.contact_name = derived;
      out.contact_name_derived = true;
    }
  }

  return out;
}

// ---- The five simulated tools -------------------------------------------
export const tools = {
  createLead(payload = {}) {
    console.log("[AGENT] create_lead", payload);
    return { tool: "create_lead", payload };
  },
  scheduleCallback(payload = {}) {
    console.log("[AGENT] schedule_callback", payload);
    return { tool: "schedule_callback", payload };
  },
  sendTeamAlert(payload = {}) {
    console.log("[AGENT] send_team_alert", payload);
    return { tool: "send_team_alert", payload };
  },
  logToCRM(payload = {}) {
    console.log("[AGENT] log_to_crm", payload);
    return { tool: "log_to_crm", payload };
  },
  flagEscalation(payload = {}) {
    console.log("[AGENT] flag_escalation", payload);
    return { tool: "flag_escalation", payload };
  }
};

// Real integration: mock SMS confirmation via the Worker.
async function sendSmsConfirmation(ctx = {}) {
  try {
    const res = await fetch(SMS_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to_phone: ctx.contact_phone,
        contact_name: ctx.contact_name,
        facility_name: ctx.facility_name
      })
    });
    const result = await res.json();
    console.log("[AGENT] send_sms_confirmation", result);
    return { tool: "send_sms_confirmation", ...result };
  } catch (e) {
    const err = {
      tool: "send_sms_confirmation",
      source: "twilio_mock",
      status: "error",
      error: `SMS request failed: ${String(e)}`
    };
    console.warn("[AGENT]", err);
    return err;
  }
}

// Real integration: HubSpot CRM lead via the Worker.
// The Worker maps contact_firstname/contact_lastname onto HubSpot's actual
// `firstname` / `lastname` properties. contact_name is kept for back-compat.
async function createHubspotLead(ctx = {}, tag) {
  const { first, last } = splitName(ctx.contact_name);
  const payload = {
    contact_name: ctx.contact_name ?? null,
    contact_firstname: first || null,
    contact_lastname: last || null,
    contact_phone: ctx.contact_phone ?? null,
    contact_email: ctx.contact_email ?? null,
    facility_name: ctx.facility_name ?? null,
    routing_tag: tag,
    name_derived: Boolean(ctx.contact_name_derived) || undefined
  };

  try {
    const res = await fetch(HUBSPOT_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const result = await res.json();
    console.log("[AGENT] hubspot.create_lead", {
      sent: { first, last, email: payload.contact_email, derived: payload.name_derived === true },
      result
    });
    return { tool: "hubspot.create_lead", ...result };
  } catch (e) {
    const err = {
      tool: "hubspot.create_lead",
      source: "hubspot",
      status: "error",
      error: `HubSpot request failed: ${String(e)}`
    };
    console.warn("[AGENT]", err);
    return err;
  }
}

// ---- Per-tag tool combinations ------------------------------------------
const ROUTING_ACTIONS = {
  RES_HOT: (ctx) => [
    tools.createLead({ tag: "RES_HOT", ...ctx }),
    tools.scheduleCallback({ priority: "high" }),
    tools.logToCRM({ note: "ready to reserve" })
  ],
  RES_WARM: (ctx) => [
    tools.createLead({ tag: "RES_WARM", ...ctx }),
    tools.logToCRM({ note: "nurture" })
  ],
  RES_COLD: (ctx) => [
    tools.logToCRM({ note: "early research", ...ctx })
  ],
  VEHICLE: (ctx) => [
    tools.createLead({ tag: "VEHICLE", ...ctx }),
    tools.scheduleCallback({ priority: "availability" }),
    tools.logToCRM({ note: "vehicle/RV/boat" })
  ],
  BUSINESS: (ctx) => [
    tools.createLead({ tag: "BUSINESS", ...ctx }),
    tools.sendTeamAlert({ reason: "commercial inquiry" }),
    tools.logToCRM({ note: "business/commercial" })
  ],

  ESCALATE_EMERGENCY: (ctx) => [
    tools.flagEscalation({ type: "emergency", ...ctx }),
    tools.sendTeamAlert({ reason: "urgent, possible 911 situation" }),
    tools.scheduleCallback({ priority: "same-day" })
  ],
  ESCALATE_SECURITY: (ctx) => [
    tools.flagEscalation({ type: "security", ...ctx }),
    tools.sendTeamAlert({ reason: "security: break-in/theft/lockout" }),
    tools.logToCRM({ note: "security event logged" })
  ],
  ESCALATE_BILLING: (ctx) => [
    tools.flagEscalation({ type: "billing/lien", ...ctx }),
    tools.sendTeamAlert({ reason: "billing/legal, route to trained staff" })
  ],
  ESCALATE_SCOPE: (ctx) => [
    tools.flagEscalation({ type: "out of scope", ...ctx }),
    tools.sendTeamAlert({ reason: "refer out / not offered" }),
    tools.logToCRM({ note: "scope mismatch" })
  ],
  ESCALATE_ACCOUNT: (ctx) => [
    tools.flagEscalation({ type: "account verification", ...ctx }),
    tools.sendTeamAlert({ reason: "needs identity/account verification" })
  ]
};

// ---- The dispatcher ------------------------------------------------------
export async function runToolsForRouting(tag, ctx = {}) {
  let resolvedTag = tag;

  if (!resolvedTag || !isValidTag(resolvedTag)) {
    console.warn(
      `[DISPATCHER] missing or invalid tag "${tag}", falling back to ${DEFAULT_FALLBACK_TAG}`
    );
    resolvedTag = DEFAULT_FALLBACK_TAG;
  }

  // Recover name/email/phone from the transcript BEFORE qualification, so a
  // lead that supplied contact info in natural language is not skipped and
  // is not sent to HubSpot with a null name.
  const enrichedCtx = extractContactInfo(ctx);

  const fired = ROUTING_ACTIONS[resolvedTag](enrichedCtx);

  // Lead tags fire real integrations — but only for a QUALIFIED lead, i.e. one
  // that includes at least one piece of contact info (phone or email).
  if (LEAD_TAGS.has(resolvedTag)) {
    const hasContact = Boolean(enrichedCtx.contact_phone || enrichedCtx.contact_email);

    console.log("[DISPATCHER] lead branch", {
      tag: resolvedTag,
      hasName: Boolean(enrichedCtx.contact_name),
      nameDerived: Boolean(enrichedCtx.contact_name_derived),
      hasEmail: Boolean(enrichedCtx.contact_email),
      hasPhone: Boolean(enrichedCtx.contact_phone)
    });

    if (hasContact) {
      const [smsResult, hsResult] = await Promise.all([
        enrichedCtx.contact_phone ? sendSmsConfirmation(enrichedCtx) : Promise.resolve(null),
        createHubspotLead(enrichedCtx, resolvedTag)
      ]);
      if (smsResult) fired.push(smsResult);
      fired.push(hsResult);
    } else {
      const skipped = {
        tool: "lead_skipped",
        reason: "no contact info (phone/email) captured",
        tag: resolvedTag
      };
      console.warn("[AGENT]", skipped);
      fired.push(skipped);
    }
  }

  return {
    tag: resolvedTag,
    fellBack: resolvedTag !== tag,
    actions: fired
  };
}
