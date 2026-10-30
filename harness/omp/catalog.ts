import { CatalogHarnessLockedError, readCatalogSession } from "../../lib/catalog-db";

/** Generic index routes must never create or retarget an OMP native conversation. */
export function guardOmpCatalogWrite(id: string | undefined, patch: { harness?: string; cwd?: string; provider?: string; model?: string; sessionPath?: string; profilePath?: string }): void {
  const row = id ? readCatalogSession(id) : null;
  if (patch.harness !== "omp" && row?.harness !== "omp") return;
  if (!row || row.harness !== "omp") throw new CatalogHarnessLockedError("Create OMP sessions through the native OMP endpoint");
  const expected = { cwd: row.cwd, provider: row.provider, model: row.model, sessionPath: row.sessionPath, profilePath: row.profilePath };
  for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
    if (patch[key] !== undefined && patch[key] !== expected[key]) throw new CatalogHarnessLockedError("OMP identity and model changes must be confirmed by the native runtime");
  }
}
