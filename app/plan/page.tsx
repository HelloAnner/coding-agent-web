import type { Metadata } from "next";
import { PlanApp } from "@/plan/ui/PlanApp";

export const metadata: Metadata = {
  title: "Plan · 全局人生规划",
  description: "把人生愿景、领域目标与当下行动放进同一张地图。",
};

/** Thin route entry. The standalone Plan application lives under root plan/. */
export default function PlanPage() {
  return <PlanApp />;
}
