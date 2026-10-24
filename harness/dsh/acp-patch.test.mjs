import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

process.env.DSH_HOME = mkdtempSync(path.join(tmpdir(), "pi-web-dsh-patch-"));
const { dshProviderEnv, overlayText } = await createJiti(import.meta.url).import("./acp-patch.ts");

const config = {
  defaultModel: "ds-flash",
  providers: [
    { id: "deepseek-official", url: "", api: "", apiEnv: "" },
    { id: "opencode-zen", url: "https://opencode.ai/zen/go/v1", api: "zen-secret", apiEnv: "" },
  ],
  models: [
    { key: "ds-flash", provider: "deepseek-official", model: "deepseek-flash", enabled: true, api: "", apiEnv: "" },
    {
      key: "opencode",
      provider: "opencode-zen",
      model: "deepseek-v4.1-flash",
      enabled: true,
      api: "",
      apiEnv: "",
    },
  ],
};

const TUI = "providers:\n      opencode-zen:\n";

test("starts on a gateway route so images are advertised", () => {
  const text = overlayText(config, TUI);
  assert.equal(text.includes("provider: \"opencode-zen\""), true);
  assert.equal(text.includes("model: \"deepseek-v4.1-flash\""), true);
});

test("keeps the default when it already is a gateway route", () => {
  const text = overlayText({ ...config, defaultModel: "opencode" }, TUI);
  assert.equal(text.includes("provider: \"opencode-zen\""), true);
});

test("leaves the bundle default when no gateway route is declared", () => {
  const text = overlayText({ ...config, providers: [config.providers[0]], models: [config.models[0]] }, TUI);
  assert.equal(text.includes("- id: acp"), false);
});

test("provider keys land in the environment the kernel inherits", () => {
  assert.deepEqual(dshProviderEnv(config), { OPENCODE_ZEN_API_KEY: "zen-secret" });
  const named = {
    ...config,
    models: [{ ...config.models[1], api: "model-secret", apiEnv: "MY_GATEWAY_KEY" }],
  };
  assert.deepEqual(dshProviderEnv(named), { MY_GATEWAY_KEY: "model-secret" });
});

test("oauth-only configs start on a catalog model that takes images", () => {
  const home = process.env.DSH_HOME;
  const catalog = path.join(home, "profiles", "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "data");
  mkdirSync(catalog, { recursive: true });
  writeFileSync(
    path.join(catalog, "openai-codex.json"),
    JSON.stringify({ responses: { "gpt-x": { id: "gpt-x", input: ["text", "image"] } } }),
  );
  const plugin = path.join(home, "profiles", "dsh-tui", "node_modules", "@deepseek-harness-tui", "dsh-tui", "lib", "types");
  mkdirSync(plugin, { recursive: true });
  writeFileSync(path.join(plugin, "oauth.js"), "");

  const oauthOnly = {
    defaultModel: "",
    providers: [{ id: "openai-codex", url: "", api: "", apiEnv: "" }],
    models: [{ key: "gpt", provider: "openai-codex", model: "gpt-x", enabled: true, api: "", apiEnv: "" }],
  };
  const text = overlayText(oauthOnly);
  assert.equal(text.includes('provider: "openai-codex"'), true);
  assert.equal(text.includes('model: "gpt-x"'), true);
  assert.equal(text.includes("providers: [openai-codex]"), true);
});
