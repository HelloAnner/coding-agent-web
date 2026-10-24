import { randomUUID } from "node:crypto";
import type { Agent, ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  getSupportedThinkingLevels,
  normalizeContext,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

const TITLE_TIMEOUT_MS = 90_000;
// Reasoning is billed as output on models that think before answering: at 256
// a longer thought spent the whole budget and the reply carried no text at all.
const TITLE_MAX_TOKENS = 1024;
const MAX_TITLE_CHARS = 15;
const MAX_TITLE_WORDS = 15;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

// Per-message caps. A title needs what the user asked for (every user turn,
// including mid-session pivots) and what came out of it (the last reply); the
// replies in between only need their opening line. Tool calls and results are
// dropped outright: they dominate the token count and say nothing about intent.
const USER_CHARS = 800;
const ASSISTANT_CHARS = 300;
const LAST_ASSISTANT_CHARS = 600;
const SUMMARY_CHARS = 600;
// Total budget across all messages. Without it the transcript still grows with
// the session, and a long session ends up costing more than replaying a cached
// prefix would have.
const TRANSCRIPT_CHARS = 6000;
// Share of the budget reserved for the opening turns. A session often states
// its goal early and then drifts into routine follow-ups, so spending the whole
// budget on the newest turns can title a session after its last chore.
const TRANSCRIPT_HEAD_CHARS = Math.round(TRANSCRIPT_CHARS * 0.4);

const TITLE_SYSTEM_PROMPT =
  "You name chat sessions from a transcript. Reply with the title only.";

const ELISION = "[…]";
const IMAGE_PLACEHOLDER = "[image]";

const TITLE_PROMPT = `Create a concise title for this session based on the conversation above.

Requirements:
- Match the primary language used by the user.
- Describe the user's concrete goal or the outcome, not the act of chatting.
- At most ${MAX_TITLE_CHARS} characters for CJK text, at most ${MAX_TITLE_WORDS} words for space-separated languages.
- Count the characters before answering: a title over the limit is sent back for a rewrite.
- Do not call any tools.
- Return only the title as plain text, with no quotes, label, markdown, or explanation.`;

/** The single user turn a title model reads: the transcript plus what to do with it. */
export function buildTitlePrompt(transcript: string): string {
  return `${transcript}\n\n${TITLE_PROMPT}`;
}

/**
 * The second turn a too-long title gets. The title is never cut to fit: a cut
 * lands mid-phrase and leaves a label nobody can read, so the model is asked
 * for the same meaning in fewer characters instead.
 */
export function shortenTitleInstruction(title: string): string {
  return `This session title is too long:\n\n${title}\n\nRewrite it with the same meaning in at most ${MAX_TITLE_CHARS} characters for CJK text, or at most ${MAX_TITLE_WORDS} words for space-separated languages. Return only the title as plain text, with no quotes, label, markdown, or explanation.`;
}

/** Whether a title is inside the limit the prompt asks for. */
export function titleFitsLimit(title: string): boolean {
  return CJK.test(title)
    ? Array.from(title).length <= MAX_TITLE_CHARS
    : title.split(/\s+/).filter(Boolean).length <= MAX_TITLE_WORDS;
}

/**
 * The title as the model first wrote it, rewritten by the model while it is
 * over the limit. Two rewrites is where a model that keeps missing the limit
 * would cost more than the label is worth, so the last answer stands.
 */
export async function fitTitleInLimit(
  first: string,
  rewrite: (instruction: string) => Promise<string>,
): Promise<string> {
  let title = parseGeneratedSessionTitle(first);
  for (let attempt = 0; attempt < 2 && !titleFitsLimit(title); attempt += 1) {
    title = parseGeneratedSessionTitle(await rewrite(shortenTitleInstruction(title)));
  }
  return title;
}

export interface GeneratedSessionTitle {
  title: string;
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export interface TitleRequest {
  model: Model<Api>;
  context: Context;
  options: SimpleStreamOptions;
}

/**
 * Naming is a short classification task, so thinking only adds latency and
 * tokens: use the cheapest level the model actually supports. Gemini rejects
 * "minimal" and its SDK emits that level when thinking is disabled, so it
 * skips to the next supported level instead.
 */
export function resolveTitleThinkingLevel(model: Model<Api>): ThinkingLevel {
  if (!model.reasoning) return "off";
  // getSupportedThinkingLevels lists levels in ascending cost order.
  const supported = getSupportedThinkingLevels(model);
  const rejectsMinimal = model.api === "google-generative-ai" || /gemini/i.test(model.id);
  const usable = rejectsMinimal ? supported.filter((level) => level !== "off" && level !== "minimal") : supported;
  return usable[0] ?? supported[0] ?? "off";
}

/**
 * One-shot stream options for a title request. Same idea as compact's
 * summarization path: a short system prompt, one user turn, no tools, a fresh
 * session id, and cacheRetention "none". The request is too small and too
 * unique to reuse the live session's prefix or write a cache nobody will read.
 */
export function buildTitleRequest(source: Agent, userText: string): TitleRequest {
  const model = source.state.model;
  const thinkingLevel = resolveTitleThinkingLevel(model);
  return {
    model,
    context: {
      systemPrompt: TITLE_SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: [{ type: "text", text: userText }],
        timestamp: Date.now(),
      }],
    },
    options: {
      maxTokens: TITLE_MAX_TOKENS,
      cacheRetention: "none",
      sessionId: randomUUID(),
      transport: source.transport,
      thinkingBudgets: source.thinkingBudgets,
      maxRetryDelayMs: source.maxRetryDelayMs,
      ...(thinkingLevel !== "off" ? { reasoning: thinkingLevel } : {}),
    },
  };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  let images = 0;
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const type = (block as { type?: string }).type;
    if (type === "text" && typeof (block as { text?: unknown }).text === "string") {
      parts.push((block as { text: string }).text);
    } else if (type === "image") {
      images += 1;
    }
  }
  const text = parts.join("\n").trim();
  if (images === 0) return text;
  const marker = images === 1 ? IMAGE_PLACEHOLDER : `${IMAGE_PLACEHOLDER} ×${images}`;
  return text ? `${text}\n${marker}` : marker;
}

