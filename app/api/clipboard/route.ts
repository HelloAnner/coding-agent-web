import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const run = promisify(execFile);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * Puts an image on the clipboard of the machine running this app.
 *
 * A browser only writes the clipboard in a secure context, so any plain-http
 * origin (the LAN address) has to ask the host instead. The image is the
 * caller's own export; the temp file exists only for the length of osascript.
 */
export async function POST(request: Request) {
  if (process.platform !== "darwin") {
    return NextResponse.json({ error: "unsupported-platform" }, { status: 501 });
  }
  const image = Buffer.from(await request.arrayBuffer());
  if (!image.length) return NextResponse.json({ error: "empty" }, { status: 400 });
  if (image.length > MAX_IMAGE_BYTES) return NextResponse.json({ error: "too-large" }, { status: 413 });

  const file = join(tmpdir(), `pi-web-clipboard-${randomUUID()}.png`);
  await writeFile(file, image);
  try {
    await run("osascript", ["-e", `set the clipboard to (read (POSIX file "${file}") as «class PNGf»)`]);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  } finally {
    await unlink(file).catch(() => {});
  }
  return new NextResponse(null, { status: 204 });
}
