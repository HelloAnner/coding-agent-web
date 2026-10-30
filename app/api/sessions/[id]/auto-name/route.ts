import { NextResponse } from "next/server";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { readCatalogSession, updateCatalogSession, type CatalogSession } from "@/lib/catalog-db";
import { askSessionTitleModel, buildTitlePrompt, buildTitleTranscript, fitTitleInLimit, generateSessionTitle, parseGeneratedSessionTitle } from "@/lib/session-title";
import { readDshNativeTitle } from "@/harness/dsh/web-session";
import { generateGrokTitle } from "@/harness/grok/title";
import { readGrokTranscript } from "@/harness/grok/transcript";
import { generateClaudeTitle } from "@/harness/claude-code/title";
import { readClaudeNativeTitle, readClaudeTranscript } from "@/harness/claude-code/transcript";
import { resolveClaudeProfile } from "@/harness/claude-code";
import { readOmpTranscript } from "@/harness/omp/transcript";
import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";
import { invalidateSessionListCache, resolveSessionPath } from "@/lib/session-reader";

export const dynamic = "force-dynamic";

/**
 * dsh reads its authoritative native title; grok and Claude Code can name
 * themselves in one headless run. The transcript comes
 * from the log the harness writes, so nothing is read back into pi's format.
 */
async function askHarness(row: CatalogSession, prompt: string): Promise<string> {
  if (row.harness === "grok") {
    return generateGrokTitle({ cwd: row.cwd, model: row.model, prompt });
  }
  if (row.harness === "claude-code") {
    return generateClaudeTitle({ cwd: row.cwd, profileId: row.model, provider: row.provider, prompt });
  }
  throw new Error(`Title generation is not wired for the ${row.harness} harness`);
}

/** The harness transcript as the title prompt, or an error when there is none. */
function harnessTitlePrompt(row: CatalogSession): string {
  if (row.harness === "claude-code") {
    const profile = resolveClaudeProfile(row.model, row.provider, true);
    if (profile.configDir !== (row.profilePath || row.sessionPath)) throw new Error("Claude Code profile directory has changed");
    const transcript = buildTitleTranscript(readClaudeTranscript(profile.configDir, row.id).messages);
    if (!transcript.trim()) throw new Error("The session has no usable text to name");
    return buildTitlePrompt(transcript);
  }
  const messages = readGrokTranscript(row.cwd, row.id).messages;
  const transcript = buildTitleTranscript(messages);
  if (!transcript.trim()) throw new Error("The session has no usable text to name");
  return buildTitlePrompt(transcript);
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const indexed = readCatalogSession(id);
    if (indexed?.harness === "dsh") {
      const title = await readDshNativeTitle(id) || indexed.title;
      if (!title) return NextResponse.json({ error: "The native dsh title is still being generated" }, { status: 409 });
      updateCatalogSession(id, { title });
      return NextResponse.json({ title, usage: null });
    }
    if (indexed?.harness === "omp") {
      const first = readOmpTranscript(id, indexed.sessionPath).messages.find((message) => message.role === "user");
      const content = first?.content;
      const text = typeof content === "string" ? content : content?.filter((block) => block.type === "text").map((block) => block.text).join(" ") ?? "";
      const title = text.trim().split("\n")[0].slice(0, 60) || indexed.title || "OMP";
      updateCatalogSession(id, { title });
      return NextResponse.json({ title, usage: null });
    }
    if (indexed?.harness === "claude-code") {
      const profile = resolveClaudeProfile(indexed.model, indexed.provider, true);
      if (profile.configDir !== (indexed.profilePath || indexed.sessionPath)) throw new Error("Claude Code profile directory has changed");
      // A title written by the CLI itself is authoritative. Headless runs do
      // not write one, so name the chat with the profile's own model instead
      // of leaving the first prompt as the title forever.
      const native = readClaudeNativeTitle(profile.configDir, indexed.id);
      const title = native
        ? parseGeneratedSessionTitle(native)
        : await fitTitleInLimit(
          await askHarness(indexed, harnessTitlePrompt(indexed)),
          (instruction) => askHarness(indexed, instruction),
        );
      updateCatalogSession(id, { title });
      return NextResponse.json({ title, usage: null });
    }
    if (indexed && indexed.harness !== "pi") {
      const title = await fitTitleInLimit(
        await askHarness(indexed, harnessTitlePrompt(indexed)),
        (instruction) => askHarness(indexed, instruction),
      );
      updateCatalogSession(id, { title });
      return NextResponse.json({ title, usage: null });
    }

    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const existing = getRpcSession(id);
    const { session } = existing?.isAlive()
      ? { session: existing }
      : await startRpcSession(id, filePath, undefined);

    // globalThis keeps wrappers alive across dev hot reloads; older instances
    // may predate waitUntilReady(), but those have already completed startup.
    await session.waitUntilReady?.();
    const result = await generateSessionTitle(session.inner as unknown as AgentSession);
    const title = await fitTitleInLimit(
      result.title,
      async (instruction) => (await askSessionTitleModel(session.inner as unknown as AgentSession, instruction)).title,
    );

    if (!session.isAlive()) {
      return NextResponse.json(
        { error: "The session was closed while its title was being generated. Please try again." },
        { status: 409 },
      );
    }

    session.inner.setSessionName(title);
    invalidateSessionListCache();
    return NextResponse.json({ title, usage: result.usage ?? null });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
