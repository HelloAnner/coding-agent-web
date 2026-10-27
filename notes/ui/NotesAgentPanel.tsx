"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { MarkdownBody } from "@/components/MarkdownBody";
import type { NotesAgentEvent, NotesAgentState, NotesChatMessage } from "@/notes/types";

/**
 * The notes agent panel: a multi-turn chat beside the note or board. The turn
 * is streamed from /api/notes/agent as NDJSON, one event per line; the panel
 * assembles bubbles from those events, and a reload asks the server for the
 * whole conversation again.
 */

const TOOL_LABELS: Record<string, string> = {
  read: "读取",
  ls: "列目录",
  notes_write: "写笔记",
  notes_board: "画白板",
};

function AssistantMessage({ message }: { message: NotesChatMessage }) {
  return (
    <div className="notes-agent-message is-assistant">
      {message.thinking && (
        <details className="notes-agent-thinking">
          <summary>思考过程</summary>
          <div>{message.thinking}</div>
        </details>
      )}
      {message.text && (
        <div className="notes-agent-text">
          <MarkdownBody isStreaming={false}>{message.text}</MarkdownBody>
        </div>
      )}
      {message.tools?.map((tool) => (
        <details key={tool.id} className={`notes-agent-tool is-${tool.status}`}>
          <summary>
            <span className="notes-agent-tool-dot" aria-hidden="true" />
            <span className="notes-agent-tool-name">{TOOL_LABELS[tool.name] ?? tool.name}</span>
            <code className="notes-agent-tool-args">{tool.args}</code>
          </summary>
          {tool.output ? <pre className="notes-agent-tool-output">{tool.output}</pre> : null}
        </details>
      ))}
    </div>
  );
}

export function NotesAgentPanel({
  open,
  contextPath,
  onClose,
  onOpenSettings,
  onVaultChanged,
}: {
  open: boolean;
  /** The note or board on screen; sent with the message as context. */
  contextPath: string | null;
  onClose: () => void;
  onOpenSettings: () => void;
  /** Called with the vault paths the agent wrote, when a turn ends. */
  onVaultChanged: (paths: string[]) => void;
}) {
  const [messages, setMessages] = useState<NotesChatMessage[]>([]);
  const [skills, setSkills] = useState<NotesAgentState["skills"]>([]);
  const [model, setModel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const assistantId = useRef<string | null>(null);
  const touched = useRef<Set<string>>(new Set());
  const logRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/notes/agent", { cache: "no-store" });
      const state = await response.json() as NotesAgentState & { error?: string };
      if (!response.ok) throw new Error(state.error || "读取对话失败");
      setMessages(state.messages);
      setSkills(state.skills ?? []);
      setModel(state.model);
      setBusy(state.busy);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "读取对话失败");
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  // The log follows the newest line unless the reader scrolled up to reread.
  useEffect(() => {
    const log = logRef.current;
    if (!log) return;
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 120;
    if (nearBottom) log.scrollTop = log.scrollHeight;
  }, [messages]);

  const apply = (event: NotesAgentEvent) => {
    if (event.type === "message") {
      setMessages((current) => [...current, event.message]);
      return;
    }
    if (event.type === "assistant_start") {
      assistantId.current = event.id;
      setMessages((current) => [...current, { id: event.id, role: "assistant", text: "" }]);
      return;
    }
    if (event.type === "text" || event.type === "thinking") {
      const id = assistantId.current;
      if (!id) return;
      setMessages((current) => current.map((message) => {
        if (message.id !== id) return message;
        return event.type === "text"
          ? { ...message, text: message.text + event.delta }
          : { ...message, thinking: `${message.thinking ?? ""}${event.delta}` };
      }));
      return;
    }
    if (event.type === "tool_start") {
      const id = assistantId.current;
      if (!id) return;
      try {
        const path = (JSON.parse(event.tool.args) as { path?: unknown }).path;
        if (typeof path === "string") touched.current.add(path);
      } catch {
        // Arguments are shown as-is; only a path we can read is a vault update.
      }
      setMessages((current) => current.map((message) => (message.id === id
        ? { ...message, tools: [...(message.tools ?? []), event.tool] }
        : message)));
      return;
    }
    if (event.type === "tool_end") {
      setMessages((current) => current.map((message) => (message.tools
        ? {
            ...message,
            tools: message.tools.map((tool) => (tool.id === event.id
              ? { ...tool, status: event.status, output: event.output }
              : tool)),
          }
        : message)));
      return;
    }
    if (event.type === "error") {
      setError(event.message);
      return;
    }
    if (event.type === "done") {
      setBusy(false);
      const paths = [...touched.current];
      touched.current = new Set();
      if (paths.length > 0) onVaultChanged(paths);
    }
  };

  const send = async (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    setError(null);
    setBusy(true);
    touched.current = new Set();
    assistantId.current = null;
    const message = contextPath ? `（当前打开：${contextPath}）\n\n${text}` : text;
    try {
      const response = await fetch("/api/notes/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      if (!response.ok || !response.body) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error || "发送失败");
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          apply(JSON.parse(line) as NotesAgentEvent);
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "发送失败");
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    await fetch("/api/notes/agent", { method: "DELETE" }).catch(() => undefined);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send(event);
    }
  };

  if (!open) return null;

  return (
    <aside className="notes-agent" aria-label="Notes agent">
      <header className="notes-agent-header">
        <span className="notes-agent-title">Agent</span>
        <span className="notes-agent-model" title={model ?? undefined}>
          {model ?? "pi 默认模型"}
        </span>
        <button type="button" className="notes-agent-icon" onClick={onOpenSettings} title="笔记设置" aria-label="笔记设置">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 7 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a1.7 1.7 0 0 0-1.6-1H1a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 3 8.6a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 8 3a1.7 1.7 0 0 0 1-1.6V1a2 2 0 1 1 4 0v.1A1.7 1.7 0 0 0 15 3a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 8c.2.6.7 1 1.4 1H23a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
          </svg>
        </button>
        <button type="button" className="notes-agent-icon" onClick={onClose} title="收起" aria-label="收起 agent">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </header>

      <div className="notes-agent-log" ref={logRef}>
        {messages.length === 0 && (
          <div className="notes-agent-empty">
            <p>让 agent 写笔记或画白板，它会直接改笔记库。</p>
            {skills.length > 0 && (
              <ul className="notes-agent-skills">
                {skills.map((skill) => (
                  <li key={skill.name}>
                    <strong>{skill.name}</strong>
                    <span>{skill.description}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="notes-agent-tip">{contextPath ? `当前打开：${contextPath}` : "在左侧选一篇笔记，或直接说你要什么"}</p>
          </div>
        )}
        {messages.map((message) => (message.role === "user" ? (
          <div key={message.id} className="notes-agent-message is-user">{message.text}</div>
        ) : (
          <AssistantMessage key={message.id} message={message} />
        )))}
        {error && <div className="notes-agent-error" role="alert">{error}</div>}
      </div>

      <form className="notes-agent-composer" onSubmit={(event) => void send(event)}>
        <textarea
          value={draft}
          rows={3}
          placeholder="写一篇周报、把方案画成白板… （Enter 发送，Shift+Enter 换行）"
          aria-label="给 agent 发消息"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="notes-agent-actions">
          <button type="button" className="notes-agent-settings" onClick={onOpenSettings}>笔记设置</button>
          {busy ? (
            <button type="button" className="notes-agent-send is-stop" onClick={() => void stop()}>停止</button>
          ) : (
            <button type="submit" className="notes-agent-send" disabled={!draft.trim()}>发送</button>
          )}
        </div>
      </form>
    </aside>
  );
}