function clip(text: string, max: number): string {
  const characters = Array.from(text);
  return characters.length <= max ? text : `${characters.slice(0, max).join("")}…`;
}

/**
 * A title needs the goal the session opened with and the outcome it reached.
 * The middle is what makes a long session expensive, so keep both ends and drop
 * it. Cost and latency then stop tracking session length.
 */
function boundTranscript(lines: string[]): string {
  const joined = lines.join("\n\n");
  if (joined.length <= TRANSCRIPT_CHARS || lines.length < 2) return joined;

  const head: string[] = [];
  let used = ELISION.length + 4;
  let next = 0;
  // The first line always survives, however long the session is.
  for (; next < lines.length; next++) {
    const size = used + lines[next].length + 2;
    if (head.length > 0 && size > TRANSCRIPT_HEAD_CHARS) break;
    head.push(lines[next]);
    used = size;
  }

  const tail: string[] = [];
  for (let i = lines.length - 1; i >= next; i--) {
    const size = used + lines[i].length + 2;
    if (size > TRANSCRIPT_CHARS) break;
    tail.unshift(lines[i]);
    used = size;
  }

  // Everything fit after all: the budget only looked tight because of joins.
  if (next + tail.length >= lines.length) return joined;
  return [...head, ELISION, ...tail].join("\n\n");
}

/**
 * What a title needs from a message. Structural on purpose: pi's own messages
 * and the ones the harness transcripts produce are different types that agree
 * on these fields.
 */
export interface TitleSourceMessage {
  role: string;
  content?: unknown;
  summary?: string;
  command?: string;
}

