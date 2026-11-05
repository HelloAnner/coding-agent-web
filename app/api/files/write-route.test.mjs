import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server.js";
import { createJiti } from "jiti";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-files-write-")));
process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { POST } = await jiti.import("./[...path]/route.ts");
const { allowFileRoot } = await jiti.import("../../../lib/allowed-roots.ts");
allowFileRoot(root);

function post(filePath, body) {
  const segments = filePath.replace(/\\/g, "/").split("/").filter(Boolean);
  return POST(
    new NextRequest("http://localhost/api/files/x?type=write", {
      method: "POST",
      // The POST guard checks the Host header, which NextRequest does not derive
      // from the URL.
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ path: segments }) },
  );
}

test("writes a text file back and reports the new version", async () => {
  const target = path.join(root, "notes.md");
  fs.writeFileSync(target, "# old\n");

  const response = await post(target, { content: "# new\n" });
  assert.equal(response.status, 200);
  const meta = await response.json();
  assert.equal(meta.size, 6);
  assert.equal(typeof meta.mtime, "string");
  assert.equal(fs.readFileSync(target, "utf8"), "# new\n");
});

test("refuses a missing file, a directory and a non-text body", async () => {
  const directory = path.join(root, "dir");
  fs.mkdirSync(directory);
  const target = path.join(root, "notes.md");
  fs.writeFileSync(target, "keep");

  assert.equal((await post(path.join(root, "nope.md"), { content: "x" })).status, 404);
  assert.equal((await post(directory, { content: "x" })).status, 400);
  assert.equal((await post(target, { content: 42 })).status, 400);
  assert.equal(fs.readFileSync(target, "utf8"), "keep");
});

test("refuses a path outside the allowed roots", async () => {
  const outside = path.join(os.tmpdir(), `pi-web-outside-${process.pid}.md`);
  fs.writeFileSync(outside, "untouched");
  try {
    assert.equal((await post(outside, { content: "x" })).status, 403);
    assert.equal(fs.readFileSync(outside, "utf8"), "untouched");
  } finally {
    fs.rmSync(outside, { force: true });
  }
});
