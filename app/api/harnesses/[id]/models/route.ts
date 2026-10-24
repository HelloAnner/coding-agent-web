import { NextResponse } from "next/server";
import { findHarness } from "@/harness/registry";
import { HarnessModelsError, type HarnessModelList } from "@/harness/types";
import { shortenPath } from "@/lib/display-path";

export const dynamic = "force-dynamic";

/**
 * Models of one harness, from that harness's own reader.
 * pi keeps using /api/models. A harness with no reader answers an empty list.
 * This route never returns credentials.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const harness = findHarness(id);
  if (!harness) return NextResponse.json({ error: "Unknown harness" }, { status: 404 });
  const live = new URL(req.url).searchParams.get("live") === "1";
  if (!harness.readModels && !harness.readChatModels) {
    return NextResponse.json({ harness: id, models: [] });
  }
  const send = (file: HarnessModelList) => NextResponse.json({
    harness: id,
    path: shortenPath(file.path),
    ...(file.providers ? { providers: file.providers } : {}),
    models: file.models,
  }, { headers: { "Cache-Control": "no-store" } });
  try {
    const file = live && harness.readChatModels
      ? await harness.readChatModels()
      // The composer falls back to the file when the runtime is not up yet.
      : harness.readModels?.();
    if (!file) return NextResponse.json({ harness: id, models: [] });
    return send(file);
  } catch (error) {
    if (live && harness.readModels) {
      try {
        return send(harness.readModels());
      } catch {
        /* fall through to the runtime error */
      }
    }
    const missing = error instanceof HarnessModelsError ? error : null;
    return NextResponse.json({
      error: missing?.message ?? "Model list was not found",
      path: shortenPath(missing?.path ?? harness.configDir()),
    }, { status: missing?.status && missing.status !== 200 ? missing.status : 404 });
  }
}

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const harness = findHarness(id);
  if (!harness?.writeModel) return NextResponse.json({ error: "This harness is not edited here" }, { status: 404 });
  const body = await req.json().catch(() => null) as { key?: unknown; name?: unknown; enabled?: unknown } | null;
  const key = typeof body?.key === "string" ? body.key.trim() : "";
  if (!key || key.length > 200 || /[\r\n]/.test(key)) {
    return NextResponse.json({ error: "Missing model key" }, { status: 400 });
  }
  const patch: { name?: string; enabled?: boolean } = {};
  if (typeof body?.name === "string") {
    const name = body.name.trim();
    if (!name || name.length > 200) return NextResponse.json({ error: "Invalid name" }, { status: 400 });
    patch.name = name;
  }
  if (typeof body?.enabled === "boolean") patch.enabled = body.enabled;
  if (patch.name === undefined && patch.enabled === undefined) {
    return NextResponse.json({ error: "Nothing to change" }, { status: 400 });
  }
  try {
    const wrote = harness.writeModel(key, patch);
    if (!wrote) return NextResponse.json({ error: "Model was not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof HarnessModelsError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "Could not write the model list" }, { status: 500 });
  }
}
