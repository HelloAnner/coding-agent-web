/** Note tabs after the notes tree moved or deleted something. */

export function isNotePathUnder(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** `from` is a note or a folder; a folder takes everything below it along. */
export function movedNotePath(path: string, from: string, to: string): string {
  if (path === from) return to;
  const tail = path.slice(from.length + 1);
  return to ? `${to}/${tail}` : tail;
}

export function remapNoteTabs<T extends { path: string }>(tabs: readonly T[], from: string, to: string): T[] {
  return tabs.map((tab) => isNotePathUnder(tab.path, from) ? { ...tab, path: movedNotePath(tab.path, from, to) } : tab);
}

const NOTE_TAB_PREFIX = "note:";

/** The active tab keeps following the file it shows. */
export function noteTabIdAfterMove(tabId: string | null, from: string, to: string): string | null {
  if (!tabId?.startsWith(NOTE_TAB_PREFIX)) return tabId;
  const path = tabId.slice(NOTE_TAB_PREFIX.length);
  return isNotePathUnder(path, from) ? NOTE_TAB_PREFIX + movedNotePath(path, from, to) : tabId;
}
