"use client";

import { useI18n } from "../../../hooks/useI18n";
import type { ClaudeTaskSnapshot } from "../tasks";
import { useClaudeTasks } from "./use-tasks";

export function ClaudeRunningAgents({ sessionId, active }: { sessionId: string; active: boolean }) {
  const { snapshot, error } = useClaudeTasks(sessionId, active);
  return <ClaudeRunningAgentsView snapshot={error ? null : snapshot} />;
}

export function ClaudeRunningAgentsView({ snapshot }: { snapshot: ClaudeTaskSnapshot | null }) {
  const { t } = useI18n();
  const tasks = snapshot?.connected ? snapshot.tasks.filter((task) => task.type === "subagent" && task.status === "running") : [];
  if (!tasks.length) return null;

  return (
    <ul aria-label={t("harness.claudeTaskAgent")} style={{ width: "calc(100% - 32px)", maxWidth: "var(--chat-content-max-width, 820px)", margin: "0 auto 6px", padding: 0, listStyle: "none", minWidth: 0 }}>
      {tasks.map((task) => (
        <li key={task.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "4px 8px", minWidth: 0, fontSize: 12 }}>
          <span title={task.description || task.agentType || task.id} style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-muted)" }}>{task.description || task.agentType || task.id}</span>
          <span style={{ marginLeft: "auto", flexShrink: 0, color: "var(--accent)" }}>{t("harness.claudeTaskRunning")}</span>
        </li>
      ))}
    </ul>
  );
}
