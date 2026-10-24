"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { ConfigButton, ConfigDetailStack, ConfigDetailTitle, ConfigSidebar, ConfigSidebarItem, ConfigSidebarList, ConfigSidebarText, ConfigSplitView } from "../SettingsUi";

interface ProfileRow { key: string; name: string; model: string; provider: string; enabled: boolean; profileDir?: string; runtimeModel?: string }

export function ClaudeModels() {
  const { t } = useI18n();
  const [file, setFile] = useState("");
  const [models, setModels] = useState<ProfileRow[]>([]);
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const response = await fetch("/api/harnesses/claude-code/models", { cache: "no-store", signal });
      const body = await response.json() as { path?: string; models?: ProfileRow[]; error?: string };
      if (signal?.aborted) return;
      setFile(body.path ?? "");
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      const rows = body.models ?? [];
      setModels(rows);
      setSelected((current) => rows.some((row) => row.key === current) ? current : rows[0]?.key ?? "");
      setError("");
    } catch (error) {
      if (!signal?.aborted) setError(error instanceof Error ? error.message : String(error));
    } finally { if (!signal?.aborted) setLoading(false); }
  }, []);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);
  const current = models.find((row) => row.key === selected);
  return (
    <div className="harness-claude-code">
      <div className="enabled-models-banner">
        <div className="enabled-models-banner-text" style={{ flexDirection: "column", alignItems: "flex-start" }}>
          <code className="enabled-models-banner-key" title={file}>{file}</code>
          <span>{t("harness.claudeConfigure")}</span>
        </div>
        <ConfigButton size="small" disabled={loading} onClick={() => void load()}>{t("i18n.refresh")}</ConfigButton>
      </div>
      {error ? <div className="config-empty-state" role="alert">{error}</div> : loading ? <div className="config-empty-state">{t("i18n.loading")}</div> : (
        <ConfigSplitView>
          <ConfigSidebar><ConfigSidebarList>
            {models.map((row) => <ConfigSidebarItem key={row.key} active={row.key === selected} onClick={() => setSelected(row.key)}>
              <ConfigSidebarText>{row.name}</ConfigSidebarText>
              {!row.enabled && <span className="models-sidebar-badge">{t("harness.off")}</span>}
            </ConfigSidebarItem>)}
          </ConfigSidebarList></ConfigSidebar>
          <div className="config-detail">
            {current ? <ConfigDetailStack>
              <ConfigDetailTitle>{current.name}</ConfigDetailTitle>
              <code className="config-detail-path">{current.runtimeModel || t("harness.claudeNativeDefault")}</code>
              <code className="config-detail-path">{current.profileDir}</code>
            </ConfigDetailStack> : <div className="config-empty-state">{t("harness.claudeConfigure")}</div>}
          </div>
        </ConfigSplitView>
      )}
    </div>
  );
}
