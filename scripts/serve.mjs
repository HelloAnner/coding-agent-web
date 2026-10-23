import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runDir = path.join(root, ".run");
const pidFile = path.join(runDir, "server.pid");
const logFile = path.join(runDir, "server.log");
const distDir = ".next-common";
const host = process.env.PI_WEB_HOST || "127.0.0.1";
const port = process.env.PI_WEB_PORT || "20169";
const url = `http://${host}:${port}`;
const readyTimeoutMs = 180_000;

const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readPid() {
  try {
    const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code === "ESRCH") return;
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

async function listening() {
  try {
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(2000),
    });
    return response.status > 0;
  } catch {
    return false;
  }
}

function logTail() {
  try {
    const text = fs.readFileSync(logFile, "utf8");
    return text.split("\n").slice(-40).join("\n");
  } catch {
    return "";
  }
}

function printRunning(pid) {
  console.log(url);
  console.log(`pid ${pid}`);
  console.log("log .run/server.log");
}

async function waitUntilReady(pid) {
  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) {
      console.error("server exited before it was ready");
      const tail = logTail();
      if (tail) console.error(tail);
      process.exit(1);
    }
    if (await listening()) {
      printRunning(pid);
      return;
    }
    await sleep(400);
  }
  console.error(`server did not answer ${url} within ${readyTimeoutMs / 1000}s`);
  const tail = logTail();
  if (tail) console.error(tail);
  process.exit(1);
}

async function start() {
  fs.mkdirSync(runDir, { recursive: true });
  const existing = readPid();
  if (existing && pidAlive(existing)) {
    console.log("already running");
    await waitUntilReady(existing);
    return;
  }
  if (existing) fs.rmSync(pidFile, { force: true });

  if (await listening()) {
    console.error(`${url} is already in use`);
    process.exit(1);
  }
  if (!fs.existsSync(nextBin)) {
    console.error("next is not installed. Run npm install in this repo.");
    process.exit(1);
  }

  const logFd = fs.openSync(logFile, "w");
  const child = spawn(process.execPath, [nextBin, "dev", "-H", host, "-p", String(port)], {
    cwd: root,
    detached: true,
    env: { ...process.env, PI_WEB_DIST_DIR: distDir },
    stdio: ["ignore", logFd, logFd],
  });
  fs.closeSync(logFd);
  child.unref();
  if (!child.pid) {
    console.error("failed to start the server");
    process.exit(1);
  }
  fs.writeFileSync(pidFile, `${child.pid}\n`);
  await waitUntilReady(child.pid);
}

async function stop() {
  const pid = readPid();
  if (!pid || !pidAlive(pid)) {
    if (pid) fs.rmSync(pidFile, { force: true });
    console.log("not running");
    return;
  }
  signalGroup(pid, "SIGTERM");
  for (let i = 0; i < 50 && pidAlive(pid); i += 1) await sleep(100);
  if (pidAlive(pid)) {
    signalGroup(pid, "SIGKILL");
    for (let i = 0; i < 20 && pidAlive(pid); i += 1) await sleep(100);
  }
  fs.rmSync(pidFile, { force: true });
  if (pidAlive(pid)) {
    console.error(`failed to stop pid ${pid}`);
    process.exit(1);
  }
  console.log("stopped");
}

const command = process.argv[2];
if (command === "start") {
  await start();
} else if (command === "stop") {
  await stop();
} else if (command === "restart") {
  await stop();
  await start();
} else {
  console.error("usage: node scripts/serve.mjs start|stop|restart");
  process.exit(1);
}
