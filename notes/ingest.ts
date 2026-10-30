import { basename } from "node:path";
import { readFileSync } from "node:fs";
import { readCatalogSession } from "../lib/catalog-db";
import { listSessionFamilies } from "../lib/session-family";
import { getSessionEntries, listAllSessions, resolveSessionPath } from "../lib/session-reader";
import { isFamilyArchived } from "../lib/session-tree";
import { readSessionUiState } from "../lib/session-ui-state";
import type { AgentMessage, SessionInfo } from "../lib/types";
import type { SessionUiState } from "../lib/session-ui-state-shared";
import type { SessionEntry, SessionMessage, TextContent } from "../lib/types";
import { parseClaudeTranscript, readClaudeTranscript } from "../harness/claude-code/transcript";
import { readDshWebTranscript } from "../harness/dsh/web-session";
import { readGrokTranscript } from "../harness/grok/transcript";
import { readOmpTranscript } from "../harness/omp/transcript";
import { readIngestRows, writeIngestRows, type NotesIngestRow } from "./db";

/**
 * Coding → Notes. The Coding sidebar already knows every harness session and
 * which families the user archived; this module turns that catalogue into the
 * notes agent's reading list, and remembers the version it has already read so
 * a session that has gone quiet is not ingested again.
 *
 * Nothing here writes notes: the agent reads a transcript with notes_sessions
 * and decides what is worth keeping.
 */

export interface CodingSession {
  id: string;
  /** Absolute path of the harness session file. */
  path: string;
  /** Project root: the group this session shows under in Coding. */
  projectRoot: string;
  /** Vault directory this project's notes live in. */
  projectDir: string;
  /** Display name: the user's session name, else the first message. */
  name: string;
  /** Last-message time, ISO; the version the state table compares. */
  modified: string;
  messageCount: number;
  /** True while this session is quiet and the vault has not seen this version. */
  pending: boolean;
}

/** The transcript the agent reads is capped: the tail holds the conclusions. */
const MAX_TRANSCRIPT_CHARS = 20_000;
const MAX_DIR_NAME = 60;
/** A session still being written waits: rereading it every tick is churn. */
const SETTLE_MS = 90_000;

function cleanDirName(value: string): string {
  return value
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, MAX_DIR_NAME);
}

/**
 * The vault directory for a project: its folder name. Worktrees share a
 * projectRoot, so they land in one directory, which is the point.
 */
export function projectDirName(projectRoot: string): string {
  return cleanDirName(basename(projectRoot)) || "项目";
}

function textOf(content: string | readonly (TextContent | { type: string })[]): string {
  if (typeof content === "string") return content.trim();
  return content
    .map((block) => (block.type === "text" ? String((block as TextContent).text ?? "") : ""))
    .join("\n")
    .trim();
}

/** The tail of a too-long transcript: the conclusions live at the end. */
function clip(text: string): string {
  if (text.length <= MAX_TRANSCRIPT_CHARS) return text;
  return `（前 ${text.length - MAX_TRANSCRIPT_CHARS} 字符省略，以下是最新的部分）\n\n${text.slice(-MAX_TRANSCRIPT_CHARS)}`;
}

/**
 * A transcript as readable text: **only what the user asked and what the
 * assistant answered**. Tool calls, tool results and thinking are the haystack,
 * not the knowledge, so they never enter the text the notes agent reads.
 *
 * Every harness ends up here after its own parser has read its own file format,
 * so what counts as a turn is decided once.
 */
export function messagesTranscript(messages: readonly AgentMessage[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const text = textOf(message.content as string | readonly TextContent[]);
      if (text) parts.push(`## 用户\n${text}`);
      continue;
    }
    if (message.role !== "assistant") continue;
    const answer = message.content
      .filter((block): block is TextContent => block.type === "text")
      .map((block) => block.text.trim())
      .filter(Boolean)
      .join("\n\n");
    if (answer) parts.push(`## 助手\n${answer}`);
  }
  return clip(parts.join("\n\n"));
}

/** pi's own session file: the message entries, read like every other harness. */
export function sessionTranscript(entries: readonly SessionEntry[]): string {
  const messages = entries
    .filter((entry) => entry.type === "message")
    .map((entry) => (entry as { message: SessionMessage }).message)
    .filter((message): message is SessionMessage => typeof message === "object" && message !== null);
  return messagesTranscript(messages.filter((message) => message.role !== "system"));
}

