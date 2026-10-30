import { readFileSync } from "node:fs";
import { CORE_SCHEMA, defineScalarTag, load } from "js-yaml";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import type { CatalogSession } from "../../lib/catalog-db";
import { escapeConfigValue } from "../../lib/mcp-import-core";
import { dshConfigFile } from "./index";
import { dshProviderEnv, dshTuiPatchFile } from "./acp-patch";
import { parseDshRuntime } from "./toml";

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Read declarative pi-ai routes only. Cordis !js elsewhere in the patch is never executed. */
export function dshModelConfig(row: CatalogSession): { provider: string; modelId: string; config: ProviderConfig } {
  let patch: unknown;
  try {
    patch = load(readFileSync(dshTuiPatchFile(), "utf8"), {
      schema: CORE_SCHEMA.withTags(defineScalarTag("tag:yaml.org,2002:js", { resolve: () => null, identify: () => false })),
    });
  } catch { throw new Error("dsh 原生网关配置无法安全读取；不会猜测其他模型配置"); }
  let route: Record<string, unknown> = {};
  const seen = new Set<unknown>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    const entry = object(value);
    if (entry.id === "llm-pi-ai" || entry.name === "@deepseek-ai/dsh-llm-pi-ai") {
      const found = object(object(object(entry.config).providers)[row.provider]);
      if (Object.keys(found).length) route = found;
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(patch);
  const config = parseDshRuntime(readFileSync(dshConfigFile(), "utf8"));
  const env = { ...process.env, ...dshProviderEnv(config) };
  const apiKey = typeof route.apiKeyEnv === "string" ? env[route.apiKeyEnv] : undefined;
  if (!Object.keys(route).length || !apiKey) {
    throw new Error("这个 dsh 来源模型没有可供 pi 复用的 API 网关认证（原生订阅登录暂不支持）；不会改用 pi 默认认证");
  }
  const configured = Array.isArray(route.models) ? route.models.find((item) => item === row.model || object(item).id === row.model) : null;
  if (Array.isArray(route.models) && !configured) throw new Error("dsh 来源模型已不在原生网关配置中");
  const builtinProvider = getBuiltinProviders().find((id) => id === row.provider);
  const base = builtinProvider ? getBuiltinModels(builtinProvider).find((item) => item.id === row.model) : undefined;
  const model = { ...object(object(route.modelOverrides)[row.model]), ...object(configured) };
  const api = typeof model.api === "string" ? model.api : typeof route.api === "string" ? route.api : base?.api;
  const baseUrl = typeof model.baseURL === "string" ? model.baseURL : typeof route.baseURL === "string" ? route.baseURL : base?.baseUrl;
  if (!api || !baseUrl) throw new Error("dsh 来源模型的协议或地址不明确；不会猜测其他模型配置");
  const headers = Object.fromEntries(Object.entries({ ...object(route.headers), ...object(model.headers) }).map(([name, value]) => {
    if (typeof value !== "string") throw new Error("dsh 动态认证 headers 暂不能供 pi 笔记 agent 复用");
    return [name, escapeConfigValue(value)];
  }));
  const positive = (value: unknown, fallback: number) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
  const efforts = model.reasoningEfforts;
  const input = model.input ?? base?.input ?? route.defaultInput ?? ["text"];
  if (!Array.isArray(input) || !input.length || input.some((item) => item !== "text" && item !== "image")) throw new Error("dsh 来源模型的输入能力无法供 pi 复用");
  return {
    provider: `notes-dsh-${row.provider}`, modelId: row.model,
    config: {
      baseUrl, api, apiKey: escapeConfigValue(apiKey), headers,
      models: [{ ...base, id: row.model, name: typeof model.name === "string" ? model.name : row.model,
        input, reasoning: efforts === false ? false : efforts !== undefined || base?.reasoning === true,
        contextWindow: positive(model.contextWindow, base?.contextWindow ?? positive(route.defaultContextWindow, 262144)),
        maxTokens: positive(model.maxTokens, base?.maxTokens ?? positive(route.defaultMaxTokens, 32768)),
        cost: base?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: { ...object(base?.compat), ...object(route.compat), ...object(model.compat) },
      }],
    },
  };
}
