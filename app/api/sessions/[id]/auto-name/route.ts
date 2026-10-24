import { NextResponse } from "next/server";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { readCatalogSession, updateCatalogSession, type CatalogSession } from "@/lib/catalog-db";
import { askSessionTitleModel, buildTitlePrompt, buildTitleTranscript, fitTitleInLimit, generateSessionTitle, parseGeneratedSessionTitle } from "@/lib/session-title";
import { generateDshTitle } from "@/harness/dsh/title";
import { readDshTranscript } from "@/harness/dsh/transcript";
import { generateGrokTitle } from "@/harness/grok/title";
import { readGrokTranscript } from "@/harness/grok/transcript";
import { readClaudeTitle } from "@/harness/claude-code/transcript";
import { resolveClaudeProfile } from "@/harness/claude-code";
import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";
import { invalidateSessionListCache, resolveSessionPath } from "@/lib/session-reader";

export const dynamic = "force-dynamic";

/**
 * A harness chat names itself through its own runtime: dsh on the kernel that
 * is already up, grok in one headless run. The transcript comes from the log
 * the harness writes, so nothing is read back into pi's session format.
 */
async function askHarness(row: CatalogSession, prompt: string): Promise<string> {
  if (row.harness === "dsh") {
    return generateDshTitle({ cwd: row.cwd, provider: row.provider, model: row.model, prompt });
  }
  if (row.harness === "grok") {
    return generateGrokTitle({ cwd: row.cwd, model: row.model, prompt });
  }
  throw new Error(`Title generation is not wired for the ${row.harness} harness`);
}

/** The harness transcript as the title prompt, or an error when there is none. */
function harnessTitlePrompt(row: CatalogSession): string {
  const messages = row.harness === "dsh"
    ? readDshTranscript(row.sessionPath).messages
    : readGrokTranscript(row.cwd, row.id).messages;
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
    // Claude Code writes its own title into the transcript; there is no second
    // turn to ask, so it is read as it stands.
    if (indexed?.harness === "claude-code") {
      const profile = resolveClaudeProfile(indexed.model, indexed.provider, true);
      if (profile.configDir !== indexed.sessionPath) throw new Error("Claude Code profile directory has changed");
      const title = parseGeneratedSessionTitle(readClaudeTitle(profile.configDir, indexed.id));
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
