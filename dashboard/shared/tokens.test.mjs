import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.join(process.cwd(), "dashboard");
const tokensCss = readFileSync(path.join(root, "shared/tokens.css"), "utf8");
const definedTokens = new Set([...tokensCss.matchAll(/--db-[a-z0-9-]+/g)].map((match) => match[0]));

function boardStylesheets() {
  const files = [];
  for (const board of readdirSync(path.join(root, "boards"))) {
    const ui = path.join(root, "boards", board, "ui");
    for (const file of readdirSync(ui)) {
      if (file.endsWith(".css")) files.push({ board, file, css: readFileSync(path.join(ui, file), "utf8") });
    }
  }
  return files;
}

test("board stylesheets own no colors: they follow the shell theme through shared tokens", () => {
  for (const { board, file, css } of boardStylesheets()) {
    const where = `${board}/ui/${file}`;
    assert.equal(/#[0-9a-fA-F]{3,8}/.test(css), false, `${where} hardcodes a hex color`);
    assert.equal(/\brgba?\(/.test(css), false, `${where} hardcodes an rgb() color`);
    assert.equal(/color-scheme/.test(css), false, `${where} pins a color scheme`);
  }
});

test("board stylesheets only reference --db- tokens the shared layer defines", () => {
  for (const { board, file, css } of boardStylesheets()) {
    for (const match of css.matchAll(/var\((--db-[a-z0-9-]+)/g)) {
      assert.ok(definedTokens.has(match[1]), `${board}/ui/${file} uses undefined ${match[1]}`);
    }
  }
});

test("the shared layer defines a light and a dark value for every tone", () => {
  const [light, dark] = tokensCss.split(/html\.dark,/);
  assert.ok(light && dark, "tokens.css must split light and dark blocks");
  for (const tone of ["rust", "blue", "teal", "green", "amber", "orange", "purple", "violet", "pink", "red"]) {
    assert.match(light, new RegExp(`--db-tone-${tone}:`), `missing light ${tone}`);
    assert.match(dark, new RegExp(`--db-tone-${tone}:`), `missing dark ${tone}`);
  }
  for (const surface of ["--db-surface:", "--db-surface-sunk:", "--db-border:", "--db-ink:", "--db-ink-muted:", "--db-ink-dim:"]) {
    assert.match(dark, new RegExp(surface), `dark block is missing ${surface}`);
  }
});
