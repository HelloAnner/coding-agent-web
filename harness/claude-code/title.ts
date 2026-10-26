import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import path from "node:path";
import { claudeProcessEnv, prepareClaudeProfile, resolveClaudeProfile } from "./index";
import { claudeTranscriptFile } from "./transcript";

const TITLE_TIMEOUT_MS = 90_000;

export interface ClaudeTitleRequest {
  cwd: string;
  /** The catalog's `model` is the profile id, not the CLI model name. */
  profileId?: string | null;
  provider?: string | null;
  prompt: string;
}

/**
 * One headless CLI run for one title. The CLI writes a native transcript for
 * the throwaway session id, so it is removed afterwards and never shows up in
 * the profile's own history. Tools and MCP are off: naming reads text only.
 */
export function generateClaudeTitle({ cwd, profileId, provider, prompt }: ClaudeTitleRequest): Promise<string> {
  const profile = resolveClaudeProfile(profileId ?? undefined, provider ?? undefined);
  prepareClaudeProfile(profile);
  const sessionId = randomUUID();
  const args = [
    "-p", prompt,
    "--output-format", "text",
    "--tools", "",
    "--strict-mcp-config",
    "--permission-mode", profile.permissionMode,
    "--effort", "low",
    ...(profile.model ? ["--model", profile.model] : []),
    "--session-id", sessionId,
  ];
  const env = claudeProcessEnv(profile);
  const bin = process.env.PI_WEB_CLAUDE_BIN?.trim() || "claude";

  return new Promise<string>((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    let stderr = "";
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        const file = claudeTranscriptFile(profile.configDir, sessionId);
        if (file) {
          rmSync(file, { force: true });
          rmSync(path.join(path.dirname(file), sessionId), { recursive: true, force: true });
        }
      } catch { /* the run may have failed before writing a transcript */ }
      if (error) reject(error);
      else resolve(text);
    };

    const timer = setTimeout(() => {
      child.kill("SIGINT");
      finish(new Error("Session title generation timed out"));
    }, TITLE_TIMEOUT_MS);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { text += chunk; });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });

    child.on("error", (error) => finish(new Error(`Claude Code could not start: ${error.message}`)));
    child.on("close", (code) => {
      if (code !== 0) {
        const tail = stderr.trim().split("\n").pop();
        finish(new Error(tail || `Claude Code exited with code ${code}`));
        return;
      }
      finish(text.trim() ? undefined : new Error("Claude Code did not return a session title"));
    });
  });
}
