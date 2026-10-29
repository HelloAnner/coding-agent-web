import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createJiti } from "jiti";

const root = await mkdtemp(path.join(tmpdir(), "pi-web-notes-watch-"));
process.env.CODING_AGENT_WEB_NOTES_DIR = root;
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const notes = await jiti.import("./files.ts");

after(() => rm(root, { recursive: true, force: true }));

/** Reads the stream until `needle` shows up in it. */
async function readUntil(reader, needle) {
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 5000;
  while (!text.includes(needle)) {
    assert.ok(Date.now() < deadline, `stream never sent ${needle}; saw: ${JSON.stringify(text)}`);
    const chunk = await Promise.race([
      reader.read(),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`no ${needle} within 5s`)), 5000)),
    ]);
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text;
}

test("a note an agent writes reaches the tree's stream", async () => {
  const response = await notes.watchNotes();
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  const reader = response.body.getReader();
  try {
    assert.match(await readUntil(reader, "event: connected"), /event: connected/);
    // A folder first: the watch has to be recursive, not just the root level.
    await notes.createDirectory("", "工作");
    const note = await notes.createItem("工作", "agent note", "note");
    // The event names the file, so an open board can ignore a note's save.
    assert.match(await readUntil(reader, note.path), /event: change/);
  } finally {
    await reader.cancel();
  }
});
