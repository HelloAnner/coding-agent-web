import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
const root = await mkdtemp(join(tmpdir(), "dsh-web-migration-"));
const file = join(root, "ds.toml"), patch = join(root, "profiles/dsh-tui/cordis.patch.yml");
process.env.DSH_DS_TOML = file;
await mkdir(join(root, "profiles/dsh-tui"), { recursive: true });
await writeFile(file, '[provider.gateway]\napi = "private-legacy-key"\napi_env = "LEGACY_KEY"\n[model.saved]\nprovider = "gateway"\nmodel = "test"\n');
await writeFile(patch, '- id: unrelated\n  config:\n    hook: !!js "globalThis.migrationExecuted = true"\n- id: llm-pi-ai\n  config:\n    providers:\n      gateway:\n        api: openai-completions\n        baseURL: http://127.0.0.1:1/v1\n        apiKeyEnv: LEGACY_KEY\n        models:\n          - id: test\n            contextWindow: 32768\n            maxTokens: 1024\n');
let providers = {}, revision = 1, mode = "ok";
const keys = new Map();
const symbol = Symbol.for("coding-agent-web.dshWebHost");
globalThis[symbol] = {
  home: root,
  async call(endpoint, args = {}) {
    if (endpoint === "session/list") return { items: [] };
    if (endpoint === "settings/describe") return { namespaces: [{ ns: "llm-pi-ai", revision, value: { providers } }] };
    if (endpoint === "credentials/set") { keys.set(args.ref, args.value); return; }
    if (endpoint === "credentials/unset") { keys.delete(args.ref); return; }
    assert.equal(endpoint, "settings/mutate");
    assert.equal(args.expectedRevision, revision);
    if (mode === "reject") throw new Error("rejected");
    for (const op of args.ops) providers[op.path[1]] = op.value;
    revision++;
    if (mode === "lost") throw new Error("response lost after write");
  },
};
const { previewDshMigration, importDshMigration } = await createJiti(import.meta.url).import("./legacy-migration.ts");
after(async () => { delete globalThis[symbol]; await rm(root, { recursive: true, force: true }); });

test("migration is explicit, redacted, non-evaluating, stale-safe and never overwrites existing providers", async () => {
  const preview = previewDshMigration();
  assert.equal(preview.available, true);
  assert.deepEqual(preview.providers, [{ id: "gateway", modelCount: 1 }]);
  assert.doesNotMatch(JSON.stringify(preview), /private-legacy-key/);
  assert.equal(globalThis.migrationExecuted, undefined);
  assert.equal(keys.size, 0);
  await assert.rejects(() => importDshMigration("0".repeat(64)), /preview it again/);
  const before = await readFile(file, "utf8");
  const imported = await importDshMigration(preview.fingerprint);
  assert.deepEqual(imported.imported, ["gateway"]);
  assert.equal(providers.gateway.api, "openai-completions");
  assert.equal(keys.get(providers.gateway.apiKeyEnv), "private-legacy-key");
  assert.notEqual(providers.gateway.apiKeyEnv, "LEGACY_KEY");
  assert.equal(await readFile(file, "utf8"), before);
  assert.deepEqual((await importDshMigration(preview.fingerprint)).skipped, ["gateway"]);
  assert.equal(keys.size, 1);
});

test("failed native writes clean only provably unused credentials; lost accepted responses preserve their keys", async () => {
  providers = {}; keys.clear(); mode = "reject";
  const preview = previewDshMigration();
  await assert.rejects(() => importDshMigration(preview.fingerprint), /could not be confirmed/);
  assert.equal(keys.size, 0);
  mode = "lost";
  await assert.rejects(() => importDshMigration(preview.fingerprint), /could not be confirmed/);
  assert.equal(keys.size, 1);
  assert.equal(keys.get(providers.gateway.apiKeyEnv), "private-legacy-key", "an uncertain response cannot invalidate applied config");
});
