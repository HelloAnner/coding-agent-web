import { NextResponse } from "next/server";
import { findHarness } from "@/harness/registry";
import { claudeAwaitingInputIds, claudeRunningIds } from "@/harness/claude-code/runtime";
import { dshRunningIds } from "@/harness/dsh/web-session";
import { grokRunningIds } from "@/harness/grok/runtime";
import { getAwaitingInputRpcSessionIds, getCompletionNotificationSuppressedRpcSessionIds, getRunningRpcSessionIds } from "@/lib/rpc-manager";
import { ompAwaitingInputIds, ompRunningIds } from "@/harness/omp/runtime";
import { guardOmpCatalogWrite } from "@/harness/omp/catalog";
import { CatalogHarnessLockedError, listCatalogSessionInfos, upsertCatalogSession } from "@/lib/catalog-db";

export const dynamic = "force-dynamic";

/** The sidebar list. Reads the index only. */
export async function GET() {
  const listed = listCatalogSessionInfos();
  return NextResponse.json({
    sessions: listed.sessions,
    sessionListVersion: listed.sessionListVersion,
    runningSessionIds: [...getRunningRpcSessionIds(), ...claudeRunningIds(), ...dshRunningIds(), ...grokRunningIds(), ...ompRunningIds()],
    awaitingInputSessionIds: [...getAwaitingInputRpcSessionIds(), ...claudeAwaitingInputIds(), ...ompAwaitingInputIds()],
    completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds(),
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null) as {
    id?: unknown;
    cwd?: unknown;
    harness?: unknown;
    provider?: unknown;
    model?: unknown;
    title?: unknown;
    sessionPath?: unknown;
    profilePath?: unknown;
  } | null;
  const cwd = typeof body?.cwd === "string" ? body.cwd : "";
  const harness = typeof body?.harness === "string" ? body.harness.trim() : "";
  if (!findHarness(harness)) return NextResponse.json({ error: "Unknown harness" }, { status: 400 });
  try {
    guardOmpCatalogWrite(typeof body?.id === "string" ? body.id : undefined, {
      harness, cwd,
      provider: typeof body?.provider === "string" ? body.provider : undefined,
      model: typeof body?.model === "string" ? body.model : undefined,
      sessionPath: typeof body?.sessionPath === "string" ? body.sessionPath : undefined,
      profilePath: typeof body?.profilePath === "string" ? body.profilePath : undefined,
    });
    const id = upsertCatalogSession({
      id: typeof body?.id === "string" ? body.id : undefined,
      cwd,
      harness,
      provider: typeof body?.provider === "string" ? body.provider : "",
      model: typeof body?.model === "string" ? body.model : "",
      title: typeof body?.title === "string" ? body.title : "",
      sessionPath: typeof body?.sessionPath === "string" ? body.sessionPath : "",
      profilePath: typeof body?.profilePath === "string" ? body.profilePath : "",
    });
    return NextResponse.json({ id });
  } catch (error) {
    if (error instanceof CatalogHarnessLockedError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    const message = error instanceof Error ? error.message : "Could not store the session";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
