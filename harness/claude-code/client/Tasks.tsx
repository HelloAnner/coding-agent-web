"use client";

import { Fragment, useState, type CSSProperties } from "react";
import { useI18n } from "../../../hooks/useI18n";
import { MessageView } from "../../../components/MessageView";
import type { ToolResultMessage } from "../../../lib/types";
import type { ClaudeTask } from "../tasks";
import { useClaudeTasks } from "./use-tasks";

const active = (task: ClaudeTask) => ["pending", "running", "paused"].includes(task.status);
const button: CSSProperties = { border: "none", background: "transparent", color: "var(--text-muted)", cursor: "pointer", padding: "5px 8px", minHeight: 32, fontSize: 12, borderRadius: 5 };
const code: CSSProperties = { fontFamily: "var(--font-mono)", fontSize: 12, whiteSpace: "pre-wrap", overflowWrap: "anywhere", overflow: "auto", maxHeight: 240, margin: 0, padding: 10, background: "var(--bg)", borderRadius: 5 };

/** Native parent ids form a tree; malformed/cyclic metadata must not hide tasks or loop. */
export function claudeTaskRows(tasks: ClaudeTask[]): Array<{ task: ClaudeTask; depth: number }> {
  const ids = new Set(tasks.map((task) => task.id));
  const children = new Map<string, ClaudeTask[]>();
  const roots: ClaudeTask[] = [];
  for (const task of tasks) {
    if (task.parentTaskId && task.parentTaskId !== task.id && ids.has(task.parentTaskId)) {
      const siblings = children.get(task.parentTaskId) ?? [];
      siblings.push(task); children.set(task.parentTaskId, siblings);
    } else roots.push(task);
  }
  const rows: Array<{ task: ClaudeTask; depth: number }> = [];
  const seen = new Set<string>();
  const visit = (task: ClaudeTask, depth: number) => {
    if (seen.has(task.id)) return;
    seen.add(task.id); rows.push({ task, depth });
    for (const child of children.get(task.id) ?? []) visit(child, depth + 1);
  };
  for (const task of roots.reverse()) visit(task, 0);
  for (const task of tasks) visit(task, 0);
  return rows;
}

export function ClaudeTasksPanel({ sessionId, active: foreground }: { sessionId: string; active: boolean }) {
  const state = useClaudeTasks(sessionId, foreground);
  return <ClaudeTasksView state={state} />;
}

