import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { HEALTH_DIRECTORY, HealthDataError, readHealthData } from "./data";

const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };

export async function getHealth(directory = HEALTH_DIRECTORY) {
  try {
    const data = await readHealthData(directory);
    return data ? Response.json(data, { headers }) : Response.json({ error: "尚无健康数据，请在 data/dashboard/健康/父亲/ 放入 health.json" }, { status: 404, headers });
  } catch (error) {
    return Response.json({ error: error instanceof HealthDataError ? error.message : "健康资料读取失败，请检查数据文件与访问权限" }, { status: 500, headers });
  }
}

/** Resolve only manifest IDs, never a client-supplied filesystem path. */
export async function getHealthAttachment(id: string, directory = HEALTH_DIRECTORY) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return new Response("附件不存在", { status: 404, headers });
  try {
    const data = await readHealthData(directory);
    const attachment = data?.attachments.find((row) => row.id === id && row.status === "available");
    if (!attachment?.path) return new Response("附件未找到；请查看详情中的来源与缺失说明", { status: 404, headers });
    const root = await realpath(directory);
    const filename = await realpath(path.join(root, attachment.path));
    if (!filename.startsWith(`${root}${path.sep}`)) return new Response("附件路径无效", { status: 403, headers });
    const mime = ({ ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".pdf": "application/pdf", ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8", ".json": "text/plain; charset=utf-8" } as Record<string, string>)[path.extname(filename).toLowerCase()];
    if (!mime) return new Response("不支持的附件类型", { status: 415, headers });
    const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK || 0));
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 16 * 1024 * 1024) return new Response("附件不是普通文件或超过16MB", { status: 413, headers });
      return new Response(new Uint8Array(await file.readFile()), { headers: {
        ...headers,
        "Content-Type": mime,
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(path.basename(filename))}`,
        "Content-Security-Policy": "default-src 'none'; sandbox",
      } });
    } finally {
      await file.close();
    }
  } catch (error) {
    const missing = ["ENOENT", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "");
    return new Response(missing ? "附件文件已缺失" : "附件读取失败，请检查本地资料", { status: missing ? 404 : 500, headers });
  }
}
