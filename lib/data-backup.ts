import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readlink, realpath, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import JSZip from "jszip";

const DAY_MS = 24 * 60 * 60 * 1000;
const ARCHIVE_NAME = /^data-\d{4}(?:-\d{2}){5}-\d{3}\.zip$/;
const globalState = globalThis as typeof globalThis & {
  dataBackup?: { timer?: ReturnType<typeof setTimeout>; inFlight?: Promise<string> };
};
const state = globalState.dataBackup ??= {};

export function nextDataBackupAt(now = new Date()): Date {
  const next = new Date(now);
  next.setHours(3, 0, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
    next.setHours(3, 0, 0, 0);
  }
  return next;
}

export function backupData(
  dataDir = join(process.cwd(), "data"),
  backupDir = join(homedir(), "backup", "coding-agent-web"),
  now = new Date(),
): Promise<string> {
  if (state.inFlight) return state.inFlight;
  state.inFlight = (async () => {
    await mkdir(backupDir, { recursive: true, mode: 0o700 });
    const work = await mkdtemp(join(backupDir, ".data-backup-"));
    const inputs: Readable[] = [];
    try {
      const zip = new JSZip();
      async function addEntry(file: string, name: string): Promise<void> {
        const info = await lstat(file);
        const options = { date: info.mtime, unixPermissions: info.mode };
        if (info.isDirectory()) {
          zip.file(`${name}/`, null, { ...options, dir: true });
          for (const child of await readdir(file)) await addEntry(join(file, child), `${name}/${child}`);
        } else if (info.isSymbolicLink()) {
          // Store the link itself; never traverse outside data or follow a cycle.
          zip.file(name, await readlink(file), options);
        } else if (info.isFile()) {
          if (info.size >= 0xffffffff) throw new Error("Data backup requires ZIP64 for files of 4 GiB or larger");
          // Open one file at a time rather than holding the entire data folder in RAM.
          const input = Readable.from((async function* () { yield* createReadStream(file); })());
          inputs.push(input);
          zip.file(name, input, options);
        } else {
          throw new Error(`Unsupported data backup entry: ${name}`);
        }
      }
      const source = await realpath(dataDir);
      if (!(await stat(source)).isDirectory()) throw new Error("Data backup source is not a directory");
      await addEntry(source, "data");
      // ponytail: JSZip writes classic ZIP; switch to a ZIP64 writer beyond these limits.
      if (Object.keys(zip.files).length >= 0xffff) throw new Error("Data backup has too many entries for classic ZIP");
      const temporary = join(work, "data.zip");
      await pipeline(
        zip.generateNodeStream({ streamFiles: true, compression: "DEFLATE", platform: "UNIX" }),
        createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
      );
      if ((await stat(temporary)).size >= 0xffffffff) throw new Error("Data backup requires ZIP64 for archives of 4 GiB or larger");
      const timestamp = [now.getFullYear(), now.getMonth() + 1, now.getDate(), now.getHours(), now.getMinutes(), now.getSeconds()]
        .map((part) => String(part).padStart(2, "0")).join("-");
      const archive = join(backupDir, `data-${timestamp}-${String(now.getMilliseconds()).padStart(3, "0")}.zip`);
      await rename(temporary, archive);
      // Only prune our own expired archives, and only after publishing a successful backup.
      for (const entry of await readdir(backupDir, { withFileTypes: true })) {
        if (!entry.isFile() || !ARCHIVE_NAME.test(entry.name)) continue;
        const file = join(backupDir, entry.name);
        if ((await stat(file)).mtimeMs <= now.getTime() - 7 * DAY_MS) await rm(file);
      }
      return archive;
    } finally {
      for (const input of inputs) input.destroy();
      await rm(work, { recursive: true, force: true });
    }
  })().finally(() => { state.inFlight = undefined; });
  return state.inFlight;
}

export function startDataBackup(): void {
  if (state.timer || process.env.NODE_ENV === "test") return;
  const schedule = () => {
    const now = new Date();
    state.timer = setTimeout(() => {
      void backupData()
        .then((archive) => console.info(`[coding-agent-web] Data backup saved: ${archive}`))
        .catch((error: unknown) => console.error("[coding-agent-web] Data backup failed:", error))
        .finally(schedule);
    }, nextDataBackupAt(now).getTime() - now.getTime());
    state.timer.unref();
  };
  schedule();
}
