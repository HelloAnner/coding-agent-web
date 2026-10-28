import assert from "node:assert/strict";
import test from "node:test";
import { TERMINAL_XTERM_THEMES } from "./terminal-theme.ts";
import { THEME_OPTIONS } from "./theme.ts";

test("every app theme has a terminal palette", () => {
  const ids = THEME_OPTIONS.map(({ id }) => id).filter((id) => id !== "auto");
  assert.deepEqual(Object.keys(TERMINAL_XTERM_THEMES).sort(), [...ids].sort());
});

test("every terminal palette defines every ANSI color", () => {
  const names = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
  for (const theme of Object.values(TERMINAL_XTERM_THEMES)) {
    for (const name of names) {
      assert.match(theme[name], /^#[0-9a-f]{6}$/);
      assert.match(theme[`bright${name[0].toUpperCase()}${name.slice(1)}`], /^#[0-9a-f]{6}$/);
    }
  }
});
