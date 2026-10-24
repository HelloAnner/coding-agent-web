import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dshConfigFile, dshHome } from "./index";
import { parseDshRuntime, type DshRuntimeConfig } from "./toml";

/**
 * What `dsh --profile acp` is missing on its own.
 *
 * The ACP bundle mounts deepseek-official only. ds.toml's custom gateways and
 * the dsh-tui profile's OAuth routes are composed by the `ds` launcher, so the
 * web hands the kernel the same layers as patches:
 *
 *   --patch ~/.dsh/profiles/dsh-tui/cordis.patch.yml   llm-pi-ai routes, keys by env
 *   --patch ~/.dsh/profiles/acp/.pi-web.patch.yml      default route + auth routes
 *
 * The second file is rewritten from ds.toml whenever it changes. It never
 * carries an API key: keys go to the child environment, as `ds` does.
 */

const OAUTH_PROVIDERS = new Set(["openai", "openai-codex", "anthropic", "xai", "meta"]);

/** The layer `ds` maintains for dsh-tui. Same routes, so the web and dst agree. */
export function dshTuiPatchFile(): string {
  return path.join(dshHome(), "profiles", "dsh-tui", "cordis.patch.yml");
}

/**
 * The dsh-tui OAuth plugin, which reads the same dsh-auth credentials as the TUI.
 * ponytail: absolute file path because the acp profile does not depend on the
 * TUI package; switch to `@deepseek-harness-tui/dsh-tui/oauth` if dsh hoists it.
 */
export function dshOauthPluginFile(): string {
  return path.join(
    dshHome(),
    "profiles",
    "dsh-tui",
    "node_modules",
    "@deepseek-harness-tui",
    "dsh-tui",
    "lib",
    "types",
    "oauth.js",
  );
}

export function dshOverlayFile(): string {
  return path.join(dshHome(), "profiles", "acp", ".pi-web.patch.yml");
}

function yamlText(value: string): string {
  return JSON.stringify(value);
}

function envName(provider: string): string {
  const name = provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `${name}_API_KEY`;
}

function providerById(config: DshRuntimeConfig): Map<string, DshRuntimeConfig["providers"][number]> {
  return new Map(config.providers.map((provider) => [provider.id, provider]));
}

/** Keys the TUI patch's `apiKeyEnv` names, taken from ds.toml. */
export function dshProviderEnv(config: DshRuntimeConfig): Record<string, string> {
  const providers = providerById(config);
  const env: Record<string, string> = {};
  for (const model of config.models) {
    if (!model.enabled) continue;
    const provider = providers.get(model.provider);
    const api = model.api || provider?.api;
    if (!api) continue;
    env[model.apiEnv || provider?.apiEnv || envName(model.provider)] = api;
  }
  return env;
}

/**
 * The route the kernel starts every new ACP session on. It decides the
 * connection's image capability, so pick a gateway route when there is one:
 * those declare `input: [text, image]`, while deepseek-official is text-only.
 * A provider missing from the dsh-tui patch is not mounted, so skip it.
 */
function firstGatewayRoute(
  config: DshRuntimeConfig,
  tuiPatch: string,
): { provider: string; model: string } | null {
  const custom = new Set(
    config.providers
      .filter((provider) => provider.url && tuiPatch.includes(`\n      ${provider.id}:`))
      .map((provider) => provider.id),
  );
  const enabled = config.models.filter((model) => model.enabled && model.provider && model.model);
  const wanted = enabled.find((model) => model.key === config.defaultModel);
  if (wanted && custom.has(wanted.provider)) return { provider: wanted.provider, model: wanted.model };
  const fallback = enabled.find((model) => custom.has(model.provider));
  return fallback ? { provider: fallback.provider, model: fallback.model } : null;
}

function piAiCatalogFile(provider: string): string {
  return path.join(
    dshHome(), "profiles", "node_modules", "@earendil-works", "pi-ai",
    "dist", "providers", "data", `${provider}.json`,
  );
}

