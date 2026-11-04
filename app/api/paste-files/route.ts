import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { NextResponse } from "next/server";
import { parseFormDataWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { validateUploadFileNames } from "@/lib/file-upload";
import { isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const run = promisify(execFile);
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_TOTAL_BYTES + 1024 * 1024;

/**
 * The files a Finder copy left on the desktop clipboard, by name. Their own
 * paths let the model read the real file, so a paste changes nothing on disk.
 */
async function clipboardPaths(): Promise<Map<string, string>> {
  if (process.platform !== "darwin") return new Map();
  try {
    const { stdout } = await run("osascript", ["-e", "POSIX path of (the clipboard as «class furl»)"]);
    return new Map(
      stdout.split("\n").map((line) => line.trim()).filter(Boolean)
        .map((file) => [path.basename(file), file]),
    );
  } catch {
    // Text, images and multi-file copies do not read as one file URL.
    return new Map();
  }
}

/**
 * Absolute paths for pasted files: the file itself when the clipboard still
 * holds it, else a copy under the temp directory. Never the working directory.
 */
export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  let formData: FormData;
  try {
    formData = await parseFormDataWithinLimit(request, MAX_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: "Pastes must total 100MB or less" }, { status: 413 });
    }
    throw error;
  }

  const files = formData.getAll("files").filter((entry): entry is File => typeof entry !== "string");
  const validationError = validateUploadFileNames(files.map((file) => file.name));
  if (validationError) return NextResponse.json({ error: validationError }, { status: 400 });
  if (
    files.some((file) => file.size > MAX_FILE_BYTES)
    || files.reduce((total, file) => total + file.size, 0) > MAX_TOTAL_BYTES
  ) {
    return NextResponse.json({ error: "Each file must be 25MB or smaller" }, { status: 413 });
  }

  const clipboard = await clipboardPaths();
  const directory = path.join(tmpdir(), `pi-web-paste-${randomUUID()}`);
  const paths: string[] = [];
  for (const file of files) {
    const original = clipboard.get(file.name);
    if (original) {
      paths.push(original);
      continue;
    }
    try {
      await mkdir(directory, { recursive: true });
      const destination = path.join(directory, file.name);
      await writeFile(destination, Buffer.from(await file.arrayBuffer()));
      paths.push(destination);
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
  }

  return NextResponse.json({ paths });
}
