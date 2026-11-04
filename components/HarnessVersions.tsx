"use client";

import { useCallback, useEffect, useState } from "react";
import type { HarnessUpgradeResponse, HarnessVersionInfo } from "@/lib/api-types";
import { useI18n } from "@/hooks/useI18n";
import {
  ConfigButton,
  ConfigDetail,
  ConfigDetailActions,
  ConfigDetailGrid,
  ConfigDetailGridRow,
  ConfigDetailHeader,
  ConfigDetailHeaderInfo,
  ConfigDetailStack,
  ConfigDetailTitle,
  ConfigNotice,
} from "./SettingsUi";

/**
 * Settings › Harness. One row per harness this app can run, with the version
 * its local CLI reports and the version it could move to. Upgrading runs that
 * harness's own updater on the server; the row reloads when it returns.
 */
export function HarnessVersions() {
  const { t } = useI18n();
  const [rows, setRows] = useState<HarnessVersionInfo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [status, setStatus] = useState<{ tone: "ok" | "error"; message: string } | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const response = await fetch("/api/harness-versions", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json() as { harnesses?: HarnessVersionInfo[] };
      setRows(body.harnesses ?? []);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const upgrade = async (row: HarnessVersionInfo) => {
    setBusyId(row.id);
    setStatus(null);
    try {
      const response = await fetch("/api/harness-versions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: row.id }),
      });
      const body = await response.json().catch(() => null) as
        | (HarnessUpgradeResponse & { error?: string })
        | null;
      if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
      setStatus({
        tone: "ok",
        message: body?.version
          ? t("harness.upgraded", { version: body.version })
          : t("i18n.packageUpdated"),
      });
    } catch (error) {
      setStatus({
        tone: "error",
        message: `${t("harness.upgradeFailed")}${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      setBusyId(null);
      await load();
    }
  };

  const statusOf = (row: HarnessVersionInfo): string => {
    if (!row.version) return t("harness.notFound");
    if (!row.latest) return t("harness.unknown");
    return row.version === row.latest ? t("i18n.upToDate") : t("i18n.updateAvailable");
  };

  return (
    <ConfigDetail>
      <ConfigDetailStack>
        {loadError && <ConfigNotice>{loadError}</ConfigNotice>}
        {status && (
          <ConfigNotice>
            <span style={{ color: status.tone === "ok" ? "var(--accent)" : "var(--danger, #ef4444)" }}>
              {status.message}
            </span>
          </ConfigNotice>
        )}
        {!rows && !loadError && <ConfigNotice>{t("i18n.loading")}</ConfigNotice>}

        {rows?.map((row) => (
          <section key={row.id}>
            <ConfigDetailHeader>
              <ConfigDetailHeaderInfo>
                <ConfigDetailTitle>{row.label}</ConfigDetailTitle>
              </ConfigDetailHeaderInfo>
              <ConfigDetailActions>
                {row.upgrade && (
                  <ConfigButton
                    size="small"
                    variant={row.latest && row.latest !== row.version ? "primary" : undefined}
                    disabled={busyId !== null}
                    onClick={() => void upgrade(row)}
                  >
                    {busyId === row.id ? t("i18n.updating") : t("i18n.update")}
                  </ConfigButton>
                )}
              </ConfigDetailActions>
            </ConfigDetailHeader>
            <ConfigDetailGrid>
              <ConfigDetailGridRow label={t("harness.command")} mono tone="dim">
                {row.command ?? t("harness.builtIn")}
              </ConfigDetailGridRow>
              <ConfigDetailGridRow label={t("i18n.version")} mono>
                {row.version ?? "—"}
              </ConfigDetailGridRow>
              <ConfigDetailGridRow label={t("harness.latest")} mono tone="dim">
                {row.latest ?? "—"}
              </ConfigDetailGridRow>
              <ConfigDetailGridRow label={t("i18n.status")} tone="plain">
                {statusOf(row)}
              </ConfigDetailGridRow>
              {row.note && (
                <ConfigDetailGridRow label={t("i18n.description")} tone="dim">
                  {t(`harness.note.${row.note}`)}
                </ConfigDetailGridRow>
              )}
              {row.upgrade && (
                <ConfigDetailGridRow label={t("harness.upgradeCommand")} mono tone="dim">
                  {row.upgrade}
                </ConfigDetailGridRow>
              )}
            </ConfigDetailGrid>
          </section>
        ))}
      </ConfigDetailStack>
    </ConfigDetail>
  );
}
