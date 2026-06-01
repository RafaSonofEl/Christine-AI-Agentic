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
  executeLookupLocationData
} from "./tools/lookup_location_data.js";
import {
  lookupLocationDataTool,
  executeLookupLocationData,
  checkUnitAvailabilityTool,        // ← must exist
  executeCheckUnitAvailability      // ← must exist
} from "./tools/cubby_adapter.js";

const API_URL = "https://christine-proxy.prods-balustre-0h.workers.dev";
const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 600;
const MAX_TOOL_HOPS = 4; // safety cap on tool-use round trips per turn

// Compiled once at module load. Promotions are evaluated at compile time;
// if you toggle a promo and want it live without reload, call compilePrompt()
// again and pass the result into createAgent.
const SYSTEM_PROMPT = compilePrompt();

const TOOLS = [lookupLocationDataTool, checkUnitAvailabilityTool];

// Maps a tool name to its executor. Add tools here as the framework grows.
const TOOL_EXECUTORS = {
  lookup_location_data: executeLookupLocationData,
  check_unit_availability: executeCheckUnitAvailability
};

function executeTool(toolUse) {
  const fn = TOOL_EXECUTORS[toolUse.name];
  if (!fn) {
    return { error: `Unknown tool: ${toolUse.name}` };
  }
  try {
    return fn(toolUse.input || {});
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

// Runs one full customer turn, including any tool-use round trips.
// `history` is the running messages array (role/content). It is mutated and
// returned so the caller persists conversation memory.
export async function runTurn(history, userText, { onToolStart } = {}) {
  history.push({ role: "user", content: userText });

  let hops = 0;
  let finalText = "";

  while (hops <= MAX_TOOL_HOPS) {
    const data = await callAnthropic(history);

    // Persist the assistant turn (text + any tool_use blocks) into memory.
    history.push({ role: "assistant", content: data.content });

    if (data.stop_reason === "tool_use") {
      if (onToolStart) onToolStart(); // UI hook: "let me pull that up"

      const toolResults = data.content
        .filter((b) => b.type === "tool_use")
        .map((toolUse) => ({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: JSON.stringify(executeTool(toolUse))
        }));

      history.push({ role: "user", content: toolResults });
      hops += 1;
      continue; // loop back for the model's next step
    }

    // Normal completion.
    finalText = textFromContent(data.content);
    break;
  }

  // Extract routing tag, strip it from customer-facing text, fire dispatcher.
  const { tag, clean } = extractRouting(finalText);
  const dispatch = runToolsForRouting(tag, {}); // ctx can carry qualification fields later

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
