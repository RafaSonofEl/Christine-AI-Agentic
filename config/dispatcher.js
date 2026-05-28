// Framework: self-storage-regional-operator
// FROZEN action layer. Five simulated tools + runToolsForRouting(tag) switch.
// Tools console-log in the demo. In production each is a real integration
// (CRM create, callback scheduler, team alert, CRM log, escalation flag).
//
// Deliberate asymmetry (the "judgment over conversion" principle):
//   - Emergencies and billing/lien disputes NEVER fire createLead.
//   - Security and account issues route to humans, not to a sales callback.
//   - Only genuine lead intents create leads and schedule sales callbacks.

import { isValidTag, DEFAULT_FALLBACK_TAG } from "./routing.js";

// ---- The five simulated tools -------------------------------------------
// Each returns a small record so a caller (or a Team View UI) can show
// "Actions Taken" without re-deriving anything.

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

// ---- Per-tag tool combinations ------------------------------------------
// Each entry is a function returning the array of fired tool records, so the
// combination is explicit and testable per tag. Context (location, storage
// type, etc.) can be passed through for richer payloads.

const ROUTING_ACTIONS = {
  // LEAD TAGS — these create leads and may schedule sales callbacks.
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

  // ESCALATION TAGS — note the asymmetry. No createLead on emergency or billing.
  ESCALATE_EMERGENCY: (ctx) => [
    tools.flagEscalation({ type: "emergency", ...ctx }),
    tools.sendTeamAlert({ reason: "urgent, possible 911 situation" }),
    tools.scheduleCallback({ priority: "same-day" })
    // intentionally no createLead, no logToCRM sales note
  ],
  ESCALATE_SECURITY: (ctx) => [
    tools.flagEscalation({ type: "security", ...ctx }),
    tools.sendTeamAlert({ reason: "security: break-in/theft/lockout" }),
    tools.logToCRM({ note: "security event logged" })
    // no createLead — a break-in is not a sales opportunity
  ],
  ESCALATE_BILLING: (ctx) => [
    tools.flagEscalation({ type: "billing/lien", ...ctx }),
    tools.sendTeamAlert({ reason: "billing/legal, route to trained staff" })
    // no createLead — a lien dispute is not a lead
  ],
  ESCALATE_SCOPE: (ctx) => [
    tools.flagEscalation({ type: "out of scope", ...ctx }),
    tools.sendTeamAlert({ reason: "refer out / not offered" }),
    tools.logToCRM({ note: "scope mismatch" })
  ],
  ESCALATE_ACCOUNT: (ctx) => [
    tools.flagEscalation({ type: "account verification", ...ctx }),
    tools.sendTeamAlert({ reason: "needs identity/account verification" })
    // no createLead — existing customer account action, not a new lead
  ]
};

// ---- The dispatcher ------------------------------------------------------
// Validates the tag against routing.js, falls back conservatively if needed,
// fires the combination, and returns a record for the Team View / Activity Log.

export function runToolsForRouting(tag, ctx = {}) {
  let resolvedTag = tag;

  if (!resolvedTag || !isValidTag(resolvedTag)) {
    console.warn(
      `[DISPATCHER] missing or invalid tag "${tag}", falling back to ${DEFAULT_FALLBACK_TAG}`
    );
    resolvedTag = DEFAULT_FALLBACK_TAG;
  }

  const fired = ROUTING_ACTIONS[resolvedTag](ctx);

  return {
    tag: resolvedTag,
    fellBack: resolvedTag !== tag,
    actions: fired
  };
}
