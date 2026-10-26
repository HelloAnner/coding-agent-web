"use client";

import type { ComponentType } from "react";

/** Registration only: native task state and interaction stay in their harness. */
export const HARNESS_SESSION_PANELS: Record<string, ComponentType<{ sessionId: string; active: boolean }>> = {};
