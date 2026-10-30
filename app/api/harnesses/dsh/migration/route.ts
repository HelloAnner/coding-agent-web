import { previewDshMigration, importDshMigration } from "@/harness/dsh/legacy-migration";
import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";

export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) return new Response(null, { status: 403 });
  return Response.json(previewDshMigration(), { headers: { "Cache-Control": "no-store" } });
}
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) return new Response(null, { status: 403 });
  if (!hasJsonContentType(req)) return new Response(null, { status: 415 });
  const body = await req.json().catch(() => null);
  if (typeof body?.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(body.fingerprint)) return new Response(null, { status: 400 });
  try { return Response.json(await importDshMigration(body.fingerprint)); }
  catch (error) {
    const message = error instanceof Error && /^(Legacy configuration changed|Native import could not be confirmed|The native multi-provider plugin|dsh still has)/.test(error.message) ? error.message : "Legacy configuration could not be safely imported; review it locally";
    return Response.json({ error: message }, { status: 409 });
  }
}
