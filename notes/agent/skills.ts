import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { NotesAgentSkill } from "../types";

/**
 * The notes agent's skills live in notes/skills, one directory per skill with a
 * SKILL.md whose frontmatter carries `name` and `description`. They are part of
 * the app, not the vault: a skill is behavior, a note is content.
 */

export function notesSkillsDir(): string {
  return path.join(process.cwd(), "notes", "skills");
}

/** Every readable skill, for the runtime's prompt and the settings dialog. */
export function listNotesSkills(): NotesAgentSkill[] {
  const root = notesSkillsDir();
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const skills: NotesAgentSkill[] = [];
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const file = path.join(root, entry, "SKILL.md");
    try {
      const { frontmatter } = parseFrontmatter<{ name?: unknown; description?: unknown }>(readFileSync(file, "utf8"));
      const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : entry;
      const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
      if (name) skills.push({ name, description, path: file });
    } catch {
      // A directory without a readable SKILL.md is not a skill.
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}
