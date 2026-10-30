import { InMemoryCredentialStore, InMemoryModelsStore, type Model, type Api } from "@earendil-works/pi-ai";
import { createAgentSessionServices, getAgentDir, ModelRuntime, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { readCatalogSession } from "../../lib/catalog-db";
import { buildSessionContext, readSessionHeader, resolveSessionPath } from "../../lib/session-reader";
import { projectTrustReloadOptions } from "../../lib/project-trust";
import type { SessionEntry } from "../../lib/types";
import { NotesError } from "../files";

export interface NotesModelSource {
  runtime: ModelRuntime;
  model: Model<Api>;
}

/** Model/auth only. No source conversation, tools, skills or extension handlers are inherited. */
export async function codingSessionModel(sessionId: string): Promise<NotesModelSource> {
  const row = readCatalogSession(sessionId);
  const harness = row?.harness ?? "pi";
  if (harness === "pi") {
    const { getRpcSession } = await import("../../lib/rpc-manager");
    const live = getRpcSession(sessionId);
    if (live?.isAlive()) {
      await live.waitUntilReady?.();
      const source = live.inner as unknown as AgentSession;
      if (!source.model) throw new NotesError("来源对话没有可用的模型", 409);
      return { runtime: source.modelRuntime, model: source.model };
    }
  }

  if (harness === "claude-code" || harness === "dsh") {
    const config = harness === "claude-code"
      ? (await import("../../harness/claude-code/model-config")).claudeModelConfig(row!)
      : (await import("../../harness/dsh/model-config")).dshModelConfig(row!);
    // Foreign credentials must never pick up pi's same-named provider or be written to its auth file.
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
      modelsPath: null, refreshOnCreate: false,
    });
    runtime.registerProvider(config.provider, config.config);
    const model = runtime.getModel(config.provider, config.modelId);
    if (!model) throw new NotesError("来源对话的模型配置无效", 409);
    return { runtime, model };
  }
  if (harness !== "pi" && harness !== "omp") {
    throw new NotesError(`${harness} 的原生模型认证暂不能供 pi 笔记 agent 复用；不会改用其他模型`, 400);
  }

  let cwd = row?.cwd ?? "";
  let selected = row ? { provider: row.provider, modelId: row.model } : null;
  if (harness === "pi") {
    const file = await resolveSessionPath(sessionId);
    const header = file ? readSessionHeader(file) : null;
    if (!file || header?.id !== sessionId) throw new NotesError("找不到来源对话", 404);
    const manager = SessionManager.open(file);
    cwd = manager.getCwd();
    selected = buildSessionContext(manager.getBranch() as unknown as SessionEntry[]).model;
  }
  if (!selected?.provider || !selected.modelId || !cwd) throw new NotesError("来源对话没有明确的模型配置", 409);
  const agentDir = getAgentDir();
  const services = await createAgentSessionServices({
    cwd, agentDir,
    resourceLoaderReloadOptions: projectTrustReloadOptions(cwd, agentDir),
    // Load provider registrations, not coding skills or instructions. The notes session has its own loader.
    resourceLoaderOptions: { noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true },
  });
  const model = services.modelRuntime.getModel(selected.provider, selected.modelId);
  if (!model) throw new NotesError(`来源模型不可用：${selected.provider}/${selected.modelId}；不会改用默认模型`, 409);
  return { runtime: services.modelRuntime, model };
}
