import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

// The index lives in a temp folder, never in the user's data.
const directory = mkdtempSync(join(tmpdir(), "pi-web-catalog-title-"));
process.env.CODING_AGENT_WEB_DATA = join(directory, "data.db");
after(() => rmSync(directory, { recursive: true, force: true }));

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const { syncCatalogTitle } = await jiti.import("./catalog-title.ts");
const { readCatalogSession, upsertCatalogSession } = await jiti.import("./catalog-db.ts");

test("a name set on a pi session lands in the row the sidebar lists", () => {
  const id = "01a16b6a-38f5-70b9-9582-d5bab82b5b36";
  upsertCatalogSession({ id, cwd: process.cwd(), harness: "pi", title: "这个生成标题的原理是什么" });

  syncCatalogTitle(id, "修复标题生成");
  assert.equal(readCatalogSession(id).title, "修复标题生成");

  // No name, no row, and the same name again are all no-ops.
  syncCatalogTitle(id, "  ");
  syncCatalogTitle("03cb1d0a-0000-7000-8000-000000000000", "hello");
  syncCatalogTitle(id, "修复标题生成");
  assert.equal(readCatalogSession(id).title, "修复标题生成");
});
