"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { ModelsConfig } from "./ModelsConfig";
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
} from "./SettingsUi";

interface HarnessTab {
  id: string;
  label: string;
}

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

/**
 * Settings › Models. One tab per harness. pi keeps its own editor.
 * dsh reads and writes that harness's ds.toml (name and enabled only).
 * grok lists the official models and does not edit them.
 */
export function HarnessModels({ cwd, onClose }: { cwd: string | null; onClose: () => void }) {
  const [harnesses, setHarnesses] = useState<HarnessTab[]>([
    { id: "pi", label: "pi" },
    { id: "dsh", label: "dsh" },
    { id: "grok", label: "grok" },
  ]);
  const [active, setActive] = useState("pi");
  const [visited, setVisited] = useState<Set<string>>(() => new Set(["pi"]));

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/harnesses", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { harnesses?: HarnessTab[] } | null) => {
        if (cancelled || !body?.harnesses?.length) return;
        setHarnesses(body.harnesses.filter((item) => item.id && item.label));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const select = (id: string) => {
    setActive(id);
    setVisited((current) => {
      if (current.has(id)) return current;
      const next = new Set(current);
      next.add(id);
      return next;
    });
  };

  return (
    <div className="harness-models">
      <div className="harness-tabs" role="tablist" aria-label="harness">
        {harnesses.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            className="harness-tab"
            aria-selected={active === item.id}
            onClick={() => select(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="harness-models-body" hidden={active !== "pi"}>
        <ModelsConfig embedded cwd={cwd} onClose={onClose} />
      </div>
      {visited.has("dsh") && (
        <div className="harness-models-body" hidden={active !== "dsh"}>
          <DshModels />
        </div>
      )}
      {visited.has("grok") && (
        <div className="harness-models-body" hidden={active !== "grok"}>
          <GrokModels />
        </div>
      )}
    </div>
  );
}

interface GrokModel {
  key: string;
  name: string;
  model: string;
  isDefault?: boolean;
}

function GrokModels() {
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

function DshModels() {
  const { t } = useI18n();
  const [path, setPath] = useState("");
  const [providers, setProviders] = useState<DshProvider[]>([]);
  const [models, setModels] = useState<DshModel[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch("/api/harnesses/dsh/models", { cache: "no-store" });
    const body = await response.json().catch(() => ({})) as {
      path?: string;
      providers?: DshProvider[];
      models?: DshModel[];
      error?: string;
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
                      {!row.enabled && <span className="models-sidebar-badge">off</span>}
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
