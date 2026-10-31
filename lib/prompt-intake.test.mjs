import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const root = mkdtempSync(path.join(tmpdir(), "pi-web-intake-"));
process.env.CODING_AGENT_WEB_INTAKE_DIR = root;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const intake = await jiti.import("./prompt-intake.ts");
const PNG = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");

function fresh() {
  intake.closeIntakeDb();
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
}

test("stores an accepted prompt and its image bytes on disk", () => {
  fresh();
  const row = intake.recordIntake({
    sessionId: "s1",
    kind: "prompt",
    text: "look at this",
    images: [{ data: PNG, mimeType: "image/png" }],
  });
  assert.ok(row);
  assert.equal(row.kind, "prompt");
  assert.equal(row.handedAt, null);
  assert.equal(row.files.length, 1);
  assert.equal(readFileSync(row.files[0].file).toString("hex"), "89504e470d0a1a0a");
  assert.equal(intake.openIntake("s1").length, 1);
  assert.equal(intake.openIntake("other").length, 0);
});

test("keeps slash commands and shell lines out of the journal", () => {
  fresh();
  // Callers filter those out; nothing but whitespace has nothing to store.
  assert.equal(intake.recordIntake({ sessionId: "s1", kind: "prompt", text: "   " }), null);
  assert.equal(intake.recordIntake({ sessionId: "s1", kind: "steer", text: "" }), null);
});

test("closes a row once the same text reaches the session history", () => {
  fresh();
  intake.recordIntake({ sessionId: "s1", kind: "prompt", text: "first  task" });
  intake.recordIntake({ sessionId: "s1", kind: "prompt", text: "second task" });
  // Normalized match, and one delivery settles one row only.
  assert.equal(intake.settleIntake("s1", ["first task"]), 1);
  assert.deepEqual(intake.openIntake("s1").map((row) => row.text), ["second task"]);
  assert.equal(intake.settleIntake("s1", ["unrelated"]), 0);
});

test("closing a row removes the attachment directory too", () => {
  fresh();
  const row = intake.recordIntake({
    sessionId: "s1",
    kind: "prompt",
    text: "",
    images: [{ data: PNG, mimeType: "image/png" }],
  });
  const dir = path.dirname(row.files[0].file);
  assert.ok(existsSync(dir));
  intake.markIntakeHanded(row.id);
  assert.equal(intake.openIntake("s1")[0].attempts, 1);
  intake.closeIntake(row.id);
  assert.equal(existsSync(dir), false);
  assert.equal(intake.openIntake("s1").length, 0);
});

test("rebuilds the prompt to send again, images from the files", () => {
  fresh();
  const row = intake.recordIntake({
    sessionId: "s1",
    kind: "steer",
    text: "also check the tests",
    images: [{ data: PNG, mimeType: "image/png" }],
  });
  const command = intake.intakeCommand(row);
  // A steer has no run to join after a restart, so it comes back as a prompt.
  assert.equal(command.type, "prompt");
  assert.equal(command.message, "also check the tests");
  assert.deepEqual(command.images, [{ type: "image", data: PNG, mimeType: "image/png" }]);
});

test("drops a missing attachment instead of failing the whole resume", () => {
  fresh();
  const row = intake.recordIntake({
    sessionId: "s1",
    kind: "prompt",
    text: "no image",
    images: [{ data: PNG, mimeType: "image/png" }],
  });
  writeFileSync(row.files[0].file, "");
  rmSync(row.files[0].file);
  assert.deepEqual(intake.intakeCommand(row).images, undefined);
});
