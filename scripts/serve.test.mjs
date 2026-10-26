import assert from "node:assert/strict";
import test from "node:test";
import {
  accessNamesFrom,
  discoverAccessNames,
  isLoopbackBind,
  mergeHostList,
  nextBuildArgs,
  nextStartArgs,
  parseEnvAssignmentFile,
  probeHost,
  resolveWebPassword,
  tailscaleStatusJson,
} from "./serve.mjs";

test("builds with webpack and serves that build", () => {
  assert.deepEqual(nextBuildArgs(), ["build", "--webpack"]);
  assert.deepEqual(nextStartArgs("0.0.0.0", "20169"), ["start", "-H", "0.0.0.0", "-p", "20169"]);
});

test("probes loopback when the bind address is every interface", () => {
  assert.equal(probeHost("0.0.0.0"), "127.0.0.1");
  assert.equal(probeHost("::"), "127.0.0.1");
  assert.equal(probeHost("[::]"), "127.0.0.1");
  assert.equal(probeHost("127.0.0.1"), "127.0.0.1");
  assert.equal(probeHost("localhost"), "localhost");
});

test("treats only loopback names as safe to run without a password", () => {
  assert.equal(isLoopbackBind("127.0.0.1"), true);
  assert.equal(isLoopbackBind("localhost"), true);
  assert.equal(isLoopbackBind("::1"), true);
  assert.equal(isLoopbackBind("[::1]"), true);
  assert.equal(isLoopbackBind("0.0.0.0"), false);
  assert.equal(isLoopbackBind("::"), false);
});

test("reads PI_WEB_PASSWORD from an env file without taking other keys", () => {
  const parsed = parseEnvAssignmentFile(`
# comment
PI_WEB_PASSWORD='local-secret'
OTHER=1
not a line
`);
  assert.deepEqual(parsed, { PI_WEB_PASSWORD: "local-secret", OTHER: "1" });
});

test("keeps a password from the environment ahead of the file", () => {
  assert.equal(resolveWebPassword("from-env", "PI_WEB_PASSWORD=from-file\n"), "from-env");
  assert.equal(resolveWebPassword("", "PI_WEB_PASSWORD=from-file\n"), "from-file");
  assert.equal(resolveWebPassword(undefined, ""), "");
});

test("allows this machine's tailscale name and its short label", () => {
  assert.deepEqual(
    accessNamesFrom({
      hostname: "annerdeMac-mini.local",
      localHostName: "annerdeMac-mini",
      tailscaleDnsName: "mac-mini-1002.example.ts.net.",
    }),
    [
      "annerdemac-mini.local",
      "annerdemac-mini",
      "mac-mini-1002.example.ts.net",
      "mac-mini-1002",
    ],
  );
});

test("finds a tailscale CLI that is not on PATH", () => {
  const tried = [];
  const raw = tailscaleStatusJson((command) => {
    tried.push(command);
    return command === "/usr/local/sbin/tailscale"
      ? JSON.stringify({ Self: { DNSName: "mac-mini-1003.tail2eda7.ts.net." } })
      : "";
  });
  assert.match(raw, /mac-mini-1003/);
  assert.deepEqual(tried.slice(0, 4), [
    "tailscale",
    "/usr/local/bin/tailscale",
    "/opt/homebrew/bin/tailscale",
    "/usr/local/sbin/tailscale",
  ]);
  assert.equal(tried.at(-1), "/usr/local/sbin/tailscale");
});

test("stops at the first tailscale CLI that answers", () => {
  let calls = 0;
  const raw = tailscaleStatusJson(() => {
    calls += 1;
    return JSON.stringify({ Self: { DNSName: "mac-mini-1002.example.ts.net." } });
  });
  assert.equal(calls, 1);
  assert.match(raw, /mac-mini-1002/);
});

test("trusts this machine's tailnet name from an out-of-PATH CLI", () => {
  const names = discoverAccessNames((command) => {
    if (command.endsWith("/tailscale")) {
      return JSON.stringify({ Self: { DNSName: "mac-mini-1003.tail2eda7.ts.net." } });
    }
    return "";
  });
  assert.ok(names.includes("mac-mini-1003.tail2eda7.ts.net"));
  assert.ok(names.includes("mac-mini-1003"));
});

test("drops names that are not a hostname and keeps an operator list", () => {
  assert.deepEqual(accessNamesFrom({
    hostname: "localhost",
    localHostName: "anner的Mac mini",
    tailscaleDnsName: "",
  }), []);
  assert.equal(
    mergeHostList("extra.example, mac-mini-1002", ["mac-mini-1002", "mac-mini-1002.example.ts.net"]),
    "extra.example,mac-mini-1002,mac-mini-1002.example.ts.net",
  );
});
