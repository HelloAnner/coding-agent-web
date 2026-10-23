/** One official grok model. Credential fields from the cache are never copied. */
export interface GrokModelRecord {
  key: string;
  name: string;
  provider: "grok";
  model: string;
  enabled: true;
  isDefault: boolean;
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const quote = value[0];
    if ((quote === "\"" || quote === "'") && value.endsWith(quote)) return value.slice(1, -1);
  }
  return value;
}

/**
 * `models.default` from grok's config.toml.
 * `GROK_DEFAULT_MODEL` wins, matching the CLI. Other tables are ignored.
 */
export function grokDefaultModelId(configText: string | null, envValue?: string): string | null {
  const fromEnv = envValue?.trim();
  if (fromEnv) return fromEnv;
  if (!configText) return null;
  let section: string | null = null;
  for (const line of configText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const header = /^\[([^\]]+)\]$/.exec(trimmed);
    if (header) {
      section = header[1].trim();
      continue;
    }
    if (section !== "models") continue;
    const match = /^default\s*=\s*(.+)$/.exec(trimmed);
    if (!match) continue;
    const id = unquote(match[1].trim());
    return id || null;
  }
  return null;
}

function modelId(value: unknown, fallback: string): string | null {
  const id = typeof value === "string" && value.trim() ? value.trim() : fallback;
  if (!id || id.length > 200 || /[\r\n]/.test(id)) return null;
  return id;
}

/**
 * Official models from `models_cache.json`.
 * Reads `info.id`, `info.name`, and `info.hidden` only.
 * A hidden model is omitted. The default model is listed first.
 */
export function parseGrokModelsCache(text: string, defaultId: string | null): GrokModelRecord[] {
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("bad cache");
  const models = (parsed as { models?: unknown }).models;
  if (!models || typeof models !== "object" || Array.isArray(models)) throw new Error("bad cache");
  const rows: GrokModelRecord[] = [];
  for (const [key, value] of Object.entries(models)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const info = (value as { info?: unknown }).info;
    if (!info || typeof info !== "object" || Array.isArray(info)) continue;
    const record = info as { id?: unknown; name?: unknown; hidden?: unknown };
    if (record.hidden === true) continue;
    const id = modelId(record.id, key);
    if (!id) continue;
    const name = typeof record.name === "string" && record.name.trim() ? record.name.trim().slice(0, 200) : id;
    rows.push({ key: id, name, provider: "grok", model: id, enabled: true, isDefault: false });
  }
  if (rows.length === 0) return rows;
  const preferred = defaultId ? rows.find((row) => row.model === defaultId) : undefined;
  const chosen = preferred ?? rows[0];
  chosen.isDefault = true;
  if (preferred && rows[0] !== preferred) return [preferred, ...rows.filter((row) => row !== preferred)];
  return rows;
}
