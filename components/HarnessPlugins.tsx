"use client";

import { useId, useState } from "react";
import { HARNESS_PLUGIN_PANELS, type HarnessPluginProps } from "./harness/panels";

/** Tabs route to native panels. Inactive panels stay mounted; an unvisited harness never boots. */
export function HarnessPlugins({ initialHarness = "pi", ...props }: HarnessPluginProps & { initialHarness?: string }) {
  const ids = Object.keys(HARNESS_PLUGIN_PANELS);
  const first = ids.includes(initialHarness) ? initialHarness : "pi";
  const [active, setActive] = useState(first);
  const [visited, setVisited] = useState(() => new Set([first]));
  const prefix = useId();
  const select = (id: string) => { setActive(id); setVisited((current) => new Set([...current, id])); };
  return <div className="harness-models">
    <div className="harness-tabs" role="tablist" aria-label="Harness plugins" onKeyDown={(event) => {
      const index = ids.indexOf(active);
      const next = event.key === "ArrowRight" ? ids[(index + 1) % ids.length] : event.key === "ArrowLeft" ? ids[(index + ids.length - 1) % ids.length] : event.key === "Home" ? ids[0] : event.key === "End" ? ids.at(-1) : null;
      if (!next) return;
      event.preventDefault(); select(next); document.getElementById(`${prefix}-tab-${next}`)?.focus();
    }}>
      {ids.map((id) => <button key={id} id={`${prefix}-tab-${id}`} type="button" role="tab" className="harness-tab" aria-selected={active === id} aria-controls={`${prefix}-panel-${id}`} tabIndex={active === id ? 0 : -1} onClick={() => select(id)}>{id}</button>)}
    </div>
    {ids.map((id) => {
      const Panel = HARNESS_PLUGIN_PANELS[id];
      return <div key={id} id={`${prefix}-panel-${id}`} role="tabpanel" aria-labelledby={`${prefix}-tab-${id}`} className="harness-models-body" hidden={active !== id}>{visited.has(id) && <Panel {...props} sessionId={id === initialHarness ? props.sessionId : null} />}</div>;
    })}
  </div>;
}
