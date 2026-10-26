"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import type { ProviderUsageResult } from "@/lib/provider-usage";
import { TOOLBAR_QUOTA_PROVIDERS, toolbarQuotaValues } from "@/lib/toolbar-quota";
import styles from "./ToolbarQuota.module.css";

const REFRESH_MS = 5 * 60 * 1000;

export function ToolbarQuota() {
  const { locale } = useI18n();
  const chinese = locale.startsWith("zh");
  const [results, setResults] = useState<Partial<Record<string, ProviderUsageResult>>>({});
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const refresh = async () => {
      await Promise.all(TOOLBAR_QUOTA_PROVIDERS.map(async ({ id }) => {
        let result: ProviderUsageResult;
        try {
          const response = await fetch("/api/provider-usage/query", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ providerId: id }),
            cache: "no-store",
            signal: controller.signal,
          });
          if (!response.ok) throw new Error("Quota query failed");
          result = await response.json() as ProviderUsageResult;
        } catch {
          if (controller.signal.aborted) return;
          result = { providerId: id, status: "query-failed", message: "Quota query failed" };
        }
        if (!controller.signal.aborted) setResults((current) => ({ ...current, [id]: result }));
      }));
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, REFRESH_MS);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) setAnchor({ top: rect.bottom + 6, right: Math.max(8, window.innerWidth - rect.right) });
    setOpen(true);
  };

  const title = chinese ? "剩余额度" : "Remaining quota";
  const formatReset = (seconds: number) => new Date(seconds * 1000).toLocaleString(locale, {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  });

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={toggle}
        title={title}
        aria-label={title}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={styles.trigger}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 17a8 8 0 1 1 16 0" />
          <path d="m12 17 4.5-5.5" />
          <path d="M4 21h16" />
        </svg>
      </button>
      {open && anchor && createPortal(
        <div
          ref={panelRef}
          role="dialog"
          aria-label={title}
          className={styles.panel}
          style={{ top: anchor.top, right: anchor.right }}
        >
          <div className={styles.panelHeader}>
            <span>{title}</span>
            <span className={styles.hint}>{chinese ? "每五分钟刷新" : "Refreshed every 5 min"}</span>
          </div>
          {TOOLBAR_QUOTA_PROVIDERS.map(({ id, name }) => {
            const result = results[id];
            const values = result?.status === "ready" ? toolbarQuotaValues(result.report) : [];
            const unavailable = result?.status === "auth-unavailable";
            const status = !result ? "…" : unavailable ? (chinese ? "未配置" : "Not configured") : (chinese ? "暂不可用" : "Unavailable");
            return (
              <div key={id} className={styles.provider}>
                <div className={styles.providerName}>{name}</div>
                {values.length ? values.map((value, index) => (
                  <div key={index} className={styles.row}>
                    <span className={styles.label}>{value.label}</span>
                    <span className={styles.value}>
                      {value.value}
                      {value.empty && <span className={styles.empty}> {chinese ? "已用尽" : "Empty"}</span>}
                    </span>
                    {"resetsAt" in value && value.resetsAt
                      ? <span className={styles.reset}>{chinese ? "重置" : "Resets"} {formatReset(value.resetsAt)}</span>
                      : null}
                  </div>
                )) : <div className={styles.status}>{status}</div>}
              </div>
            );
          })}
        </div>,
        document.body,
      )}
    </>
  );
}
