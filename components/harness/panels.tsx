"use client";

import type { ComponentType } from "react";
import { ModelsConfig } from "../ModelsConfig";
import { ClaudeModels } from "./ClaudeModels";
import { DshModels, DshPlugins } from "@/harness/dsh/client/NativeView";
import { PluginsConfig } from "../PluginsConfig";
import { useI18n } from "@/hooks/useI18n";
import type { ProjectTrustStatus } from "@/lib/api-types";
import { GrokModels } from "./GrokModels";
import { OmpModels } from "@/harness/omp/client/Models";

/** One harness's settings page. Props the harness does not use are ignored. */
export type HarnessModelPanel = ComponentType<{ cwd?: string | null; onClose?: () => void }>;

function PiModelsPanel({ cwd, onClose }: { cwd?: string | null; onClose?: () => void }) {
  return <ModelsConfig embedded cwd={cwd ?? null} onClose={onClose ?? (() => {})} />;
}

/**
 * Which settings page a harness id opens.
 * Adding a harness registers its panel here and its descriptor in `harness/registry.ts`.
 */
export const HARNESS_MODEL_PANELS: Record<string, HarnessModelPanel> = {
  pi: PiModelsPanel,
  omp: OmpModels,
  dsh: DshModels,
  grok: GrokModels,
  "claude-code": ClaudeModels,
};

export interface HarnessPluginProps {
  cwd: string | null;
  sessionId: string | null;
  trust?: ProjectTrustStatus | null;
  onClose: () => void;
  onReloaded?: () => void;
}
function PiPluginsPanel({ cwd, ...props }: HarnessPluginProps) {
  const { locale } = useI18n();
  if (!cwd) return <p role="status" style={{ padding: 24 }}>{locale === "en" ? "Choose a project to manage pi plugins." : "请选择项目以管理 pi 插件。"}</p>;
  return <PluginsConfig {...props} embedded cwd={cwd} />;
}
/** Route page context only; plugin records and operations remain native to each harness. */
export const HARNESS_PLUGIN_PANELS: Record<string, ComponentType<HarnessPluginProps>> = { pi: PiPluginsPanel, dsh: DshPlugins };
