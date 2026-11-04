import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { VERSION as PI_SDK_VERSION } from "@earendil-works/pi-coding-agent";
import { DSH_WEB_VERSION } from "../harness/dsh/web-host";
import { grokBin } from "../harness/grok";
import { ompBinary } from "../harness/omp/models";
import type { HarnessVersionInfo } from "./api-types";
import { nodeCliInvocation } from "./node-cli";

const run = promisify(execFile);

/** Long enough for a global npm install, short enough that a hung updater gives up. */
const UPGRADE_TIMEOUT_MS = 180_000;
const PROBE_TIMEOUT_MS = 15_000;

/** pi reads any `PI_OFFLINE` value as "never touch the network", the same rule the model catalog uses. */
function isModelNetworkDisabled(): boolean {
  return process.env.PI_OFFLINE !== undefined;
}

/** The first `1.2.3[-pre]` in an installer's chatter. */
export function parseVersion(text: string): string | null {
  return /\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?/.exec(text)?.[0] ?? null;
}

function claudeBin(): string {
  return process.env.PI_WEB_CLAUDE_BIN?.trim() || "claude";
}

function dshBin(): string {
  return process.env.PI_WEB_DSH_BIN?.trim() || "dsh";
}

async function exec(command: string, args: string[], timeout = PROBE_TIMEOUT_MS): Promise<string> {
  const { stdout } = await run(command, args, { timeout, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

/** `<bin> --version` on every harness that ships one, parsed down to the number. */
async function installedVersion(bin: string): Promise<string | null> {
  try {
    return parseVersion(await exec(bin, ["--version"]));
  } catch {
    return null;
  }
}

/** What the npm registry says is published. Cached for a minute; the panel asks once per open. */
const latestCache = new Map<string, { value: string | null; at: number }>();

async function npmLatest(pkg: string): Promise<string | null> {
  const cached = latestCache.get(pkg);
  if (cached && Date.now() - cached.at < 60_000) return cached.value;
  let value: string | null = null;
  try {
    const response = await fetch(`https://registry.npmjs.org/${pkg.replace("/", "%2F")}/latest`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
    if (response.ok) {
      const body = await response.json() as { version?: unknown };
      value = typeof body.version === "string" ? body.version : null;
    }
  } catch {
    // An offline registry is not an error the panel needs to show.
  }
  latestCache.set(pkg, { value, at: Date.now() });
  return value;
}

/** grok and omp both know their own release channel; their checker says what the server cannot guess. */
async function selfLatest(bin: string, args: string[]): Promise<string | null> {
  if (isModelNetworkDisabled()) return null;
  try {
    const output = await exec(bin, args, 30_000);
    const json = args.includes("--json") ? JSON.parse(output) as { latestVersion?: unknown } : null;
    if (typeof json?.latestVersion === "string") return json.latestVersion;
    const line = /new version available:\s*(\S+)/i.exec(output)?.[1];
    return line ? parseVersion(line) : null;
  } catch {
    return null;
  }
}

function row(
  harness: { id: string; label: string },
  fields: Partial<Omit<HarnessVersionInfo, "id" | "label">>,
): HarnessVersionInfo {
  return {
    id: harness.id,
    label: harness.label,
    command: null,
    version: null,
    latest: null,
    upgrade: null,
    note: null,
    ...fields,
  };
}

/**
 * Every harness this app runs, its installed version and how it upgrades.
 * pi has no CLI of its own here: it runs from this app's SDK, so it moves with pi-web.
 */
export async function listHarnessVersions(): Promise<HarnessVersionInfo[]> {
  const [claude, dsh, grok, omp] = await Promise.all([
    (async () => {
      const bin = claudeBin();
      return row({ id: "claude-code", label: "Claude Code" }, {
        command: bin,
        version: await installedVersion(bin),
        latest: isModelNetworkDisabled() ? null : await npmLatest("@anthropic-ai/claude-code"),
        upgrade: "claude update",
      });
    })(),
    (async () => {
      const bin = dshBin();
      return row({ id: "dsh", label: "dsh" }, {
        command: bin,
        version: await installedVersion(bin),
        // The web adapter speaks one dsh release; anything else refuses to start.
        latest: DSH_WEB_VERSION,
        upgrade: `npm install -g @deepseek-ai/dsh@${DSH_WEB_VERSION}`,
        note: "pinned",
      });
    })(),
    (async () => {
      const bin = grokBin();
      return row({ id: "grok", label: "grok" }, {
        command: bin,
        version: await installedVersion(bin),
        latest: await selfLatest(bin, ["update", "--check", "--json"]),
        upgrade: "grok update",
      });
    })(),
    (async () => {
      const bin = ompBinary();
      return row({ id: "omp", label: "omp" }, {
        command: bin,
        version: await installedVersion(bin),
        latest: await selfLatest(bin, ["update", "--check"]),
        upgrade: "omp update",
      });
    })(),
  ]);

  const pi = row({ id: "pi", label: "pi" }, {
    version: PI_SDK_VERSION,
    latest: isModelNetworkDisabled() ? null : await npmLatest("@earendil-works/pi-coding-agent"),
    note: "built-in",
  });

  return [pi, claude, dsh, grok, omp];
}

/** Runs the harness's own updater. Only these ids, only these commands; null for the rest. */
export async function upgradeHarness(id: string): Promise<{ version: string | null } | null> {
  if (id === "dsh") {
    // The adapter pins dsh exactly, so "upgrade" installs that release.
    const invocation = nodeCliInvocation("npm", ["install", "-g", `@deepseek-ai/dsh@${DSH_WEB_VERSION}`]);
    await run(invocation.command, invocation.args, { timeout: UPGRADE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
    return { version: await installedVersion(dshBin()) };
  }
  const selfUpdating: Record<string, () => string> = {
    "claude-code": claudeBin,
    grok: grokBin,
    omp: ompBinary,
  };
  const bin = selfUpdating[id];
  if (!bin) return null;
  const command = bin();
  await run(command, ["update"], { timeout: UPGRADE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
  return { version: await installedVersion(command) };
}
