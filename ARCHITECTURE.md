# Christine AI - Architecture & Implementation Plan

## 1. Overview

Christine is a multi-surface agentic assistant for Better Self Storage. She
operates as a **customer-facing chat agent** and feeds a real-time **internal
Team View** that lets staff watch her qualify, route, and action leads.

**Design principle:** the browser never holds secrets. A single Cloudflare
Worker is the trust boundary and orchestration layer between the UIs and all
third-party APIs (Anthropic, HubSpot, Twilio, Datadog).

---

## 2. Component Architecture

### 2.1 Frontend surfaces
- **`index.html`** — customer chat widget (cream/forest/gold Christine theme).
  Loads `agent.js` as a module and renders a launcher + chat panel.
- **Team View** — internal ops console: a static chat on the left mirroring the
  agent experience, and a live Lead & Process Tracker on the right showing
  routing tags, extracted lead fields, tool results, and agent events.

### 2.2 Client agent (`agent.js`)
Thin wrapper exposing `createAgent().send(text)`. Holds conversation history,
posts to the Worker `/chat` endpoint, and returns the `{reply, routing_tag,
lead, tool_results}` envelope to the UI.

### 2.3 Framework layer (`framework/`)
- **`prompt.template.js`** — persona, tone, safety rules, qualification order.
- **`compilePrompt.js`** — merges the template with `config/` data into the
  final system prompt sent to the model.
- **`routing.js`** — canonical routing-tag set and the `[ROUTING:*]` extractor.
- **`dispatcher.js`** — maps parsed intent/tags to the correct workflow and
  downstream tools.

### 2.4 Tools layer (`tools/`)
- **`lookup_location_data.js`** — facility availability, unit sizes, rates.
- **`cubby_adapter.js`** — integration with the Cubby storage platform.
- **`twilio.js`** — SMS confirmation (mockable for demos).

### 2.5 Configuration (`config/`)
- **`locations.js`**, **`operator.config.js`**, **`promotions.js`** — data-only
  files so business changes don't require code edits.

### 2.6 Cloudflare Worker (`cloudflare_worker.js`)
The orchestration core. Responsibilities:
- CORS + origin allow-listing (customer + Team View origins; internal origin for
  in-process subrequests).
- `/chat` — calls Anthropic, parses `[ROUTING:*]` and `<LEAD>` blocks, fans out
  to HubSpot + SMS in-process, emits Datadog events, returns the envelope.
- `/hubspot` — contact create with dedup (409) handling; mockable.
- `/sms` — phone normalization + confirmation body (Twilio mock).
- Datadog logs + metrics on every meaningful step.

---

## 3. Request Lifecycle
  1. User sends message in chat UI

  2. agent.js → POST /chat { message, session_id, channel, history, context }

  3. Worker builds system prompt, calls Anthropic /v1/messages

  4. Worker parses reply:

  5. extract [ROUTING:*] tag

  6. extract <LEAD>{...}</LEAD> JSON (stripped from user-visible text)
  
  7. If lead has contact info → in-process calls to /hubspot and /sms
  
  8. Worker emits Datadog log + metric for the turn
  
  9. Worker returns { reply, routing_tag, lead, tool_results }
  
  10. UI renders reply; Team View updates tracker, metrics, and events


---

## 4. Data Contract

The envelope every surface consumes:
```json
{
  "reply": "string (user-visible, tags/lead stripped)",
  "routing_tag": "RES_HOT | ... | null",
  "lead": { "contact_name": "...", "contact_phone": "...", "facility_name": "...", "...": "..." },
  "tool_results": [
    { "tool_name": "anthropic.messages", "status": "ok|error", "source": "anthropic", "message": "...", "payload": {} }
  ],
  "session_id": "uuid",
  "created_at": "ISO-8601"
}
```

---

## 5. Security & Trust Boundaries
- **Secrets** live only as Worker secrets (`ANTHROPIC_API_KEY`, `HUBSPOT_CRM_KEY`,
  `DATADOG_API_KEY`) — never shipped to the browser.
- **Origin allow-list** rejects any non-approved caller with 403.
- **Internal subrequests** (`/chat` → `/hubspot`/`/sms`) run in-process via a
  synthetic request, avoiding public loopback and CORS edge cases.
- **PII** (name, phone, email) only leaves the Worker toward HubSpot/Twilio;
  Datadog receives sanitized tags, not raw contact data.

---

## 6. Observability
- **Datadog logs** (`christine-proxy` service) for each event: anthropic_proxy,
  chat_turn, hubspot_lead, sms_confirmation.
- **Datadog metrics** (`christine.*.count`) tagged by `status`, `source`, and
  `routing_tag` for dashboards on lead volume, escalations, and error rates.
- **Team View** mirrors this client-side: turns, tool calls, leads,
  escalations, and SMS-confirmed counters.

---

## 7. Known Constraints & Decisions
- **Model availability:** the configured Anthropic model must be provisioned for
  the account's key, or it returns `not_found_error` (404). Mitigation: an
  `ANTHROPIC_MODEL` override and/or a candidate-fallback loop in `callAnthropic`.
- **HubSpot `hs_lead_status`:** only set when the portal pipeline defines the
  value; guarded behind `HUBSPOT_SET_LEAD_STATUS` to avoid 400s.
- **SMS is mocked** (`twilio_mock`) pending production Twilio credentials.

---

## 8. Implementation Phases

| Phase | Scope | Status |
|-------|-------|--------|
| 1 | Customer chat UI + Worker proxy + Anthropic | ✅ Done |
| 2 | Routing tags + lead extraction + dispatcher | ✅ Done |
| 3 | HubSpot + SMS + Datadog orchestration | ✅ Done |
| 4 | Team View ops console (live tracker) | ✅ Done |
| 5 | Christine theme (cream/forest/gold) across surfaces | ✅ Done |
| 6 | Mock Production Twilio + HubSpot pipeline mapping | ✅ Done |
| 7 | Auth on Team View, persistence, analytics dashboards | 🔜 Planned |

---

## 9. Future Enhancements
- Session persistence (KV / D1) for cross-visit lead continuity.
- Authenticated Team View with role-based access.
- Real Twilio send + delivery receipts.
- Multi-operator support driven entirely by `config/`.
- Automated model-availability health check on deploy.
