export default {
  async fetch(request, env, ctx) {
    const ALLOWED_ORIGIN = "https://christine-ai-agentic.onrender.com";

    const corsHeaders = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, anthropic-version",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const origin = request.headers.get("Origin");
    if (origin !== ALLOWED_ORIGIN) {
      return new Response("Forbidden", { status: 403 });
    }

    const url = new URL(request.url);

    if (url.pathname === "/sms") {
      return handleSms(request, env, corsHeaders, ctx);
    }

    if (url.pathname === "/hubspot") {
      return handleHubspot(request, env, corsHeaders, ctx);
    }

    // Default: Anthropic proxy (with latency capture)
    const started = Date.now();
    const body = await request.text();

    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body,
    });

    const data = await upstream.text();

    ctx.waitUntil(observe(env, "anthropic_proxy", {
      status: upstream.ok ? "ok" : "error",
      source: "anthropic",
      code: upstream.status,
      latency_ms: Date.now() - started,
    }));

    return new Response(data, {
      status: upstream.status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      },
    });
  },
};

// ─────────────────────────── DATADOG OBSERVABILITY ──────────────────────────
// Mirrors Uniti's monitoring stack. Emits a structured LOG and a custom METRIC
// per integration call, tagged with status/source/routing_tag so dashboards and
// monitors can slice by outcome. Fire-and-forget via ctx.waitUntil in callers —
// observability must never delay or break a customer request. US site endpoints.

const DD_LOGS = "https://http-intake.logs.datadoghq.com/api/v2/logs";
const DD_METRICS = "https://api.datadoghq.com/api/v2/series";

async function ddLog(env, event, extra) {
  if (!env.DATADOG_API_KEY) return;
  const payload = [{
    ddsource: "cloudflare-worker",
    service: "christine-proxy",
    ddtags: `env:prod,event:${event},status:${extra.status || "unknown"},source:${extra.source || "n/a"}`,
    message: JSON.stringify({ event, ...extra, ts: new Date().toISOString() }),
  }];
  await fetch(DD_LOGS, {
    method: "POST",
    headers: { "Content-Type": "application/json", "DD-API-KEY": env.DATADOG_API_KEY },
    body: JSON.stringify(payload),
  }).catch(() => {});
}

async function ddMetric(env, metric, value, extra) {
  if (!env.DATADOG_API_KEY) return;
  const tags = [
    "env:prod",
    `source:${extra.source || "n/a"}`,
    `status:${extra.status || "unknown"}`,
  ];
  if (extra.routing_tag) tags.push(`routing_tag:${extra.routing_tag}`);

  const body = {
    series: [{
      metric: `christine.${metric}`,
      type: 1, // 1 = count
      points: [{ timestamp: Math.floor(Date.now() / 1000), value }],
      tags,
      resources: [{ name: "christine-proxy", type: "host" }],
    }],
  };
  await fetch(DD_METRICS, {
    method: "POST",
    headers: { "Content-Type": "application/json", "DD-API-KEY": env.DATADOG_API_KEY },
    body: JSON.stringify(body),
  }).catch(() => {});
}

// Emit a log + a count metric together for one integration outcome.
async function observe(env, event, extra = {}, metricValue = 1) {
  await Promise.all([
    ddLog(env, event, extra),
    ddMetric(env, `${event}.count`, metricValue, extra),
  ]);
}

// ─────────────────────────── SMS HANDLER (MOCK) ─────────────────────────────
// Mock SMS firing tool, by design — mirrors the cubby_mock pattern. No live
// carrier send (Twilio trial cannot register A2P 10DLC, error 30034). Validates
// number format, builds the message that WOULD be sent, returns twilio_mock.
// No allowlist: any well-formed number is accepted, just as Cubby returns data
// for any facility.

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

function json(payload, corsHeaders, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": corsHeaders["Access-Control-Allow-Origin"],
    },
  });
}

