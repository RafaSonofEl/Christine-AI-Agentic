// ---------------------------------------------------------------------------
// cubby_adapter.js
//
// This is the demonstration adapter layer between Christine and Cubby, Better Self
// Storage's property-management system. In production this module will hit
// Cubby's REST API. For this demo it serves a hand-curated mock database whose
// shape matches the Cubby response, so swapping to live calls later
// is a one-function change inside the executors if needed.
//
// Two tools are exported:
//   1. lookup_location_data       > directory + hours + offerings
//   2. check_unit_availability    > live unit counts + monthly pricing
//
// Both return { source: "cubby_mock", ... } so the model and logs can tell
// mock data from real data once the live integration lands.
// ---------------------------------------------------------------------------

// ─────────────────────────── TOOL DEFINITIONS ───────────────────────────────

export const lookupLocationDataTool = {
  name: "lookup_location_data",
  description:
    "Look up Better Self Storage facility information: address, phone, office " +
    "hours, access hours, and what kinds of storage each facility offers. " +
    "Use whenever the customer mentions a city, state, street, or asks 'where " +
    "are you' / 'what are your hours'. Can search by metro, state, or facility_id.",
  input_schema: {
    type: "object",
    properties: {
      by_metro: {
        type: "string",
        description: "City or metro name, e.g. 'topeka', 'casper', 'west memphis'."
      },
     by_state: {
        type: "string",
        description:
          "State, either as a two-letter code or full name, e.g. 'UT' or 'Utah', " +
          "'AR' or 'Arkansas', 'WA' or 'Washington'."
      },
      facility_id: {
        type: "string",
        description: "Specific Cubby facility_id, e.g. 'BSS-TOPEKA-001'."
      }
    }
  }
};

export const checkUnitAvailabilityTool = {
  name: "check_unit_availability",
  description:
    "Check live unit availability and pricing at a specific Better Self Storage " +
    "facility. Use when the customer asks 'do you have a [size] available?' or " +
    "'how much is a 10x10?' or 'what's available in [location]?'. Always call " +
    "lookup_location_data FIRST to identify the facility, then call this tool " +
    "with that facility_id.",
  input_schema: {
    type: "object",
    properties: {
      facility_id: {
        type: "string",
        description: "The Cubby facility_id from a prior lookup_location_data call."
      },
      size_filter: {
        type: "string",
        description:
          "Optional. Filter by unit type id (e.g., '10x10', '5x5', " +
          "'parking_covered'). Omit to return all sizes."
      },
      available_only: {
        type: "boolean",
        description:
          "Optional. If true, returns only unit types with available_units > 0. " +
          "Default true."
      }
    },
    required: ["facility_id"]
  }
};

// ─────────────────────────── UNIT CATALOG + HELPERS ─────────────────────────

const UNIT_TYPES = [
  { id: "5x5",             name: "5' x 5'",        sqft: 25,  category: "small"   },
  { id: "5x10",            name: "5' x 10'",       sqft: 50,  category: "small"   },
  { id: "10x10",           name: "10' x 10'",      sqft: 100, category: "medium"  },
  { id: "10x15",           name: "10' x 15'",      sqft: 150, category: "medium"  },
  { id: "10x20",           name: "10' x 20'",      sqft: 200, category: "large"   },
  { id: "10x30",           name: "10' x 30'",      sqft: 300, category: "large"   },
  { id: "parking_covered", name: "Covered Parking", sqft: null, category: "parking" },
  { id: "parking_open",    name: "Open Parking",    sqft: null, category: "parking" }
];

const STATE_NAME_TO_CODE = {
  "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR",
  "california": "CA", "colorado": "CO", "connecticut": "CT", "delaware": "DE",
  "florida": "FL", "georgia": "GA", "hawaii": "HI", "idaho": "ID",
  "illinois": "IL", "indiana": "IN", "iowa": "IA", "kansas": "KS",
  "kentucky": "KY", "louisiana": "LA", "maine": "ME", "maryland": "MD",
  "massachusetts": "MA", "michigan": "MI", "minnesota": "MN", "mississippi": "MS",
  "missouri": "MO", "montana": "MT", "nebraska": "NE", "nevada": "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", "ohio": "OH", "oklahoma": "OK",
  "oregon": "OR", "pennsylvania": "PA", "rhode island": "RI",
  "south carolina": "SC", "south dakota": "SD", "tennessee": "TN", "texas": "TX",
  "utah": "UT", "vermont": "VT", "virginia": "VA", "washington": "WA",
  "west virginia": "WV", "wisconsin": "WI", "wyoming": "WY",
  "district of columbia": "DC"
};

