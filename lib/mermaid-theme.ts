/**
 * Mermaid's base theme, filled from the app's CSS variables. Reading the live
 * variables keeps diagrams on the same palette as the chrome for every theme,
 * including ones added later; no second color table to forget.
 */
export function mermaidTheme(read: (name: string) => string, dark: boolean) {
  return {
    theme: "base" as const,
    darkMode: dark,
    themeVariables: {
      background: read("--bg"),
      primaryColor: read("--bg-panel"),
      primaryTextColor: read("--text"),
      primaryBorderColor: read("--border"),
      secondaryColor: read("--bg-hover"),
      tertiaryColor: read("--bg-selected"),
      lineColor: read("--text-muted"),
      textColor: read("--text"),
      mainBkg: read("--bg-panel"),
      nodeBorder: read("--border"),
      nodeTextColor: read("--text"),
      clusterBkg: read("--bg-subtle"),
      clusterBorder: read("--border"),
      titleColor: read("--text"),
      edgeLabelBackground: read("--bg"),
      noteBkgColor: read("--bg-panel"),
      noteTextColor: read("--text"),
      noteBorderColor: read("--border"),
      actorBkg: read("--bg-panel"),
      actorBorder: read("--border"),
      actorTextColor: read("--text"),
      actorLineColor: read("--border"),
      signalColor: read("--text-muted"),
      signalTextColor: read("--text"),
      labelBoxBkgColor: read("--bg-panel"),
      labelBoxBorderColor: read("--border"),
      labelTextColor: read("--text"),
      loopTextColor: read("--text"),
      activationBkgColor: read("--bg-hover"),
      activationBorderColor: read("--border"),
      sequenceNumberColor: read("--bg"),
      fontFamily: read("--font-ui"),
      fontSize: "14px",
    },
  };
}
