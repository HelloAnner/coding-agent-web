"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import {
  ConfigDetailStack,
  ConfigDetailTitle,
  ConfigSidebar,
  ConfigSidebarItem,
  ConfigSidebarList,
  ConfigSidebarText,
  ConfigSplitView,
} from "../../../components/SettingsUi";

interface OmpModel {
  key: string;
  name: string;
  provider: string;
  model: string;
  isDefault?: boolean;
}

/** Settings › Models › omp. The same catalog and config a terminal `omp` uses. */
export function OmpModels() {
  const { t } = useI18n();
  const [path, setPath] = useState("");
  const [models, setModels] = useState<OmpModel[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/harnesses/omp/models?live=1", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json().catch(() => ({})) as { path?: string; models?: OmpModel[] };
        if (cancelled) return;
        setPath(typeof body.path === "string" ? body.path : "");
        const rows = response.ok ? body.models ?? [] : [];
        setMissing(!response.ok);
        setModels(rows);
        setSelected((current) => (current && rows.some((item) => item.key === current) ? current : rows[0]?.key ?? null));
      })
      .catch(() => { if (!cancelled) setMissing(true); });
    return () => { cancelled = true; };
  }, []);

  const current = models.find((item) => item.key === selected) ?? null;

  return (
    <div className="harness-grok">
      <div className="enabled-models-banner">
        <div className="enabled-models-banner-text">
          <code className="enabled-models-banner-key" title={path}>{path}</code>
          <span>{t("harness.ompModelsNative")}</span>
        </div>
      </div>
      {missing ? (
        <div className="config-empty-state">{t("harness.missingOmp")}</div>
      ) : (
        <ConfigSplitView>
          <ConfigSidebar>
            <ConfigSidebarList>
              {models.map((row) => (
                <ConfigSidebarItem key={row.key} active={row.key === selected} onClick={() => setSelected(row.key)}>
                  <ConfigSidebarText>{row.name || row.key}</ConfigSidebarText>
                  {row.isDefault && <span className="models-sidebar-badge">{t("harness.default")}</span>}
                </ConfigSidebarItem>
              ))}
            </ConfigSidebarList>
          </ConfigSidebar>
          <div className="config-detail">
            {current ? (
              <ConfigDetailStack>
                <ConfigDetailTitle>{current.name || current.key}</ConfigDetailTitle>
                <code className="config-detail-path">{`${current.provider}/${current.model}`}</code>
              </ConfigDetailStack>
            ) : (
              <div className="config-empty-state">{path}</div>
            )}
          </div>
        </ConfigSplitView>
      )}
    </div>
  );
}
