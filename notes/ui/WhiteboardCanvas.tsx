"use client";

import { memo, useCallback, useMemo, type ComponentProps } from "react";
import {
  Excalidraw,
  FONT_FAMILY,
  serializeAsJSON,
} from "@excalidraw/excalidraw";
import type { ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";
import "@excalidraw/excalidraw/index.css";
type NormalizedTheme = "light" | "dark";

/**
 * The whiteboard defaults the notes vault has been tuned to. They are the
 * starting style of everything drawn from now on; elements already in a scene
 * keep their own style.
 */
const DEFAULT_APP_STATE = {
  viewBackgroundColor: "#ffffff",
  currentItemStrokeColor: "#1b1b1f",
  currentItemStrokeWidth: 1,
  currentItemStrokeStyle: "solid",
  currentItemRoughness: 1,
  currentItemRoundness: "round",
  currentItemArrowType: "round",
  currentItemStartArrowhead: null,
  currentItemEndArrowhead: "arrow",
  currentItemOpacity: 100,
  // 等宽代码字体（Cascadia），不用手写风格（Virgil/Excalifont）。
  currentItemFontFamily: FONT_FAMILY.Cascadia,
  currentItemFontSize: 20,
  currentItemTextAlign: "left",
} as const;

function parseScene(content: string): ExcalidrawInitialDataState {
  try {
    const parsed = JSON.parse(content) as Partial<ExcalidrawInitialDataState> | null;
    return {
      elements: parsed?.elements ?? [],
      appState: { ...DEFAULT_APP_STATE, ...(parsed?.appState ?? {}) },
      files: parsed?.files ?? {},
    };
  } catch {
    // A board edited outside the app can be broken; start empty rather than
    // crashing the page, and the next change rewrites it as valid JSON.
    return { elements: [], appState: { ...DEFAULT_APP_STATE }, files: {} };
  }
}

/**
 * The Excalidraw half of a board, loaded only in the browser (SSR has no
 * canvas). Kept apart from Whiteboard.tsx so the wrapper stays free of the
 * Excalidraw bundle and can be statically rendered.
 */
type SceneChange = Parameters<NonNullable<ComponentProps<typeof Excalidraw>["onChange"]>>;

function WhiteboardCanvas({
  content,
  theme,
  onChange,
}: {
  content: string;
  theme: NormalizedTheme;
  onChange: (scene: string) => void;
}) {
  const initialData = useMemo(() => parseScene(content), [content]);
  // Excalidraw re-runs its onChange effect when the callback's identity
  // changes. A fresh arrow on every render (this component renders whenever
  // the save status changes) would save forever; keep it stable.
  const handleChange = useCallback((...args: SceneChange) => {
    const [elements, appState, files] = args;
    // Excalidraw reports its own restore as a change; saving then would
    // overwrite the file with a half-loaded scene.
    if (appState.isLoading) return;
    onChange(serializeAsJSON(elements, appState, files, "local"));
  }, [onChange]);
  return (
    <div className="notes-board">
      <Excalidraw
        initialData={initialData}
        langCode="zh-CN"
        theme={theme}
        autoFocus
        UIOptions={{
          canvasActions: { export: false, loadScene: false, saveAsImage: false, toggleTheme: false },
        }}
        onChange={handleChange}
      />
    </div>
  );
}

// Stable props (content, theme, onChange) keep a status re-render of the
// header from re-rendering the whole canvas.
export default memo(WhiteboardCanvas);
