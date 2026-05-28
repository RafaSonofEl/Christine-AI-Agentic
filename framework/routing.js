// Framework: self-storage-regional-operator
// FROZEN taxonomy. Ten tags: five lead, five escalation.
// This file owns: tag definitions, the prompt render for {{ROUTING_TAGS}},
// tag extraction from model output, and validation.
// It does NOT execute tools. Tool dispatch lives in dispatcher.js.

export const LEAD_TAGS = {
  RES_HOT: {
    kind: "lead",
    label: "Ready to reserve",
    description:
      "Ready to reserve now or has a near-immediate need. Has or nearly has location, size, and a move-in date."
  },
  RES_WARM: {
    kind: "lead",
    label: "Actively comparing",
    description:
      "Engaged and comparing options with a near-term move-in, but not ready to commit this moment."
  },
  RES_COLD: {
    kind: "lead",
    label: "Early research",
    description: "Early research, no move-in date, gathering information only."
  },
  VEHICLE: {
    kind: "lead",
    label: "Vehicle / RV / boat",
    description:
      "Inquiry centered on vehicle, RV, trailer, camper, or boat storage. Distinct inventory and rules; confirm the location supports it."
  },
  BUSINESS: {
    kind: "lead",
    label: "Business / commercial",
    description:
      "Business, commercial, warehouse, or office-space inquiry. Longer consideration cycle; may need human follow-up."
  }
};

export const ESCALATION_TAGS = {
  ESCALATE_EMERGENCY: {
    kind: "escalation",
    label: "Emergency",
    description:
      "Fire, flood, injury, someone trapped, or immediate danger. Direct to 911 first if there is immediate danger."
  },
  ESCALATE_SECURITY: {
    kind: "escalation",
    label: "Security",
    description: "Break-in, theft, suspected trespass, or lockout. Do not request sensitive details."
  },
  ESCALATE_BILLING: {
    kind: "escalation",
    label: "Billing / lien",
    description:
      "Billing dispute, lien, delinquency, or auction. Do not advise on the process; route to a human."
  },
  ESCALATE_SCOPE: {
    kind: "escalation",
    label: "Out of scope",
    description:
      "Requests for services not offered (pods, full-service moving, document shredding, mailboxes, etc.)."
  },
  ESCALATE_ACCOUNT: {
    kind: "escalation",
    label: "Account verification",
    description:
      "Anything requiring identity or account access: gate code, lease changes, move-out finalization."
  }
};

export const ALL_TAGS = { ...LEAD_TAGS, ...ESCALATION_TAGS };

// Ordered list used for prompt rendering and as the validation source of truth.
export const TAG_ORDER = [
  "RES_HOT",
  "RES_WARM",
  "RES_COLD",
  "VEHICLE",
  "BUSINESS",
  "ESCALATE_EMERGENCY",
  "ESCALATE_SECURITY",
  "ESCALATE_BILLING",
  "ESCALATE_SCOPE",
  "ESCALATE_ACCOUNT"
];

// Renders ONLY the lead tags for the {{ROUTING_TAGS}} prompt slot.
// Escalation tags are written inline in Section 6 of the template, because
// their triggers are framework judgment, not operator config.
export function renderLeadTagsForPrompt() {
  return Object.entries(LEAD_TAGS)
    .map(([tag, def]) => `- ${tag}: ${def.description}`)
    .join("\n");
}

// Optional full render (lead + escalation) for documentation or a team view.
export function renderAllTagsForPrompt() {
  return TAG_ORDER.map((tag) => `- ${tag}: ${ALL_TAGS[tag].description}`).join("\n");
}

// Validation: is this a known tag?
export function isValidTag(tag) {
  return Object.prototype.hasOwnProperty.call(ALL_TAGS, tag);
}

// Builds the regex from TAG_ORDER so the taxonomy stays the single source of truth.
// (No hand-maintained alternation list that can drift from the tag set.)
const TAG_PATTERN = new RegExp(
  `\\[ROUTING:\\s*(${TAG_ORDER.join("|")})\\s*\\]`,
  "i"
);

// Extracts the routing tag from a raw model response.
// Returns { tag, clean } where `clean` is the customer-facing text with the
// tag (and any stray routing tags) stripped. If no valid tag is found,
// tag is null and a safe default can be chosen by the caller.
export function extractRouting(rawText) {
  const match = rawText.match(TAG_PATTERN);
  const tag = match ? match[1].toUpperCase() : null;

  const clean = rawText
    .replace(/\[ROUTING:\s*[A-Z_]+\s*\]/gi, "")
    .trim();

  return { tag, clean };
}

// Safety net: if the model emits no tag or an invalid one, the caller should
// fall back to the most conservative lead tag rather than guessing high intent.
export const DEFAULT_FALLBACK_TAG = "RES_COLD";
