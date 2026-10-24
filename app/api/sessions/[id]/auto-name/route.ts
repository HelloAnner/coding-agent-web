import { NextResponse } from "next/server";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { readCatalogSession, updateCatalogSession, type CatalogSession } from "@/lib/catalog-db";
import { buildTitlePrompt, buildTitleTranscript, generateSessionTitle, parseGeneratedSessionTitle } from "@/lib/session-title";
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
async function generateHarnessTitle(row: CatalogSession): Promise<string> {
  if (row.harness === "claude-code") {
    const profile = resolveClaudeProfile(row.model, row.provider, true);
    if (profile.configDir !== row.sessionPath) throw new Error("Claude Code profile directory has changed");
    return readClaudeTitle(profile.configDir, row.id);
  }
  const messages = row.harness === "dsh"
    ? readDshTranscript(row.sessionPath).messages
    : readGrokTranscript(row.cwd, row.id).messages;
  const transcript = buildTitleTranscript(messages);
  if (!transcript.trim()) throw new Error("The session has no usable text to name");
  const prompt = buildTitlePrompt(transcript);

  if (row.harness === "dsh") {
    return generateDshTitle({ cwd: row.cwd, provider: row.provider, model: row.model, prompt });
  }
  if (row.harness === "grok") {
    return generateGrokTitle({ cwd: row.cwd, model: row.model, prompt });
  }
  throw new Error(`Title generation is not wired for the ${row.harness} harness`);
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const indexed = readCatalogSession(id);
    if (indexed && indexed.harness !== "pi") {
      const title = parseGeneratedSessionTitle(await generateHarnessTitle(indexed));
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

    if (!session.isAlive()) {
      return NextResponse.json(
        { error: "The session was closed while its title was being generated. Please try again." },
        { status: 409 },
      );
    }

    session.inner.setSessionName(result.title);
    invalidateSessionListCache();
    return NextResponse.json({ title: result.title, usage: result.usage ?? null });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
