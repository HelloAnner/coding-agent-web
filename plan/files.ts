import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { addAttachment, attachmentLocation, deleteAttachment, hasGoal, planFilesRoot, readPlan } from "./db";

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_FILE_BYTES + 1024 * 1024;

class FileError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

function snapshot(): Response {
  return Response.json(readPlan(), { headers: { "Cache-Control": "no-store" } });
}

function safeStoredPath(goalId: string, storedName: string): string {
  if (!/^[a-z0-9-]+(?:\.[a-z0-9]{1,12})?$/i.test(storedName)) throw new FileError("附件路径无效", 400);
  const directory = path.join(planFilesRoot(), goalId);
  const file = path.resolve(directory, storedName);
  if (path.dirname(file) !== path.resolve(directory)) throw new FileError("附件路径无效", 400);
  return file;
}

function originalName(file: File): string {
  const name = file.name.trim();
  if (!name || name === "." || name === ".." || name.length > 180 || /[/\\\0\r\n]/.test(name) || path.basename(name) !== name) {
    throw new FileError("附件名称无效");
  }
  return name;
}

function disposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7E]|["\\;\r\n]/g, "_") || "attachment";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export async function GET(request: Request): Promise<Response> {
  try {
    const id = new URL(request.url).searchParams.get("id") ?? "";
    const attachment = attachmentLocation(id);
    if (!attachment) throw new FileError("附件不存在", 404);
    const bytes = await readFile(safeStoredPath(attachment.goalId, attachment.storedName));
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": attachment.mime || "application/octet-stream",
        "Content-Length": String(bytes.byteLength),
        "Content-Disposition": disposition(attachment.name),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof FileError) return Response.json({ error: error.message }, { status: error.status });
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Response.json({ error: "附件文件不存在" }, { status: 404 });
    return Response.json({ error: "附件读取失败" }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<Response> {
  let written: string | null = null;
  try {
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) throw new FileError("附件不能超过 20 MB", 413);
    const form = await request.formData();
    const goalId = form.get("goalId");
    const file = form.get("file");
    if (typeof goalId !== "string" || !hasGoal(goalId)) throw new FileError("目标不存在", 404);
    if (!(file instanceof File) || file.size === 0) throw new FileError("请选择要上传的文件");
    if (file.size > MAX_FILE_BYTES) throw new FileError("附件不能超过 20 MB", 413);
    const name = originalName(file);
    const extension = path.extname(name).toLowerCase();
    const storedName = `${randomUUID()}${/^\.[a-z0-9]{1,12}$/i.test(extension) ? extension : ""}`;
    const destination = safeStoredPath(goalId, storedName);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, new Uint8Array(await file.arrayBuffer()), { flag: "wx", mode: 0o600 });
    written = destination;
    addAttachment(goalId, name, storedName, file.type.slice(0, 120), file.size);
    return snapshot();
  } catch (error) {
    if (written) await rm(written, { force: true }).catch(() => {});
    if (error instanceof FileError) return Response.json({ error: error.message }, { status: error.status });
    console.error("Plan attachment upload failed", error);
    return Response.json({ error: "附件上传失败" }, { status: 500 });
  }
}

export async function DELETE(request: Request): Promise<Response> {
  try {
    const body = await request.json() as { id?: unknown };
    if (typeof body.id !== "string") throw new FileError("附件标识无效");
    const removed = deleteAttachment(body.id);
    if (!removed) throw new FileError("附件不存在", 404);
    await unlink(safeStoredPath(removed.goalId, removed.storedName)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    return snapshot();
  } catch (error) {
    if (error instanceof FileError) return Response.json({ error: error.message }, { status: error.status });
    if (error instanceof SyntaxError) return Response.json({ error: "请求 JSON 无效" }, { status: 400 });
    return Response.json({ error: "附件删除失败" }, { status: 500 });
  }
}
