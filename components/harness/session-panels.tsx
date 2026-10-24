"use client";

import dynamic from "next/dynamic";
import type { ComponentType } from "react";

/** Registration only: native task state and interaction stay in their harness. */
export const HARNESS_SESSION_PANELS: Record<string, ComponentType<{ sessionId: string; active: boolean }>> = {
  "claude-code": dynamic(() => import("@/harness/claude-code/client/Tasks").then((module) => module.ClaudeTasksPanel), { ssr: false }),
};