function normalizeStateInput(raw) {
  if (!raw) return null;
  // Strip non-letters except spaces, lowercase, collapse whitespace
  let v = String(raw).toLowerCase().replace(/[^a-z\s]/g, "").trim().replace(/\s+/g, " ");
  if (!v) return null;

  // Direct two-letter
  if (v.length === 2) return v.toUpperCase();

  // Direct full-name match
  if (STATE_NAME_TO_CODE[v]) return STATE_NAME_TO_CODE[v];

  // Strip common prefixes Haiku might attach: "in wyoming", "the state of utah"
  const stripped = v
    .replace(/^(in|the state of|state of|near)\s+/, "")
    .trim();
  if (STATE_NAME_TO_CODE[stripped]) return STATE_NAME_TO_CODE[stripped];

  // Last resort: check if any known state name is a substring
  for (const [name, code] of Object.entries(STATE_NAME_TO_CODE)) {
    if (v.includes(name)) return code;
  }

  return null;
}

// Deterministic pseudo-random so a given facility+size always returns the same
// numbers within a session. Prevents demo flicker where Christine quotes "4
// available" then "1 available" thirty seconds later.
function seededAvailability(facilityId, unitTypeId) {
  const seed = (facilityId + unitTypeId)
    .split("")
    .reduce((a, c) => a + c.charCodeAt(0), 0);
  const r = (seed * 9301 + 49297) % 233280;
  return r / 233280;
}

function generateUnits(facilityId, offerings) {
  return UNIT_TYPES.map((t) => {
    if (t.category === "parking" && !offerings.vehicle && !offerings.rv) return null;

    const rand = seededAvailability(facilityId, t.id);

    let total;
    if (t.category === "small")       total = 12 + Math.floor(rand * 8);  // 12–19
    else if (t.category === "medium") total = 8  + Math.floor(rand * 6);  //  8–13
    else if (t.category === "large")  total = 4  + Math.floor(rand * 4);  //  4–7
    else                              total = 3  + Math.floor(rand * 4);  //  3–6

    const occupiedRatio = 0.4 + rand * 0.55; // 40%–95% occupied
    const available = Math.max(0, total - Math.floor(total * occupiedRatio));

    let monthlyRate;
    if      (t.id === "5x5")              monthlyRate = 39  + Math.floor(rand * 11);
    else if (t.id === "5x10")             monthlyRate = 59  + Math.floor(rand * 16);
    else if (t.id === "10x10")            monthlyRate = 89  + Math.floor(rand * 21);
    else if (t.id === "10x15")            monthlyRate = 119 + Math.floor(rand * 26);
    else if (t.id === "10x20")            monthlyRate = 159 + Math.floor(rand * 31);
    else if (t.id === "10x30")            monthlyRate = 219 + Math.floor(rand * 41);
    else if (t.id === "parking_covered")  monthlyRate = 79  + Math.floor(rand * 21);
    else if (t.id === "parking_open")     monthlyRate = 49  + Math.floor(rand * 16);

    return {
      unit_type_id: t.id,
      display_name: t.name,
      sqft: t.sqft,
      category: t.category,
      total_units: total,
      available_units: available,
      monthly_rate: monthlyRate,
      currency: "USD"
    };
  }).filter(Boolean);
}

// ─────────────────────────── MOCK DATABASE ──────────────────────────────────

