import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { parseDshToml, parseDshRuntime, updateDshModel } = await createJiti(import.meta.url).import("./toml.ts");

const SAMPLE = `
# comment
[common]
default = "ds-flash"

[provider.fineres]
name = "公司网关"
url = "https://example.invalid/v1"
api = "sk-test-secret"

[provider.fineres.headers]
User-Agent = "keep-me"

[model.ds-flash]
name = "DeepSeek"
provider = "deepseek-official"
model = "deepseek-flash"

[model.company]
name = "公司 Flash"
provider = "fineres"
model = "deepseek-v4.1-flash"
enabled = false

[model.company.compat]
thinkingFormat = "deepseek"
`;

test("reads providers and models without credentials", () => {
  const parsed = parseDshToml(SAMPLE);
  assert.deepEqual(parsed.providers, [
    { id: "fineres", name: "公司网关", url: "https://example.invalid/v1" },
  ]);
  assert.deepEqual(parsed.models, [
    { key: "ds-flash", name: "DeepSeek", provider: "deepseek-official", model: "deepseek-flash", enabled: true },
    { key: "company", name: "公司 Flash", provider: "fineres", model: "deepseek-v4.1-flash", enabled: false },
  ]);
  assert.equal(JSON.stringify(parsed).includes("sk-test-secret"), false);
});

test("updates one model and leaves the key line alone", () => {
  const next = updateDshModel(SAMPLE, "company", { name: "改名", enabled: true });
  assert.equal(next.includes("sk-test-secret"), true);
  assert.equal(next.includes("User-Agent = \"keep-me\""), true);
  assert.equal(next.includes("thinkingFormat = \"deepseek\""), true);
  const parsed = parseDshToml(next);
  assert.deepEqual(parsed.models[1], {
    key: "company",
    name: "改名",
    provider: "fineres",
    model: "deepseek-v4.1-flash",
    enabled: true,
  });
  assert.equal(parsed.models[0].name, "DeepSeek");
  assert.equal(updateDshModel(SAMPLE, "missing", { enabled: false }), null);
});

test("runtime config keeps the default model and every key", () => {
  const runtime = parseDshRuntime(SAMPLE);
  assert.equal(runtime.defaultModel, "ds-flash");
  assert.deepEqual(runtime.providers, [
    { id: "fineres", url: "https://example.invalid/v1", api: "sk-test-secret", apiEnv: "" },
  ]);
  assert.deepEqual(runtime.models[1], {
    key: "company",
    provider: "fineres",
    model: "deepseek-v4.1-flash",
    enabled: false,
    api: "",
    apiEnv: "",
  });
});
