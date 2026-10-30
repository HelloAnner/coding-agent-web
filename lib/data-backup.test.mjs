import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import JSZip from "jszip";
import { createJiti } from "jiti";

const { backupData, nextDataBackupAt, startDataBackup } = await createJiti(import.meta.url).import("./data-backup.ts");
const DAY_MS = 24 * 60 * 60 * 1000;

test("schedules the next local 03:00, including day rollover and daylight saving", () => {
  assert.equal(nextDataBackupAt(new Date(2026, 9, 30, 2, 59)).getTime(), new Date(2026, 9, 30, 3).getTime());
  assert.equal(nextDataBackupAt(new Date(2026, 9, 30, 3)).getTime(), new Date(2026, 9, 31, 3).getTime());
  assert.equal(nextDataBackupAt(new Date(2026, 11, 31, 23)).getTime(), new Date(2027, 0, 1, 3).getTime());
  const previous = process.env.TZ;
  try {
    process.env.TZ = "America/New_York";
    for (const [now, hours] of [[new Date(2026, 2, 7, 3), 23], [new Date(2026, 9, 31, 3), 25]]) {
      const next = nextDataBackupAt(now);
      assert.equal(next.getHours(), 3);
      assert.equal(next.getTime() - now.getTime(), hours * 60 * 60 * 1000);
    }
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test("arms one unreferenced background timer and skips the test environment", (t) => {
  const previous = process.env.NODE_ENV;
  const timer = { unref: t.mock.fn() };
  const timeout = t.mock.method(globalThis, "setTimeout", () => timer);
  t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 9, 30, 2, 59, 59) });
  try {
    process.env.NODE_ENV = "test";
    startDataBackup();
    assert.equal(timeout.mock.callCount(), 0);
    process.env.NODE_ENV = "production";
    startDataBackup();
    startDataBackup();
    assert.equal(timeout.mock.callCount(), 1);
    assert.equal(timeout.mock.calls[0].arguments[1], 1000);
    assert.equal(timer.unref.mock.callCount(), 1);
  } finally {
    delete globalThis.dataBackup.timer;
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

test("backs up the entire data folder, prunes only expired backups, and preserves backups on failure", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "data-backup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, "project with spaces", "data");
  const destination = join(root, "home", "backup", "coding-agent-web");
  await mkdir(join(data, "notes", "empty"), { recursive: true });
  await mkdir(destination, { recursive: true });
  await writeFile(join(data, ".hidden"), "hidden data");
  await writeFile(join(data, "notes", "中文 笔记.md"), "全部内容\n");
  const binary = Buffer.from([0, 1, 127, 128, 255]);
  await writeFile(join(data, "binary.bin"), binary);
  let source = data;
  if (process.platform !== "win32") {
    await symlink(".", join(data, "cycle"));
    source = join(root, "data-link");
    await symlink(data, source, "dir");
  }

  const now = new Date();
  const expired = "data-2020-01-01-03-00-00-000.zip";
  const recent = "data-2020-01-02-03-00-00-000.zip";
  const unrelated = "manual.zip";
  for (const [name, age] of [[expired, 7 * DAY_MS + 1000], [recent, 7 * DAY_MS - 1000], [unrelated, 30 * DAY_MS]]) {
    const file = join(destination, name);
    await writeFile(file, "previous backup");
    const modified = new Date(now.getTime() - age);
    await utimes(file, modified, modified);
  }
  const directory = "data-2020-01-03-03-00-00-000.zip";
  await mkdir(join(destination, directory));

  const running = backupData(source, destination, now);
  assert.equal(backupData(source, destination, now), running, "concurrent calls share one backup");
  const archive = await running;
  assert.match(basename(archive), /^data-\d{4}(?:-\d{2}){5}-\d{3}\.zip$/);
  const saved = await readFile(archive);
  const zip = await JSZip.loadAsync(saved, { checkCRC32: true });
  assert.equal(zip.files["data/"].dir, true);
  assert.equal(zip.files["data/notes/empty/"].dir, true);
  assert.equal(await zip.file("data/.hidden").async("string"), "hidden data");
  assert.equal(await zip.file("data/notes/中文 笔记.md").async("string"), "全部内容\n");
  assert.deepEqual(await zip.file("data/binary.bin").async("nodebuffer"), binary);
  if (process.platform !== "win32") {
    assert.equal(await zip.file("data/cycle").async("string"), ".");
    assert.equal(zip.file("data/cycle").unixPermissions & 0o170000, 0o120000);
  }
  assert.deepEqual((await readdir(destination)).sort(), [basename(archive), recent, unrelated, directory].sort());

  await writeFile(join(destination, expired), "keep this if compression fails");
  const old = new Date(now.getTime() - 8 * DAY_MS);
  await utimes(join(destination, expired), old, old);
  const generation = t.mock.method(JSZip.prototype, "generateNodeStream", () => Readable.from((async function* () {
    yield Buffer.from("partial zip");
    throw new Error("compression failed");
  })()));
  await assert.rejects(backupData(data, destination, now), /compression failed/);
  generation.mock.restore();
  assert.deepEqual(await readFile(archive), saved, "a failed backup cannot overwrite the previous zip");
  assert.equal(await readFile(join(destination, expired), "utf8"), "keep this if compression fails");
  assert.ok(!(await readdir(destination)).some((name) => name.startsWith(".data-backup-")), "partial files are removed");

  const generate = JSZip.prototype.generateNodeStream;
  const deletedSource = t.mock.method(JSZip.prototype, "generateNodeStream", function (...args) {
    unlinkSync(join(data, "binary.bin"));
    return generate.apply(this, args);
  });
  await assert.rejects(backupData(data, destination, now), { code: "ENOENT" });
  deletedSource.mock.restore();
  assert.deepEqual(await readFile(archive), saved);
  assert.equal(await readFile(join(destination, expired), "utf8"), "keep this if compression fails");
  assert.ok(!(await readdir(destination)).some((name) => name.startsWith(".data-backup-")));

  await assert.rejects(backupData(join(root, "missing-data"), destination), { code: "ENOENT" });
  await backupData(data, destination, new Date(now.getTime() + 1000));
  assert.ok(!(await readdir(destination)).includes(expired), "a later successful run still works and prunes");
});
