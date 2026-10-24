"use client";

import type { ComponentType } from "react";
import { ModelsConfig } from "../ModelsConfig";
import { ClaudeModels } from "./ClaudeModels";
import { DshModels } from "./DshModels";
import { GrokModels } from "./GrokModels";

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
  dsh: DshModels,
  grok: GrokModels,
  "claude-code": ClaudeModels,
};
