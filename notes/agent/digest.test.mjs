import assert from "node:assert/strict";
import { test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { sessionDigestPrompt } = await jiti.import("./digest.ts");

const prompt = sessionDigestPrompt("方案/发布.excalidraw", "只补四道闸门各自能证明什么");

test("the user's sentence is the instruction, the board is the only limit", () => {
  // The typed prompt is the brief; editing the board (even replace) is allowed.
  assert.ok(prompt.includes("方案/发布.excalidraw"));
  assert.ok(prompt.includes("只补四道闸门各自能证明什么"));
  for (const rule of ["优先级最高", "replace=true", "不许新建白板", "没提的内容不要自己加", "什么都不写", "无需另读文件", "action=draw"]) {
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
