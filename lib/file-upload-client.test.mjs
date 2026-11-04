import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { dropMentionText, pastedFiles, splitDroppedItems } = await jiti.import("./file-upload-client.ts");

const file = (name, type = "") => new File(["x"], name, { type });

test("a chat drop attaches images, uploads other files, and leaves folders out", () => {
  const photo = file("photo.png", "image/png");
  const notes = file("notes.md", "text/markdown");
  const data = file("data.bin");
  const result = splitDroppedItems([
    { kind: "file", file: photo },
    { kind: "file", file: notes },
    { kind: "folder", name: "src" },
    { kind: "file", file: data },
  ]);
  assert.deepEqual(result.images, [photo]);
  assert.deepEqual(result.files, [notes, data]);
  assert.deepEqual(result.folders, ["src"]);
});

test("mentions follow the drop order and only name files now in the working directory", () => {
  const files = [file("b.txt"), file("my notes.md"), file("failed.log"), file("a.txt")];
  assert.equal(
    dropMentionText(files, ["a.txt", "my notes.md", "b.txt"]),
    '@b.txt @"my notes.md" @a.txt ',
  );
  assert.equal(dropMentionText(files, []), "");
});

test("a file copied in Finder pastes as a file, text pastes stay text", () => {
  const report = file("report.pdf", "application/pdf");
  const log = file("server.log");
  // Finder puts the file names in the clipboard text as well.
  assert.deepEqual(pastedFiles([report, log], "report.pdf\nserver.log"), [report, log]);
  assert.deepEqual(pastedFiles([report], ""), [report]);
  // Typing or copying text is never eaten by the file path.
  assert.deepEqual(pastedFiles([report], "see /tmp/report.pdf"), []);
  // Images keep going down the image path, and a reference without content is unreadable.
  assert.deepEqual(pastedFiles([file("p.png", "image/png")], ""), []);
  assert.deepEqual(pastedFiles([new File([], "empty.pdf")], ""), []);
});
