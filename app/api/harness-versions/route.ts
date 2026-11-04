import { NextResponse } from "next/server";
import type { HarnessUpgradeResponse } from "@/lib/api-types";
import { listHarnessVersions, upgradeHarness } from "@/lib/harness-versions";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

/** GET /api/harness-versions: every supported harness with the version it runs today. */
export async function GET() {
  return NextResponse.json({ harnesses: await listHarnessVersions() }, {
    headers: { "Cache-Control": "no-store" },
  });
}

/** POST /api/harness-versions body: { id } — runs that harness's own updater. */
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  const body = await req.json().catch(() => null) as { id?: unknown } | null;
  const id = typeof body?.id === "string" ? body.id : "";
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  try {
    const result = await upgradeHarness(id);
    if (!result) return NextResponse.json({ error: `No one-click upgrade for ${id}` }, { status: 400 });
    return NextResponse.json(result satisfies HarnessUpgradeResponse);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
