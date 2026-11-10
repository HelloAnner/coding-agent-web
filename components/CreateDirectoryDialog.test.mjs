import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { CreateDirectoryDialog } = await jiti.import("./CreateDirectoryDialog.tsx");
const source = await readFile(new URL("./CreateDirectoryDialog.tsx", import.meta.url), "utf8");
const start = source.indexOf("  const create = async () => {");
const end = source.indexOf("\n  return (", start);
assert.ok(start >= 0 && end > start);
const code = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

test("folder dialog has a named, bounded input, destination preview and no mount-time creation", () => {
  const html = renderToStaticMarkup(React.createElement(I18nProvider, null,
    React.createElement(CreateDirectoryDialog, { parentPath: "~", onCancel() {}, onCreated() { assert.fail("not submitted"); } })));
  assert.match(html, /<dialog[^>]*aria-modal="true"[^>]*aria-labelledby=/);
  assert.match(html, /<label for="[^"]+">Folder name<\/label>/);
  assert.match(html, /<input[^>]*required=""[^>]*maxLength="255"/);
  assert.match(html, /<code class="create-directory-path">~\/<\/code>/);
  assert.match(html, /type="submit" disabled=""/);
});

test("creation rejects duplicate submissions, preserves errors and retries opening without another mkdir", async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let requests = 0;
  let openings = 0;
  const scope = {
    Error,
    name: "  中文 project  ", parentPath: "~", createdPath: null,
    busyRef: { current: false },
    setCreating: (busy) => { scope.creating = busy; },
    setError: (error) => { scope.error = error; },
    setCreatedPath: (path) => { scope.createdPath = path; },
    fetch: async (url, options) => {
      requests++;
      assert.equal(url, "/api/cwd/browse");
      assert.deepEqual(JSON.parse(options.body), { path: "~", name: "中文 project" });
      await pending;
      return { ok: true, json: async () => ({ path: "/home/test/中文 project" }) };
    },
    onCreated: async (path) => {
      openings++;
      assert.equal(path, "/home/test/中文 project");
      if (openings === 1) throw new Error("project save failed");
    },
  };
  const create = vm.runInNewContext(`${code}\ncreate`, scope);
  const first = create();
  await create();
  assert.equal(requests, 1);
  assert.equal(scope.creating, true);
  release();
  await first;
  assert.equal(scope.error, "project save failed");
  assert.equal(scope.creating, false);
  await create();
  assert.equal(requests, 1, "retry must not fail with EEXIST after a successful mkdir");
  assert.equal(openings, 2);
  assert.equal(scope.error, null);

  scope.createdPath = null;
  scope.fetch = async () => ({ ok: false, status: 409, json: async () => ({ error: "Already exists" }) });
  await create();
  assert.equal(scope.error, "Already exists");
  assert.equal(openings, 2, "a failed mkdir must not select an existing directory");
  assert.equal(scope.creating, false);
});
