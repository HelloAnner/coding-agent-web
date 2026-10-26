import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { TreeNode } = await jiti.import("./FileExplorer.tsx");
const { getFileAncestorPaths } = await jiti.import("../lib/file-paths.ts");

test("active file ancestors are ordered from the root without expanding the file", () => {
  assert.deepEqual(getFileAncestorPaths("/repo", "/repo/docs/guides/start.txt"), ["/repo/docs", "/repo/docs/guides"]);
  assert.deepEqual(getFileAncestorPaths("/repo/", "/repo/docs/start.txt"), ["/repo/docs"]);
  assert.deepEqual(getFileAncestorPaths("/repo", "/repo/start.txt"), []);
  assert.deepEqual(getFileAncestorPaths("/repo", "/repo-other/docs/start.txt"), []);
  assert.deepEqual(getFileAncestorPaths("/repo", null), []);
  assert.deepEqual(getFileAncestorPaths("/", "/docs/start.txt"), ["/docs"]);
  assert.deepEqual(getFileAncestorPaths("C:\\repo", "C:\\repo\\docs\\start.txt"), ["C:/repo/docs"]);
});

function renderTree(activeFilePath) {
  return renderToStaticMarkup(React.createElement(TreeNode, {
    node: {
      name: "docs", fullPath: "/repo/docs", isDir: true, size: 0, loaded: true,
      children: [{ name: "start.txt", fullPath: "/repo/docs/start.txt", isDir: false, size: 0, loaded: true }],
    },
    depth: 0,
    cwd: "/repo",
    activeFilePath,
    onOpenFile() {},
    expandedPaths: new Set(["/repo/docs"]),
    onToggleExpanded() {},
    highlightedPaths: new Set(),
    gitStatusByPath: new Map(),
    changedDirectoryPaths: new Set(),
    t: (key) => key,
  }));
}

test("the active file is highlighted through recursive directory nodes", () => {
  const html = renderTree("/repo/docs/start.txt");
  assert.equal(html.match(/aria-current="true"/g)?.length, 1);
  assert.match(html, /data-active-file="true"/);
  assert.match(html, /color-mix\(in srgb, var\(--accent\) 16%, transparent\)/);
});

test("switching away clears the previous file highlight", () => {
  assert.doesNotMatch(renderTree("/repo/another.txt"), /data-active-file|aria-current/);
  assert.doesNotMatch(renderTree(null), /data-active-file|aria-current/);
});
