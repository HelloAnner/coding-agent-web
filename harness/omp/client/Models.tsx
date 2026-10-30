"use client";

import { ModelsConfig } from "../../../components/ModelsConfig";
import { useI18n } from "../../../hooks/useI18n";

export function OmpModels({ cwd, onClose }: { cwd?: string | null; onClose?: () => void }) {
  const { t } = useI18n();
  return <>
    <p role="note" style={{ padding: "8px 16px", color: "var(--text-muted)", fontSize: 12 }}>{t("harness.ompModelsShared")}</p>
    <ModelsConfig embedded cwd={cwd ?? null} onClose={onClose ?? (() => {})} />
  </>;
}