const NO_RUNNING: ReadonlySet<string> = new Set();

/**
 * The reading list out of a catalogue scan: every non-archived session with
 * content, newest first, marked with whether it is ready to read. Subagents
 * ride along in their parent's transcript, and a session with no message has
 * nothing to keep. A session still being written is not ready: the agent would
 * otherwise rewrite the same note after every turn.
 */
export function codingSessions(
  catalog: readonly SessionInfo[],
  uiState: SessionUiState,
  known: ReadonlyMap<string, NotesIngestRow>,
  now = Date.now(),
): CodingSession[] {
  const sessions: CodingSession[] = [];
  for (const family of listSessionFamilies(catalog)) {
    const root = family.root;
    if (root.messageCount <= 0) continue;
    if (isFamilyArchived(family, uiState, NO_RUNNING)) continue;
    if (now - Date.parse(root.modified) < SETTLE_MS) continue;
    const projectRoot = root.projectRoot || root.cwd;
    const seen = known.get(root.id);
    sessions.push({
      id: root.id,
      path: root.path,
      projectRoot,
      projectDir: projectDirName(projectRoot),
      name: root.name?.trim() || root.firstMessage.slice(0, 40) || root.id,
      modified: root.modified,
      messageCount: root.messageCount,
      pending: !seen || seen.modified !== root.modified || seen.messageCount !== root.messageCount,
    });
  }
  return sessions.sort((a, b) => b.modified.localeCompare(a.modified));
}

/** The catalogue, read fresh: what Coding shows, minus the archived families. */
export async function listCodingSessions(): Promise<CodingSession[]> {
  return codingSessions(await listAllSessions(), readSessionUiState(), readIngestRows());
}

/** The task prompt: which sessions this run reads, and where their notes go. */
export function sessionsPrompt(sessions: readonly CodingSession[], queued = 0): string {
  const lines = ["本轮要读的 Coding 会话（按最近活动排序）：", ""];
  for (const session of sessions) {
    lines.push(`- 「${session.name}」（id \`${session.id}\`）`);
    lines.push(`  来自 ${session.projectDir}（${session.projectRoot}），只是出处，不要拿它当笔记目录`);
    lines.push(`  最后活动 ${session.modified}，共 ${session.messageCount} 条消息`);
  }
  lines.push("");
  lines.push("用 notes_sessions action=read session=<id> 读正文，把有价值的内容并进白板。");
  lines.push("笔记库按场景分，不按项目分：先按内容判断这条对话属于哪个场景（项目、面试、AI、工具……）和哪个主题，再去找该主题下已有的白板。");
  if (queued > 0) lines.push(`另有 ${queued} 个会话在排队，下一轮再看。`);
  return lines.join("\n\n");
}

/** Remember that these versions have been read, so they are not read twice. */
export function claimSessions(sessions: readonly CodingSession[]): void {
  writeIngestRows(sessions.map((session) => ({
    sessionId: session.id,
    path: session.path,
    project: session.projectRoot,
    modified: session.modified,
    messageCount: session.messageCount,
  })));
}

/** One session's transcript, or null when the id names no session on disk. */
export async function readCodingSession(id: string): Promise<string | null> {
  // Each harness writes its own file format, so each one is read by its own
  // parser and then reduced to the same two kinds of text: what the user asked
  // and what the assistant answered.
  const row = readCatalogSession(id);
  if (row) {
    if (row.harness === "claude-code") {
      const messages = row.profilePath
        ? readClaudeTranscript(row.profilePath, id).messages
        : parseClaudeTranscript(readFileSync(row.sessionPath, "utf8"));
      return messagesTranscript(messages);
    }
    if (row.harness === "omp") return messagesTranscript(readOmpTranscript(id, row.sessionPath).messages);
    if (row.harness === "dsh") return messagesTranscript((await readDshWebTranscript(id)).messages);
    if (row.harness === "grok") return messagesTranscript(readGrokTranscript(row.cwd, id).messages);
  }
  const filePath = await resolveSessionPath(id);
  if (!filePath) return null;
  return sessionTranscript(getSessionEntries(filePath));
}
