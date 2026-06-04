// ---------------------------------------------------------------------------
// twilio.js
//
// SMS confirmation tool for Christine. On lead capture, Christine sends a
// short confirmation text to the customer's verified callback number.
//
// IMPORTANT: Twilio trial accounts cannot register for A2P 10DLC, which US
// carriers now require for live SMS (error 30034). The live API path is fully
// implemented below; when a trial/A2P block is hit — or when SMS_MODE=mock —
// the executor returns a clearly labeled mock result so the lead flow and
// Team View still demonstrate the full confirmation step end to end.
//
// Every result carries source: "twilio" (live) or "twilio_mock" (mock) so the
// model and logs can tell real sends from simulated ones, mirroring the
// cubby_mock convention.
// ---------------------------------------------------------------------------

// ─────────────────────────── TOOL DEFINITION ────────────────────────────────

export const sendSmsConfirmationTool = {
  name: "send_sms_confirmation",
  description:
    "Send a brief SMS confirmation to a customer's phone number after a storage " +
    "lead is captured. Use ONLY when a lead has been collected (residential, " +
    "vehicle, or business interest) and you have the customer's callback number. " +
    "Do NOT use for escalations. The number must be one of the demo's verified " +
    "numbers.",
  input_schema: {
    type: "object",
    properties: {
      to_phone: {
        type: "string",
        description:
          "Customer callback number exactly as provided, e.g. '(785) 329-9852' " +
          "or '7853299852'. Will be normalized to E.164 before sending."
      },
      contact_name: {
        type: "string",
        description: "Customer first name to personalize the message, if known."
      },
      facility_name: {
        type: "string",
        description: "Facility the customer is interested in, e.g. 'Better Self Storage Topeka'."
      }
    },
    required: ["to_phone"]
  }
};

// ─────────────────────────── HELPERS ────────────────────────────────────────

const ALLOWED_NUMBERS = new Set([
  "+15551112222", // Kerric
  "+15553334444", // Rayan
  "+15555556666",
  "+15557778888",
  "+15559990000"
]);

const MOCK_FALLBACK_CODES = new Set([30032, 30034, 21608, 21211]);

function normalizePhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  return null;
}

function buildBody({ contact_name, facility_name }) {
  const who = contact_name ? `Hi ${contact_name}, ` : "Hi, ";
  const where = facility_name ? ` about ${facility_name}` : "";
  return `${who}thanks for reaching out to Better Self Storage${where}. A team member will follow up shortly.`;
}

// ─────────────────────────── EXECUTOR ───────────────────────────────────────

export async function executeSendSmsConfirmation({ to_phone, contact_name, facility_name }) {
  const ts = new Date().toISOString();
  const phone = normalizePhone(to_phone);
  const body = buildBody({ contact_name, facility_name });

  if (!phone || !ALLOWED_NUMBERS.has(phone)) {
    return {
      source: "twilio",
      status: "error",
      to: to_phone,
      error: "Number not in demo allowlist"
    };
  }

  // Explicit mock mode: skip the live call entirely.
  if (process.env.SMS_MODE === "mock") {
    return {
      source: "twilio_mock",
      status: "ok",
      to: phone,
      mock: true,
      would_send: body,
      note: "SMS_MODE=mock"
    };
  }

  try {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_FROM_NUMBER;

    const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
    const auth = Buffer.from(`${sid}:${token}`).toString("base64");
    const params = new URLSearchParams({ To: phone, From: from, Body: body });

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params
    });
    const data = await res.json();

    if (res.ok) {
      return {
        source: "twilio",
        status: "ok",
        to: phone,
        mock: false,
        sid: data.sid,
        twilio_status: data.status
      };
    }

    // Trial / A2P block -> graceful, clearly labeled mock fallback.
    if (MOCK_FALLBACK_CODES.has(data.code)) {
      return {
        source: "twilio_mock",
        status: "ok",
        to: phone,
        mock: true,
        would_send: body,
        twilio_code: data.code,
        note: `Live send unavailable on trial (Twilio ${data.code})`
      };
    }

    return {
      source: "twilio",
      status: "error",
      to: phone,
      twilio_code: data.code,
      error: data.message || "Twilio send failed"
    };
  } catch (err) {
    return {
      source: "twilio",
      status: "error",
      to: phone,
      error: String(err)
    };
  }
}
