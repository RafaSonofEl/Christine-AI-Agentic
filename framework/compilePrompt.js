// Framework: self-storage-regional-operator
// Runtime prompt compiler. Fills every {{UPPER_SNAKE}} token in the template
// from the operator instance (config) and the framework renderers (routing,
// promotions). No build step: this runs at agent init.
//
// This is the seam that makes one template serve many operators. To onboard a
// new operator in this vertical, you change config/, never this file.

import { PROMPT_TEMPLATE } from "./prompt.template.js";
import { renderLeadTagsForPrompt } from "./routing.js";
import { operatorConfig } from "../config/operator.config.js";
import { renderPromotionsForPrompt } from "../config/promotions.js";

// ---- Small render helpers (config -> prompt-ready text) -----------------

function bullets(arr) {
  return (arr || []).map((item) => `- ${item}`).join("\n");
}

function renderKbDefaults(defaults) {
  const d = defaults;
  return [
    `Support: ${d.support}`,
    `Gate access: ${d.gateAccess}`,
    `Office hours: ${d.officeHours}`,
    "",
    "Security:",
    bullets(d.security),
    "",
    "Rental flow:",
    bullets(d.rentalFlow),
    "",
    "Move-in process:",
    bullets(d.moveIn),
    "",
    "Required to rent:",
    bullets(d.requirementsToRent),
    "",
    "Payments:",
    bullets(d.payments),
    "",
    "Move-out:",
    bullets(d.moveOut)
  ].join("\n");
}

// ---- Token map -----------------------------------------------------------
// One place that maps every template token to its rendered value. If the
// template gains a token, it must be added here, and vice versa.

function buildTokenMap(now = new Date()) {
  const c = operatorConfig;
  const k = c.knowledge;

  return {
    AGENT_NAME: c.agent.name,
    OPERATOR_NAME: c.operator.name,

    VOICE_STYLE: c.brand.voice.style,
    VOICE_PRINCIPLES: bullets(c.brand.voice.principles),
    VOICE_AVOID: bullets(c.brand.voice.avoid),

    STATES_SERVED: k.statesServed.join(", "),
    METROS_SERVED: k.metrosServed.join(", "),

    KB_DEFAULTS: renderKbDefaults(k.defaults),
    KB_EXCEPTIONS: bullets(k.exceptions),
    KB_NOT_OFFERED: bullets(k.notOfferedOrUnknown),
    PROHIBITED_ITEMS: bullets(k.prohibitedItems),

    ACTIVE_PROMOS: renderPromotionsForPrompt(now),

    QUALIFICATION_FIELDS: bullets(c.qualification.fields),
    QUALIFICATION_RULES: bullets(c.qualification.rules),

    ROUTING_TAGS: renderLeadTagsForPrompt(),

    SUPPORT_PHONE: c.operator.supportPhone,
    SUPPORT_EMAIL: c.operator.supportEmail
  };
}

// ---- The compiler --------------------------------------------------------

export function compilePrompt(now = new Date()) {
  const tokens = buildTokenMap(now);
  let out = PROMPT_TEMPLATE;

  // Replace every {{TOKEN}}. Global replace so a token may appear more than once.
  for (const [key, value] of Object.entries(tokens)) {
    out = out.split(`{{${key}}}`).join(value);
  }

  // Safety net: catch any unfilled token so a typo never silently ships to the model.
  const leftover = out.match(/\{\{[A-Z_]+\}\}/g);
  if (leftover) {
    throw new Error(
      `compilePrompt: unfilled tokens remain: ${[...new Set(leftover)].join(", ")}`
    );
  }

  return out;
}
