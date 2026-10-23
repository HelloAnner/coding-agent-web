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

function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
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

function render(preamble: string[], sections: Section[]): string {
  const parts = [...preamble];
  for (const section of sections) {
    parts.push(`[${section.header}]`);
    parts.push(...section.lines);
  }
  let text = parts.join("\n");
  if (!text.endsWith("\n")) text += "\n";
  return text;
}

function setField(section: Section, key: string, value: string): void {
  const rendered = `${key} = ${value}`;
  let sub = section.lines.length;
  for (let i = 0; i < section.lines.length; i += 1) {
    if (/^\s*\[/.test(section.lines[i])) {
      sub = i;
      break;
    }
  }
  for (let i = 0; i < sub; i += 1) {
    const item = assignment(section.lines[i]);
    if (item?.key === key) {
      section.lines[i] = rendered;
      return;
    }
  }
  section.lines.splice(sub, 0, rendered);
}

/** Rewrite one model's name and enabled flag. Other lines, including keys, stay. */
export function updateDshModel(text: string, key: string, patch: { name?: string; enabled?: boolean }): string | null {
  const { preamble, sections } = parseSections(text);
  const section = sections.find((item) => item.header === `model.${key}`);
  if (!section) return null;
  if (patch.name !== undefined) setField(section, "name", quote(patch.name));
  if (patch.enabled !== undefined) setField(section, "enabled", patch.enabled ? "true" : "false");
  return render(preamble, sections);
}
