"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import {
  CaptureUpdateAction,
  Excalidraw,
  restoreElements,
  serializeAsJSON,
} from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI, ExcalidrawInitialDataState, NormalizedZoomValue } from "@excalidraw/excalidraw/types";
import type { NotesBoardSettings, NotesBoardView } from "@/notes/types";
import "@excalidraw/excalidraw/index.css";
type NormalizedTheme = "light" | "dark";

/**
 * The whiteboard defaults: the vault's tuned style, with the font family and
 * size from the notes settings. They are the starting style of everything
 * drawn from now on; elements already in a scene keep their own style.
 */
function defaultAppState(board: NotesBoardSettings) {
  return {
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
    currentItemFontFamily: board.fontFamily,
    currentItemFontSize: board.fontSize,
    currentItemTextAlign: "left",
  } as const;
}

/** A board file as JSON, or null while it is not one (a half-written file). */
function parseFile(content: string): Partial<ExcalidrawInitialDataState> | null {
  try {
    return (JSON.parse(content) ?? {}) as Partial<ExcalidrawInitialDataState>;
  } catch {
    return null;
  }
}

function parseScene(content: string, board: NotesBoardSettings, view: NotesBoardView | null): ExcalidrawInitialDataState {
  const defaults = defaultAppState(board);
  // The file has no viewport (Excalidraw strips scroll and zoom from a saved
  // scene); the database row is the only place it comes from.
  const viewport = view
    ? { scrollX: view.scrollX, scrollY: view.scrollY, zoom: { value: view.zoom as NormalizedZoomValue } }
    : {};
  const parsed = parseFile(content);
  // A board edited outside the app can be broken; start empty rather than
  // crashing the page, and the next change rewrites it as valid JSON.
  return {
    elements: parsed?.elements ?? [],
    appState: { ...defaults, ...(parsed?.appState ?? {}), ...viewport },
    files: parsed?.files ?? {},
  };
}

/**
 * The Excalidraw half of a board, loaded only in the browser (SSR has no
 * canvas). Kept apart from Whiteboard.tsx so the wrapper stays free of the
 * Excalidraw bundle and can be statically rendered.
 */
type SceneChange = Parameters<NonNullable<ComponentProps<typeof Excalidraw>["onChange"]>>;

function WhiteboardCanvas({
  content,
  view,
  theme,
  board,
  onChange,
  onViewChange,
}: {
  content: string;
  view: NotesBoardView | null;
  theme: NormalizedTheme;
  board: NotesBoardSettings;
  onChange: (scene: string) => void;
  onViewChange: (view: NotesBoardView) => void;
}) {
  // Mounted with one board's content by Whiteboard's key, so the scene is
  // parsed once per open file and per font change.
  const initialData = useMemo(() => parseScene(content, board, view), [content, board, view]);
  const api = useRef<ExcalidrawImperativeAPI | null>(null);
  const takeApi = useCallback((instance: ExcalidrawImperativeAPI) => { api.current = instance; }, []);
  const pixelRatio = useRef(window.devicePixelRatio);
  const shown = useRef(content);
  // Someone else rewrote the file (an agent, "存入笔记"). Swap the elements in
  // place: remounting Excalidraw flashes the canvas and re-measures every text
  // with freshly loaded fonts, which is the jolt you see while it redraws.
  useEffect(() => {
    const scene = api.current;
    if (!scene || content === shown.current) return;
    const parsed = parseFile(content);
    // A file caught mid-write: keep what is on screen, the next write is whole.
    if (!parsed) return;
    shown.current = content;
    scene.updateScene({
      elements: restoreElements(parsed.elements, null, { repairBindings: true }),
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    const files = Object.values(parsed.files ?? {});
    if (files.length) scene.addFiles(files);
  }, [content]);
  // Excalidraw parks its element properties panel over the canvas as soon as
  // something is selected. The board keeps it collapsed until the styles
  // button in the top bar asks for it.
  const [shapesOpen, setShapesOpen] = useState(false);
  const toggleShapes = useCallback(() => setShapesOpen((open) => !open), []);
  const renderShapesTrigger = useCallback((isMobile: boolean) => (isMobile ? null : (
    <button
      type="button"
      className={`sidebar-trigger notes-shapes-trigger${shapesOpen ? " active" : ""}`}
      onClick={toggleShapes}
      aria-pressed={shapesOpen}
    >
      样式
    </button>
  )), [shapesOpen, toggleShapes]);
  // Excalidraw re-runs its onChange effect when the callback's identity
  // changes. A fresh arrow on every render (this component renders whenever
  // the save status changes) would save forever; keep it stable.
  const handleChange = useCallback((...args: SceneChange) => {
    const [elements, appState, files] = args;
    // Excalidraw reports its own restore as a change; saving then would
    // overwrite the file with a half-loaded scene.
    if (appState.isLoading) return;
    // Excalidraw 0.18's bitmap cache ignores DPR changes without a resize
    // (e.g. switching displays). Check on every redraw, not just resize/media
    // events. New identities rebuild caches, preserving geometry and history.
    if (pixelRatio.current !== window.devicePixelRatio) {
      pixelRatio.current = window.devicePixelRatio;
      api.current?.updateScene({
        elements: elements.map((element) => ({ ...element })),
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    }
    onViewChange({ scrollX: appState.scrollX, scrollY: appState.scrollY, zoom: appState.zoom.value });
    onChange(serializeAsJSON(elements, appState, files, "local"));
  }, [onChange, onViewChange]);
  return (
    <div className={`notes-board${shapesOpen ? " is-shapes-open" : ""}`}>
      <Excalidraw
        excalidrawAPI={takeApi}
        initialData={initialData}
        langCode="zh-CN"
        theme={theme}
        autoFocus
        UIOptions={{
          canvasActions: { export: false, loadScene: false, saveAsImage: false, toggleTheme: false },
        }}
        renderTopRightUI={renderShapesTrigger}
        onChange={handleChange}
      />
    </div>
  );
}

// Stable props (content, theme, onChange) keep a status re-render of the
// header from re-rendering the whole canvas.
export default memo(WhiteboardCanvas);
