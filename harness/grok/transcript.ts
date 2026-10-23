import { readFileSync } from "node:fs";
import type { AgentMessage, AssistantContentBlock, AssistantMessage } from "@/lib/types";
import { resolveGrokHistoryFile } from "./index";

/**
 * Grok's own transcript (`chat_history.jsonl`) -> the message list this app renders.
 *
 * Grok writes one record per model call, plus the tool results that call asked for:
 *
 *   {"type":"reasoning","summary":[{"type":"summary_text","text":"..."}]}
 *   {"type":"assistant","content":"text","tool_calls":[{"id","name","arguments"}],"model_id"}
 *   {"type":"tool_result","tool_call_id":"...","content":"..."}
 *   {"type":"user","content":[{"type":"text","text":"<user_query>...</user_query>"}]}
 *
 * A user record is not always a user turn: grok also stores its own envelopes
 * (`<system-reminder>`, `<rules>`, the session summary) as `user` records. Those
 * carry `synthetic_reason`, and real prompts are wrapped in `<user_query>`.
 */
const PROVIDER = "grok";
const SYNTHETIC_ENVELOPE = /^<(system-reminder|user_info|rules|image_files|workspace|summary)/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function userText(text: string): string | null {
  const query = /<user_query>([\s\S]*?)<\/user_query>/.exec(text);
  if (query) return query[1].trim() || null;
  const trimmed = text.trim();
  if (!trimmed || SYNTHETIC_ENVELOPE.test(trimmed)) return null;
  return trimmed;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (isObject(part) && typeof part.text === "string" ? part.text : ""))
    .join("");
}

function thinkingOf(record: Record<string, unknown>): string {
  const summary = record.summary;
  if (!Array.isArray(summary)) return "";
  return summary
    .map((part) => (isObject(part) && typeof part.text === "string" ? part.text : ""))
    .join("\n\n")
    .trim();
}

/** `arguments` is a JSON string; an older grok wrote a python-repr string. */
function toolCalls(record: Record<string, unknown>): Array<{ id: string; name: string; input: Record<string, unknown> }> {
  const raw = record.tool_calls;
  if (!Array.isArray(raw)) return [];
  const calls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
  for (const call of raw) {
    if (!isObject(call)) continue;
    const id = typeof call.id === "string" ? call.id : "";
    const name = typeof call.name === "string" ? call.name : "tool";
    if (!id) continue;
    let input: Record<string, unknown> = {};
    const args = call.arguments;
    if (isObject(args)) input = args;
    else if (typeof args === "string") {
      try {
        const parsed = JSON.parse(args) as unknown;
        if (isObject(parsed)) input = parsed;
      } catch {
        input = { arguments: args };
      }
    }
    calls.push({ id, name, input });
  }
  return calls;
}

export interface GrokTranscript {
  messages: AgentMessage[];
  /** True when grok has a session file for this id and folder. */
  exists: boolean;
  path: string | null;
  model: string | null;
}

/**
 * Read one grok session. Missing file is not an error: a session that has not
 * run its first turn yet has no transcript.
 */
export function readGrokTranscript(cwd: string, sessionId: string): GrokTranscript {
  const file = resolveGrokHistoryFile(cwd, sessionId);
  if (!file) return { messages: [], exists: false, path: null, model: null };

  const messages: AgentMessage[] = [];
  const toolNames = new Map<string, string>();
  let thinking = "";
  let model: string | null = null;

  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    switch (record.type) {
      case "reasoning":
        thinking = thinkingOf(record);
        break;
      case "assistant": {
        const content: AssistantContentBlock[] = [];
        if (thinking) content.push({ type: "thinking", thinking });
        thinking = "";
        const text = typeof record.content === "string" ? record.content : "";
        if (text.trim()) content.push({ type: "text", text });
        for (const call of toolCalls(record)) {
          toolNames.set(call.id, call.name);
          content.push({ type: "toolCall", toolCallId: call.id, toolName: call.name, input: call.input });
        }
        if (typeof record.model_id === "string" && record.model_id) model = record.model_id;
        if (content.length === 0) break;
        const message: AssistantMessage = {
          role: "assistant",
          content,
          model: model ?? PROVIDER,
          provider: PROVIDER,
        };
        messages.push(message);
        break;
      }
      case "tool_result": {
        const toolCallId = typeof record.tool_call_id === "string" ? record.tool_call_id : "";
        if (!toolCallId) break;
        messages.push({
          role: "toolResult",
          toolCallId,
          toolName: toolNames.get(toolCallId),
          content: [{ type: "text", text: typeof record.content === "string" ? record.content : textOf(record.content) }],
        });
        break;
      }
      case "user": {
        if (record.synthetic_reason !== undefined && record.synthetic_reason !== null) break;
        const text = userText(typeof record.content === "string" ? record.content : textOf(record.content));
        if (!text) break;
        messages.push({ role: "user", content: text });
        break;
      }
      default:
        break;
    }
  }

  return { messages, exists: true, path: file, model };
}
