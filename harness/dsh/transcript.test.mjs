import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { zstdCompressSync } from "node:zlib";
import { createJiti } from "jiti";

const { readDshTranscript, decompressFrames } = await createJiti(import.meta.url).import("./transcript.ts");

const HEADER = { type: "session", version: 4, id: "abc", cwd: "/tmp/x", isSeeded: false };
const USER = {
  type: "user/message",
  seq: 8,
  time: 1000,
  data: { content: [{ type: "text", text: "list the files" }], source: { kind: "user" }, role: "user" },
};
const ENVELOPE = {
  type: "user/message",
  seq: 9,
  time: 1001,
  data: { content: [{ type: "text", text: "<system-reminder>rules</system-reminder>" }], role: "user" },
};
const STEP_ONE = {
  type: "assistant/message",
  seq: 10,
  time: 1002,
  data: {
    turn: 1,
    step: 1,
    message: {
      role: "assistant",
      content: [
        { type: "reasoning", text: "look first" },
        { type: "tool-call", id: "call_1", name: "bash", arguments: '{"command":"ls"}' },
      ],
      source: { kind: "model", provider: "deepseek-official", model: "deepseek-v4-flash" },
    },
  },
};
const RESULT = {
  type: "tool/result",
  seq: 11,
  time: 1003,
  data: { message: { role: "tool", toolCallId: "call_1", content: [{ type: "text", text: "a.txt" }] } },
};
const STEP_TWO = {
  type: "assistant/message",
  seq: 12,
  time: 1004,
  data: {
    turn: 1,
    step: 2,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "one file" }],
      source: { kind: "model", provider: "deepseek-official", model: "deepseek-v4-flash" },
    },
  },
};

/** The kernel appends one Zstandard frame per flush. */
function writeLog(dir, records) {
  const half = Math.ceil(records.length / 2);
  const frame = (rows) => zstdCompressSync(Buffer.from(rows.map((row) => JSON.stringify(row)).join("\n") + "\n"));
  writeFileSync(path.join(dir, "session.v4.jsonl.zstd"), Buffer.concat([frame(records.slice(0, half)), frame(records.slice(half))]));
}

test("reads every frame of one session log", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dsh-log-"));
  writeLog(dir, [HEADER, USER, ENVELOPE, STEP_ONE, RESULT, STEP_TWO]);

  const transcript = readDshTranscript(dir);
  assert.equal(transcript.exists, true);
  assert.equal(transcript.model, "deepseek-v4-flash");
  assert.equal(transcript.messages.length, 4);

  const [user, stepOne, result, stepTwo] = transcript.messages;
  assert.deepEqual(user, { role: "user", content: "list the files", timestamp: 1000 });
  assert.equal(stepOne.role, "assistant");
  assert.deepEqual(stepOne.content[0], { type: "thinking", thinking: "look first" });
  assert.deepEqual(stepOne.content[1], { type: "toolCall", toolCallId: "call_1", toolName: "bash", input: { command: "ls" } });
  assert.equal(result.role, "toolResult");
  assert.equal(result.toolName, "bash");
  assert.equal(result.content[0].text, "a.txt");
  assert.equal(stepTwo.content[0].text, "one file");
});

test("a torn final frame keeps the frames before it", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dsh-log-"));
  writeLog(dir, [HEADER, USER, STEP_ONE, RESULT, STEP_TWO]);
  const file = path.join(dir, "session.v4.jsonl.zstd");
  const whole = readFileSync(file);
  writeFileSync(file, whole.subarray(0, whole.length - 6));

  const transcript = readDshTranscript(dir);
  assert.equal(transcript.exists, true);
  // The first frame survives; the frame still being written is dropped.
  assert.equal(transcript.messages.length, 2);
  assert.deepEqual(transcript.messages[0], { role: "user", content: "list the files", timestamp: 1000 });
});

test("a session with no log is not an error", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dsh-log-"));
  assert.deepEqual(readDshTranscript(dir), { messages: [], exists: false, path: null, model: null });
});

test("a user image is read back from the attachment store", () => {
  const hex = "a".repeat(64);
  const home = mkdtempSync(path.join(tmpdir(), "dsh-home-"));
  process.env.DSH_HOME = home;
  const objectDir = path.join(home, "attachments", "v1", "objects", hex.slice(0, 2));
  mkdirSync(objectDir, { recursive: true });
  const bytes = Buffer.from("89504e470d0a1a0a", "hex");
  writeFileSync(path.join(objectDir, hex), bytes);

  const dir = mkdtempSync(path.join(tmpdir(), "dsh-log-"));
  writeLog(dir, [
    HEADER,
    {
      type: "user/message",
      seq: 1,
      time: 1000,
      data: {
        content: [
          { type: "text", text: "what is this" },
          {
            type: "image",
            attachment: { attachmentId: `sha256:${hex}`, mediaType: "image/png", width: 1, height: 1, bytes: bytes.length },
          },
        ],
        source: { kind: "user" },
      },
    },
  ]);

  const [message] = readDshTranscript(dir).messages;
  assert.equal(message.role, "user");
  assert.deepEqual(message.content, [
    { type: "text", text: "what is this" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: bytes.toString("base64") } },
  ]);
  delete process.env.DSH_HOME;
});

test("one uncompressed frame still decompresses", () => {
  const one = zstdCompressSync(Buffer.from('{"a":1}\n'));
  assert.equal(decompressFrames(one).toString("utf8"), '{"a":1}\n');
});
