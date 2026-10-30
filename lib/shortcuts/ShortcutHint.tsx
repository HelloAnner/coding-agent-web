"use client";

import { useI18n } from "@/hooks/useI18n";
import { LEADER_COMMANDS } from "./leader";

/**
 * ⌃E 按下之后的那一下：底部一条提示，列出第二个键能做什么。
 * 键是用户自己定的，会一直加，所以这里不背，按出来看一眼就行。
 */
export function ShortcutHint({ armed }: { armed: boolean }) {
  const { t } = useI18n();
  if (!armed) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        left: "50%",
        bottom: 18,
        transform: "translateX(-50%)",
        zIndex: 1200,
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "7px 14px",
        borderRadius: 8,
        border: "1px solid var(--border)",
        background: "var(--bg-panel)",
        boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
        color: "var(--text-muted)",
        fontSize: 12,
        pointerEvents: "none",
        whiteSpace: "nowrap",
      }}
    >
      <Kbd>⌃E</Kbd>
      {LEADER_COMMANDS.map((command) => (
        <span key={command.id} style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Kbd>{command.key ? command.key.toUpperCase() : "⌃E"}</Kbd>
          {t(command.labelKey)}
        </span>
      ))}
    </div>
  );
}

function Kbd({ children }: { children: string }) {
  return (
    <kbd
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minWidth: 18,
        height: 18,
        padding: "0 4px",
        borderRadius: 4,
        border: "1px solid var(--border)",
        background: "var(--bg-selected)",
        color: "var(--text)",
        fontFamily: "inherit",
        fontSize: 11,
        lineHeight: 1,
      }}
    >
      {children}
    </kbd>
  );
}
