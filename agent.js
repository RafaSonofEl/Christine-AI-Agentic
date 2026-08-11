// Framework: self-storage-regional-operator
// Integration layer. Compiles the system prompt at init, runs the Anthropic
// Messages API with tool use (via a Cloudflare Worker proxy), resolves the
// location lookup loop, then extracts the routing tag and dispatches the
// tool/action layer.
//
// The Anthropic API key is NOT in this file. It lives as an encrypted secret
// in the Cloudflare Worker. This file only knows the Worker URL.

import { compilePrompt } from "./framework/compilePrompt.js";
import { extractRouting } from "./framework/routing.js";
import { runToolsForRouting } from "./framework/dispatcher.js";
import {
  lookupLocationDataTool,
  executeLookupLocationData,
  checkUnitAvailabilityTool,
  executeCheckUnitAvailability
} from "./tools/cubby_adapter.js";

const API_URL = "https://christine-proxy.prods-balustre-0h.workers.dev";
const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 600;
const MAX_TOOL_HOPS = 4; // safety cap on tool-use round trips per turn

const SYSTEM_PROMPT = compilePrompt();

const TOOLS = [lookupLocationDataTool, checkUnitAvailabilityTool];

const TOOL_EXECUTORS = {
  lookup_location_data: executeLookupLocationData,
  check_unit_availability: executeCheckUnitAvailability
};

async function executeTool(toolUse) {
  const fn = TOOL_EXECUTORS[toolUse.name];
  if (!fn) {
    return { error: `Unknown tool: ${toolUse.name}` };
  }
  try {
    return await fn(toolUse.input || {});
  } catch (e) {
    return { error: `Tool execution failed: ${String(e)}` };
  }
}

async function callAnthropic(messages) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      tool_choice: { type: "auto" },
      messages
    })
  });

  if (!res.ok) {
    throw new Error(`Anthropic API ${res.status}`);
  }
  return res.json();
}

// Pulls the concatenated text from a content array (ignoring tool_use blocks).
function textFromContent(content) {
  return (content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

// ─────────────────────── CONTEXT EXTRACTION HELPERS ─────────────────────────
// Derive qualification fields from the running conversation so lead tags can
// fire a personalized SMS confirmation and a HubSpot CRM lead via the dispatcher.

// Shared text extractor for a message's content (string or block array).
// Named messageText (not userText) to avoid shadowing runTurn's userText param.
function messageText(msg) {
  return typeof msg.content === "string"
    ? msg.content
    : Array.isArray(msg.content)
    ? msg.content.filter((b) => b.type === "text").map((b) => b.text).join(" ")
    : "";
}

// Scans user-typed text (newest first) for a US phone number.
function extractPhone(history) {
  const phoneRe = /(?:\+?1[\s\-.]?)?\(?\d{3}\)?[\s\-.]?\d{3}[\s\-.]?\d{4}/;
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.role !== "user") continue;
    const m = messageText(msg).match(phoneRe);
    if (m) return m[0];
  }
  return null;
}

// Scans user-typed text (newest first) for an email address.
function extractEmail(history) {
  const emailRe = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.role !== "user") continue;
    const m = messageText(msg).match(emailRe);
    if (m) return m[0];
  }
  return null;
}

// Best-effort name capture from user self-introductions.
// Handles: "my name is X", "my first name is X", "my last name is X",
// "my full name is X", "my first and last name is X", "my name's X",
// "name: X", "name is X", "the name is X", "this is X", "it's X",
// "I'm X", "I am X", "call me X". Case-insensitive. Captures 1–4 name tokens.
function extractName(history) {
  const nameRe = /\b(?:my\s+(?:first\s+(?:and\s+last\s+)?|last\s+|full\s+)?name(?:'s|\s+is)|(?:the\s+)?name(?:\s+is|[:\-])|this\s+is|it'?s|i'?m|i\s+am|call\s+me)\s+([A-Za-z][A-Za-z'\-]{1,20}(?:\s+[A-Za-z][A-Za-z'\-]{1,20}){0,3})/i;
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.role !== "user") continue;
    const m = messageText(msg).match(nameRe);
    if (m) return m[1].trim().replace(/[.,;!?]+$/, "");
  }
  return null;
}

// Pulls the facility name from tool_result blocks (Cubby adapter returns
// facility_name / facilities[].name). Most reliable source. Newest first.
function extractFacilityName(history) {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type !== "tool_result" || typeof block.content !== "string") continue;
      try {
        const parsed = JSON.parse(block.content);
        if (parsed.facility_name) return parsed.facility_name;
        if (Array.isArray(parsed.facilities) && parsed.facilities[0]?.name) {
          return parsed.facilities[0].name;
        }
      } catch {
        // non-JSON tool result; skip
      }
    }
  }
  return null;
}

// Runs one full customer turn, including any tool-use round trips.
export async function runTurn(history, userText, { onToolStart } = {}) {
  history.push({ role: "user", content: userText });

  let hops = 0;
  let finalText = "";

  while (hops <= MAX_TOOL_HOPS) {
    const data = await callAnthropic(history);

    history.push({ role: "assistant", content: data.content });

    if (data.stop_reason === "tool_use") {
      if (onToolStart) onToolStart();

      const toolResults = await Promise.all(
        data.content
          .filter((b) => b.type === "tool_use")
          .map(async (toolUse) => ({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: JSON.stringify(await executeTool(toolUse))
          }))
      );

      history.push({ role: "user", content: toolResults });
      hops += 1;
      continue;
    }

    finalText = textFromContent(data.content);
    break;
  }

  // Extract routing tag, strip it from customer-facing text, fire dispatcher.
  const { tag, clean } = extractRouting(finalText);

  // Build context. A lead is only pushed to CRM if it has phone OR email
  // (enforced in the dispatcher); name and facility personalize the message.
  const ctx = {
    contact_phone: extractPhone(history),
    contact_email: extractEmail(history),
    contact_name: extractName(history),
    facility_name: extractFacilityName(history)
  };

  const dispatch = await runToolsForRouting(tag, ctx);

  return {
    reply: clean || "I'm sorry, I had trouble responding just now. Please try again.",
    routing: dispatch, // { tag, fellBack, actions } for a Team View / Activity Log
    history
  };
}

// Convenience factory if you want a fresh conversation object per session.
export function createAgent() {
  const history = [];
  return {
    history,
    send: (userText, opts) => runTurn(history, userText, opts)
  };
}
