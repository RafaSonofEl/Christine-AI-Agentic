// Framework: self-storage-regional-operator
// Action layer. Five simulated tools + runToolsForRouting(tag) switch, plus two
// real integrations on QUALIFIED lead tags: a mock SMS confirmation and a
// HubSpot CRM lead — both routed through the Cloudflare Worker.
//
// Lead quality rule: a lead is only pushed to the CRM if it carries at least
// one piece of reachable contact info (phone OR email). A name-only "lead" is
// not actionable and is logged and skipped.
//
// The LLM is responsible for extracting contact_name from natural language and
// placing it in the <LEAD> block. We keep a light email/phone regex fallback
// here so the qualification check doesn't spuriously skip a lead when the LLM
// omits those from <LEAD> but they're clearly in the transcript.

import { isValidTag, DEFAULT_FALLBACK_TAG } from "./routing.js";

const WORKER_BASE = "https://christine-proxy.prods-balustre-0h.workers.dev";
const SMS_ENDPOINT = `${WORKER_BASE}/sms`;
const HUBSPOT_ENDPOINT = `${WORKER_BASE}/hubspot`;

const LEAD_TAGS = new Set(["RES_HOT", "RES_WARM", "VEHICLE", "BUSINESS"]);

// ---- Email/phone fallback (cheap, deterministic) -------------------------
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
const PHONE_RE = /(?:\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}\b/;

function collectText(ctx) {
  if (Array.isArray(ctx.transcript)) {
    return ctx.transcript
      .map((m) => (typeof m === "string" ? m : m?.content || m?.text || ""))
      .join("\n");
  }
  return [ctx.message, ctx.user_message, ctx.last_message]
    .filter(Boolean)
    .join("\n");
}

function splitName(fullName) {
  if (!fullName || typeof fullName !== "string") return { first: "", last: "" };
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: "", last: "" };
  if (parts.length === 1) return { first: parts[0], last: "" };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

function extractContactInfo(ctx = {}) {
  const out = { ...ctx };
  if (out.contact_email && out.contact_phone) return out;

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

async function createHubspotLead(ctx = {}, tag) {
  const { first, last } = splitName(ctx.contact_name);
  const payload = {
    contact_name: ctx.contact_name || null,
    contact_firstname: first || null,
    contact_lastname: last || null,
    contact_phone: ctx.contact_phone || null,
    contact_email: ctx.contact_email || null,
    facility_name: ctx.facility_name || null,
    routing_tag: tag
  };

  try {
    const res = await fetch(HUBSPOT_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const result = await res.json();
    console.log("[AGENT] hubspot.create_lead", {
      sent: { first, last, email: payload.contact_email },
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

  const enrichedCtx = extractContactInfo(ctx);

  const fired = ROUTING_ACTIONS[resolvedTag](enrichedCtx);

  if (LEAD_TAGS.has(resolvedTag)) {
    const hasContact = Boolean(enrichedCtx.contact_phone || enrichedCtx.contact_email);

    console.log("[DISPATCHER] lead branch", {
      tag: resolvedTag,
      hasName: Boolean(enrichedCtx.contact_name),
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
