import { stat } from "fs/promises";
import { resolve } from "path";
import { findHarness } from "@/harness/registry";
import { readProjectPreference, writeProjectPreference } from "@/lib/catalog-db";
import { invalidateModelsCache } from "@/lib/models-cache";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";

export const dynamic = "force-dynamic";

interface ProjectPreferenceRequest {
  cwd?: unknown;
  harness?: unknown;
  provider?: unknown;
  model?: unknown;
}

async function checkedCwd(value: unknown): Promise<{ cwd: string } | { error: Response }> {
  if (typeof value !== "string" || !value.trim()) {
    return { error: Response.json({ error: "cwd is required" }, { status: 400 }) };
  }
  const cwd = resolve(value);
  let cwdStat;
  try {
    cwdStat = await stat(cwd);
  } catch {
    return { error: Response.json({ error: `Directory does not exist: ${cwd}` }, { status: 400 }) };
  }
  if (!cwdStat.isDirectory()) {
    return { error: Response.json({ error: `Not a directory: ${cwd}` }, { status: 400 }) };
  }
  const allowedRoots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
    return { error: Response.json({ error: "Access denied" }, { status: 403 }) };
  }
  return { cwd };
}

/** The last harness, provider and model picked in this folder. */
export async function GET(req: Request) {
  const checked = await checkedCwd(new URL(req.url).searchParams.get("cwd"));
  if ("error" in checked) return checked.error;
  return Response.json({ preference: readProjectPreference(checked.cwd) });
}

/**
 * Remember a pick for this folder. Each new session in the folder starts with
 * it; another folder keeps its own row.
 */
export async function PUT(req: Request) {
  let body: ProjectPreferenceRequest;
  try {
    body = await req.json() as ProjectPreferenceRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const harness = typeof body.harness === "string" ? body.harness.trim() : "";
  if (!findHarness(harness)) return Response.json({ error: "Unknown harness" }, { status: 400 });
  if (typeof body.provider !== "string" || typeof body.model !== "string") {
    return Response.json({ error: "Expected harness, provider and model" }, { status: 400 });
  }
  const checked = await checkedCwd(body.cwd);
  if ("error" in checked) return checked.error;

  const preference = { harness, provider: body.provider, model: body.model };
  try {
    writeProjectPreference(checked.cwd, preference);
    // /api/models caches per folder; the next new chat must read this pick.
    invalidateModelsCache();
    return Response.json({ ok: true, preference });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