function lineForMessage(message: TitleSourceMessage, lastAssistant?: TitleSourceMessage): string | undefined {
  if (message.role === "compactionSummary" || message.role === "branchSummary") {
    const summary = message.summary?.trim() ?? "";
    if (!summary) return undefined;
    return `[Earlier summary] ${clip(summary, SUMMARY_CHARS)}`;
  }
  if (message.role === "custom") {
    const text = textOf(message.content).trim();
    return text ? `User: ${clip(text, USER_CHARS)}` : undefined;
  }
  if (message.role === "bashExecution") {
    const command = message.command?.trim() ?? "";
    return command ? `User: ${clip(`Ran \`${command}\``, USER_CHARS)}` : undefined;
  }
  if (message.role !== "user" && message.role !== "assistant") return undefined;
  const text = textOf(message.content).trim();
  if (!text) return undefined;
  if (message.role === "user") return `User: ${clip(text, USER_CHARS)}`;
  return `Assistant: ${clip(text, message === lastAssistant ? LAST_ASSISTANT_CHARS : ASSISTANT_CHARS)}`;
}

/** Flatten the session into the plain-text transcript the title model reads. */
export function buildTitleTranscript(messages: TitleSourceMessage[]): string {
  let lastAssistant: TitleSourceMessage | undefined;
  for (const message of messages) {
    if (message.role === "assistant" && textOf(message.content).trim()) lastAssistant = message;
  }

  const lines: string[] = [];
  for (const message of messages) {
    const line = lineForMessage(message, lastAssistant);
    if (line) lines.push(line);
  }
  return boundTranscript(lines);
}

function stripWrappingQuotes(value: string): string {
  const pairs: Array<[string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ["`", "`"],
    ["\u201c", "\u201d"],
    ["\u300c", "\u300d"],
    ["\u300e", "\u300f"],
  ];
  for (const [start, end] of pairs) {
    if (value.startsWith(start) && value.endsWith(end) && value.length > start.length + end.length) {
      return value.slice(start.length, -end.length).trim();
    }
  }
  return value;
}

export function parseGeneratedSessionTitle(raw: string): string {
  let value = raw.trim();
  const fenced = value.match(/^```(?:json|text)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) value = fenced[1].trim();

  if (value.startsWith("{")) {
    try {
      const parsed = JSON.parse(value) as { title?: unknown };
      if (typeof parsed.title === "string") value = parsed.title.trim();
    } catch {
      // Fall back to plain-text cleanup below.
    }
  }

  value = value.split(/\r?\n/, 1)[0] ?? "";
  value = value.replace(/^(?:session\s+title|title|标题)\s*[:：-]\s*/i, "");
  value = stripWrappingQuotes(value).replace(/\s+/g, " ").trim();
  value = value.replace(/[。.!]+$/u, "").trim();

  if (!/[\p{L}\p{N}]/u.test(value)) {
    throw new Error("The model did not return a usable session title");
  }

  // Chinese titles are counted in characters, Latin ones in words. Nothing is
  // cut here: a title over the limit is rewritten by the model (see
  // fitTitleInLimit), never trimmed into a half phrase.
  return value;
}

function titleFromAssistant(message: AssistantMessage): GeneratedSessionTitle {
  if (message.stopReason === "error") {
    throw new Error(message.errorMessage || "The title model request failed");
  }
  if (message.stopReason === "aborted") {
    throw new Error("Session title generation timed out");
  }
  if (message.stopReason === "length") {
    throw new Error("The title model ran out of tokens before answering");
  }
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  if (!text) throw new Error("The model did not return a session title");
  return {
    title: parseGeneratedSessionTitle(text),
    ...(message.usage ? {
      usage: {
        input: message.usage.input,
        output: message.usage.output,
        cacheRead: message.usage.cacheRead,
        cacheWrite: message.usage.cacheWrite,
        total: message.usage.totalTokens,
      },
    } : {}),
  };
}

export async function generateSessionTitle(source: AgentSession): Promise<GeneratedSessionTitle> {
  const sourceAgent = source.agent;
  // Snapshot whatever the session holds right now. The transcript is plain
  // text the model reads once, so a turn still in flight only means the
  // newest reply is missing from it; there is nothing to wait for.
  const transcript = buildTitleTranscript([...sourceAgent.state.messages]);
  if (!transcript.trim()) {
    throw new Error("The session has no usable text to name");
  }
  return askSessionTitleModel(source, buildTitlePrompt(transcript));
}

/** One more title turn on the session's own model, for a rewrite or a retry. */
export async function askSessionTitleModel(source: AgentSession, instruction: string): Promise<GeneratedSessionTitle> {
  const sourceAgent = source.agent;
  const { model, context, options } = buildTitleRequest(sourceAgent, instruction);
  const apiKey = await sourceAgent.getApiKey?.(model.provider);
  const controller = new AbortController();
  const requestOptions: SimpleStreamOptions = {
    ...options,
    signal: controller.signal,
    ...(apiKey ? { apiKey } : {}),
  };

  const timeout = setTimeout(() => controller.abort(), TITLE_TIMEOUT_MS);

  try {
    // Providers read the prompt from the transcript's leading system message.
    const stream = await sourceAgent.streamFunction(model, normalizeContext(context), requestOptions);
    return titleFromAssistant(await stream.result());
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("Session title generation timed out");
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
