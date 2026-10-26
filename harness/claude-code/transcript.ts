import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import type { AgentMessage, AssistantContentBlock, AssistantMessage, ToolResultMessage } from "../../lib/types";
import { object } from "./index";
import { CLAUDE_TASK_ID } from "./tasks";
import { mergeSessionStats, type SessionFileStats } from "../../lib/session-stats";

export type ClaudeMessage = AgentMessage & { nativeId: string };
export const CLAUDE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function claudeTranscriptFile(profileDir: string, id: string): string | null {
  if (!CLAUDE_UUID.test(id)) throw new Error("Invalid Claude Code session id");
  const root = path.join(profileDir, "projects");
  if (!existsSync(root)) return null;
  const realRoot = realpathSync(root);
  const profileRoot = realpathSync(profileDir);
  if (!realRoot.startsWith(profileRoot + path.sep)) throw new Error("Claude Code projects directory escapes its profile");
  for (const directory of readdirSync(root, { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    const file = path.join(root, directory.name, `${id}.jsonl`);
    if (!existsSync(file)) continue;
    const real = realpathSync(file);
    if (!real.startsWith(realRoot + path.sep)) throw new Error("Claude Code transcript escapes its profile");
    if (path.basename(real) !== `${id}.jsonl`) throw new Error("Claude Code transcript does not match its session id");
    return real;
  }
  return null;
}

export function claudeAssistantContent(raw: unknown): AssistantContentBlock[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((value): AssistantContentBlock[] => {
    const block = object(value);
    if (block.type === "text" && typeof block.text === "string") return [{ type: "text", text: block.text }];
    if (block.type === "thinking" && typeof block.thinking === "string") return [{ type: "thinking", thinking: block.thinking }];
    if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") return [{ type: "toolCall", toolCallId: block.id, toolName: block.name, input: object(block.input) }];
    return [];
  });
}

export function claudeResultContent(raw: unknown): ToolResultMessage["content"] {
  if (typeof raw === "string") return [{ type: "text", text: raw }];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((value): ToolResultMessage["content"] => {
    const block = object(value);
    if (block.type === "text" && typeof block.text === "string") return [{ type: "text", text: block.text }];
    const source = object(block.source);
    if (block.type === "image" && source.type === "base64" && typeof source.data === "string" && typeof source.media_type === "string") return [{ type: "image", source: { type: "base64", data: source.data, media_type: source.media_type } }];
    return [];
  });
}

export function claudeUsage(raw: unknown): AssistantMessage["usage"] {
  const usage = object(raw);
  if (!Object.keys(usage).length) return undefined;
  const number = (key: string) => typeof usage[key] === "number" ? usage[key] as number : 0;
  return { input: number("input_tokens"), output: number("output_tokens"), cacheRead: number("cache_read_input_tokens"), cacheWrite: number("cache_creation_input_tokens"), cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function claudeToolDetails(record: Record<string, unknown>): { diff: string } | undefined {
  const result = object(record.toolUseResult ?? record.tool_use_result);
  if (!Array.isArray(result.structuredPatch) || typeof result.filePath !== "string") return undefined;
  const hunks: string[] = [];
  for (const value of result.structuredPatch) {
    const hunk = object(value);
    if (![hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines].every((number) => typeof number === "number") || !Array.isArray(hunk.lines) || !hunk.lines.every((line) => typeof line === "string")) return undefined;
    hunks.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.join("\n")}`);
  }
  return hunks.length ? { diff: `--- a/${result.filePath}\n+++ b/${result.filePath}\n${hunks.join("\n")}\n` } : undefined;
}

export function claudeRecordMessages(record: Record<string, unknown>, toolNames: Map<string, string>, includeSidechain = false): ClaudeMessage[] {
  if ((!includeSidechain && record.isSidechain) || (record.isMeta && !record.isCompactSummary) || record.parent_tool_use_id || object(record.origin).kind === "task-notification") return [];
  const message = object(record.message);
  const timestamp = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Date.now();
  const nativeId = String(record.uuid ?? message.id ?? "");
  if (record.type === "assistant") {
    const content = claudeAssistantContent(message.content);
    for (const block of content) if (block.type === "toolCall") toolNames.set(block.toolCallId, block.toolName);
    if (!content.length) return [];
    return [{ role: "assistant", content, nativeId: String(message.id ?? nativeId), model: String(message.model ?? "claude-code"), provider: "claude-code", usage: claudeUsage(message.usage), timestamp }];
  }
  if (record.type !== "user") return [];
  const results = Array.isArray(message.content) ? message.content.filter((block) => object(block).type === "tool_result") : [];
  if (results.length) return results.map((value): ClaudeMessage => {
    const block = object(value);
    const toolCallId = String(block.tool_use_id ?? "");
    const result: ToolResultMessage & { nativeId: string } = { role: "toolResult", toolCallId, toolName: toolNames.get(toolCallId), content: claudeResultContent(block.content), isError: block.is_error === true, details: claudeToolDetails(record), nativeId: `tool:${toolCallId}`, timestamp };
    return result;
  });
  if (record.isCompactSummary) return [{ role: "custom", customType: "compaction", display: true, content: typeof message.content === "string" ? message.content : claudeResultContent(message.content), nativeId, timestamp }];
  if (typeof message.content === "string") {
    return [{ role: "user", content: message.content, nativeId, timestamp }];
  }
  const content = claudeResultContent(message.content);
  return content.length ? [{ role: "user", content, nativeId, timestamp }] : [];
}

/** Native JSONL is versioned by the CLI, so keep all format knowledge here. */
export function* claudeNativeRecords(text: string): Generator<Record<string, unknown>> {
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { yield object(JSON.parse(line)); }
    catch { /* the CLI can be appending the last line */ }
  }
}

export function parseClaudeTranscript(text: string, includeSidechain = false): ClaudeMessage[] {
  const records: Record<string, unknown>[] = [];
  const byId = new Map<string, Record<string, unknown>>();
  for (const record of claudeNativeRecords(text)) {
    if ((!includeSidechain && record.isSidechain) || typeof record.uuid !== "string") continue;
    // Attachments are hidden, but their UUIDs still link the native message chain.
    records.push(record);
    byId.set(record.uuid, record);
  }
  // Follow the active leaf, not abandoned siblings left by native resume/rewind.
  const leaf = records.findLast((record) => record.type === "user" || record.type === "assistant");
  const active: Record<string, unknown>[] = [];
  const visited = new Set<unknown>();
  for (let record = leaf; record && !visited.has(record.uuid); record = byId.get(String(record.parentUuid ?? record.logicalParentUuid))) {
    visited.add(record.uuid);
    active.push(record);
  }
  const source = active.length ? active.reverse() : records;
  const messages: ClaudeMessage[] = [];
  const tools = new Map<string, string>();
  for (const record of source) {
    for (const message of claudeRecordMessages(record, tools, includeSidechain)) {
      const previous = messages.at(-1);
      if (message.role === "assistant" && previous?.role === "assistant" && previous.nativeId === message.nativeId) {
        const index = record.apiBlockIndex;
        if (typeof index === "number") previous.content.splice(index, message.content.length, ...message.content);
        else previous.content.push(...message.content);
        if (message.usage) previous.usage = message.usage;
      } else messages.push(message);
    }
  }
  return messages;
}

function claudeSubagentsRoot(profileDir: string, id: string): string | null {
  const parent = claudeTranscriptFile(profileDir, id);
  if (!parent) return null;
  const sessionRoot = path.join(path.dirname(parent), id);
  const root = path.join(sessionRoot, "subagents");
  if (!existsSync(root)) return null;
  const realRoot = realpathSync(root);
  if (!realRoot.startsWith(sessionRoot + path.sep)) throw new Error("Claude Code subagent directory escapes its session");
  return realRoot;
}

export function claudeSubagentIds(profileDir: string, id: string): string[] {
  const root = claudeSubagentsRoot(profileDir, id);
  if (!root) return [];
  return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isFile() && /^agent-.+\.jsonl$/.test(entry.name)).map((entry) => entry.name.slice(6, -6)).filter((id) => CLAUDE_TASK_ID.test(id));
}

export function readClaudeSubagentTranscript(profileDir: string, id: string, agentId: string): ClaudeMessage[] {
  if (!CLAUDE_TASK_ID.test(agentId)) throw new Error("Invalid Claude Code agent id");
  const root = claudeSubagentsRoot(profileDir, id);
  if (!root) return [];
  const file = path.join(root, `agent-${agentId}.jsonl`);
  if (!existsSync(file)) return [];
  const realFile = realpathSync(file);
  if (!realFile.startsWith(root + path.sep)) throw new Error("Claude Code subagent transcript escapes its session");
  if (path.basename(realFile) !== `agent-${agentId}.jsonl`) throw new Error("Claude Code transcript does not match its subagent id");
  return parseClaudeTranscript(readFileSync(realFile, "utf8"), true);
}

/** The native title the CLI maintains itself, when it wrote one. */
export function readClaudeNativeTitle(profileDir: string, id: string): string | undefined {
  const file = claudeTranscriptFile(profileDir, id);
  if (!file) return undefined;
  const text = readFileSync(file, "utf8");
  let custom = "";
  let generated = "";
  for (const line of text.split("\n")) {
    try {
      const record = object(JSON.parse(line));
      if (record.type === "custom-title" && typeof record.customTitle === "string") custom = record.customTitle;
      if (record.type === "ai-title" && typeof record.aiTitle === "string") generated = record.aiTitle;
    } catch { /* partial trailing record */ }
  }
  const title = (custom || generated).trim().split("\n")[0].slice(0, 100);
  return title || undefined;
}

export function readClaudeTitle(profileDir: string, id: string): string {
  const native = readClaudeNativeTitle(profileDir, id);
  if (native) return native;
  const file = claudeTranscriptFile(profileDir, id);
  if (!file) throw new Error("Claude Code session history is missing");
  const first = parseClaudeTranscript(readFileSync(file, "utf8")).find((message) => message.role === "user");
  const prompt = first?.role === "user" ? typeof first.content === "string" ? first.content : first.content.filter((block) => block.type === "text").map((block) => block.text).join(" ") : "";
  const title = prompt.trim().split("\n")[0].slice(0, 100);
  if (!title) throw new Error("The session has no usable title");
  return title;
}

export function readClaudeTranscript(profileDir: string, id: string): { path: string | null; messages: ClaudeMessage[]; stats: SessionFileStats } {
  const file = claudeTranscriptFile(profileDir, id);
  // ponytail: one full native transcript per read; add paged streaming reads if long chats stall requests.
  const text = file ? readFileSync(file, "utf8") : "";
  const messages = parseClaudeTranscript(text);
  const stats = mergeSessionStats(undefined, [], messages);
  for (const line of text.split("\n")) {
    if (!line.includes('"cost-state"')) continue;
    try {
      const record = object(JSON.parse(line));
      if (record.type !== "cost-state") continue;
      // Native totals are cumulative: take the newest snapshot, never sum turn results.
      if (typeof record.totalCostUSD === "number" && Number.isFinite(record.totalCostUSD) && record.totalCostUSD >= 0) stats.cost = record.totalCostUSD;
      const usage = Object.values(object(record.modelUsage)).map(object);
      if (usage.length) {
        const total = (key: string) => usage.reduce((sum, item) => sum + (typeof item[key] === "number" ? item[key] as number : 0), 0);
        stats.tokens = { input: total("inputTokens"), output: total("outputTokens"), cacheRead: total("cacheReadInputTokens"), cacheWrite: total("cacheCreationInputTokens"), total: 0 };
        stats.tokens.total = stats.tokens.input + stats.tokens.output + stats.tokens.cacheRead + stats.tokens.cacheWrite;
      }
    } catch { /* partial trailing snapshot */ }
  }
  return { path: file, messages, stats };
}
