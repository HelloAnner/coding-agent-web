import { NextResponse } from "next/server";
import { findHarness } from "@/harness/registry";
import { CatalogHarnessLockedError, deleteCatalogSession, updateCatalogSession, upsertCatalogSession } from "@/lib/catalog-db";

export const dynamic = "force-dynamic";

/** Update the index row. A missing row is created when cwd is sent. Does not touch the harness file. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null) as {
    cwd?: unknown;
    harness?: unknown;
    provider?: unknown;
    model?: unknown;
    title?: unknown;
    sessionPath?: unknown;
    profilePath?: unknown;
  } | null;
  const harness = typeof body?.harness === "string" ? body.harness.trim() : undefined;
  if (harness && !findHarness(harness)) return NextResponse.json({ error: "Unknown harness" }, { status: 400 });
  const patch = {
    harness,
    provider: typeof body?.provider === "string" ? body.provider : undefined,
    model: typeof body?.model === "string" ? body.model : undefined,
    title: typeof body?.title === "string" ? body.title : undefined,
    sessionPath: typeof body?.sessionPath === "string" ? body.sessionPath : undefined,
    profilePath: typeof body?.profilePath === "string" ? body.profilePath : undefined,
    cwd: typeof body?.cwd === "string" ? body.cwd : undefined,
  };
  try {
    if (updateCatalogSession(id, patch)) return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof CatalogHarnessLockedError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
  if (!patch.cwd || !patch.harness) return NextResponse.json({ error: "Session is not in the index" }, { status: 404 });
  try {
    upsertCatalogSession({
      id,
      cwd: patch.cwd,
      harness: patch.harness,
      provider: patch.provider,
      model: patch.model,
      title: patch.title,
      sessionPath: patch.sessionPath,
      profilePath: patch.profilePath,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not store the session";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

/** Drop the index row. The harness session file stays where it is. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  deleteCatalogSession(id);
  return NextResponse.json({ ok: true });
}
