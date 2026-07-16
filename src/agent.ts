/**
 * Claude agent loop — Anthropic /messages API shape against a
 * configurable base URL (Anthropic direct or any compatible relay).
 * Tools: `escalate` (always available) and whatever you add.
 */

import { SYSTEM_GUARDRAILS } from "./config";

export interface AgentEnv {
  AI_API_KEY?: string;
  AI_BASE_URL?: string; // e.g. https://api.anthropic.com/v1
  AI_MODEL?: string; // e.g. claude-sonnet-4-6
}

interface ToolUse {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}
interface TextBlock {
  type: "text";
  text: string;
}
export interface AIMessage {
  role: "user" | "assistant";
  content: string | Array<ToolUse | TextBlock | Record<string, unknown>>;
}

export interface AgentResult {
  reply: string | null;
  escalation: { reason: string; summary: string } | null;
}

const escalateTool = {
  name: "escalate",
  description:
    "Hand this conversation to a human staff member. Use for refunds, complaints, anger, money issues, partnerships, or anything you are unsure about.",
  input_schema: {
    type: "object",
    properties: {
      reason: { type: "string", description: "one-line category" },
      summary: {
        type: "string",
        description: "2-3 sentence summary of the customer's need for staff",
      },
    },
    required: ["reason", "summary"],
  },
};

/**
 * One agentic exchange: guardrails + KB + history + the new message,
 * up to 4 tool round-trips. Returns final reply text and/or escalation.
 */
export async function runCustomerAgent(
  env: AgentEnv,
  kbText: string,
  userMessage: string,
  history: AIMessage[] = [],
): Promise<AgentResult> {
  if (!env.AI_API_KEY || !env.AI_BASE_URL) {
    return { reply: null, escalation: null };
  }
  const system = `${SYSTEM_GUARDRAILS}\n\n=== KNOWLEDGE BANK ===\n${kbText}`;
  const messages: AIMessage[] = [
    ...history,
    { role: "user", content: userMessage },
  ];
  let escalation: AgentResult["escalation"] = null;

  for (let turn = 0; turn < 4; turn++) {
    const res = await fetch(`${env.AI_BASE_URL.replace(/\/$/, "")}/messages`, {
      method: "POST",
      headers: {
        "x-api-key": env.AI_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: env.AI_MODEL ?? "claude-sonnet-4-6",
        max_tokens: 500,
        system,
        tools: [escalateTool],
        messages,
      }),
    });
    if (!res.ok) return { reply: null, escalation: null };
    const data = (await res.json()) as {
      content: Array<ToolUse | TextBlock>;
      stop_reason: string;
    };

    const toolUses = data.content.filter(
      (b): b is ToolUse => b.type === "tool_use",
    );
    if (toolUses.length === 0 || data.stop_reason !== "tool_use") {
      const text = data.content
        .filter((b): b is TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      return { reply: text || null, escalation };
    }

    messages.push({ role: "assistant", content: data.content });
    const results: Array<Record<string, unknown>> = [];
    for (const tu of toolUses) {
      let output = "";
      if (tu.name === "escalate") {
        escalation = {
          reason: String(tu.input.reason ?? "unspecified"),
          summary: String(tu.input.summary ?? ""),
        };
        output =
          "Escalation logged — staff will follow up. Tell the customer a team member will reply here soon.";
      }
      results.push({ type: "tool_result", tool_use_id: tu.id, content: output });
    }
    messages.push({ role: "user", content: results });
  }
  return { reply: null, escalation };
}
