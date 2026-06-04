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
// Deliberate asymmetry (the "judgment over conversion" principle):
//   - Emergencies and billing/lien disputes NEVER fire createLead, SMS, or CRM.
//   - Security and account issues route to humans, not to a sales callback.
//   - Only genuine, reachable lead intents create leads, text, and CRM records.

import { isValidTag, DEFAULT_FALLBACK_TAG } from "./routing.js";

const WORKER_BASE = "https://christine-proxy.prods-balustre-0h.workers.dev";
const SMS_ENDPOINT = `${WORKER_BASE}/sms`;
const HUBSPOT_ENDPOINT = `${WORKER_BASE}/hubspot`;

// Tags that represent genuine leads -> SMS confirmation + HubSpot contact.
const LEAD_TAGS = new Set(["RES_HOT", "RES_WARM", "VEHICLE", "BUSINESS"]);

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
    const err = { tool: "send_sms_confirmation", source: "twilio_mock", status: "error", error: `SMS request failed: ${String(e)}` };
    console.warn("[AGENT]", err);
    return err;
  }
}

// Real integration: HubSpot CRM lead via the Worker.
async function createHubspotLead(ctx = {}, tag) {
  try {
    const res = await fetch(HUBSPOT_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contact_name: ctx.contact_name,
        contact_phone: ctx.contact_phone,
        contact_email: ctx.contact_email,
        facility_name: ctx.facility_name,
        routing_tag: tag
      })
    });
    const result = await res.json();
    console.log("[AGENT] hubspot.create_lead", result);
    return { tool: "hubspot.create_lead", ...result };
  } catch (e) {
    const err = { tool: "hubspot.create_lead", source: "hubspot", status: "error", error: `HubSpot request failed: ${String(e)}` };
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

  const fired = ROUTING_ACTIONS[resolvedTag](ctx);

  // Lead tags fire real integrations — but only for a QUALIFIED lead, i.e. one
  // that includes at least one piece of contact info (phone or email). A lead
  // with only a name is not actionable and would clutter the CRM, so we skip it
  // and log the decision for visibility / dogfooding.
  if (LEAD_TAGS.has(resolvedTag)) {
    const hasContact = Boolean(ctx.contact_phone || ctx.contact_email);

    if (hasContact) {
      const [smsResult, hsResult] = await Promise.all([
        ctx.contact_phone ? sendSmsConfirmation(ctx) : Promise.resolve(null),
        createHubspotLead(ctx, resolvedTag)
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
