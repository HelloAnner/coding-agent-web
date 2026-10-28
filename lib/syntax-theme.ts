import type { CSSProperties } from "react";
import oneDark from "react-syntax-highlighter/dist/cjs/styles/prism/one-dark";
import vs from "react-syntax-highlighter/dist/cjs/styles/prism/vs";
import vscDarkPlus from "react-syntax-highlighter/dist/cjs/styles/prism/vsc-dark-plus";
import type { ResolvedTheme } from "./theme";

export type SyntaxTheme = Record<string, CSSProperties>;

// Prism's light themes color <pre> with backgroundColor, its dark themes with
// the background shorthand. Both views set their own backgroundColor, and a
// theme switch that leaves the shorthand behind resets the frame, so the
// shorthand is dropped here.
function withoutPreBackground(theme: SyntaxTheme): SyntaxTheme {
  const pre = theme['pre[class*="language-"]'];
  if (!pre || !("background" in pre)) return theme;
  const clone = { ...theme, ['pre[class*="language-"]']: { ...pre } };
  delete clone['pre[class*="language-"]'].background;
  return clone;
}

// One syntax palette per resolved app theme, so a new theme cannot ship with
// code blocks still painted by the previous one.
export const SYNTAX_THEMES: Record<ResolvedTheme, SyntaxTheme> = {
  light: vs,
  "github-light": vs,
  dark: withoutPreBackground(vscDarkPlus),
  "one-dark-pro": withoutPreBackground(oneDark),
};
