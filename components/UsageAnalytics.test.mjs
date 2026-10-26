import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("./UsageAnalytics.module.css", import.meta.url), "utf8");
const source = readFileSync(new URL("./UsageAnalytics.tsx", import.meta.url), "utf8");

test("usage details flow with the page instead of a nested scrollable table", () => {
  assert.doesNotMatch(css, /max-height:\s*430px|\.tableScroll/);
  assert.match(css, /\.detailMetrics\s*\{[^}]*repeat\(auto-fit,/);
  assert.match(source, /<dl className=\{styles.detailMetrics\}>/);
  assert.match(source, /<dt>\{l\[key\]\}<\/dt><dd>/);
  assert.doesNotMatch(source, /styles\.tableScroll/);
});

test("usage headline values stay compact on desktop and mobile", () => {
  assert.match(css, /\.kpi\.hero > strong\s*\{\s*font-size:\s*24px/);
  assert.doesNotMatch(css, /font-size:\s*(?:48|38|32|30)px/);
  assert.match(css, /\.rankGrid\s*\{[^}]*align-items:\s*start/);
});
