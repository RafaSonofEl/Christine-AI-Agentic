# Christine — AI Agentic Storage Operations

Christine is an AI operations agent for **Better Self Storage**. She qualifies
storage renters, matches them to facilities, routes leads by intent, and
escalates security or manager issues — across a customer chat widget and an
internal Team View ops console.

The model (Anthropic Claude) is never called from the browser. All requests pass
through a Cloudflare Worker proxy (`cloudflare_worker.js`) that holds the API
keys server-side and orchestrates downstream tools (HubSpot, SMS, Datadog).

---

## Architecture at a Glance

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full design.

---

## Repository Layout

| Path | Purpose |
|------|---------|
| `config/locations.js` | Facility / metro data and unit inventory definitions |
| `config/operator.config.js` | Operator-level settings (Better Self Storage branding, defaults) |
| `config/promotions.js` | Active promotions and rate offers |
| `framework/compilePrompt.js` | Assembles the runtime system prompt from templates + config |
| `framework/dispatcher.js` | Routes parsed intents to the correct workflow / tool |
| `framework/prompt.template.js` | Base prompt scaffold for Christine's persona and rules |
| `framework/routing.js` | Routing-tag definitions and tag-extraction logic |
| `tools/cubby_adapter.js` | Adapter for the Cubby storage management system |
| `tools/lookup_location_data.js` | Resolves facility availability, sizes, and rates |
| `tools/twilio.js` | SMS confirmation sender (mockable) |
| `agent.js` | Client-side agent wrapper used by the chat UI |
| `cloudflare_worker.js` | Server-side proxy + orchestration (`/chat`, `/sms`, `/hubspot`) |
| `index.html` | Customer-facing Christine chat widget |

---

## Routing Tags

Christine appends exactly one tag to each reply; the frontend and Worker act on it.

| Tag | Meaning | Action |
|-----|---------|--------|
| `RES_HOT` | Move-in ≤30 days or ready to reserve | Route to sales now |
| `RES_WARM` | 30–90 days, engaged | Nurture / follow up |
| `RES_COLD` | Browsing, >90 days | Low-priority |
| `RV_BOAT` | RV / boat / vehicle storage | Vehicle specialist |
| `COMMERCIAL` | Business / inventory storage | Commercial sales |
| `ESCALATE_SECURITY` | Break-in, theft, safety | Alert ops (911 advisory) |
| `ESCALATE_MANAGER` | Complaint, billing dispute | Manager follow-up |

---

## Getting Started

### Prerequisites
- Node.js 18+ and a Cloudflare account (Wrangler CLI)
- Anthropic API key with access to a current Claude model
- (Optional) HubSpot private-app token, Datadog API key

### 1. Configure Worker secrets
```bash
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put HUBSPOT_CRM_KEY      # optional
wrangler secret put DATADOG_API_KEY      # optional
# Optional vars:
#   ANTHROPIC_MODEL=<known-good model id>   pins a model and skips fallback
#   HUBSPOT_MODE=mock                       skips real HubSpot writes
#   HUBSPOT_SET_LEAD_STATUS=true            only if "NEW" exists in your pipeline
```

### 2. Verify your model access
A `not_found_error` (HTTP 404) means the configured model isn't provisioned for
your key. List what your key can actually call:
```bash
curl https://api.anthropic.com/v1/models \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01"
```
Set `ANTHROPIC_MODEL` to one of the returned IDs.

### 3. Deploy the Worker
```bash
wrangler deploy
wrangler tail        # live logs while testing
```

### 4. Point the frontends at the Worker
In `index.html` (and the Team View), set:
```js
const WORKER_URL = "https://christine-proxy.<your-subdomain>.workers.dev/chat";
```

### 5. Serve the UIs
Deploy `index.html` (customer chat) and the Team View as static sites. Add both
origins to `ALLOWED_ORIGINS` in `cloudflare_worker.js`.

---

## Deployed Surfaces

| Surface | URL |
|---------|-----|
| Customer chat | `https://christine-ai-agentic.onrender.com` |
| Team View (internal) | `https://christine-ai-team-view.onrender.com` |
| Worker proxy | `https://christine-proxy.<subdomain>.workers.dev` |

---

## Demo / Offline Mode
Both UIs support `USE_MOCK = true`, which returns canned responses so the
interface can be demoed without the Worker or any live API keys.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `Anthropic 404 / not_found_error` | Model not provisioned for your key | Use `/v1/models`, set `ANTHROPIC_MODEL` |
| `403 Forbidden` from Worker | Origin not allow-listed | Add origin to `ALLOWED_ORIGINS` |
| HubSpot 400 | `hs_lead_status` value not in pipeline | Unset `HUBSPOT_SET_LEAD_STATUS` |
| No reply, dot shows "Degraded" | Worker reached Anthropic but errored | Check `wrangler tail` |

---

## License
Internal project for Better Self Storage. All rights reserved.
