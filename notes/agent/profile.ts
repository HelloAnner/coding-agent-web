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
import type { NotesAgentModelSettings } from "../types";
import { notesRoot } from "../files";
import { readNotesSettings } from "./settings";
import { notesSkillsDir } from "./skills";
import { NOTES_SYSTEM_PROMPT } from "./system-prompt";
import { NOTES_BOARD_TOOL, NOTES_LS_TOOL, NOTES_SESSIONS_TOOL, notesAgentTools } from "./tools";

/**
 * How one notes agent session is built. The expensive, auth-bound part (the
 * ModelRuntime) is process-wide and shared; everything a task may vary — system
 * prompt, skills, enabled tools — lives here and is resolved per session. The
 * interactive panel and every scheduled task use this same factory.
 */

export const NOTES_AGENT_PROVIDER = "notes";

/** Only what an agent may call: reading, listing, drawing boards, Coding sessions. */
export const NOTES_AGENT_TOOLS = ["read", NOTES_LS_TOOL, NOTES_BOARD_TOOL, NOTES_SESSIONS_TOOL];

export interface NotesSessionProfile {
  /** Defaults to the notes panel's own preamble. */
  systemPrompt?: string;
  /** Skill names under notes/skills; undefined loads all of them, [] loads none. */
  skills?: string[];
  /** Tool allowlist; defaults to NOTES_AGENT_TOOLS. [] disables every tool. */
  tools?: string[];
}

export interface NotesSessionHandle {
  session: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"];
  modelLabel: string | null;
}

declare global {
  // One runtime per process: it holds pi's provider composition and auth. A
  // failed build is not cached, so the next call retries.
  var __piWebNotesModelRuntime: Promise<ModelRuntime> | undefined;
}

function notesModelRuntime(): Promise<ModelRuntime> {
  const agentDir = getAgentDir();
  globalThis.__piWebNotesModelRuntime ??= ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(agentDir, "models.json"),
  }).catch((error: unknown) => {
    globalThis.__piWebNotesModelRuntime = undefined;
    throw error;
  });
  return globalThis.__piWebNotesModelRuntime;
}

/**
 * The notes model from the settings dialog, registered as its own provider so
 * it never touches models.json. Empty baseUrl or model means "use pi's own
 * default model", which is what a fresh install already has.
 */
function notesModel(runtime: ModelRuntime, settings: NotesAgentModelSettings) {
  if (!settings.baseUrl || !settings.model) return undefined;
  runtime.registerProvider(NOTES_AGENT_PROVIDER, {
    name: "Notes Agent",
    baseUrl: settings.baseUrl,
    // Local OpenAI-compatible servers often need no key; pi refuses a provider without one.
    apiKey: settings.apiKey || "not-needed",
    api: settings.api,
    models: [{
      id: settings.model,
      name: settings.model,
      api: settings.api,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      reasoning: false,
      contextWindow: settings.contextWindow,
      maxTokens: settings.maxTokens,
    }],
  });
  return runtime.getModel(NOTES_AGENT_PROVIDER, settings.model);
}

/**
 * pi's own default model, as a label, so the settings dialog can say what an
 * empty notes model actually runs on. Undefined when pi has not chosen one.
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
  const runtime = await notesModelRuntime();
  const model = notesModel(runtime, settings.agent);
  const wanted = profile.skills;

  const services = await createAgentSessionServices({
    cwd: vault,
    agentDir: getAgentDir(),
    modelRuntime: runtime,
    // The notes agent has no project settings of its own: nothing here may
    // write to the user's global pi settings.
    settingsManager: SettingsManager.inMemory(),
    resourceLoaderOptions: {
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: profile.systemPrompt ?? NOTES_SYSTEM_PROMPT,
      // pi's global APPEND_SYSTEM.md is coding rules (git, AGENTS.md); the
      // notes agent has its own prompt and must not inherit them.
      appendSystemPrompt: [],
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
    tools: profile.tools ?? NOTES_AGENT_TOOLS,
    customTools: notesAgentTools(settings.board),
    ...(model ? { model } : {}),
  });

  return { session, modelLabel: model ? `${model.provider}/${model.id}` : null };
}
