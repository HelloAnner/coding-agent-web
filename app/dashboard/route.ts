import { dashboardPage } from "../../dashboard/server.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The standalone dashboard page. Its code lives in dashboard/. */
export async function GET() {
  return new Response(await dashboardPage(), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
