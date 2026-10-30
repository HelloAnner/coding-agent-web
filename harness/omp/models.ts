import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { orderSelectorModels } from "../../lib/model-scope";
import { readProjectModels, type ProjectModels } from "../../lib/project-models";
import type { HarnessModelList } from "../types";
import { OmpError } from "./rpc";

export { readProjectModels };
export type { ProjectModels };

export function selectedOmpModel(source: ProjectModels, provider?: string, id?: string): Model<Api> {
  if ((provider !== undefined || id !== undefined) && (!provider || !id)) throw new OmpError("Select a provider and model id together");
  if (source.runtime.getError()) throw new OmpError("Pi model configuration could not be loaded. Check Settings → Models.");
  const model = provider && id
    ? source.scope.visible.find((item) => item.provider === provider && item.id === id)
    : source.scope.visible[0];
  if (!model) throw new OmpError(provider && id ? `Model is not available in the Pi enabled scope: ${provider}/${id}` : "No Pi models are available. Configure a model in Settings → Models.");
  if (!source.runtime.getModel(model.provider, model.id)) throw new OmpError(`${model.provider}/${model.id}: the Pi provider is listed but not registered in the model service. Providers that register only in Pi session_start must also register during extension initialization; OMP will not create a Pi agent to activate them.`);
  return model;
}

/** The pipe carries display/capability metadata only, never endpoints, headers, or credentials. */
export function ompModelMetadata(source: ProjectModels) {
  return orderSelectorModels(source.scope).map((model) => {
    const efforts = getSupportedThinkingLevels(model).filter((level) => level !== "off");
    return {
      provider: model.provider, id: model.id, name: model.name, input: model.input,
      reasoning: model.reasoning, contextWindow: model.contextWindow, maxTokens: model.maxTokens,
      cost: { input: model.cost.input, output: model.cost.output, cacheRead: model.cost.cacheRead, cacheWrite: model.cost.cacheWrite },
      ...(efforts.length ? { thinking: { mode: "effort", efforts } } : {}),
    };
  });
}

export async function listOmpModels(cwd = getAgentDir()): Promise<HarnessModelList> {
  const source = await readProjectModels(cwd).catch(() => { throw new OmpError("Pi model configuration could not be loaded. Check Settings → Models."); });
  if (source.runtime.getError()) throw new OmpError("Pi model configuration could not be loaded. Check Settings → Models.");
  return { path: join(getAgentDir(), "models.json"), models: orderSelectorModels(source.scope).map((model, index) => ({
    key: JSON.stringify([model.provider, model.id]), name: model.name, provider: model.provider, model: model.id, enabled: true, isDefault: index === 0,
  })) };
}
