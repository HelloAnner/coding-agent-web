/**
 * One shared stream of notes-vault changes. The tree and the open board both
 * listen, but the page keeps a single EventSource: browsers cap connections
 * per host, and the chat stream already holds one.
 */

/** `paths` is `null` when the server could not name what changed. */
export type NotesWatchListener = (paths: readonly string[] | null) => void;

const listeners = new Set<NotesWatchListener>();
let source: EventSource | null = null;
let connectedOnce = false;

/** Writes initiated here can refresh listeners without waiting for fs.watch. */
export function notifyNotesChanged(paths: readonly string[] | null): void {
  for (const notify of listeners) notify(paths);
}

export function subscribeNotesWatch(listener: NotesWatchListener): () => void {
  listeners.add(listener);
  if (!source) {
    const stream = new EventSource("/api/notes/watch");
    source = stream;
    stream.addEventListener("connected", () => {
      // A reconnect may have missed changes: everyone re-reads.
      if (connectedOnce) notifyNotesChanged(null);
      connectedOnce = true;
    });
    stream.addEventListener("change", (event) => {
      let paths: string[] | null = null;
      try {
        const data = JSON.parse((event as MessageEvent).data) as { paths?: unknown };
        if (Array.isArray(data.paths)) {
          paths = data.paths.filter((item): item is string => typeof item === "string");
        }
      } catch {
        // An unreadable event still means "something changed".
      }
      notifyNotesChanged(paths);
    });
    // EventSource reconnects on its own; the next "connected" re-reads.
    stream.onerror = () => {};
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size) return;
    source?.close();
    source = null;
    connectedOnce = false;
  };
}
