import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { grokPromptWithImages, stripGrokAttachments } = await createJiti(import.meta.url).import("./index.ts");

test("an image becomes a marker block under the text", () => {
  const prompt = grokPromptWithImages("what is this?", ["/tmp/a.png"]);
  assert.equal(prompt, "what is this?\n\n[attached images] open each file below before answering\n/tmp/a.png");
});

test("an image-only prompt has no leading blank lines", () => {
  const prompt = grokPromptWithImages("", ["/tmp/a.png", "/tmp/b.jpg"]);
  assert.match(prompt, /^\[attached images\]/);
  assert.match(prompt, /\/tmp\/b\.jpg$/);
});

test("text without images is passed through untouched", () => {
  assert.equal(grokPromptWithImages("hi", []), "hi");
});

test("reading the transcript back drops the marker block", () => {
  assert.equal(stripGrokAttachments(grokPromptWithImages("what is this?", ["/tmp/a.png"])), "what is this?");
  assert.equal(stripGrokAttachments("plain text"), "plain text");
});
