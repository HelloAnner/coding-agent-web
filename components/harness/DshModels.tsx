"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import {
  ConfigDetailStack,
  ConfigDetailTitle,
  ConfigField,
  ConfigSidebar,
  ConfigSidebarGroupLabel,
  ConfigSidebarItem,
  ConfigSidebarList,
  ConfigSidebarText,
  ConfigSplitView,
  ConfigSwitch,
} from "../SettingsUi";

interface DshModel {
  key: string;
  name: string;
  provider: string;
  model: string;
  enabled: boolean;
}

interface DshProvider {
  id: string;
  name: string;
  url: string;
}

/** Settings › Models › dsh. Reads and writes ds.toml. Name and enabled only. */
export function DshModels() {
  const { t } = useI18n();
  const [path, setPath] = useState("");
  const [providers, setProviders] = useState<DshProvider[]>([]);
  const [models, setModels] = useState<DshModel[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [saving, setSaving] = useState(false);
  // `provider/model` pairs the ACP kernel mounts. Null until the live read answers.
  const [mounted, setMounted] = useState<Set<string> | null>(null);

  const load = useCallback(async () => {
    const response = await fetch("/api/harnesses/dsh/models", { cache: "no-store" });
    const body = await response.json().catch(() => ({})) as {
      path?: string;
      providers?: DshProvider[];
      models?: DshModel[];
    };
    if (!response.ok) {
      setMissing(true);
      setPath(typeof body.path === "string" ? body.path : "");
      setProviders([]);
      setModels([]);
      setError(null);
      return;
    }
    setMissing(false);
    setPath(body.path ?? "");
    setProviders(body.providers ?? []);
    setModels(body.models ?? []);
    setSelected((current) => {
      if (current && body.models?.some((item) => item.key === current)) return current;
      return body.models?.[0]?.key ?? null;
    });
  }, []);

  useEffect(() => { void load().catch(() => setMissing(true)); }, [load]);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/harnesses/dsh/models?live=1", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { models?: DshModel[] } | null) => {
        if (cancelled || !body?.models) return;
        setMounted(new Set(body.models.map((item) => `${item.provider}/${item.model}`)));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const current = models.find((item) => item.key === selected) ?? null;
  useEffect(() => { setNameDraft(current?.name ?? ""); }, [current?.key, current?.name]);

  const save = async (patch: { name?: string; enabled?: boolean }) => {
    if (!current) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/harnesses/dsh/models", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: current.key, ...patch }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        setError(body.error || t("harness.writeFailed"));
        return;
      }
      await load();
    } catch {
      setError(t("harness.writeFailed"));
    } finally {
      setSaving(false);
    }
  };

  const commitName = () => {
    if (!current) return;
    const name = nameDraft.trim();
    if (!name || name === current.name) return;
    void save({ name });
  };

  const groups = new Map<string, DshModel[]>();
  for (const provider of providers) groups.set(provider.id, []);
  for (const model of models) {
    const rows = groups.get(model.provider) ?? [];
    rows.push(model);
    groups.set(model.provider, rows);
  }
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));

  return (
    <div className="harness-dsh">
      <div className="enabled-models-banner">
        <div className="enabled-models-banner-text">
          <code className="enabled-models-banner-key" title={path}>{path}</code>
        </div>
      </div>
      {missing ? (
        <div className="config-empty-state">{t("harness.missingToml")}</div>
      ) : (
        <ConfigSplitView>
          <ConfigSidebar>
            <ConfigSidebarList>
              {[...groups.entries()].map(([providerId, rows]) => (
                <Fragment key={providerId}>
                  <ConfigSidebarGroupLabel>{providerById.get(providerId)?.name || providerId}</ConfigSidebarGroupLabel>
                  {rows.map((row) => (
                    <ConfigSidebarItem key={row.key} active={row.key === selected} onClick={() => setSelected(row.key)}>
                      <ConfigSidebarText>{row.name || row.key}</ConfigSidebarText>
                      {!row.enabled
                        ? <span className="models-sidebar-badge">{t("harness.off")}</span>
                        : mounted && !mounted.has(`${row.provider}/${row.model}`)
                          ? <span className="models-sidebar-badge">{t("harness.notMounted")}</span>
                          : null}
                    </ConfigSidebarItem>
                  ))}
                </Fragment>
              ))}
            </ConfigSidebarList>
          </ConfigSidebar>
          <div className="config-detail">
            {current ? (
              <ConfigDetailStack>
                <ConfigDetailTitle>{current.name || current.key}</ConfigDetailTitle>
                <code className="config-detail-path">{current.provider}/{current.model}</code>
                {providerById.get(current.provider)?.url && (
                  <code className="config-detail-path">{providerById.get(current.provider)?.url}</code>
                )}
                <ConfigField label={t("harness.name")}>
                  <input
                    className="harness-field-input"
                    value={nameDraft}
                    disabled={saving}
                    aria-label={t("harness.name")}
                    onChange={(event) => setNameDraft(event.target.value)}
                    onBlur={commitName}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        commitName();
                      }
                    }}
                  />
                </ConfigField>
                <div className="harness-enabled-row">
                  <ConfigSwitch
                    checked={current.enabled}
                    disabled={saving}
                    label={t("harness.enabled")}
                    onChange={(checked) => { void save({ enabled: checked }); }}
                  />
                  <span className="config-field-label">{t("harness.enabled")}</span>
                </div>
                {error && <div role="alert" className="harness-save-error">{error}</div>}
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
