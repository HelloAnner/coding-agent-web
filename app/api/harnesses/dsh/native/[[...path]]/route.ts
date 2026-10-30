import { proxyDshNative } from "@/harness/dsh/web-view";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function handle(req: Request, ctx: { params: Promise<{ path?: string[] }> }) {
  return proxyDshNative(req, (await ctx.params).path ?? []);
}
export { handle as GET, handle as HEAD, handle as POST };
