"use client";

import { useEffect, useState } from "react";
import { HARNESS_MODEL_PANELS } from "./harness/panels";

interface HarnessTab {
  id: string;
  label: string;
}

/**
 * Settings › Models. One tab per harness.
 * Each tab is that harness's own panel. This file does not know how a harness stores models.
 */
export function HarnessModels({ cwd, onClose }: { cwd: string | null; onClose: () => void }) {
  const [harnesses, setHarnesses] = useState<HarnessTab[]>([{ id: "pi", label: "pi" }]);
  const [active, setActive] = useState("pi");
  const [visited, setVisited] = useState<Set<string>>(() => new Set(["pi"]));

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/harnesses", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { harnesses?: HarnessTab[] } | null) => {
        if (cancelled || !body?.harnesses?.length) return;
        setHarnesses(body.harnesses.filter((item) => item.id && item.label && HARNESS_MODEL_PANELS[item.id]));
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
      {harnesses.map((item) => {
        const Panel = HARNESS_MODEL_PANELS[item.id];
        if (!Panel || !visited.has(item.id)) return null;
        return (
          <div key={item.id} className="harness-models-body" hidden={active !== item.id}>
            <Panel cwd={cwd} onClose={onClose} />
          </div>
        );
      })}
    </div>
  );
}
