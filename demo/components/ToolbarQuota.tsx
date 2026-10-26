"use client";

import { type CSSProperties, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import type { ProviderUsageResult } from "@/lib/provider-usage";
import { TOOLBAR_QUOTA_PROVIDERS, toolbarQuotaValues } from "@/lib/toolbar-quota";

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 200,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
  background: "rgba(0,0,0,0.45)",
};

const panelStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  width: "min(420px, 100%)",
  maxHeight: "min(80vh, 560px)",
  overflow: "hidden",
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  boxShadow: "0 16px 48px rgba(0,0,0,0.32)",
  color: "var(--text)",
};

export function ToolbarQuota() {
  const { locale } = useI18n();
  const chinese = locale.startsWith("zh");
  const [results, setResults] = useState<Partial<Record<string, ProviderUsageResult>>>({});
  const [open, setOpen] = useState(false);

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
    return () => { controller.abort(); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const title = chinese ? "剩余额度" : "Remaining quota";
  const formatReset = (seconds: number) => new Date(seconds * 1000).toLocaleString(locale, {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  });

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={title}
        aria-label={title}
        aria-haspopup="dialog"
        style={{
          display: "flex", alignItems: "center", justifyContent: "center",
          height: "100%", padding: "0 12px",
          background: "none", border: "none", borderRight: "1px solid var(--border)",
          color: "var(--text-muted)", cursor: "pointer", flexShrink: 0,
        }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 17a8 8 0 1 1 16 0" />
          <path d="m12 17 4.5-5.5" />
          <path d="M4 21h16" />
        </svg>
      </button>
      {open && createPortal(
        <div
          style={overlayStyle}
          onClick={(event) => { if (event.target === event.currentTarget) setOpen(false); }}
          onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }}
        >
          <div role="dialog" aria-modal="true" aria-label={title} style={panelStyle}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "12px 16px", borderBottom: "1px solid var(--border)" }}>
              <span style={{ fontSize: 14, fontWeight: 700 }}>{title}</span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                title={chinese ? "关闭" : "Close"}
                aria-label={chinese ? "关闭" : "Close"}
                style={{ display: "grid", placeItems: "center", width: 24, height: 24, marginLeft: "auto", background: "none", border: "none", borderRadius: 6, color: "var(--text-muted)", cursor: "pointer" }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
              </button>
            </div>
            <div style={{ overflowY: "auto", padding: "4px 0" }}>
              {TOOLBAR_QUOTA_PROVIDERS.map(({ id, name }) => {
                const result = results[id];
                const values = result?.status === "ready" ? toolbarQuotaValues(result.report) : [];
                const unavailable = result?.status === "auth-unavailable";
                const status = !result ? "…" : unavailable ? (chinese ? "未配置" : "Not configured") : (chinese ? "暂不可用" : "Unavailable");
                return (
                  <div key={id} style={{ padding: "10px 16px", borderBottom: "1px solid var(--border)" }}>
                    <div style={{ marginBottom: 6, color: "var(--text-muted)", fontSize: 11, fontWeight: 600 }}>{name}</div>
                    {values.length ? values.map((value, index) => (
                      <div key={index} style={{ display: "grid", gridTemplateColumns: "1fr auto", alignItems: "baseline", columnGap: 10 }}>
                        <span style={{ color: "var(--text-muted)", fontSize: 11 }}>{value.label}</span>
                        <span style={{ fontSize: 12, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                          {value.value}
                          {value.empty && <span style={{ fontSize: 10, fontWeight: 400 }}> {chinese ? "已用尽" : "Empty"}</span>}
                        </span>
                        {"resetsAt" in value && value.resetsAt
                          ? <span style={{ gridColumn: "1 / -1", color: "var(--text-muted)", fontSize: 10 }}>{chinese ? "重置" : "Resets"} {formatReset(value.resetsAt)}</span>
                          : null}
                      </div>
                    )) : <div style={{ color: "var(--text-muted)", fontSize: 11 }}>{status}</div>}
                  </div>
                );
              })}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
