/** A `[model.*]` row in ds.toml. API keys are never copied out. */
export interface DshModelRecord {
  key: string;
  name: string;
  provider: string;
  model: string;
  enabled: boolean;
}

/** A `[provider.*]` row. `url` is the base URL. The key stays in the file. */
export interface DshProviderRecord {
  id: string;
  name: string;
  url: string;
}

interface Section {
  header: string;
  lines: string[];
}

function parseSections(text: string): { preamble: string[]; sections: Section[] } {
  const lines = text.split("\n");
  const preamble: string[] = [];
  const sections: Section[] = [];
  let current: Section | null = null;
  for (const line of lines) {
    const header = /^\[([^\]]+)\]\s*$/.exec(line.trim());
    if (header && !current?.header.startsWith(header[1] + ".") && !(current && header[1].startsWith(current.header + "."))) {
      current = { header: header[1], lines: [] };
      sections.push(current);
      continue;
    }
    if (current && header && header[1].startsWith(current.header + ".")) {
      current.lines.push(line);
      continue;
    }
    if (current) current.lines.push(line);
    else preamble.push(line);
  }
  return { preamble, sections };
}

function assignment(line: string): { key: string; value: string } | null {
  const match = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.*?)\s*$/.exec(line);
  if (!match) return null;
  return { key: match[1], value: unquote(match[2]) };
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
    return value.slice(1, -1).replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
  }
  return value;
}

function field(section: Section, key: string): string | undefined {
  for (const line of section.lines) {
    if (/^\s*\[/.test(line)) break;
    const item = assignment(line);
    if (item?.key === key) return item.value;
  }
  return undefined;
}

/** Providers and models declared in a ds.toml. Drops every credential field. */
export function parseDshToml(text: string): { providers: DshProviderRecord[]; models: DshModelRecord[] } {
  const { sections } = parseSections(text);
  const providers: DshProviderRecord[] = [];
  const models: DshModelRecord[] = [];
  for (const section of sections) {
    if (section.header.startsWith("provider.") && !section.header.slice("provider.".length).includes(".")) {
      const id = section.header.slice("provider.".length);
      providers.push({
        id,
        name: field(section, "name") || id,
        url: field(section, "url") || "",
      });
    }
    if (section.header.startsWith("model.") && !section.header.slice("model.".length).includes(".")) {
      const key = section.header.slice("model.".length);
      const enabled = field(section, "enabled");
      models.push({
        key,
        name: field(section, "name") || key,
        provider: field(section, "provider") || "",
        model: field(section, "model") || "",
        enabled: enabled !== "false",
      });
    }
  }
  return { providers, models };
}

/**
 * Legacy migration input, keys included. Only the explicit server-side import
 * uses this; neither ordinary model loading nor the browser reads it.
 */
export interface DshRuntimeConfig {
  /** `[common].default`: the config key of the model ds starts with. */
  defaultModel: string;
  providers: Array<{ id: string; url: string; api: string; apiEnv: string }>;
  models: Array<{
    key: string;
    provider: string;
    model: string;
    enabled: boolean;
    api: string;
    apiEnv: string;
  }>;
}

/** Read legacy migration facts. Nothing here is returned to a browser. */
export function parseDshRuntime(text: string): DshRuntimeConfig {
  const { sections } = parseSections(text);
  const providers: DshRuntimeConfig["providers"] = [];
  const models: DshRuntimeConfig["models"] = [];
  let defaultModel = "";
  for (const section of sections) {
    if (section.header === "common") {
      defaultModel = field(section, "default") || "";
      continue;
    }
    const provider = section.header.match(/^provider\.([^.]+)$/);
    if (provider) {
      providers.push({
        id: provider[1],
        url: field(section, "url") || "",
        api: field(section, "api") || "",
        apiEnv: field(section, "api_env") || "",
      });
      continue;
    }
    const model = section.header.match(/^model\.([^.]+)$/);
    if (model) {
      models.push({
        key: model[1],
        provider: field(section, "provider") || "",
        model: field(section, "model") || "",
        enabled: field(section, "enabled") !== "false",
        api: field(section, "api") || "",
        apiEnv: field(section, "api_env") || "",
      });
    }
  }
  return { defaultModel, providers, models };
}