export function ClaudeTasksView({ state }: { state: ReturnType<typeof useClaudeTasks> }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const tasks = state.snapshot?.tasks ?? [];
  if (!tasks.length && !state.error) return null;
  const count = tasks.filter(active).length;
  const typeLabel: Record<string, string> = { shell: t("harness.claudeTaskShell"), monitor: "Monitor", subagent: t("harness.claudeTaskAgent"), workflow: t("harness.claudeTaskWorkflow") };
  const statusLabel: Record<ClaudeTask["status"], string> = { pending: t("harness.claudeTaskPending"), running: t("harness.claudeTaskRunning"), paused: t("harness.claudeTaskPaused"), completed: t("harness.claudeTaskCompleted"), failed: t("harness.claudeTaskFailed"), stopped: t("harness.claudeTaskStopped"), unknown: t("harness.claudeTaskUnknown") };
  const detailResults = new Map<string, ToolResultMessage>((state.detail?.messages ?? []).filter((message): message is ToolResultMessage => message.role === "toolResult").map((message) => [message.toolCallId, message]));

  return (
    <section aria-label={t("harness.claudeTasks")} style={{ width: "calc(100% - 32px)", maxWidth: "var(--chat-content-max-width, 820px)", margin: "0 auto 6px", minWidth: 0, border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-panel)" }}>
      <div style={{ display: "flex", alignItems: "center", minHeight: 34 }}>
        <button type="button" aria-expanded={open} onClick={() => { setOpen(!open); if (open) state.select(null); }} style={{ ...button, flex: 1, minWidth: 0, textAlign: "left", display: "flex", alignItems: "center", gap: 7 }}>
          <span aria-hidden="true" style={{ display: "inline-block", transform: open ? "rotate(90deg)" : undefined }}>›</span>
          <span>{t("harness.claudeTasks")} · {tasks.length}</span>
          {count > 0 && <span style={{ color: "var(--accent)", fontSize: 11 }}>{t("harness.claudeTaskActive", { count })}</span>}
        </button>
        <button type="button" className="file-viewer-icon-button" onClick={state.refresh} style={button}>{t("subagent.refresh")}</button>
      </div>
      {(state.error || state.actionError) && <div role="alert" style={{ padding: "6px 10px", color: "var(--error)", fontSize: 12, overflowWrap: "anywhere" }}>{state.error || state.actionError}</div>}
      {open && (
        <div style={{ maxHeight: "min(50dvh, 420px)", overflowY: "auto", borderTop: "1px solid var(--border)" }}>
          {claudeTaskRows(tasks).map(({ task, depth }) => {
            const selected = state.selectedId === task.id;
            const running = Boolean(state.snapshot?.connected && active(task));
            return (
              <Fragment key={task.id}>
                <div style={{ display: "flex", alignItems: "center", gap: 2, paddingLeft: Math.min(depth, 4) * 12, borderBottom: "1px solid var(--border)" }}>
                  <button type="button" title={task.description || task.agentType || task.id} aria-expanded={selected} onClick={() => state.select(selected ? null : task.id)} style={{ ...button, flex: 1, minWidth: 0, textAlign: "left", background: selected ? "var(--bg-hover)" : undefined }}>
                    <span style={{ display: "flex", alignItems: "baseline", gap: 7, minWidth: 0 }}>
                      <span style={{ color: "var(--text-dim)", fontSize: 10, flexShrink: 0 }}>{Object.hasOwn(typeLabel, task.type) ? typeLabel[task.type] : task.type}</span>
                      <span style={{ color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{task.description || task.agentType || task.id}</span>
                      <span style={{ marginLeft: "auto", color: task.status === "failed" ? "var(--error)" : running ? "var(--accent)" : "var(--text-dim)", fontSize: 10, flexShrink: 0 }}>{statusLabel[task.status]}</span>
                    </span>
                    {(task.lastToolName || task.usage) && <span style={{ display: "block", marginTop: 2, color: "var(--text-dim)", fontSize: 10 }}>{[task.lastToolName, task.usage && t("harness.claudeTaskTools", { count: task.usage.toolUses }), task.usage && `${Math.round(task.usage.durationMs / 1000)}s`].filter(Boolean).join(" · ")}</span>}
                  </button>
                  {running && !task.background && task.toolUseId && (task.type === "shell" || task.type === "subagent") && <button type="button" className="file-viewer-icon-button" disabled={state.pending !== null} onClick={() => void state.act(task, "background")} style={button}>{t("harness.claudeTaskBackground")}</button>}
                  {running && <button type="button" className="file-viewer-icon-button" disabled={state.pending !== null} onClick={() => void state.act(task, "stop")} aria-label={`${t("harness.claudeTaskStop")} · ${task.description || task.id}`} style={{ ...button, opacity: state.pending ? 0.5 : 1 }}>{state.pending === task.id ? "…" : t("chat.stop")}</button>}
                </div>
                {selected && (
                  <div style={{ padding: 10, display: "grid", gap: 8, minWidth: 0, borderBottom: "1px solid var(--border)" }}>
                    {task.command && <pre style={code}>{task.command}</pre>}
                    {task.summary && task.summary !== task.description && <div style={{ color: "var(--text-muted)", whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 12 }}>{task.summary}</div>}
                    {task.error && <div role="alert" style={{ color: "var(--error)", fontSize: 12 }}>{task.error}</div>}
                    {state.detailError ? <div role="alert" style={{ color: "var(--error)", overflowWrap: "anywhere", fontSize: 12 }}>{state.detailError}</div>
                      : !state.detail ? <div role="status" style={{ color: "var(--text-dim)", fontSize: 12 }}>{t("chat.loadingSession")}</div>
                        : state.detail.messages ? <div>{state.detail.messages.length === 0 ? <span style={{ color: "var(--text-dim)", fontSize: 12 }}>{t("subagent.viewer.empty")}</span> : state.detail.messages.filter((message) => message.role !== "toolResult").map((message, index) => <MessageView key={String((message as { nativeId?: string }).nativeId ?? index)} message={message} toolResults={detailResults} />)}</div>
                          : state.detail.output !== undefined && <pre style={code}>{state.detail.output || t("harness.claudeTaskNoOutput")}</pre>}
                    {state.detail?.truncated && <span style={{ color: "var(--text-dim)", fontSize: 10 }}>{t("harness.claudeTaskTruncated")}</span>}
                  </div>
                )}
              </Fragment>
            );
          })}
        </div>
      )}
    </section>
  );
}
