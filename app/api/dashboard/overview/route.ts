import { NextResponse } from "next/server";
import { dashboardOverview } from "../../../../dashboard/server.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The dashboard's own backend, behind this server's authentication. */
export async function GET() {
  return NextResponse.json(dashboardOverview(), {
    headers: { "Cache-Control": "no-store" },
  });
}
