import { NextResponse } from "next/server";
import { listHarnesses } from "@/harness/registry";
import { shortenPath } from "@/lib/display-path";

export const dynamic = "force-dynamic";

/** Harnesses the settings tabs and the composer can switch to. */
export async function GET() {
  return NextResponse.json({
    harnesses: listHarnesses().map((harness) => ({
      id: harness.id,
      label: harness.label,
      configDir: shortenPath(harness.configDir()),
    })),
  }, { headers: { "Cache-Control": "no-store" } });
}
