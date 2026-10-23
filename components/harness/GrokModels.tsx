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
} from "../SettingsUi";

interface GrokModel {
  key: string;
  name: string;
  model: string;
  isDefault?: boolean;
}

/** Settings › Models › grok. Official models, read-only. */
export function GrokModels() {
  const { t } = useI18n();
  const [path, setPath] = useState("");
  const [models, setModels] = useState<GrokModel[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/harnesses/grok/models", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json().catch(() => ({})) as { path?: string; models?: GrokModel[] };
        if (cancelled) return;
        setPath(typeof body.path === "string" ? body.path : "");
        if (!response.ok) {
          setMissing(true);
          setModels([]);
          setSelected(null);
          return;
        }
        const rows = body.models ?? [];
        setMissing(false);
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
        </div>
      </div>
      {missing ? (
        <div className="config-empty-state">{t("harness.missingGrok")}</div>
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
                <code className="config-detail-path">{current.model}</code>
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
