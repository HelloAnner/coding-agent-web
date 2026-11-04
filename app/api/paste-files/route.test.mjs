import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { POST } = await jiti.import("./route.ts");
const { NextRequest } = await jiti.import("next/server");

/** A name no desktop clipboard can hold, so the temp-copy branch is the one under test. */
const NAME = `pi-web-paste-test-${process.pid}-${Date.now()}.txt`;

async function paste(file) {
  const form = new FormData();
  form.append("files", file, file.name);
  return POST(new NextRequest("http://localhost/api/paste-files", {
    method: "POST", headers: { host: "localhost" }, body: form,
  }));
}

test("a pasted file comes back as an absolute path outside the working directory", async () => {
  const response = await paste(new File(["hello"], NAME));
  assert.equal(response.status, 200);
  const { paths } = await response.json();
  assert.equal(paths.length, 1);
  assert.ok(path.isAbsolute(paths[0]));
  assert.ok(paths[0].startsWith(os.tmpdir() + path.sep));
  assert.equal(path.basename(paths[0]), NAME);
  assert.equal(fs.readFileSync(paths[0], "utf8"), "hello");
  assert.equal(fs.existsSync(path.join(process.cwd(), NAME)), false);
  fs.rmSync(path.dirname(paths[0]), { recursive: true, force: true });
});

test("the same name pasted twice stays one file and never replaces it", async () => {
  const form = new FormData();
  form.append("files", new File(["a"], NAME), NAME);
  form.append("files", new File(["b"], NAME), NAME);
  const response = await POST(new NextRequest("http://localhost/api/paste-files", {
    method: "POST", headers: { host: "localhost" }, body: form,
  }));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "Duplicate file name in upload: " + NAME);
});

test("another origin cannot write paste copies", async () => {
  const form = new FormData();
  form.append("files", new File(["x"], NAME), NAME);
  const response = await POST(new NextRequest("http://localhost/api/paste-files", {
    method: "POST",
    headers: { host: "localhost", origin: "http://evil.example" },
    body: form,
  }));
  assert.equal(response.status, 403);
});
