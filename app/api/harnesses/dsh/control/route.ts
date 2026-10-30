import { dshWebHost, DSH_WEB_PROFILE, DSH_WEB_VERSION } from "@/harness/dsh/web-host";
import { dshAdmission } from "@/harness/dsh/web-view";
import { leaseDshNativeView } from "@/harness/dsh/web-session";
import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";

export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) return Response.json({ error: "Untrusted request" }, { status: 403 });
  return Response.json({ profile: DSH_WEB_PROFILE, version: DSH_WEB_VERSION, path: dshWebHost().profileDir }, { headers: { "Cache-Control": "no-store" } });
}
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) return Response.json({ error: "Untrusted request" }, { status: 403 });
  if (!hasJsonContentType(req)) return new Response(null, { status: 415 });
  const body = await req.json().catch(() => null);
  if (body?.action === "view-lease") {
    if (typeof body.nativeId !== "string" || typeof body.leaseId !== "string" || typeof body.active !== "boolean") return new Response(null, { status: 400 });
    try { await leaseDshNativeView(body.nativeId, body.leaseId, body.active); return Response.json({ success: true }); }
    catch { return Response.json({ error: "Native view lease failed" }, { status: 409 }); }
  }
  if (body?.action !== "restart") return Response.json({ error: "Unknown control action" }, { status: 400 });
  try {
    await dshAdmission(true, async () => { await dshWebHost().stop(); await dshWebHost().ready(); });
    return Response.json({ success: true });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "dsh restart failed" }, { status: 409 }); }
}
