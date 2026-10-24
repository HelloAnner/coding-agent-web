import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { grokBin, grokHistoryFile, grokPermissionMode } from "./index";

const TITLE_TIMEOUT_MS = 90_000;

export interface GrokTitleRequest {
  cwd: string;
  model?: string | null;
  prompt: string;
}

/**
 * One headless grok run for one title. `-s` pins the session id so the log the
 * run writes can be removed afterwards and never appears in grok's own list.
 * Without `--model` grok uses its configured default, which is the same rule
 * the harness follows everywhere else.
 */
export function generateGrokTitle({ cwd, model, prompt }: GrokTitleRequest): Promise<string> {
  const sessionId = randomUUID();
  const args = [
    "-p", prompt,
    "--output-format", "streaming-json",
    "--permission-mode", grokPermissionMode(),
    ...(model?.trim() ? ["--model", model.trim()] : []),
    "-s", sessionId,
  ];

  return new Promise<string>((resolve, reject) => {
    const child = spawn(grokBin(), args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    let stderr = "";
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rmSync(path.dirname(grokHistoryFile(cwd, sessionId)), { recursive: true, force: true });
      if (error) reject(error);
      else resolve(text);
    };

    const timer = setTimeout(() => {
      child.kill("SIGINT");
      finish(new Error("Session title generation timed out"));
    }, TITLE_TIMEOUT_MS);

    child.stdout?.setEncoding("utf8");
    createInterface({ input: child.stdout! }).on("line", (line) => {
      if (!line.trim()) return;
      try {
        const record = JSON.parse(line) as { type?: unknown; data?: unknown };
        if (record.type === "text" && typeof record.data === "string") text += record.data;
      } catch {
        /* a partial line at the end of a killed run */
      }
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000);
    });

    child.on("error", (error) => finish(new Error(`grok could not start: ${error.message}`)));
    child.on("close", (code) => {
      if (code !== 0) {
        const tail = stderr.trim().split("\n").pop();
        finish(new Error(tail || `grok exited with code ${code}`));
        return;
      }
      finish(text.trim() ? undefined : new Error("grok did not return a session title"));
    });
  });
}
