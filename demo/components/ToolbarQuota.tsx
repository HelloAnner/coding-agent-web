"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { ProviderUsageResult } from "@/lib/provider-usage";
import { TOOLBAR_QUOTA_PROVIDERS, toolbarQuotaValues } from "@/lib/toolbar-quota";
import styles from "./ToolbarQuota.module.css";

const REFRESH_MS = 5 * 60 * 1000;

export function ToolbarQuota() {
  const { locale } = useI18n();
  const chinese = locale.startsWith("zh");
  const [results, setResults] = useState<Partial<Record<string, ProviderUsageResult>>>({});

  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
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
      pending = false;
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, REFRESH_MS);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, []);

  const formatReset = (seconds: number) => new Date(seconds * 1000).toLocaleString(locale, {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  });

  return (
    <div className={styles.quotas} role="group" aria-label={chinese ? "剩余额度，每五分钟刷新" : "Remaining quota, refreshed every five minutes"}>
      {TOOLBAR_QUOTA_PROVIDERS.map(({ id, name }) => {
        const result = results[id];
        const values = result?.status === "ready" ? toolbarQuotaValues(result.report) : [];
        const unavailable = result?.status === "auth-unavailable";
        const status = !result ? "…" : unavailable ? (chinese ? "未配置" : "Not configured") : (chinese ? "暂不可用" : "Unavailable");
        const details = values.map((value) => `${value.label}: ${value.value}${"resetsAt" in value && value.resetsAt ? ` · ${chinese ? "重置" : "Resets"} ${formatReset(value.resetsAt)}` : ""}`).join("\n");
        return (
          <div key={id} className={styles.provider} tabIndex={0} title={details || status}>
            <span className={styles.name}>{name}</span>
            <span className={styles.values}>
              {values.length ? values.map((value, index) => (
                <span key={index} className={styles.window}>
                  {values.length > 1 && <span className={styles.label}>{value.label}</span>}
                  <strong className={styles.value}>{value.value}{value.empty && <span className={styles.empty}> {chinese ? "已用尽" : "Empty"}</span>}</strong>
                  {"resetsAt" in value && value.resetsAt ? <span className={styles.reset}>{chinese ? "重置" : "Resets"} {formatReset(value.resetsAt)}</span> : null}
                </span>
              )) : <span className={styles.label}>{status}</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}
