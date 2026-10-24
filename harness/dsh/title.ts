import { rmSync } from "node:fs";
import { dshKernel, type AcpSessionState } from "./acp";
import { findDshSessionDir } from "./index";

const TITLE_TIMEOUT_MS = 90_000;

export interface DshTitleRequest {
  cwd: string;
  provider?: string | null;
  model?: string | null;
  prompt: string;
}

/**
 * One throwaway ACP session for one title, on the kernel that is already up.
 * The chat's own session is untouched, and the log the kernel writes for the
 * naming run is removed afterwards so it never shows up as a chat in dsh.
 */
export async function generateDshTitle({ cwd, provider, model, prompt }: DshTitleRequest): Promise<string> {
  const client = dshKernel();
  await client.ready();
  const state = await client.request<AcpSessionState>("session/new", { cwd, mcpServers: [] });
  const sessionId = state.sessionId;

  let text = "";
  const unsubscribe = client.onUpdate((message) => {
    if (message.sessionId !== sessionId || message.update.sessionUpdate !== "agent_message_chunk") return;
    const content = message.update.content as { type?: unknown; text?: unknown } | undefined;
    if (content?.type === "text" && typeof content.text === "string") text += content.text;
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    client.notify("session/cancel", { sessionId });
  }, TITLE_TIMEOUT_MS);

  try {
    if (provider && model) {
      // A profile that does not mount this model still names the session: the
      // kernel's own default is a better answer than no title.
      await client
        .request("session/set_config_option", { sessionId, configId: "model", value: JSON.stringify([provider, model]) })
        .catch(() => undefined);
    }
    await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: prompt }] });
    if (timedOut) throw new Error("Session title generation timed out");
    if (!text.trim()) throw new Error("dsh did not return a session title");
    return text;
  } finally {
    clearTimeout(timer);
    unsubscribe();
    const directory = findDshSessionDir(sessionId);
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
}
