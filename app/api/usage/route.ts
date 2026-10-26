import { NextResponse } from "next/server";
import { refreshUsage, usageData } from "@/lib/usage-refresh";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    return NextResponse.json(usageData());
  } catch {
    return NextResponse.json({ error: "Usage database is unavailable." }, { status: 500 });
  }
}

export async function POST() {
  try {
    await refreshUsage();
    const data = usageData();
    return NextResponse.json(data, { status: data.sync.error ? 503 : 200 });
  } catch {
    return NextResponse.json({ error: "Usage collection is unavailable." }, { status: 500 });
  }
}
