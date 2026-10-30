import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { CORE_SCHEMA, defineScalarTag, load } from "js-yaml";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import type { CatalogSession } from "../../lib/catalog-db";
import { escapeConfigValue } from "../../lib/mcp-import-core";
import { dshWebHost } from "./web-host";

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Notes may borrow an explicit API gateway, never native OAuth or another harness's fallback. */
export async function dshModelConfig(row: CatalogSession): Promise<{ provider: string; modelId: string; config: ProviderConfig }> {
  const host = dshWebHost();
  const settings = await host.call<{ namespaces: { ns: string; value: unknown }[] }>("settings/describe").catch(() => { throw new Error("dsh 原生网关配置无法安全读取；不会猜测其他模型配置"); });
  const profile = settings.namespaces.find((item) => item.ns === "llm-pi-ai");
  const route = object(object(object(profile?.value).providers)[row.provider]);
  const ref = typeof route.apiKeyEnv === "string" ? route.apiKeyEnv : "";
  const info = ref ? await host.call<Record<string, { configured: boolean; source?: string }>>("credentials/describe", { refs: [ref] }) : {};
  let apiKey: string | undefined;
  if (info[ref]?.source === "env") apiKey = process.env[ref];
  else if (info[ref]?.source === "file") {
    // Resolve the local provider's declared file, without evaluating Cordis expressions or exporting secrets over RPC.
    const { stdout } = await promisify(execFile)(host.bin, ["--profile", "coding-agent-web", "--dump-config"], { env: { ...process.env, DSH_HOME: host.home }, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
    const composed = load(stdout, { schema: CORE_SCHEMA.withTags(defineScalarTag("tag:yaml.org,2002:js", { resolve: () => ({ expression: true }), identify: () => false })) });
    const entries = Array.isArray(composed) ? composed.map(object) : [];
    const credentials = entries.find((entry) => entry.name === "@deepseek-ai/dsh-credentials-local");
    const configuredPath = object(credentials?.config).path;
    if (!credentials || (configuredPath !== undefined && typeof configuredPath !== "string")) throw new Error("dsh 原生凭据来源无法安全读取；不会猜测其他认证");
    if (typeof configuredPath === "string" && !path.isAbsolute(configuredPath)) throw new Error("dsh 原生凭据使用了非绝对路径，暂不能安全复用");
    const filename = typeof configuredPath === "string" ? configuredPath : path.join(host.home, ".credentials.yaml");
    try {
      const document = object(load(readFileSync(filename, "utf8"), { schema: CORE_SCHEMA }));
      const value = object(document.refs)[ref];
      if (document.version === 1 && typeof value === "string") apiKey = value;
    } catch { throw new Error("dsh 原生凭据无法安全读取；不会猜测其他认证"); }
  }
  if (!Object.keys(route).length || !apiKey) {
    throw new Error("这个 dsh 来源模型没有可供 pi 复用的 API 网关认证（原生订阅登录暂不支持）；不会改用 pi 默认认证");
  }
  const configured = Array.isArray(route.models) ? route.models.find((item) => item === row.model || object(item).id === row.model) : null;
  if (Array.isArray(route.models) && route.models.length && !configured) throw new Error("dsh 来源模型已不在原生网关配置中");
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
  const declaredInput = Array.isArray(model.input) && !model.input.length ? undefined : model.input;
  const input = declaredInput ?? base?.input ?? route.defaultInput ?? ["text"];
  if (!Array.isArray(input) || !input.length || input.some((item) => item !== "text" && item !== "image")) throw new Error("dsh 来源模型的输入能力无法供 pi 复用");
  return {
    provider: `notes-dsh-${row.provider}`, modelId: row.model,
    config: {
      baseUrl, api, apiKey: escapeConfigValue(apiKey), headers,
      models: [{ ...base, id: row.model, name: typeof model.name === "string" ? model.name : row.model,
        input, reasoning: efforts === false ? false : Object.keys(object(efforts)).length > 0 || base?.reasoning === true,
        contextWindow: positive(model.contextWindow, base?.contextWindow ?? positive(route.defaultContextWindow, 262144)),
        maxTokens: positive(model.maxTokens, base?.maxTokens ?? positive(route.defaultMaxTokens, 32768)),
        cost: base?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: { ...object(base?.compat), ...object(route.compat), ...object(model.compat) },
      }],
    },
  };
}
