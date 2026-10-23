import assert from "node:assert/strict";
import test from "node:test";
import {
  isLoopbackBind,
  parseEnvAssignmentFile,
  probeHost,
  resolveWebPassword,
} from "./serve.mjs";

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
