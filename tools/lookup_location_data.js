// Framework: self-storage-regional-operator
// One tool, four operations. FROZEN shape; the DATA it returns is per-operator
// (it reads from the instance's locations.js). This is the integration seam:
// for an off-the-shelf RMS customer this executor becomes a thin adapter to
// Cubby/Storable/SiteLink; for a custom RMS, an adapter to their API.

import { locations } from "../config/locations.js";

// ---- Tool definition (what the model sees) ------------------------------

export const lookupLocationDataTool = {
  name: "lookup_location_data",
  description:
    "Look up facility-specific details for this operator. Use whenever the customer references a city, state, address, or facility name, or asks about hours, sizes, amenities, or contact info for a specific location. Prefer this over general knowledge whenever a specific place is involved.",
  input_schema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: ["list_by_state", "list_by_metro", "get_facility", "search_by_amenity"],
        description:
          "list_by_state: facilities in a state. list_by_metro: facilities in a metro/city. get_facility: full record for one named facility. search_by_amenity: facilities offering a specific amenity (e.g. rv, boat, covered parking, 24-hour, commercial)."
      },
      query: {
        type: "string",
        description:
          "The state (name or 2-letter code), metro/city, facility name or short name, or amenity keyword to search for."
      }
    },
    required: ["operation", "query"]
  }
};

// ---- Helpers -------------------------------------------------------------

function norm(s) {
  return String(s || "").trim().toLowerCase();
}

// Customer-safe projection. Strips internal-only fields (verificationNotes,
// statusNotes, sourceUrls, operatorSlug, id) so they never reach the model
// or the customer. Returns only what is safe to say out loud.
function publicView(loc) {
  return {
    name: loc.name,
    city: loc.city,
    state: loc.state,
    address: [loc.address1, `${loc.city}, ${loc.state} ${loc.postalCode || ""}`.trim()]
      .filter(Boolean)
      .join(", "),
    phone: loc.phone,
    officeHours: loc.officeHours.summary,
    accessHours: loc.accessHours.summary,
    accessException: loc.accessHours.exception || null,
    offerings: Object.entries(loc.offerings)
      .filter(([, v]) => v)
      .map(([k]) => k),
    amenities: loc.amenities,
    notes: loc.exceptions // customer-relevant exceptions only (e.g. 24h, commercial)
  };
}

function listMini(loc) {
  return {
    name: loc.name,
    shortName: loc.shortName,
    city: loc.city,
    state: loc.state,
    phone: loc.phone,
    accessHours: loc.accessHours.summary
  };
}

const AMENITY_ALIASES = {
  rv: ["rvStorage"],
  boat: ["boatStorage"],
  vehicle: ["vehicleStorage"],
  car: ["vehicleStorage"],
  "covered parking": ["coveredParking"],
  parking: ["coveredParking"],
  commercial: ["commercialWarehouse", "officeSpace"],
  warehouse: ["commercialWarehouse"],
  office: ["officeSpace"],
  business: ["businessStorage"]
};

// ---- Executor (what the agent loop runs) --------------------------------

export function executeLookupLocationData({ operation, query }) {
  const q = norm(query);

  switch (operation) {
    case "list_by_state": {
      const matches = locations.filter(
        (l) => norm(l.state) === q || norm(l.stateName) === q
      );
      return matches.length
        ? { operation, query, count: matches.length, results: matches.map(listMini) }
        : { operation, query, count: 0, results: [], message: "No facilities found in that state." };
    }

    case "list_by_metro": {
      const matches = locations.filter(
        (l) => norm(l.metro).includes(q) || norm(l.city).includes(q)
      );
      return matches.length
        ? { operation, query, count: matches.length, results: matches.map(listMini) }
        : { operation, query, count: 0, results: [], message: "No facilities found in that area." };
    }

    case "get_facility": {
      // Match on name, shortName, or address fragment.
      const match = locations.find(
        (l) =>
          norm(l.name).includes(q) ||
          norm(l.shortName) === q ||
          norm(l.shortName).includes(q) ||
          norm(l.address1).includes(q)
      );
      if (!match) {
        // If the query looks like a city with multiple facilities, nudge to list.
        const cityMatches = locations.filter((l) => norm(l.city).includes(q));
        if (cityMatches.length > 1) {
          return {
            operation,
            query,
            count: cityMatches.length,
            disambiguate: true,
            results: cityMatches.map(listMini),
            message: "Multiple facilities match. Ask the customer which one they mean."
          };
        }
        return { operation, query, found: false, message: "No matching facility found." };
      }
      return { operation, query, found: true, facility: publicView(match) };
    }

    case "search_by_amenity": {
      const aliasKeys = AMENITY_ALIASES[q] || null;
      const is24h = q.includes("24");

      const matches = locations.filter((l) => {
        if (is24h) return /24/.test(norm(l.accessHours.summary));
        if (aliasKeys) return aliasKeys.some((k) => l.offerings[k]);
        // fall back to free-text amenity match
        return l.amenities.some((a) => norm(a).includes(q));
      });

      return matches.length
        ? { operation, query, count: matches.length, results: matches.map(listMini) }
        : { operation, query, count: 0, results: [], message: "No facilities match that amenity." };
    }

    default:
      return { operation, query, error: "Unknown operation." };
  }
}
