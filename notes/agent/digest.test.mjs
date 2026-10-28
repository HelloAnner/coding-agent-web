import assert from "node:assert/strict";
import { test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { sessionDigestPrompt } = await jiti.import("./digest.ts");

const prompt = sessionDigestPrompt("方案/发布.excalidraw", "只补四道闸门各自能证明什么");

test("the run is pinned to the open board and to the user's focus", () => {
  // The board path and the focus are the whole brief: no free rein left.
  assert.ok(prompt.includes("方案/发布.excalidraw"));
  assert.ok(prompt.includes("只补四道闸门各自能证明什么"));
  for (const rule of ["replace 一律 false", "不许新建白板", "一个字都不写", "没提到"]) {
    assert.ok(prompt.includes(rule), rule);
  }
});

test("an empty focus is rejected before a run starts", async () => {
  const { digestSession } = await jiti.import("./digest.ts");
  await assert.rejects(() => digestSession("s1", { boardPath: "方案/发布.excalidraw", focus: "  " }));
});

test("a missing board is rejected before a run starts", async () => {
  const { digestSession } = await jiti.import("./digest.ts");
  await assert.rejects(() => digestSession("s1", { boardPath: "方案/不存在的板.excalidraw", focus: "补点东西" }));
});
