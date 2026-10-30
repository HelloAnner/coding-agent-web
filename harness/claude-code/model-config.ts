import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type { CatalogSession } from "../../lib/catalog-db";
import { escapeConfigValue } from "../../lib/mcp-import-core";
import { claudeProcessEnv, object, resolveClaudeProfile } from "./index";
import { readClaudeTranscript } from "./transcript";

/** Export only API-backed model/auth configuration, never Claude's agent or tools. */
export function claudeModelConfig(row: CatalogSession): { provider: string; modelId: string; config: ProviderConfig } {
  const profile = resolveClaudeProfile(row.model, row.provider);
  if (profile.configDir !== (row.profilePath || row.sessionPath)) throw new Error("Claude Code profile directory has changed");
  const file = path.join(profile.configDir, "settings.json");
  let settings: Record<string, unknown>;
  try { settings = existsSync(file) ? object(JSON.parse(readFileSync(file, "utf8"))) : {}; }
  catch { throw new Error("Claude Code 原生模型配置读取失败"); }
  const nativeEnv = profile.env === undefined ? object(settings.env) : {};
  const env = { ...claudeProcessEnv(profile), ...nativeEnv };
  const value = (key: string) => typeof env[key] === "string" ? (env[key] as string).trim() : "";
  const apiKey = value("ANTHROPIC_API_KEY") || value("ANTHROPIC_OAUTH_TOKEN");
  const token = value("ANTHROPIC_AUTH_TOKEN");
  if (!apiKey && !token) {
    throw new Error("这个 Claude Code profile 使用原生登录或 apiKeyHelper，暂不能供 pi 笔记 agent 复用；不会改用 pi 默认认证");
  }
  let modelId = profile.model || value("ANTHROPIC_MODEL") || (typeof settings.model === "string" ? settings.model : "");
  if (!modelId || /^(sonnet|opus|haiku)(\[1m\])?$/i.test(modelId)) {
    const last = readClaudeTranscript(profile.configDir, row.id).messages.findLast((message) => message.role === "assistant");
    if (last?.role !== "assistant") throw new Error("Claude Code 来源对话没有可确认的实际模型名");
    modelId = last.model;
  }
  if (!modelId || modelId === "claude-code") throw new Error("Claude Code 来源对话没有明确的模型名");
  const base = getBuiltinModels("anthropic").find((model) => model.id === modelId);
  const headers: Record<string, string> = {};
  for (const line of value("ANTHROPIC_CUSTOM_HEADERS").split("\n").filter(Boolean)) {
    const cut = line.indexOf(":");
    if (cut < 1) throw new Error("Claude Code ANTHROPIC_CUSTOM_HEADERS 格式无效");
    headers[line.slice(0, cut).trim()] = escapeConfigValue(line.slice(cut + 1).trim());
  }
  if (token) headers.Authorization = escapeConfigValue(`Bearer ${token}`);
  return {
    provider: `notes-claude-${profile.id}`, modelId,
    config: {
      baseUrl: value("ANTHROPIC_BASE_URL") || "https://api.anthropic.com",
      api: "anthropic-messages", apiKey: escapeConfigValue(token ? "" : apiKey), headers,
      models: [{ ...base, id: modelId, name: modelId, input: base?.input ?? ["text"], reasoning: base?.reasoning ?? false,
        cost: base?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: base?.contextWindow ?? 128000, maxTokens: base?.maxTokens ?? 8192 }],
    },
  };
}