async function handleSms(request, env, corsHeaders, ctx) {
  const ts = new Date().toISOString();

  let input;
  try {
    input = await request.json();
  } catch {
    return json(
      { tool_name: "send_sms_confirmation", source: "twilio_mock", status: "error", error: "Invalid JSON body", created_at: ts },
      corsHeaders,
      400
    );
  }

  const { to_phone, contact_name, facility_name } = input || {};
  const phone = normalizePhone(to_phone);
  const body = buildBody({ contact_name, facility_name });

  if (!phone) {
    ctx.waitUntil(observe(env, "sms_confirmation", { status: "error", source: "twilio_mock" }));
    return json(
      { tool_name: "send_sms_confirmation", source: "twilio_mock", status: "error", to: to_phone, error: "Unrecognized phone number format", created_at: ts },
      corsHeaders
    );
  }

  ctx.waitUntil(observe(env, "sms_confirmation", { status: "ok", source: "twilio_mock" }));
  return json(
    {
      tool_name: "send_sms_confirmation",
      source: "twilio_mock",
      status: "ok",
      to: phone,
      mock: true,
      would_send: body,
      created_at: ts,
    },
    corsHeaders
  );
}

// ─────────────────────────── HUBSPOT HANDLER ────────────────────────────────
// Creates a Contact in HubSpot from a captured lead. Auth uses a Service Key
// (bearer token) held only in the Worker as HUBSPOT_CRM_KEY. Optional
// HUBSPOT_MODE=mock returns a labeled mock without calling HubSpot. Email is
// HubSpot's primary identifier, so providing it gives natural dedup. Returns
// source: "hubspot" or "hubspot_mock".

function splitName(full) {
  if (!full) return { first: "", last: "" };
  const parts = String(full).trim().split(/\s+/);
  return { first: parts[0] || "", last: parts.slice(1).join(" ") || "" };
}

async function handleHubspot(request, env, corsHeaders, ctx) {
  const ts = new Date().toISOString();

  let input;
  try {
    input = await request.json();
  } catch {
    return json(
      { tool_name: "hubspot.create_lead", source: "hubspot", status: "error", error: "Invalid JSON body", created_at: ts },
      corsHeaders,
      400
    );
  }

  const { contact_name, contact_phone, contact_email, facility_name, routing_tag } = input || {};

  if (env.HUBSPOT_MODE === "mock") {
    ctx.waitUntil(observe(env, "hubspot_lead", { status: "mock", source: "hubspot_mock", routing_tag }));
    return json(
      { tool_name: "hubspot.create_lead", source: "hubspot_mock", status: "ok", mock: true,
        would_create: { contact_name, contact_phone, contact_email, facility_name, routing_tag }, note: "HUBSPOT_MODE=mock", created_at: ts },
      corsHeaders
    );
  }

  const { first, last } = splitName(contact_name);

  const properties = {
    ...(first && { firstname: first }),
    ...(last && { lastname: last }),
    ...(contact_email && { email: contact_email }), // primary identifier (dedup)
    ...(contact_phone && { phone: contact_phone }),
    lifecyclestage: "lead",
    ...(routing_tag && { hs_lead_status: "NEW" }),
  };

  try {
    const res = await fetch("https://api.hubapi.com/crm/v3/objects/contacts", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.HUBSPOT_CRM_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ properties }),
    });
    const data = await res.json();

    if (res.ok) {
      ctx.waitUntil(observe(env, "hubspot_lead", { status: "ok", source: "hubspot", routing_tag, contact_id: data.id }));
      return json(
        { tool_name: "hubspot.create_lead", source: "hubspot", status: "ok", mock: false,
          contact_id: data.id, routing_tag, created_at: ts },
        corsHeaders
      );
    }

    if (res.status === 409) {
      ctx.waitUntil(observe(env, "hubspot_lead", { status: "duplicate", source: "hubspot", routing_tag }));
      return json(
        { tool_name: "hubspot.create_lead", source: "hubspot", status: "ok", mock: false,
          note: "Contact already exists", routing_tag, created_at: ts },
        corsHeaders
      );
    }

    ctx.waitUntil(observe(env, "hubspot_lead", { status: "error", source: "hubspot", code: res.status, routing_tag }));
    return json(
      { tool_name: "hubspot.create_lead", source: "hubspot", status: "error",
        error: data.message || `HubSpot API ${res.status}`, created_at: ts },
      corsHeaders
    );
  } catch (err) {
    ctx.waitUntil(observe(env, "hubspot_lead", { status: "error", source: "hubspot", routing_tag }));
    return json(
      { tool_name: "hubspot.create_lead", source: "hubspot", status: "error", error: String(err), created_at: ts },
      corsHeaders
    );
  }
}
