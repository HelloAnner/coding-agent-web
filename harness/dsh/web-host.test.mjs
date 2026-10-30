import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
const { DshWebHost } = await createJiti(import.meta.url).import("./web-host.ts");

test("version mismatch and cancelled startup never spawn a second kernel", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "dsh-web-launch-"));
  const bin = join(home, "dsh"), marker = join(home, "spawned");
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(bin, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 9.9.9; else touch '${marker}'; fi\n`, { mode: 0o700 });
  const host = new DshWebHost(home, bin);
  await assert.rejects(host.ready(), /Host and Client releases must match/);
  await assert.rejects(access(marker));
  await writeFile(bin, `#!/bin/sh\nif [ "$1" = "--version" ]; then sleep 0.1; echo 0.2.0-rc.2; else touch '${marker}'; fi\n`, { mode: 0o700 });
  const pending = assert.rejects(host.ready(), /startup was cancelled/);
  await host.stop();
  await pending;
  await assert.rejects(access(marker));
  const legacy = Symbol.for("pi-web.dshAcp");
  globalThis[legacy] = { isRunning: () => true };
  try { await assert.rejects(host.ready(), /two Hosts must not write/); }
  finally { delete globalThis[legacy]; }
});

test("application shutdown cancels pending launch, detaches hooks and refuses a late restart", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "dsh-web-shutdown-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const bin = join(home, "dsh");
  await writeFile(bin, '#!/bin/sh\nsleep 0.1\necho 0.2.0-rc.2\n', { mode: 0o700 });
  const previous = process.listeners("SIGTERM");
  const host = new DshWebHost(home, bin);
  const launch = assert.rejects(host.ready(), /startup was cancelled/);
  const shutdown = process.listeners("SIGTERM").find((listener) => !previous.includes(listener));
  assert.equal(typeof shutdown, "function");
  shutdown();
  await launch;
  await assert.rejects(host.ready(), /dsh is stopping/);
  assert.deepEqual(process.listeners("SIGTERM"), previous);
});
