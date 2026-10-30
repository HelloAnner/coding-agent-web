import { createAgentSessionServices, getAgentDir } from "@earendil-works/pi-coding-agent";
import { rememberProviderModels, withDeferredProviderModels } from "./deferred-provider-models";
import { resolveVisibleModels } from "./model-scope";
import { projectTrustReloadOptions } from "./project-trust";

/** Model configuration only: no agent, tools, MCP connections, or session is created. */
export async function readProjectModels(cwd: string) {
  const agentDir = getAgentDir();
  const trust = projectTrustReloadOptions(cwd, agentDir);
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    ...(trust ? { resourceLoaderReloadOptions: trust } : {}),
  });
  await rememberProviderModels(services.modelRuntime);
  const scope = await resolveVisibleModels(
    withDeferredProviderModels(services.modelRuntime),
    services.settingsManager.getEnabledModels(),
  );
  return { runtime: services.modelRuntime, settings: services.settingsManager, scope };
}

export type ProjectModels = Awaited<ReturnType<typeof readProjectModels>>;