const RAW_FACILITIES = [
  // ──────────── UTAH ────────────
  {
    facility_id: "BSS-KEARNS-001",
    account_id: "betterselfstorage",
    display_name: "Kearns Discount Storage",
    address: { line_1: "4184 W 5415 S", city: "Kearns", state: "UT", postal_code: "84118" },
    phone: "(801) 613-2404",
    hours_office: { summary: "Mon–Fri 9:00 AM – 5:00 PM, closed Sat/Sun", exceptions: [] },
    hours_access: { summary: "Daily 5:00 AM – 10:00 PM", exceptions: [] },
    offerings: { self_storage: true, vehicle: true, rv: true, boat: false, commercial: false },
    amenities: ["24/7 video surveillance", "controlled gated entry", "bright lighting", "after-hours monitoring"],
    _internal: { metro: "Salt Lake City", verified: "2026-05-01" }
  },

  // ──────────── IDAHO ────────────
  {
    facility_id: "BSS-POCATELLO-001",
    account_id: "betterselfstorage",
    display_name: "Pocatello Business Park and Storage",
    address: { line_1: "1261 Wilson Ave", city: "Pocatello", state: "ID", postal_code: "83201" },
    phone: "(208) 417-7131",
    hours_office: { summary: "Mon–Fri 9:00 AM – 5:00 PM, closed Sat/Sun", exceptions: [] },
    hours_access: { summary: "Daily 5:00 AM – 10:00 PM", exceptions: [] },
    offerings: {
      self_storage: true, vehicle: true, rv: true, boat: false,
      commercial: true, warehouse: true, office_space: true
    },
    amenities: ["commercial warehouse space", "office space", "24/7 video surveillance", "controlled gated entry", "bright lighting"],
    _internal: { metro: "Pocatello", verified: "2026-05-01", note: "Commercial warehouse and office space available" }
  },

  // ──────────── KANSAS ────────────
  {
    facility_id: "BSS-TOPEKA-001",
    account_id: "betterselfstorage",
    display_name: "Better Self Storage Topeka",
    address: { line_1: "3101 NE Seward Ave", city: "Topeka", state: "KS", postal_code: "66616" },
    phone: "(785) 329-9852",
    hours_office: { summary: "Mon–Fri 9:00 AM – 5:00 PM, closed Sat/Sun", exceptions: [] },
    hours_access: {
      summary: "24-hour access",
      exceptions: ["Topeka offers 24-hour gate access, unlike the default 5:00 AM – 10:00 PM at other locations"]
    },
    offerings: {
      self_storage: true, vehicle: true, rv: true, boat: false,
      commercial: false, covered_parking: true
    },
    amenities: ["RV, camper, trailer, vehicle covered parking", "24-hour access", "24/7 video surveillance", "controlled gated entry", "bright lighting"],
    _internal: { metro: "Topeka", verified: "2026-05-01", note: "Only location with 24-hour access" }
  },

  // ──────────── ARKANSAS (West Memphis ×6) ────────────
  {
    facility_id: "BSS-WMEMPHIS-EBARTON-001",
    account_id: "betterselfstorage",
    display_name: "Better Self Storage — E Barton",
    address: { line_1: "809 E Barton Avenue", city: "West Memphis", state: "AR", postal_code: "72301" },
    phone: "(870) 735-7400",
    hours_office: { summary: "Mon–Fri 9:00 AM – 5:00 PM, closed Sat/Sun", exceptions: [] },
    hours_access: { summary: "Daily 5:00 AM – 10:00 PM", exceptions: [] },
    offerings: { self_storage: true, vehicle: true, rv: true, boat: false, commercial: false },
    amenities: ["24/7 video surveillance", "controlled gated entry", "bright lighting"],
    _internal: { metro: "West Memphis", verified: "2026-05-01" }
  },
  {
    facility_id: "BSS-WMEMPHIS-GLENBAILEY-001",
    account_id: "betterselfstorage",
    display_name: "Better Self Storage — Glenn Bailey",
    address: { line_1: "301 Glen Bailey Dr", city: "West Memphis", state: "AR", postal_code: "72301" },
    phone: "(870) 735-7400",
    hours_office: { summary: "Mon–Fri 9:00 AM – 5:00 PM, closed Sat/Sun", exceptions: [] },
    hours_access: { summary: "Daily 5:00 AM – 10:00 PM", exceptions: [] },
    offerings: { self_storage: true, vehicle: true, rv: true, boat: false, commercial: false },
    amenities: ["24/7 video surveillance", "controlled gated entry", "bright lighting"],
    _internal: { metro: "West Memphis", verified: "2026-05-01" }
  },
  {
    facility_id: "BSS-WMEMPHIS-POLK-A",
    account_id: "betterselfstorage",
    display_name: "Better Self Storage — 110 Polk Ave",
    address: { line_1: "110 W Polk Ave", city: "West Memphis", state: "AR", postal_code: "72301" },
    phone: "(870) 394-9480",
    hours_office: { summary: "Mon–Fri 9:00 AM – 5:00 PM, closed Sat/Sun", exceptions: [] },
    hours_access: { summary: "Daily 5:00 AM – 10:00 PM", exceptions: [] },
    offerings: { self_storage: true, vehicle: true, rv: true, boat: false, commercial: false },
    amenities: ["24/7 video surveillance", "controlled gated entry", "bright lighting"],
    _internal: {
      metro: "West Memphis",
      verified: "2026-05-01",
      note: "Shares (870) 394-9480 with three other Polk-area West Memphis facilities; disambiguate by street address"
    }
  },
  {
    facility_id: "BSS-WMEMPHIS-POLK-B",
    account_id: "betterselfstorage",
    display_name: "Better Self Storage — 121 Polk Ave",
    address: { line_1: "121 W Polk Ave", city: "West Memphis", state: "AR", postal_code: "72301" },
    phone: "(870) 394-9480",
    hours_office: { summary: "Mon–Fri 9:00 AM – 5:00 PM, closed Sat/Sun", exceptions: [] },
    hours_access: { summary: "Daily 5:00 AM – 10:00 PM", exceptions: [] },
    offerings: { self_storage: true, vehicle: true, rv: true, boat: false, commercial: false },
    amenities: ["24/7 video surveillance", "controlled gated entry", "bright lighting"],
    _internal: {
      metro: "West Memphis",
      verified: "2026-05-01",
      note: "Source data lists 121 Polk under this facility but with 110 W Polk address; verified entry shows 121 W Polk. Shares phone with three other Polk-area facilities."
    }
  },
  {
    facility_id: "BSS-WMEMPHIS-S1ST-001",
    account_id: "betterselfstorage",
    display_name: "Better Self Storage — S 1st St",
    address: { line_1: "120 S 1st", city: "West Memphis", state: "AR", postal_code: "72301" },
    phone: "(870) 394-9480",
    hours_office: { summary: "Mon–Fri 9:00 AM – 5:00 PM, closed Sat/Sun", exceptions: [] },
    hours_access: { summary: "Daily 5:00 AM – 10:00 PM", exceptions: [] },
    offerings: { self_storage: true, vehicle: true, rv: true, boat: false, commercial: false },
    amenities: ["24/7 video surveillance", "controlled gated entry", "bright lighting"],
    _internal: {
      metro: "West Memphis",
      verified: "2026-05-01",
      note: "Shares (870) 394-9480 with three other Polk-area West Memphis facilities"
    }
  },
  {
    facility_id: "BSS-WMEMPHIS-WOODS-001",
    account_id: "betterselfstorage",
    display_name: "Better Self Storage — Woods St",
    address: { line_1: "120 Woods St", city: "West Memphis", state: "AR", postal_code: "72301" },
    phone: "(870) 394-9480",
    hours_office: { summary: "Mon–Fri 9:00 AM – 5:00 PM, closed Sat/Sun", exceptions: [] },
    hours_access: { summary: "Daily 5:00 AM – 10:00 PM", exceptions: [] },
    offerings: { self_storage: true, vehicle: true, rv: true, boat: false, commercial: false },
    amenities: ["24/7 video surveillance", "controlled gated entry", "bright lighting"],
    _internal: {
      metro: "West Memphis",
      verified: "2026-05-01",
      note: "Shares (870) 394-9480 with three other Polk-area West Memphis facilities"
    }
  },

  // ──────────── WYOMING (Casper ×2) ────────────
  {
    facility_id: "BSS-CASPER-VIEWCT-001",
    account_id: "betterselfstorage",
    display_name: "AA Casper Storage — Casper View Ct",
    address: { line_1: "131 Casper View Ct", city: "Casper", state: "WY", postal_code: "82601" },
    phone: "(307) 224-4475",
    hours_office: { summary: "Mon–Fri 9:00 AM – 5:00 PM, closed Sat/Sun", exceptions: [] },
    hours_access: { summary: "Daily 5:00 AM – 10:00 PM", exceptions: [] },
    offerings: { self_storage: true, vehicle: true, rv: true, boat: false, commercial: false },
    amenities: ["24/7 video surveillance", "controlled gated entry", "bright lighting"],
    _internal: { metro: "Casper", verified: "2026-05-01" }
  },
  {
    facility_id: "BSS-CASPER-MELROSE-001",
    account_id: "betterselfstorage",
    display_name: "AA Casper Storage — S Melrose St",
    address: { line_1: "1112 S Melrose St", city: "Casper", state: "WY", postal_code: "82601" },
    phone: "(307) 224-4475",
    hours_office: { summary: "Mon–Fri 9:00 AM – 5:00 PM, closed Sat/Sun", exceptions: [] },
    hours_access: { summary: "Daily 5:00 AM – 10:00 PM", exceptions: [] },
    offerings: { self_storage: true, vehicle: true, rv: true, boat: false, commercial: false },
    amenities: ["24/7 video surveillance", "controlled gated entry", "bright lighting"],
    _internal: { metro: "Casper", verified: "2026-05-01" }
  },

  // ──────────── WASHINGTON (West Richland ×2) ────────────
  {
    facility_id: "BSS-WRICHLAND-DODGE-001",
    account_id: "betterselfstorage",
    display_name: "Ideal Mini Storage — Dodge St",
    address: { line_1: "3754 Dodge St", city: "West Richland", state: "WA", postal_code: "" },
    phone: "(509) 903-9032",
    hours_office: { summary: "Mon–Fri 9:00 AM – 5:00 PM, closed Sat/Sun", exceptions: [] },
    hours_access: { summary: "Daily 5:00 AM – 10:00 PM", exceptions: [] },
    offerings: { self_storage: true, vehicle: true, rv: true, boat: false, commercial: false },
    amenities: ["24/7 video surveillance", "controlled gated entry", "bright lighting"],
    _internal: { metro: "West Richland", verified: "2026-05-01" }
  },
  {
    facility_id: "BSS-WRICHLAND-VANGIESEN-001",
    account_id: "betterselfstorage",
    display_name: "Ideal Mini Storage — Van Giesen",
    address: { line_1: "4044 W Van Giesen St", city: "West Richland", state: "WA", postal_code: "" },
    phone: "(509) 903-9032",
    hours_office: { summary: "Mon–Fri 9:00 AM – 5:00 PM, closed Sat/Sun", exceptions: [] },
    hours_access: { summary: "Daily 5:00 AM – 10:00 PM", exceptions: [] },
    offerings: { self_storage: true, vehicle: true, rv: true, boat: false, commercial: false },
    amenities: ["24/7 video surveillance", "controlled gated entry", "bright lighting"],
    _internal: { metro: "West Richland", verified: "2026-05-01" }
  }
];

