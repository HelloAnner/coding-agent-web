import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { claudeProjectTrusted, prepareClaudeProfile, resolveClaudeProfile, trustClaudeProject } from "@/harness/claude-code";
import { claudeState, getClaudeRun, sendClaudePrompt } from "@/harness/claude-code/runtime";
import { CLAUDE_UUID, readClaudeTranscript } from "@/harness/claude-code/transcript";
import { readCatalogSession } from "@/lib/catalog-db";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { MAX_TOOL_RESULT_IMAGE_BYTES, TOOL_RESULT_IMAGE_MIMES } from "@/lib/tool-result-images";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!CLAUDE_UUID.test(id)) return NextResponse.json({ error: "Invalid Claude Code session id" }, { status: 400 });
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Expected JSON" }, { status: 400 });
  try {
    if (body.type === "abort") return NextResponse.json({ success: true, data: { aborted: getClaudeRun(id).abort() } });
    if (body.type === "get_state") return NextResponse.json({ success: true, data: claudeState(id).state });
    if (body.type === "extension_ui_response") {
      if (typeof body.id !== "string" || (body.value !== undefined && (typeof body.value !== "string" || body.value.length > 1024 * 1024))) return NextResponse.json({ error: "Invalid Claude Code response" }, { status: 400 });
      getClaudeRun(id).respond(body.id, body);
      return NextResponse.json({ success: true });
    }
    if (body.type !== "prompt") return NextResponse.json({ error: "Unknown Claude Code command" }, { status: 400 });
    const message = typeof body.message === "string" ? body.message : "";
    const cwdInput = typeof body.cwd === "string" ? body.cwd : "";
    if (!path.isAbsolute(cwdInput) || !statSync(cwdInput).isDirectory()) return NextResponse.json({ error: "cwd must be an existing absolute directory" }, { status: 400 });
    const cwd = realpathSync(cwdInput);
    if (!isExistingFilePathAllowed(cwd, await getAllowedFileRoots())) return NextResponse.json({ error: "Select this project directory in the web app before starting Claude Code" }, { status: 403 });
    if (message.length > 1024 * 1024) return NextResponse.json({ error: "Message is too large" }, { status: 400 });
    const images: Array<{ data: string; mimeType: string }> = [];
    if (body.images !== undefined) {
      if (!Array.isArray(body.images) || body.images.length > 8) return NextResponse.json({ error: "Expected at most 8 images" }, { status: 400 });
      for (const image of body.images) {
        if (!image || typeof image !== "object" || typeof image.data !== "string" || typeof image.mimeType !== "string" || !TOOL_RESULT_IMAGE_MIMES.has(image.mimeType) || image.data.length > Math.ceil(MAX_TOOL_RESULT_IMAGE_BYTES * 4 / 3) || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) return NextResponse.json({ error: "Invalid image attachment" }, { status: 400 });
        images.push({ data: image.data, mimeType: image.mimeType });
      }
    }
    if (!message.trim() && !images.length) return NextResponse.json({ error: "Message is empty" }, { status: 400 });
    const existing = readCatalogSession(id);
    const profileId = typeof body.model === "string" ? body.model : existing?.model;
    const provider = typeof body.provider === "string" ? body.provider : existing?.provider;
    const profile = resolveClaudeProfile(profileId, provider);
    if (existing && (existing.harness !== "claude-code" || existing.model !== profile.id || existing.provider !== profile.provider || existing.sessionPath !== profile.configDir || realpathSync(existing.cwd) !== cwd)) return NextResponse.json({ error: "Start a new chat to switch Claude Code profiles" }, { status: 409 });
    if (!claudeProjectTrusted(profile, cwd)) {
      if (body.trusted !== true) return NextResponse.json({ error: "Claude Code will load this project's hooks and MCP servers", requiresTrust: true, cwd }, { status: 409 });
      prepareClaudeProfile(profile);
      trustClaudeProject(profile, cwd);
    }
    if (body.promptId !== undefined && (typeof body.promptId !== "string" || !CLAUDE_UUID.test(body.promptId))) return NextResponse.json({ error: "Invalid prompt id" }, { status: 400 });
    const data = await sendClaudePrompt({ id, cwd, profileId: profile.id, provider: profile.provider, promptId: body.promptId as string | undefined, text: message, images });
    return NextResponse.json({ success: true, data: { ...data, cwd, sessionId: id, accepted: true } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Claude Code request failed" }, { status: 400 });
  }
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!CLAUDE_UUID.test(id)) return NextResponse.json({ error: "Invalid Claude Code session id" }, { status: 400 });
  if (new URL(req.url).searchParams.has("state")) return NextResponse.json(claudeState(id), { headers: { "Cache-Control": "no-store" } });
  const session = readCatalogSession(id);
  if (!session || session.harness !== "claude-code") return NextResponse.json({ error: "Session not found" }, { status: 404 });
  try {
    const profile = resolveClaudeProfile(session.model, session.provider, true);
    if (session.sessionPath !== profile.configDir) throw new Error("This session's profile directory has changed. Restore its configured directory to resume it.");
    const transcript = readClaudeTranscript(profile.configDir, id);
    return NextResponse.json({ sessionId: id, filePath: transcript.path ?? "", totalActiveMs: 0, stats: transcript.stats, tree: [], leafId: null,
      context: { messages: transcript.messages, entryIds: transcript.messages.map((message) => message.nativeId), oldestEntryId: null, hasMore: false, turnsBefore: 0, thinkingLevel: profile.effort ?? "off", model: { provider: session.provider, modelId: session.model } },
      ...claudeState(id),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not read Claude Code history" }, { status: 400 });
  }
}