function oauthRoutes(config: DshRuntimeConfig): string[] {
  const custom = new Set(config.providers.filter((provider) => provider.url).map((provider) => provider.id));
  const used = new Set(config.models.filter((model) => model.enabled).map((model) => model.provider));
  // The plugin refuses an id its installed pi-ai catalog does not ship, and a
  // boot error there would take the whole kernel down. Only mount known ones.
  return [...used].filter((provider) => (
    !custom.has(provider) && OAUTH_PROVIDERS.has(provider) && existsSync(piAiCatalogFile(provider))
  ));
}

/** The first image-capable catalog model: the OAuth plugin mounts the catalog as is. */
function firstCatalogImageRoute(oauth: string[]): { provider: string; model: string } | null {
  for (const provider of oauth) {
    try {
      const document = JSON.parse(readFileSync(piAiCatalogFile(provider), "utf8")) as Record<
        string,
        Record<string, { id?: unknown; input?: unknown }>
      >;
      for (const group of Object.values(document)) {
        for (const model of Object.values(group ?? {})) {
          if (typeof model?.id === "string" && Array.isArray(model.input) && model.input.includes("image")) {
            return { provider, model: model.id };
          }
        }
      }
    } catch {
      /* an unreadable catalog is handled by oauthRoutes */
    }
  }
  return null;
}

export function overlayText(config: DshRuntimeConfig | null, tuiPatch = ""): string {
  if (!config) return "";
  const lines = ["# Written by pi-web from ds.toml. Edited by hand? It will be rewritten."];
  const oauth = oauthRoutes(config);
  const authReady = oauth.length > 0 && existsSync(dshOauthPluginFile());
  const route = firstGatewayRoute(config, tuiPatch) ?? (authReady ? firstCatalogImageRoute(oauth) : null);
  if (route) {
    lines.push(
      "- id: acp",
      "  config:",
      `    provider: ${yamlText(route.provider)}`,
      `    model: ${yamlText(route.model)}`,
    );
  }
  if (authReady) {
    lines.push(
      "- insert:",
      "    - id: acp-auth",
      `      name: ${yamlText(dshOauthPluginFile())}`,
      "      inject: [llm]",
      "      config:",
      `        providers: [${oauth.join(", ")}]`,
    );
  }
  return lines.join("\n") + "\n";
}

function writeIfChanged(file: string, content: string): void {
  try {
    if (readFileSync(file, "utf8") === content) return;
  } catch {
    /* first write */
  }
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, content, { mode: 0o600 });
  renameSync(temporary, file);
}

function mtime(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

export interface DshKernelSpawn {
  args: string[];
  env: NodeJS.ProcessEnv;
  /** Changes when ds.toml or either patch layer changes: the kernel must respawn. */
  signature: string;
}

/** The process a dsh harness starts: profile, model layers, and provider keys. */
export function dshKernelSpawn(baseEnv: NodeJS.ProcessEnv = process.env): DshKernelSpawn {
  const configFile = dshConfigFile();
  let config: DshRuntimeConfig | null = null;
  try {
    config = parseDshRuntime(readFileSync(configFile, "utf8"));
  } catch {
    config = null;
  }

  const args = ["--profile", "acp"];
  const tuiPatch = dshTuiPatchFile();
  let tuiText = "";
  try {
    tuiText = readFileSync(tuiPatch, "utf8");
  } catch {
    tuiText = "";
  }
  if (tuiText) args.push("--patch", tuiPatch);

  const overlay = overlayText(config, tuiText);
  if (overlay) {
    const file = dshOverlayFile();
    writeIfChanged(file, overlay);
    args.push("--patch", file);
  }

  const env = config ? { ...baseEnv, ...dshProviderEnv(config) } : baseEnv;
  const signature = [args.join("\0"), mtime(configFile), mtime(tuiPatch), overlay].join("\0");
  return { args, env, signature };
}
