import type { ITheme } from "@xterm/xterm";
import type { ResolvedTheme } from "./theme";

// One palette per resolved app theme, so adding a theme to THEME_OPTIONS
// leaves a compile error here until its terminal colors are chosen too.
// Keep each background in step with --terminal-bg in app/globals.css.
const light: ITheme = {
  background: "#fbfbfc", foreground: "#24292f", cursor: "#2563eb",
  cursorAccent: "#fbfbfc", selectionBackground: "#bfd7fb",
  black: "#24292f", red: "#cf222e", green: "#116329", yellow: "#7d4e00",
  blue: "#0969da", magenta: "#8250df", cyan: "#1b7c83", white: "#6e7781",
  brightBlack: "#57606a", brightRed: "#a40e26", brightGreen: "#1a7f37",
  brightYellow: "#633c01", brightBlue: "#218bff", brightMagenta: "#a475f9",
  brightCyan: "#3192aa", brightWhite: "#8c959f",
};

export const TERMINAL_XTERM_THEMES: Record<ResolvedTheme, ITheme> = {
  light,
  "github-light": {
    ...light,
    background: "#ffffff", cursorAccent: "#ffffff", selectionBackground: "#b6d7ff",
  },
  dark: {
    background: "#111318", foreground: "#d7dce5", cursor: "#60a5fa",
    selectionBackground: "#365b8a",
    black: "#1d222b", red: "#f87171", green: "#4ade80", yellow: "#facc15",
    blue: "#60a5fa", magenta: "#c084fc", cyan: "#22d3ee", white: "#e5e7eb",
    brightBlack: "#6b7280", brightRed: "#fca5a5", brightGreen: "#86efac",
    brightYellow: "#fde047", brightBlue: "#93c5fd", brightMagenta: "#d8b4fe",
    brightCyan: "#67e8f9", brightWhite: "#ffffff",
  },
  // Atom One Dark (One Dark Pro): its editor background, comment gray and syntax colors.
  "one-dark-pro": {
    background: "#282c34", foreground: "#abb2bf", cursor: "#528bff",
    selectionBackground: "#3e4451",
    black: "#282c34", red: "#e06c75", green: "#98c379", yellow: "#e5c07b",
    blue: "#61afef", magenta: "#c678dd", cyan: "#56b6c2", white: "#abb2bf",
    brightBlack: "#5c6370", brightRed: "#e06c75", brightGreen: "#98c379",
    brightYellow: "#e5c07b", brightBlue: "#61afef", brightMagenta: "#c678dd",
    brightCyan: "#56b6c2", brightWhite: "#ffffff",
  },
};
