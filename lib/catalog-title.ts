import { readCatalogSession, updateCatalogSession } from "./catalog-db";

/**
 * The sidebar lists the index, not pi's session files, so a name set on the
 * session has to land in its row too: generated titles, `/name`, and an
 * extension's own naming all end up here. An unchanged name writes nothing,
 * or every rename event would reload the list in every open tab.
 */
export function syncCatalogTitle(sessionId: string, name: string | undefined): void {
  const title = name?.trim();
  if (!title) return;
  const row = readCatalogSession(sessionId);
  if (!row || row.title === title) return;
  updateCatalogSession(sessionId, { title });
}
