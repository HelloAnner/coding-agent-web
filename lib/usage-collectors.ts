import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { zstdDecompressSync } from "node:zlib";
import type { CollectUsageOptions, UsageBucket, UsageDaySummary, UsageHarness, UsageMetrics, UsageRoot, UsageSnapshot, UsageSourceDiagnostic } from "./usage-types";
export type * from "./usage-types";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
const text = (...values: unknown[]): string | null => values.find((value) => typeof value === "string" && value.length > 0) as string | undefined ?? null;
const number = (...values: unknown[]): number => values.find((value) => typeof value === "number" && Number.isFinite(value) && value >= 0) as number | undefined ?? 0;
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const limitation = (source: UsageSourceDiagnostic, code: string) => { if (!source.limitations.includes(code)) source.limitations.push(code); };

function emptyMetrics(): UsageMetrics {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, cost: null, costKnownRequests: 0, costUnknownRequests: 0, requests: 0, messages: 0, toolCalls: 0, sessions: 0, errors: 0 };
}

function timestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Number.isFinite(new Date(value).getTime()) ? value : null;
  if (typeof value !== "string" || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function usageMetrics(raw: unknown, source: UsageSourceDiagnostic): UsageMetrics {
  const usage = object(raw);
  const result = emptyMetrics();
  result.cacheReadTokens = number(usage.cacheRead, usage.cacheReadTokens, usage.cache_read_input_tokens, usage.cache_read_tokens, usage.cachedReadTokens, object(usage.prompt_tokens_details).cached_tokens, object(usage.input_tokens_details).cached_tokens);
  result.cacheWriteTokens = number(usage.cacheWrite, usage.cacheWriteTokens, usage.cache_creation_input_tokens, usage.cache_write_tokens, usage.cacheCreationTokens);
  result.inputTokens = number(usage.input, usage.inputTokens, usage.input_tokens, usage.prompt_tokens);
  // OpenAI-compatible prompt/input token counters include the cache hit subset.
  if (usage.prompt_tokens !== undefined || object(usage.input_tokens_details).cached_tokens !== undefined) result.inputTokens = Math.max(0, result.inputTokens - result.cacheReadTokens);
  result.outputTokens = number(usage.output, usage.outputTokens, usage.output_tokens, usage.completion_tokens);
  const sum = result.inputTokens + result.outputTokens + result.cacheReadTokens + result.cacheWriteTokens;
  result.totalTokens = number(usage.totalTokens, usage.total_tokens) || sum;
  const cost = [object(usage.cost).total, usage.costUSD, usage.costUsd, usage.cost_usd, typeof usage.cost === "number" ? usage.cost : undefined].find((value) => typeof value === "number" && Number.isFinite(value) && value >= 0);
  result.cost = typeof cost === "number" ? cost : null;
  if (usage.costUsdTicks !== undefined && result.cost === null) limitation(source, "cost_usd_ticks_unit_unknown");
  return result;
}

interface Event {
  key: string;
  session: string;
  harness: UsageHarness;
  model: string | null;
  provider: string | null;
  time: number | null;
  metrics: UsageMetrics;
  tools: Set<string>;
}

function addMetrics(target: UsageMetrics, value: UsageMetrics): void {
  for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens", "costKnownRequests", "costUnknownRequests", "requests", "messages", "toolCalls", "errors"] as const) target[key] += value[key];
  if (value.cost !== null) target.cost = (target.cost ?? 0) + value.cost;
}

function expand(value: string, home: string): string {
  return resolve(value === "~" ? home : value.startsWith("~/") ? join(home, value.slice(2)) : value);
}

/** Discovery reads only profile paths, never auth/settings/credential files, and never invokes a harness. */
async function discover(options: CollectUsageOptions): Promise<{ roots: UsageRoot[]; failed: boolean }> {
  const home = options.homeDir ?? homedir();
  const env = options.env ?? process.env;
  const roots: UsageRoot[] = [];
  let failed = false;
  if (options.discoverDefaults !== false) {
    const add = (harness: UsageHarness, directory: string, suffix: string) => roots.push({ harness, path: join(expand(directory, home), suffix) });
    add("pi", env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent"), "sessions");
    add("dsh", env.DSH_HOME || join(home, ".dsh"), "sessions");
    add("grok", env.GROK_HOME || join(home, ".grok"), "sessions");
    add("claude-code", join(home, ".claude"), "projects");
    if (env.CLAUDE_CONFIG_DIR) add("claude-code", env.CLAUDE_CONFIG_DIR, "projects");
    const config = join(dirname(expand(env.CODING_AGENT_WEB_DATA || join(home, ".coding-agent-web", "data.db"), home)), "claude-code.json");
    try {
      const profiles = object(JSON.parse(await readFile(config, "utf8"))).profiles;
      if (!Array.isArray(profiles)) failed = true;
      else for (const raw of profiles) {
        const profile = object(raw);
        if (typeof profile.configDir === "string") roots.push({ harness: "claude-code", path: join(expand(profile.configDir, home), "projects"), provider: text(profile.provider) ?? undefined });
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") failed = true; }
  }
  roots.push(...(options.roots ?? []).map((root) => ({ ...root, path: expand(root.path, home) })));
  // Prefer configured profile attribution over the anonymous default root.
  const unique = new Map<string, UsageRoot>();
  for (const root of roots) {
    let path = root.path;
    try { path = await realpath(path); } catch { /* report inaccessible roots while enumerating */ }
    const key = `${root.harness}:${path}`;
    unique.set(key, { ...unique.get(key), ...root, path });
  }
  return { roots: [...unique.values()], failed };
}

function isSessionFile(harness: UsageHarness, file: string): boolean {
  const name = basename(file);
  if (harness === "dsh") return /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/.test(name);
  if (harness === "grok") return ["usage.json", "events.jsonl", "chat_history.jsonl"].includes(name);
  return name.endsWith(".jsonl") && name !== "sessions-index.jsonl";
}

async function enumerate(root: UsageRoot, source: UsageSourceDiagnostic): Promise<string[]> {
  const files: string[] = [];
  const visited = new Set<string>();
  async function visit(path: string, isRoot = false): Promise<void> {
    try {
      const canonical = await realpath(path);
      if (visited.has(canonical)) return;
      visited.add(canonical);
      const info = await stat(path);
      if (info.isFile()) { if (isSessionFile(root.harness, path)) files.push(canonical); return; }
      if (!info.isDirectory()) return;
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (entry.isDirectory() || entry.isSymbolicLink()) await visit(join(path, entry.name));
        else if (entry.isFile() && isSessionFile(root.harness, entry.name)) files.push(join(canonical, entry.name));
      }
    } catch (error) {
      if (isRoot && (error as NodeJS.ErrnoException).code === "ENOENT") { limitation(source, "root_not_found"); return; }
      source.unreadableFiles++;
      limitation(source, "discovery_failed");
    }
  }
  await visit(root.path, true);
  if (root.harness !== "dsh") return files.sort();
  const newest = new Map<string, { file: string; version: number }>();
  for (const file of files) {
    const version = Number(/\.v(\d+)\./.exec(file)?.[1] ?? 0);
    const previous = newest.get(dirname(file));
    if (!previous || previous.version < version || (previous.version === version && file.endsWith(".zstd"))) newest.set(dirname(file), { file, version });
  }
  if (newest.size < files.length) limitation(source, "superseded_log_generations_excluded");
  return [...newest.values()].map((entry) => entry.file).sort();
}

/** Exact Zstandard frame boundaries, rather than searching compressed payload for magic bytes. */
function frameLength(buffer: Buffer): number | null {
  if (buffer.length < 5) return null;
  const magic = buffer.readUInt32LE(0);
  if ((magic & 0xfffffff0) >>> 0 === 0x184d2a50) {
    if (buffer.length < 8) return null;
    const size = 8 + buffer.readUInt32LE(4);
    return buffer.length >= size ? size : null;
  }
  if (magic !== 0xfd2fb528) throw new Error("invalid_zstd_frame");
  const descriptor = buffer[4];
  if (descriptor & 8) throw new Error("invalid_zstd_header");
  const single = !!(descriptor & 32);
  const flag = descriptor >>> 6;
  let offset = 5 + (single ? 0 : 1) + [0, 1, 2, 4][descriptor & 3] + (flag === 0 ? (single ? 1 : 0) : [0, 2, 4, 8][flag]);
  if (buffer.length < offset) return null;
  while (true) {
    if (buffer.length < offset + 3) return null;
    const block = buffer.readUIntLE(offset, 3);
    const type = (block >>> 1) & 3;
    if (type === 3) throw new Error("invalid_zstd_block");
    offset += 3 + (type === 1 ? 1 : block >>> 3);
    if (buffer.length < offset) return null;
    if (block & 1) {
      offset += descriptor & 4 ? 4 : 0;
      return buffer.length >= offset ? offset : null;
    }
  }
}

async function* decodedFrames(file: string, source: UsageSourceDiagnostic, signal?: AbortSignal): AsyncGenerator<string> {
  const input = createReadStream(file, { signal });
  const decoder = new StringDecoder("utf8");
  let pending = Buffer.alloc(0);
  try {
    for await (const chunk of input) {
      pending = Buffer.concat([pending, chunk]);
      let size: number | null;
      while ((size = frameLength(pending)) !== null) {
        const frame = pending.subarray(0, size);
        if (frame.readUInt32LE(0) === 0xfd2fb528) yield decoder.write(zstdDecompressSync(frame));
        pending = pending.subarray(size);
      }
    }
    if (pending.length) limitation(source, "incomplete_compressed_tail_skipped");
    const tail = decoder.end();
    if (tail) yield tail;
  } finally { input.destroy(); }
}

async function scanLines(file: string, source: UsageSourceDiagnostic, callback: (record: ObjectValue) => void, signal?: AbortSignal): Promise<void> {
  source.files++;
  const stream = file.endsWith(".zstd") ? Readable.from(decodedFrames(file, source, signal)) : createReadStream(file, { signal, encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      signal?.throwIfAborted();
      if (!line.trim()) continue;
      let record: unknown;
      try { record = JSON.parse(line); } catch { source.invalidRecords++; limitation(source, "malformed_records_skipped"); continue; }
      if (!record || typeof record !== "object" || Array.isArray(record)) { source.invalidRecords++; continue; }
      source.records++;
      callback(record as ObjectValue);
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    source.unreadableFiles++;
    limitation(source, file.endsWith(".zstd") ? "read_or_decompression_failed" : "read_failed");
  } finally { lines.close(); stream.destroy(); }
}

function toolIds(message: ObjectValue): Set<string> {
  const tools = new Set<string>();
  const blocks = Array.isArray(message.content) ? message.content : [];
  for (const [index, raw] of blocks.entries()) {
    const block = object(raw);
    if (["toolCall", "tool_use", "tool-call"].includes(String(block.type))) tools.add(text(block.id, block.toolCallId) ?? `block:${index}`);
  }
  if (Array.isArray(message.tool_calls)) for (const [index, raw] of message.tool_calls.entries()) tools.add(text(object(raw).id) ?? `call:${index}`);
  return tools;
}

/** Full-history scan. No file writes, pricing estimates, credential reads, or model requests. */
export async function collectUsage(options: CollectUsageOptions = {}): Promise<UsageSnapshot> {
  for (const day of [options.startDay, options.endDay]) if (day !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(day) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day)) throw new Error("Invalid usage calendar day");
  if (options.startDay && options.endDay && options.startDay > options.endDay) throw new Error("Invalid usage day range");
  options.signal?.throwIfAborted();
  const timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
  const calendar = (time: number) => {
    const parts = Object.fromEntries(formatter.formatToParts(time).map((part) => [part.type, part.value]));
    return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
  };
  const discovered = await discover(options);
  options.signal?.throwIfAborted();
  const diagnostics: UsageSourceDiagnostic[] = [];
  const events = new Map<string, Event>();
  const seenFiles = new Set<string>();
  const save = (event: Event, source: UsageSourceDiagnostic) => {
    if (event.time === null) { source.missingTimestamps++; limitation(source, "undated_events_excluded"); return; }
    const key = `${event.harness}:${event.key}`;
    const previous = events.get(key);
    if (!previous) { events.set(key, event); return; }
    source.duplicates++;
    // A repeated assistant ID is a cumulative snapshot or another content block of one response.
    // Keep component maxima, never sum snapshots; union tool IDs across content fragments.
    for (const field of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens", "requests", "messages", "errors"] as const) previous.metrics[field] = Math.max(previous.metrics[field], event.metrics[field]);
    if (event.metrics.cost !== null) previous.metrics.cost = Math.max(previous.metrics.cost ?? 0, event.metrics.cost);
    for (const tool of event.tools) previous.tools.add(tool);
    previous.model ??= event.model;
    previous.provider ??= event.provider;
  };

  for (const root of discovered.roots) {
    const source: UsageSourceDiagnostic = { harness: root.harness, root: root.path, files: 0, records: 0, duplicates: 0, invalidRecords: 0, missingTimestamps: 0, unreadableFiles: 0, limitations: [] };
    diagnostics.push(source);
    const files = await enumerate(root, source);
    const fileSet = new Set(files);
    for (const file of files) {
      options.signal?.throwIfAborted();
      const fileKey = `${root.harness}:${file}`;
      if (seenFiles.has(fileKey)) { source.duplicates++; continue; }
      seenFiles.add(fileKey);
      let session = hash(`${root.harness}:${root.harness === "dsh" || root.harness === "grok" ? dirname(file) : basename(file, ".jsonl")}`);
      let model: string | null = root.model ?? null;
      let provider: string | null = root.provider ?? null;
      let lineIndex = 0;
      const makeEvent = (key: string, time: unknown, metrics = emptyMetrics(), tools = new Set<string>()): Event => ({ key, time: timestamp(time), session, harness: root.harness, model, provider, metrics, tools });

      if (root.harness === "grok" && basename(file) === "usage.json") {
        source.files++;
        try {
          const ledger = object(JSON.parse(await readFile(file, { encoding: "utf8", signal: options.signal })));
          if (Array.isArray(ledger.turns)) for (const raw of ledger.turns) {
            options.signal?.throwIfAborted();
            source.records++;
            const turn = object(raw);
            const models = object(turn.modelUsage);
            const entries = Object.keys(models).length ? Object.entries(models) : [[text(turn.primaryModelId) ?? "", turn]] as const;
            for (const [modelId, rawUsage] of entries) {
              model = modelId || null;
              provider = "xai";
              const usage = object(rawUsage);
              const metrics = usageMetrics(usage, source);
              metrics.requests = number(usage.modelCalls);
              save(makeEvent(`ledger:${session}:${String(turn.turnNumber ?? turn.endedAt)}:${model}`, turn.endedAt, metrics), source);
            }
          }
          limitation(source, "turn_usage_attributed_to_end_time");
          limitation(source, "session_cumulative_usage_excluded");
        } catch (error) {
          if (options.signal?.aborted) throw error;
          if ((error as Error).name === "SyntaxError") { source.invalidRecords++; limitation(source, "malformed_usage_ledger"); }
          else { source.unreadableFiles++; limitation(source, "read_failed"); }
        }
        continue;
      }

      const grokEvents = root.harness === "grok" && fileSet.has(join(dirname(file), "events.jsonl"));
      const grokLedger = root.harness === "grok" && fileSet.has(join(dirname(file), "usage.json"));
      if (root.harness === "grok" && basename(file) === "chat_history.jsonl" && grokEvents) { limitation(source, "history_counts_use_timestamped_events"); continue; }
      await scanLines(file, source, (record) => {
        lineIndex++;
        const type = String(record.type ?? "");
        if (root.harness === "pi") {
          if (type === "session") { session = hash(`pi:${text(record.id) ?? basename(file)}`); return; }
          if (type === "model_change") { model = text(record.modelId, record.model); provider = text(record.provider); return; }
          const message = object(record.message);
          if (type !== "message" && !["usage", "compaction", "branch_summary"].includes(type)) return;
          const role = String(message.role ?? "");
          const rawUsage = type === "message" ? message.usage : record.usage;
          if (type !== "message" && !rawUsage) return;
          model = text(message.model, record.model, model);
          provider = text(message.provider, record.provider, provider);
          const metrics = usageMetrics(rawUsage, source);
          metrics.messages = type === "message" ? 1 : 0;
          metrics.requests = role === "assistant" || rawUsage ? 1 : 0;
          metrics.errors = message.isError === true || message.stopReason === "error" || message.errorMessage ? 1 : 0;
          const identity = text(record.id);
          const event = makeEvent(identity ? `entry:${identity}:${String(record.timestamp ?? message.timestamp)}` : `line:${session}:${lineIndex}`, record.timestamp ?? message.timestamp, metrics, toolIds(message));
          save(event, source);
          if (!identity) limitation(source, "records_without_ids_cannot_deduplicate_forks");
          return;
        }

        if (root.harness === "claude-code") {
          if (type === "cost-state" || type === "result") { limitation(source, "cumulative_cost_and_usage_excluded"); return; }
          if (type !== "assistant" && type !== "user") return;
          if (record.isCompactSummary || record.isMeta) return;
          const message = object(record.message);
          const role = String(message.role ?? type);
          const blocks = Array.isArray(message.content) ? message.content.map(object) : [];
          if (message.model === "<synthetic>") return;
          model = text(message.model, model);
          provider = text(message.provider, record.provider, provider);
          const metrics = usageMetrics(message.usage, source);
          metrics.messages = 1;
          metrics.requests = role === "assistant" ? 1 : 0;
          metrics.errors = record.isApiErrorMessage || blocks.some((block) => block.type === "tool_result" && block.is_error) || message.stop_reason === "error" ? 1 : 0;
          const id = role === "assistant" ? text(message.id, record.uuid) : text(record.uuid, message.id);
          save(makeEvent(id ? `${role}:${id}` : `line:${session}:${lineIndex}`, record.timestamp ?? message.timestamp, metrics, toolIds(message)), source);
          if (!provider) limitation(source, "provider_not_recorded");
          limitation(source, "requests_inferred_from_assistant_ids");
          return;
        }

        if (root.harness === "dsh") {
          if (type === "session") { session = hash(`dsh:${text(record.id) ?? dirname(file)}`); return; }
          const data = object(record.data);
          if (type === "request/context") { model = text(data.model, model); provider = text(data.provider, provider); return; }
          const message = type === "user/message" ? data : object(data.message);
          if (type === "user/message" && object(data.source).kind !== "user") return;
          if (!["user/message", "assistant/message", "tool/result", "usage", "request/usage"].includes(type)) return;
          model = text(object(message.source).model, data.model, model);
          provider = text(object(message.source).provider, data.provider, provider);
          const metrics = usageMetrics(data.usage ?? message.usage ?? (type.includes("usage") ? data : undefined), source);
          metrics.messages = type.includes("message") || type === "tool/result" ? 1 : 0;
          metrics.requests = type === "assistant/message" || type.includes("usage") ? 1 : 0;
          metrics.errors = message.isError === true || message.stopReason === "error" ? 1 : 0;
          const id = text(message.id, data.id);
          save(makeEvent(id ? `message:${id}` : `seq:${session}:${String(record.seq ?? lineIndex)}`, record.time ?? record.timestamp, metrics, toolIds(message)), source);
          limitation(source, "requests_inferred_from_assistant_messages");
          return;
        }

        // Native Grok histories omit time/usage; use the time-bearing event journal and turn ledger.
        model = text(record.model_id, record.model, model);
        provider = text(record.provider, provider) ?? "xai";
        const metrics = emptyMetrics();
        const tools = new Set<string>();
        if (basename(file) === "events.jsonl") {
          if (type === "turn_started" || type === "first_token") metrics.messages = 1;
          else if (type === "tool_completed") { metrics.messages = 1; tools.add(text(record.tool_call_id) ?? `line:${lineIndex}`); metrics.errors = record.outcome === "error" || record.outcome === "failed" ? 1 : 0; }
          else if (type === "turn_ended") { metrics.errors = record.outcome === "error" || record.outcome === "failed" ? 1 : 0; }
          else if (type === "usage" && !grokLedger) {
            Object.assign(metrics, usageMetrics(record.usage, source)); metrics.requests = 1;
          } else return;
          limitation(source, "message_counts_inferred_from_events");
          if (!grokLedger) limitation(source, "usage_ledger_missing");
        } else {
          if (!["assistant", "user", "tool_result"].includes(type) || record.synthetic_reason) return;
          Object.assign(metrics, usageMetrics(grokLedger ? undefined : record.usage, source));
          metrics.messages = 1;
          metrics.requests = type === "assistant" && !grokLedger ? 1 : 0;
          for (const id of toolIds(record)) tools.add(id);
        }
        save(makeEvent(`grok:${session}:${basename(file)}:${text(record.id, record.uuid) ?? lineIndex}`, record.ts ?? record.timestamp ?? record.time, metrics, tools), source);
      }, options.signal);
    }
  }

  options.signal?.throwIfAborted();
  const groups = new Map<string, { bucket: UsageBucket; sessions: Set<string> }>();
  const dayGroups = new Map<string, { summary: UsageDaySummary; sessions: Set<string> }>();
  const inRange = (day: string) => (!options.startDay || day >= options.startDay) && (!options.endDay || day <= options.endDay);
  for (const event of events.values()) {
    const date = calendar(event.time!);
    if (!inRange(date.day)) continue;
    event.metrics.toolCalls = event.tools.size;
    if (event.metrics.requests) {
      if (event.metrics.cost === null) event.metrics.costUnknownRequests = event.metrics.requests;
      else event.metrics.costKnownRequests = event.metrics.requests;
    }
    for (const hour of [-1, date.hour]) {
      const key = JSON.stringify([date.day, hour, event.harness, event.model, event.provider]);
      let group = groups.get(key);
      if (!group) {
        group = { bucket: { ...emptyMetrics(), day: date.day, hour, harness: event.harness, model: event.model, provider: event.provider, sessionIds: [] }, sessions: new Set() };
        groups.set(key, group);
      }
      addMetrics(group.bucket, event.metrics);
      group.sessions.add(event.session);
    }
    let day = dayGroups.get(date.day);
    if (!day) { day = { summary: { day: date.day, ...emptyMetrics() }, sessions: new Set() }; dayGroups.set(date.day, day); }
    addMetrics(day.summary, event.metrics);
    day.sessions.add(event.session);
  }
  // Include today even on a pristine installation. Explicit ranges include empty dates for replacement.
  const today = calendar(Date.now()).day;
  if (inRange(today) && !dayGroups.has(today)) dayGroups.set(today, { summary: { day: today, ...emptyMetrics() }, sessions: new Set() });
  if (options.startDay && options.endDay) {
    for (let day = options.startDay; day <= options.endDay; day = new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)) {
      if (!dayGroups.has(day)) dayGroups.set(day, { summary: { day, ...emptyMetrics() }, sessions: new Set() });
    }
  }
  const buckets = [...groups.values()].map(({ bucket, sessions }) => ({ ...bucket, sessions: sessions.size, sessionIds: [...sessions].sort() })).sort((a, b) => a.day.localeCompare(b.day) || a.hour - b.hour || a.harness.localeCompare(b.harness) || (a.model ?? "").localeCompare(b.model ?? "") || (a.provider ?? "").localeCompare(b.provider ?? ""));
  const days = [...dayGroups.values()].map(({ summary, sessions }) => ({ ...summary, sessions: sessions.size })).sort((a, b) => a.day.localeCompare(b.day));
  if (discovered.failed) {
    diagnostics.push({ harness: "claude-code", root: "claude-code.json", files: 0, records: 0, duplicates: 0, invalidRecords: 0, missingTimestamps: 0, unreadableFiles: 1, limitations: ["profile_discovery_failed"] });
  }
  return { schemaVersion: 1, collectedAt: new Date().toISOString(), timeZone, startDay: options.startDay ?? null, endDay: options.endDay ?? null, complete: !diagnostics.some((source) => source.unreadableFiles > 0), days, buckets, diagnostics };
}
