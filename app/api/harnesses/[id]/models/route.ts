import { NextResponse } from "next/server";
import { dshConfigFile, readDshModels, writeDshModel } from "@/harness/dsh";
import { grokModelsCacheFile, readGrokModels } from "@/harness/grok";
import { findHarness } from "@/harness/registry";
import { shortenPath } from "@/lib/display-path";

export const dynamic = "force-dynamic";

/**
 * Models of one harness, from that harness's own file.
 * pi keeps using /api/models. This route never returns credentials.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!findHarness(id)) return NextResponse.json({ error: "Unknown harness" }, { status: 404 });
  if (id === "grok") {
    try {
      const file = readGrokModels();
      return NextResponse.json({
        harness: "grok",
        path: shortenPath(file.path),
        models: file.models,
      }, { headers: { "Cache-Control": "no-store" } });
    } catch {
      return NextResponse.json({ error: "Grok's model list was not found", path: shortenPath(grokModelsCacheFile()) }, { status: 404 });
    }
  }
  if (id !== "dsh") return NextResponse.json({ harness: id, models: [] });
  try {
    const file = readDshModels();
    return NextResponse.json({
      harness: "dsh",
      path: shortenPath(file.path),
      providers: file.providers,
      models: file.models,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "ds.toml was not found", path: shortenPath(dshConfigFile()) }, { status: 404 });
  }
}

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (id !== "dsh") return NextResponse.json({ error: "This harness is not edited here" }, { status: 404 });
  const body = await req.json().catch(() => null) as { key?: unknown; name?: unknown; enabled?: unknown } | null;
  const key = typeof body?.key === "string" ? body.key.trim() : "";
  if (!key || key.includes(".") || key.includes("/")) {
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
    const wrote = writeDshModel(key, patch);
    if (!wrote) return NextResponse.json({ error: "Model was not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Could not write ds.toml" }, { status: 500 });
  }
}
