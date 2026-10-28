import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runDir = path.join(root, ".run");
const pidFile = path.join(runDir, "server.pid");
const logFile = path.join(runDir, "server.log");
const envFile = path.join(root, ".env.local");
// Two build dirs, alternating. A restart compiles into the one the running
// server is not serving from, so the live app is untouched while webpack runs
// and the swap costs one stop plus one start. Keeping both keeps each one's
// webpack cache warm for its next turn.
const distDirs = [".next-common", ".next-common-b"];
const distStateFile = path.join(runDir, "dist");
const host = process.env.PI_WEB_HOST || "0.0.0.0";
const port = process.env.PI_WEB_PORT || "20169";
const openHost = probeHost(host);
const probeUrl = `http://${openHost}:${port}`;
const readyTimeoutMs = 60_000;
let announcedHosts = "";

const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");

export function isLoopbackBind(value) {
  return value === "127.0.0.1" || value === "localhost" || value === "::1" || value === "[::1]";
}

// Connecting to 0.0.0.0 or :: is not a reliable readiness check.
export function probeHost(value) {
  if (value === "0.0.0.0" || value === "::" || value === "[::]") return "127.0.0.1";
  return value;
}

export function parseEnvAssignmentFile(text) {
  const out = {};
  for (const line of String(text).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      value.length >= 2
      && ((value.startsWith("\"") && value.endsWith("\""))
        || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

// A password already in the environment wins. An empty one falls through to the file.
export function resolveWebPassword(envValue, fileText) {
  if (typeof envValue === "string" && envValue.length > 0) return envValue;
  const fromFile = parseEnvAssignmentFile(fileText ?? "").PI_WEB_PASSWORD;
  return typeof fromFile === "string" ? fromFile : "";
}

function isDnsName(value) {
  return value.length > 0
    && value.length <= 253
    && !value.startsWith(".")
    && !value.endsWith(".")
    && !value.includes("..")
    && /^[a-z0-9.-]+$/.test(value);
}

// Hostnames the proxy will trust. IP literals are already allowed, so this is
// only names: the Mac's hostname, its Bonjour name, and this node's Tailscale
// DNS name plus the short label MagicDNS search uses.
export function accessNamesFrom({ hostname = "", localHostName = "", tailscaleDnsName = "" } = {}) {
  const found = [];
  const seen = new Set();
  const add = (raw) => {
    const name = String(raw ?? "").trim().replace(/\.$/, "").toLowerCase();
    if (!isDnsName(name) || name === "localhost" || name.endsWith(".localhost")) return;
    if (seen.has(name)) return;
    seen.add(name);
    found.push(name);
    if (name.endsWith(".local")) add(name.slice(0, -".local".length));
  };
  add(hostname);
  add(localHostName);
  if (localHostName) add(`${localHostName}.local`);
  const dns = String(tailscaleDnsName ?? "").trim();
  add(dns);
  const short = dns.replace(/\.$/, "").split(".")[0];
  if (short && short !== dns) add(short);
  return found;
}

export function mergeHostList(existing, extras) {
  const seen = new Set();
  const out = [];
  for (const raw of [...String(existing ?? "").split(","), ...extras]) {
    const name = String(raw ?? "").trim().replace(/\.$/, "");
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out.join(",");
}

function commandOutput(command, args) {
  try {
    const result = spawnSync(command, args, { encoding: "utf8", timeout: 2000 });
    if (!result || result.status !== 0) return "";
    return String(result.stdout ?? "").trim();
  } catch {
    return "";
  }
}

// The Tailscale CLI is not always on the shell's PATH: the standalone macOS
// build puts it in /usr/local/sbin, the App Store build inside the bundle, and
// Homebrew in /opt/homebrew/bin. A missing CLI used to cost the machine its own
// tailnet name (mac-mini-1003:20169 answered "Untrusted request"), so try the
// known locations too.
export function tailscaleCommands() {
  return [
    "tailscale",
    "/usr/local/bin/tailscale",
    "/opt/homebrew/bin/tailscale",
    "/usr/local/sbin/tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  ];
}

export function tailscaleStatusJson(run = commandOutput, commands = tailscaleCommands()) {
  for (const command of commands) {
    const raw = run(command, ["status", "--json"]);
    if (raw) return raw;
  }
  return "";
}

export function discoverAccessNames(run = commandOutput) {
  let tailscaleDnsName = "";
  const raw = tailscaleStatusJson(run);
  if (raw) {
    try {
      tailscaleDnsName = String(JSON.parse(raw)?.Self?.DNSName ?? "");
    } catch {
      tailscaleDnsName = "";
    }
  }
  const localHostName = process.platform === "darwin"
    ? run("scutil", ["--get", "LocalHostName"])
    : "";
  return accessNamesFrom({
    hostname: os.hostname(),
    localHostName,
    tailscaleDnsName,
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function seconds(since) {
  return `${((Date.now() - since) / 1000).toFixed(1)}s`;
}

function readDistDir() {
  try {
    const value = fs.readFileSync(distStateFile, "utf8").trim();
    if (distDirs.includes(value)) return value;
  } catch {
    // first run, or the state file was removed
  }
  return distDirs[0];
}

export function otherDistDir(value) {
  return value === distDirs[0] ? distDirs[1] : distDirs[0];
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

function loadPassword() {
  let fileText = "";
  try {
    fileText = fs.readFileSync(envFile, "utf8");
  } catch {
    fileText = "";
  }
  return resolveWebPassword(process.env.PI_WEB_PASSWORD, fileText);
}

async function listening() {
  try {
    const response = await fetch(probeUrl, {
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

export function nextBuildArgs() {
  return ["build", "--webpack"];
}

export function nextStartArgs(bindHost, bindPort) {
  return ["start", "-H", bindHost, "-p", String(bindPort)];
}

function printRunning(pid) {
  console.log(`http://${host}:${port}`);
  if (openHost !== host) console.log(`http://${openHost}:${port}`);
  if (announcedHosts) console.log(`hosts ${announcedHosts}`);
  console.log("mode production");
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
  console.error(`server did not answer ${probeUrl} within ${readyTimeoutMs / 1000}s`);
  const tail = logTail();
  if (tail) console.error(tail);
  process.exit(1);
}

function prepareEnv() {
  const password = loadPassword();
  if (!isLoopbackBind(host) && password.length === 0) {
    console.error("refusing to listen outside loopback without PI_WEB_PASSWORD");
    console.error("put it in the environment or in .env.local");
    process.exit(1);
  }
  if (!fs.existsSync(nextBin)) {
    console.error("next is not installed. Run npm install in this repo.");
    process.exit(1);
  }

  const fileEnv = parseEnvAssignmentFile(
    fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : "",
  );
  const configuredHosts = process.env.PI_WEB_ALLOWED_HOSTS || fileEnv.PI_WEB_ALLOWED_HOSTS || "";
  const allowedHosts = mergeHostList(
    configuredHosts,
    isLoopbackBind(host) ? [] : discoverAccessNames(),
  );
  announcedHosts = allowedHosts;

  const childEnv = {
    ...process.env,
    NODE_ENV: "production",
    PI_WEB_HOSTNAME: host,
  };
  if (allowedHosts) childEnv.PI_WEB_ALLOWED_HOSTS = allowedHosts;
  if (password.length > 0) childEnv.PI_WEB_PASSWORD = password;
  return childEnv;
}

function buildInto(distDir, baseEnv) {
  // tsconfig.json includes the generated types of every dist dir (and .next),
  // but `next build` only rewrites the one it is building into and never drops
  // what it finds there. A route that moved or was deleted therefore leaves a
  // validator pointing at a missing file, and the type check fails on the very
  // next build. Clear them all before building; the running server does not
  // need them, only its compiled output.
  for (const dir of [...distDirs, ".next"]) {
    fs.rmSync(path.join(root, dir, "dev"), { recursive: true, force: true });
    fs.rmSync(path.join(root, dir, "types"), { recursive: true, force: true });
  }

  console.log(`building ${distDir}`);
  const startedAt = Date.now();
  const built = spawnSync(process.execPath, [nextBin, ...nextBuildArgs()], {
    cwd: root,
    env: { ...baseEnv, PI_WEB_DIST_DIR: distDir },
    stdio: "inherit",
  });
  if (!built || built.status !== 0) return false;
  console.log(`built ${distDir} in ${seconds(startedAt)}`);
  return true;
}

async function launch(distDir, baseEnv) {
  const logFd = fs.openSync(logFile, "w");
  const child = spawn(process.execPath, [nextBin, ...nextStartArgs(host, port)], {
    cwd: root,
    detached: true,
    env: { ...baseEnv, PI_WEB_DIST_DIR: distDir },
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
  fs.writeFileSync(distStateFile, `${distDir}\n`);
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

  const childEnv = prepareEnv();
  if (await listening()) {
    console.error(`${probeUrl} is already in use`);
    process.exit(1);
  }

  const distDir = readDistDir();
  if (!buildInto(distDir, childEnv)) {
    console.error("build failed");
    process.exit(1);
  }
  await launch(distDir, childEnv);
}

// Build first, swap second. The running server keeps serving its own build
// while the new one compiles into the other dist dir, so a failed build leaves
// production alone and the downtime is one stop plus one start.
async function restart() {
  fs.mkdirSync(runDir, { recursive: true });
  const childEnv = prepareEnv();
  const pid = readPid();
  const running = Boolean(pid && pidAlive(pid)) || (await listening());
  const distDir = running ? otherDistDir(readDistDir()) : readDistDir();

  if (!buildInto(distDir, childEnv)) {
    console.error("build failed");
    if (running) console.error("the running server was left alone on its old build");
    process.exit(1);
  }

  const swappingAt = Date.now();
  if (running) await stop();
  await launch(distDir, childEnv);
  console.log(`downtime ${seconds(swappingAt)}`);
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

const entry = process.argv[1];
const invokedDirectly = Boolean(entry) && path.resolve(entry) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const command = process.argv[2];
  if (command === "start") {
    await start();
  } else if (command === "stop") {
    await stop();
  } else if (command === "restart") {
    await restart();
  } else {
    console.error("usage: node scripts/serve.mjs start|stop|restart");
    process.exit(1);
  }
}
