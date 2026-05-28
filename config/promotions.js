// Framework rule (self-storage-regional-operator):
// Promotions are an operator-instance layer. The agent NEVER hardcodes a promo.
// It only sees what getActivePromotions() returns, injected into the prompt
// at runtime via the {{ACTIVE_PROMOS}} placeholder.
//
// To toggle a promo: flip `active`.
// To swap promos: edit this array. No prompt edits, no agent edits.
// To run none: leave the array empty or set all `active: false`. The agent
// will then make no promotional claims at all.
//
// Production path (named, not built): this array is replaced by a fetch from
// a promotions endpoint or a backend feature flag, so marketing can toggle
// without a redeploy.

const DATE_FMT = { year: "numeric", month: "short", day: "numeric" };

// A promo is considered live only if active === true AND today is within
// its optional start/end window. Null start or end means open-ended.
function isLive(promo, now = new Date()) {
  if (!promo.active) return false;
  if (promo.startDate && now < new Date(promo.startDate)) return false;
  if (promo.endDate && now > new Date(promo.endDate)) return false;
  return true;
}

export const promotions = [
  {
    id: "spring-into-storage-2026",
    active: true,
    headline: "Spring into Storage",
    offer: "One month free or 50% off rent on select units",
    // Qualification text is mandatory by framework rule. The agent must always
    // pair the offer with this so it never overpromises.
    terms: "Subject to availability and select units.",
    appliesTo: "select units",
    channel: "web chat",
    startDate: null,   // open-ended start
    endDate: null,     // no published end date; flip `active` to retire
    priority: 1        // lower number wins when multiple are live
  }
  // Add future promos here. Example shape:
  // {
  //   id: "summer-rv-2026",
  //   active: false,
  //   headline: "Summer RV & Boat Special",
  //   offer: "First month free on covered RV and boat parking",
  //   terms: "Available at participating locations only.",
  //   appliesTo: "RV and boat parking",
  //   channel: "web chat",
  //   startDate: "2026-06-01",
  //   endDate: "2026-08-31",
  //   priority: 2
  // }
];

// Returns only live promos, sorted by priority. This is what the prompt
// compiler injects into {{ACTIVE_PROMOS}}.
export function getActivePromotions(now = new Date()) {
  return promotions
    .filter((p) => isLive(p, now))
    .sort((a, b) => a.priority - b.priority);
}

// Renders the active promos as a compact block for the system prompt.
// If nothing is live, returns an explicit "no active promotions" instruction
// so the agent affirmatively avoids inventing offers.
export function renderPromotionsForPrompt(now = new Date()) {
  const live = getActivePromotions(now);

  if (live.length === 0) {
    return [
      "ACTIVE PROMOTIONS: None.",
      "Do not mention, imply, or invent any promotion, discount, or special offer.",
      "If a customer asks about deals, say you do not have an active promotion to share right now and offer to connect them with the team."
    ].join("\n");
  }

  const lines = live.map((p) => {
    return `- ${p.headline}: ${p.offer}. ${p.terms} (applies to: ${p.appliesTo})`;
  });

  return [
    "ACTIVE PROMOTIONS (quote only what is listed here, always include the terms):",
    ...lines,
    "Never combine, extend, or alter these offers. If a customer asks about a promo not listed, say you do not have it available and offer to connect them with the team."
  ].join("\n");
}

// Optional: human-readable window for internal/team display, not the agent.
export function describePromoWindow(promo) {
  const start = promo.startDate
    ? new Date(promo.startDate).toLocaleDateString("en-US", DATE_FMT)
    : "open";
  const end = promo.endDate
    ? new Date(promo.endDate).toLocaleDateString("en-US", DATE_FMT)
    : "open";
  return `${start} to ${end}`;
}
