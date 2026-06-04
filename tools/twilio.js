const ALLOWED_NUMBERS = new Set([
  "+15551112222", // Kerric
  "+15553334444", // Rayan
  "+15555556666",
  "+15557778888",
  "+15559990000",
]);

function normalizePhone(raw) {
  const digits = String(raw).replace(/\D/g, "");
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  return null;
}

const MOCK_FALLBACK_CODES = new Set([30032, 30034, 21608, 21211]);

async function sendSmsConfirmation(env, rawPhone, body) {
  const phone = normalizePhone(rawPhone);
  const ts = () => new Date().toISOString();

  if (!phone || !ALLOWED_NUMBERS.has(phone)) {
    return { tool_name: "twilio.send_sms_confirmation", status: "error", source: "twilio",
      error: "Number not in demo allowlist", payload: { to: rawPhone }, created_at: ts() };
  }

  if (env.SMS_MODE === "mock") {
    return { tool_name: "twilio.send_sms_confirmation", status: "ok", source: "twilio",
      message: "SMS confirmation (mock mode)", payload: { to: phone, mock: true, would_send: body }, created_at: ts() };
  }

  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`;
    const auth = Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString("base64");
    const params = new URLSearchParams({ To: phone, From: env.TWILIO_FROM_NUMBER, Body: body });

    const res = await fetch(url, { method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" }, body: params });
    const data = await res.json();

    if (res.ok) {
      return { tool_name: "twilio.send_sms_confirmation", status: "ok", source: "twilio",
        message: "Confirmation sent", payload: { to: phone, sid: data.sid, twilio_status: data.status, mock: false }, created_at: ts() };
    }
    if (MOCK_FALLBACK_CODES.has(data.code)) {
      return { tool_name: "twilio.send_sms_confirmation", status: "ok", source: "twilio",
        message: `SMS confirmation (mock — Twilio ${data.code}: live send unavailable on trial)`,
        payload: { to: phone, mock: true, would_send: body, twilio_code: data.code }, created_at: ts() };
    }
    return { tool_name: "twilio.send_sms_confirmation", status: "error", source: "twilio",
      error: data.message || "Twilio send failed", payload: { to: phone, twilio_code: data.code }, created_at: ts() };
  } catch (err) {
    return { tool_name: "twilio.send_sms_confirmation", status: "error", source: "twilio",
      error: String(err), payload: { to: phone }, created_at: ts() };
  }
}

module.exports = { sendSmsConfirmation, normalizePhone, ALLOWED_NUMBERS };