// Inject deterministic units into every facility at module load.
const MOCK_CUBBY_DB = {
  facilities: RAW_FACILITIES.map((f) => ({
    ...f,
    units: generateUnits(f.facility_id, f.offerings)
  }))
};

// ─────────────────────────── NORMALIZER ─────────────────────────────────────
//
// Shapes a Cubby facility record into the lean payload Christine should see.
// Strips _internal fields and the full units list (units come back via the
// dedicated availability tool, not the directory tool).

function normalize(f) {
  return {
    facility_id: f.facility_id,
    name: f.display_name,
    address: `${f.address.line_1}, ${f.address.city}, ${f.address.state}${
      f.address.postal_code ? " " + f.address.postal_code : ""
    }`,
    phone: f.phone,
    office_hours: f.hours_office.summary,
    access_hours: f.hours_access.summary,
    access_exceptions: f.hours_access.exceptions || [],
    offerings: f.offerings,
    amenities: f.amenities
  };
}

// ─────────────────────────── EXECUTORS ──────────────────────────────────────

export async function executeLookupLocationData({ by_metro, by_state, facility_id }) {
  let matches = MOCK_CUBBY_DB.facilities;

  if (facility_id) {
    matches = matches.filter(
      (f) => f.facility_id.toLowerCase() === facility_id.toLowerCase()
    );
  } else if (by_state) {
    const code = normalizeStateInput(by_state);
    if (!code) {
      return {
        source: "cubby_mock",
        count: 0,
        facilities: [],
        error: `Unrecognized state value: '${by_state}'`
      };
    }
    matches = matches.filter((f) => f.address.state === code);
  } else if (by_metro) {
    const v = by_metro.toLowerCase().trim();
    matches = matches.filter(
      (f) =>
        f.address.city.toLowerCase().includes(v) ||
        (f._internal?.metro || "").toLowerCase().includes(v)
    );
  }

  return {
    source: "cubby_mock",
    count: matches.length,
    facilities: matches.map(normalize)
  };
}

export async function executeCheckUnitAvailability({
  facility_id,
  size_filter,
  available_only = true
}) {
  const facility = MOCK_CUBBY_DB.facilities.find(
    (f) => f.facility_id.toLowerCase() === facility_id.toLowerCase()
  );

  if (!facility) {
    return {
      source: "cubby_mock",
      error: `No facility found with id ${facility_id}`,
      units: []
    };
  }

  let units = facility.units || [];

  if (size_filter) {
    const v = size_filter.toLowerCase().trim();
    units = units.filter(
      (u) => u.unit_type_id === v || u.display_name.toLowerCase().includes(v)
    );
  }

  if (available_only) {
    units = units.filter((u) => u.available_units > 0);
  }

  return {
    source: "cubby_mock",
    facility_id: facility.facility_id,
    facility_name: facility.display_name,
    count: units.length,
    units: units.map((u) => ({
      size: u.display_name,
      sqft: u.sqft,
      category: u.category,
      available: u.available_units,
      monthly_rate: `$${u.monthly_rate}/month`,
      status:
        u.available_units === 0
          ? "waitlist"
          : u.available_units <= 2
          ? "limited"
          : "available"
    }))
  };
}
