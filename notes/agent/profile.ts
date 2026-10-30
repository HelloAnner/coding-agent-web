import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import path from "node:path";
import { notesRoot } from "../files";
import { readNotesSettings } from "./settings";
import { codingSessionModel } from "./model";
import { listNotesSkills, notesSkillsDir } from "./skills";
import { NOTES_SYSTEM_PROMPT } from "./system-prompt";
import { NOTES_BOARD_TOOL, NOTES_LS_TOOL, NOTES_SESSIONS_TOOL, notesAgentTools } from "./tools";

/**
 * Every notes run remains an independent pi session. A digest borrows only
 * its source model/auth; the standalone panel shares pi defaults. Prompts,
 * skills, tools and the in-memory conversation remain owned by this factory.
 */

/** Only what an agent may call: reading, listing, drawing boards, Coding sessions. */
export const NOTES_AGENT_TOOLS = ["read", NOTES_LS_TOOL, NOTES_BOARD_TOOL, NOTES_SESSIONS_TOOL];

export interface NotesSessionProfile {
  /** Inherit only this Coding conversation's model and authentication. */
  sourceSessionId?: string;
  /** Defaults to the notes panel's own preamble. */
  systemPrompt?: string;
  /** Skill names under notes/skills; undefined loads all of them, [] loads none. */
  skills?: string[];
  /** Tool allowlist; defaults to NOTES_AGENT_TOOLS. [] disables every tool. */
  tools?: string[];
  /** Pin notes_board to this one board: edit it however the prompt says, nothing else. */
  onlyBoard?: string;
}

export interface NotesSessionHandle {
  session: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"];
  modelLabel: string | null;
}

declare global {
  // A new cache key deliberately excludes runtimes that registered the retired
  // notes provider before a dev reload. A failed build is retried.
  var __piWebNotesDefaultModelRuntime: Promise<ModelRuntime> | undefined;
}

function notesModelRuntime(): Promise<ModelRuntime> {
  const agentDir = getAgentDir();
  globalThis.__piWebNotesDefaultModelRuntime ??= ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(agentDir, "models.json"),
  }).catch((error: unknown) => {
    globalThis.__piWebNotesDefaultModelRuntime = undefined;
    throw error;
  });
  return globalThis.__piWebNotesDefaultModelRuntime;
}

/**
 * pi's own default model, for the standalone notes panel before its first run.
 */
export function piDefaultModelLabel(): string | null {
  try {
    const settings = JSON.parse(readFileSync(path.join(getAgentDir(), "settings.json"), "utf8")) as {
      defaultProvider?: unknown;
      defaultModel?: unknown;
    };
    return typeof settings.defaultProvider === "string" && typeof settings.defaultModel === "string"
      ? `${settings.defaultProvider}/${settings.defaultModel}`
      : null;
  } catch {
    return null;
  }
}

/** Build a fresh, disposable session for one run of a notes agent profile. */
export async function createNotesSession(profile: NotesSessionProfile = {}): Promise<NotesSessionHandle> {
  const settings = readNotesSettings();
  const vault = notesRoot();
  const skillsDir = notesSkillsDir();
  const source = profile.sourceSessionId ? await codingSessionModel(profile.sourceSessionId) : null;
  const runtime = source?.runtime ?? await notesModelRuntime();
  const model = source?.model;
  const wanted = profile.skills;
  const tools = profile.tools ?? NOTES_AGENT_TOOLS;
  const piDefaults = SettingsManager.create(vault, getAgentDir(), { projectTrusted: false });

  const services = await createAgentSessionServices({
    cwd: vault,
    agentDir: getAgentDir(),
    modelRuntime: runtime,
    // Copy only model preferences, not coding resources or vault project settings.
    // Setters still write to memory, never to the user's global pi settings.
    settingsManager: SettingsManager.inMemory({
      defaultProvider: piDefaults.getDefaultProvider(),
      defaultModel: piDefaults.getDefaultModel(),
      defaultThinkingLevel: piDefaults.getDefaultThinkingLevel(),
      modelThinkingLevels: piDefaults.getAllModelThinkingLevels(),
    }),
    resourceLoaderOptions: {
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: profile.systemPrompt ?? NOTES_SYSTEM_PROMPT,
      // Never inherit global coding rules. The selected skill bodies are always
      // appended, even when `read` is on: the rules must be in the prompt, and
      // references/ under each skill is only depth for a run that wants it.
      appendSystemPrompt: listNotesSkills()
        .filter((skill) => !wanted || wanted.includes(skill.name))
        .map((skill) => readFileSync(skill.path, "utf8")),
      additionalSkillPaths: [skillsDir],
      // Only the notes agent's own skills, narrowed to the profile's list: the
      // user's coding skills are for coding sessions, and their catalog would
      // bloat every notes prompt.
      skillsOverride: (base) => ({
        skills: base.skills.filter((skill) => skill.filePath.startsWith(skillsDir)
          && (!wanted || wanted.includes(skill.name))),
        diagnostics: base.diagnostics,
      }),
    },
  });

  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(vault),
    tools,
    customTools: notesAgentTools(settings.board, { onlyBoard: profile.onlyBoard }),
    ...(model ? { model } : {}),
  });

  return { session, modelLabel: session.model ? `${session.model.provider}/${session.model.id}` : null };
}
