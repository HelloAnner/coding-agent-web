import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { grokDefaultModelId, parseGrokModelsCache } = await createJiti(import.meta.url).import("./models.ts");

const SECRET = "grok-cache-secret-token";

const CACHE = JSON.stringify({
  identity: SECRET,
  auth_method: "session",
  models: {
    "grok-4.6": {
      api_key: SECRET,
      env_key: SECRET,
      api_base_url: `https://example.invalid/${SECRET}`,
      info: {
        id: "grok-4.6",
        name: "Grok 4.6",
        hidden: false,
        base_url: `https://example.invalid/${SECRET}`,
        auth_scheme: SECRET,
        extra_headers: { Authorization: `Bearer ${SECRET}` },
      },
    },
    "grok-hidden": {
      api_key: SECRET,
      info: { id: "grok-hidden", name: SECRET, hidden: true },
    },
    "grok-4.7": {
      api_key: SECRET,
      info: { id: "grok-4.7", name: "Grok 4.7", hidden: false, context_window: 256000 },
    },
  },
});

test("lists official models and drops every credential", () => {
  const models = parseGrokModelsCache(CACHE, "grok-4.7");
  assert.deepEqual(models, [
    { key: "grok-4.7", name: "Grok 4.7", provider: "grok", model: "grok-4.7", enabled: true, isDefault: true },
    { key: "grok-4.6", name: "Grok 4.6", provider: "grok", model: "grok-4.6", enabled: true, isDefault: false },
  ]);
  assert.equal(JSON.stringify(models).includes(SECRET), false);
});

test("a hidden default falls back to the first visible model", () => {
  const models = parseGrokModelsCache(CACHE, "grok-hidden");
  assert.equal(models[0].model, "grok-4.6");
  assert.equal(models[0].isDefault, true);
  assert.equal(models.some((item) => item.model === "grok-hidden"), false);
});

test("reads models.default and ignores other tables", () => {
  const text = `
[cli]
default = "not-this"

[models]
# default = "commented"
default = "grok-4.7"

[privacy]
default = "nope"
`;
  assert.equal(grokDefaultModelId(text), "grok-4.7");
  assert.equal(grokDefaultModelId(text, "from-env"), "from-env");
  assert.equal(grokDefaultModelId(text, "  "), "grok-4.7");
  assert.equal(grokDefaultModelId(null), null);
});
