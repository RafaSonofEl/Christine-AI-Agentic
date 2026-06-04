// Framework: self-storage-regional-operator
// Action layer. Five simulated tools + runToolsForRouting(tag) switch, plus a
// real SMS confirmation (via the Cloudflare Worker /sms route) on lead tags.
//
// Deliberate asymmetry (the "judgment over conversion" principle):
//   - Emergencies and billing/lien disputes NEVER fire createLead or SMS.
//   - Security and account issues route to humans, not to a sales callback.
//   - Only genuine lead intents create leads, schedule callbacks, and text.

import { isValidTag, DEFAULT_FALLBACK_TAG } from "./routing.js";

const SMS_ENDPOINT = "https://christine-proxy.prods-balustre-0h.workers.dev/sms";

// Tags that should trigger a customer SMS confirmation.
const SMS_LEAD_TAGS = new Set(["RES_HOT", "RES_WARM", "VEHICLE", "BUSINESS"]);

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

// Real integration: SMS confirmation via the Worker (which holds Twilio secrets).
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
      source: "twilio",
      status: "error",
      error: `SMS request failed: ${String(e)}`
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
// Now async: lead tags additionally fire a real SMS confirmation through the
// Worker. The synchronous simulated tools run exactly as before.

export async function runToolsForRouting(tag, ctx = {}) {
  let resolvedTag = tag;

  if (!resolvedTag || !isValidTag(resolvedTag)) {
    console.warn(
      `[DISPATCHER] missing or invalid tag "${tag}", falling back to ${DEFAULT_FALLBACK_TAG}`
    );
    resolvedTag = DEFAULT_FALLBACK_TAG;
  }

  const fired = ROUTING_ACTIONS[resolvedTag](ctx);

  // Lead tags also send a real (or mock-fallback) SMS confirmation.
  if (SMS_LEAD_TAGS.has(resolvedTag) && ctx.contact_phone) {
    const smsResult = await sendSmsConfirmation(ctx);
    fired.push(smsResult);
  }

  return {
    tag: resolvedTag,
    fellBack: resolvedTag !== tag,
    actions: fired
  };
}
