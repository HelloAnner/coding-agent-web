import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { CORE_SCHEMA, defineScalarTag, load } from "js-yaml";
import { parseDshRuntime } from "./toml";
import { dshWebHost } from "./web-host";
import { dshAdmission } from "./web-view";
import { record } from "./web-projection";

type Route = { id: string; config: Record<string, unknown>; key?: string };
function source() {
  const file = process.env.DSH_DS_TOML || path.join(homedir(), "bin/ds/ds.toml");
  const patch = path.join(dshWebHost().home, "profiles/dsh-tui/cordis.patch.yml");
  const text = readFileSync(file, "utf8");
  let yaml = ""; try { yaml = readFileSync(patch, "utf8"); } catch { /* A bare ds.toml has no unambiguous protocol declaration. */ }
  const config = parseDshRuntime(text);
  const parsed = yaml ? load(yaml, { schema: CORE_SCHEMA.withTags(defineScalarTag("tag:yaml.org,2002:js", { resolve: () => ({ unsupportedExpression: true }), identify: () => false })) }) : [];
  let providers: Record<string, unknown> = {};
  const visit = (value: unknown, seen = new Set<unknown>()) => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    const row = record(value);
    if (row.id === "llm-pi-ai" || row.name === "@deepseek-ai/dsh-llm-pi-ai") providers = { ...providers, ...record(record(row.config).providers) };
    for (const child of Object.values(value)) visit(child, seen);
  };
  visit(parsed);
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const model of config.models.filter((item) => item.enabled)) {
    const provider = config.providers.find((item) => item.id === model.provider);
    const key = model.api || provider?.api;
    const ref = model.apiEnv || provider?.apiEnv || `${model.provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
    if (key) env[ref] = key;
  }
  const warnings: string[] = [], routes: Route[] = [];
  for (const id of new Set(config.models.filter((item) => item.enabled).map((item) => item.provider))) {
    const route = record(providers[id]);
    if (!Object.keys(route).length || JSON.stringify(route).includes('"unsupportedExpression":true')) { warnings.push(`${id}: no safe declarative gateway configuration; configure it in native Models instead`); continue; }
    const key = typeof route.apiKeyEnv === "string" ? env[route.apiKeyEnv] : undefined;
    if (!key) { warnings.push(`${id}: legacy OAuth/ambient credentials are not copied; sign in through native Models`); continue; }
    routes.push({ id, config: structuredClone(route), key });
  }
  return { file, fingerprint: createHash("sha256").update(text).update(yaml).digest("hex"), warnings, routes };
}

/** Explicit migration is the only code path that reads legacy ds/TUI configuration. */
export function previewDshMigration() {
  try {
    const value = source();
    return { available: true, file: value.file, fingerprint: value.fingerprint, warnings: value.warnings, providers: value.routes.map((route) => ({ id: route.id, modelCount: Array.isArray(route.config.models) ? route.config.models.length : 0 })) };
  } catch {
    return { available: false, providers: [], warnings: ["Legacy configuration is missing or cannot be safely read"] };
  }
}
export function importDshMigration(fingerprint: string): Promise<{ imported: string[]; skipped: string[]; warnings: string[] }> {
  return dshAdmission(true, async () => {
    const value = source();
    if (value.fingerprint !== fingerprint) throw new Error("Legacy configuration changed; preview it again before importing");
    const host = dshWebHost();
    const settings = await host.call<{ namespaces: { ns: string; revision: number; value: unknown }[] }>("settings/describe");
    const section = settings.namespaces.find((item) => item.ns === "llm-pi-ai");
    if (!section) throw new Error("The native multi-provider plugin is unavailable");
    const existing = record(record(section.value).providers);
    const routes = value.routes.filter((route) => !Object.hasOwn(existing, route.id));
    const skipped = value.routes.filter((route) => Object.hasOwn(existing, route.id)).map((route) => route.id);
    const saved: string[] = [];
    try {
      const ops = [];
      for (const route of routes) {
        const ref = `CODING_AGENT_DSH_${randomBytes(8).toString("hex").toUpperCase()}_KEY`;
        await host.call("credentials/set", { ref, value: route.key });
        saved.push(ref);
        ops.push({ op: "set", path: ["providers", route.id], value: { ...route.config, apiKeyEnv: ref } });
      }
      if (ops.length) await host.call("settings/mutate", { ns: section.ns, ops, expectedRevision: section.revision });
    } catch {
      // A lost response is not a rejected write: never delete a key that an applied provider may now use.
      const confirmed = await host.call<{ namespaces: { ns: string; value: unknown }[] }>("settings/describe").catch(() => null);
      if (confirmed) {
        const providers = record(record(confirmed.namespaces.find((item) => item.ns === "llm-pi-ai")?.value).providers);
        const used = new Set(Object.values(providers).map((item) => record(item).apiKeyEnv));
        for (const ref of saved.filter((ref) => !used.has(ref))) await host.call("credentials/unset", { ref }).catch(() => {});
      }
      throw new Error("Native import could not be confirmed; check native Models before retrying. Existing providers were not overwritten.");
    }
    return { imported: routes.map((route) => route.id), skipped, warnings: value.warnings };
  });
}
