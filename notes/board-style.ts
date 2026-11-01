import type { AppState } from "@excalidraw/excalidraw/types";
import type { NotesBoardSettings, NotesBoardStyle } from "./types";

export const DEFAULT_BOARD_SETTINGS: NotesBoardSettings = { fontFamily: 3, fontSize: 20 };

export const DEFAULT_BOARD_STYLE: NotesBoardStyle = {
  currentItemBackgroundColor: "transparent",
  currentItemStrokeColor: "#263d8f",
  currentItemFillStyle: "solid",
  currentItemStrokeWidth: 2,
  currentItemStrokeStyle: "solid",
  currentItemRoughness: 0,
  currentItemRoundness: "round",
  currentItemArrowType: "round",
  currentItemStartArrowhead: null,
  currentItemEndArrowhead: "arrow",
  currentItemOpacity: 100,
  currentItemTextAlign: "left",
};

const ARROWHEADS = [null, "arrow", "bar", "dot", "circle", "circle_outline", "triangle", "triangle_outline", "diamond", "diamond_outline", "crowfoot_one", "crowfoot_many", "crowfoot_one_or_many"];
const STYLE_OPTIONS: Partial<Record<keyof NotesBoardStyle, readonly unknown[]>> = {
  currentItemFillStyle: ["solid", "hachure", "cross-hatch", "zigzag"],
  currentItemStrokeStyle: ["solid", "dashed", "dotted"],
  currentItemRoundness: ["round", "sharp"],
  currentItemArrowType: ["sharp", "round", "elbow"],
  currentItemStartArrowhead: ARROWHEADS,
  currentItemEndArrowhead: ARROWHEADS,
  currentItemTextAlign: ["left", "center", "right"],
};
const STYLE_RANGES: Partial<Record<keyof NotesBoardStyle, readonly [number, number]>> = {
  currentItemStrokeWidth: [0.1, 100],
  currentItemRoughness: [0, 3],
  currentItemOpacity: [0, 100],
};
const STYLE_KEYS = Object.keys(DEFAULT_BOARD_STYLE) as (keyof NotesBoardStyle)[];

/** Whitelist drawing styles only: never store scene, viewport or selection state. */
export function normalizeBoardStyle(raw: unknown): Partial<NotesBoardStyle> {
  const style: Partial<NotesBoardStyle> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return style;
  for (const key of STYLE_KEYS) {
    const value = (raw as Record<string, unknown>)[key];
    const range = STYLE_RANGES[key];
    const valid = key.endsWith("Color")
      ? typeof value === "string" && /^(transparent|#[\da-f]{3,4}|#[\da-f]{6}|#[\da-f]{8})$/i.test(value)
      : range
        ? typeof value === "number" && Number.isFinite(value) && value >= range[0] && value <= range[1]
        : STYLE_OPTIONS[key]?.includes(value);
    if (valid) Object.assign(style, { [key]: value });
  }
  return style;
}

export function boardAppState(board: NotesBoardSettings) {
  return {
    ...DEFAULT_BOARD_STYLE,
    ...board.style,
    currentItemFontFamily: board.fontFamily,
    currentItemFontSize: board.fontSize,
  };
}

export function boardSettingsFromAppState(appState: AppState): NotesBoardSettings {
  return {
    fontFamily: appState.currentItemFontFamily,
    fontSize: appState.currentItemFontSize,
    style: Object.fromEntries(STYLE_KEYS.map((key) => [key, appState[key]])) as NotesBoardStyle,
  };
}
