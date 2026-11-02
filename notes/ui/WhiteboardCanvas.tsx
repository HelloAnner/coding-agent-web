"use client";

import { memo, useCallback, useEffect, useRef, useState, type ComponentProps } from "react";
import {
  CaptureUpdateAction,
  Excalidraw,
  exportToBlob,
  restoreElements,
  serializeAsJSON,
} from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI, ExcalidrawInitialDataState, NormalizedZoomValue } from "@excalidraw/excalidraw/types";
import type { NotesBoardSettings, NotesBoardView } from "@/notes/types";
import { boardAppState, boardSettingsFromAppState } from "@/notes/board-style";
import { useIsMobile } from "@/hooks/useIsMobile";
import "@excalidraw/excalidraw/index.css";
type NormalizedTheme = "light" | "dark";

/** A board file as JSON, or null while it is not one (a half-written file). */
function parseFile(content: string): Partial<ExcalidrawInitialDataState> | null {
  try {
    return (JSON.parse(content) ?? {}) as Partial<ExcalidrawInitialDataState>;
  } catch {
    return null;
  }
}

function parseScene(content: string, board: NotesBoardSettings, view: NotesBoardView | null, isMobile: boolean): ExcalidrawInitialDataState {
  const defaults = boardAppState(board);
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
    // Drawing preferences are global; old scene defaults must not override them.
    appState: { viewBackgroundColor: "#ffffff", ...(parsed?.appState ?? {}), ...defaults, ...viewport, viewModeEnabled: isMobile },
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
  name,
  onChange,
  onViewChange,
  onBoardChange,
}: {
  content: string;
  view: NotesBoardView | null;
  theme: NormalizedTheme;
  board: NotesBoardSettings;
  name: string;
  onChange: (scene: string) => void;
  onViewChange: (view: NotesBoardView) => void;
  onBoardChange: (board: NotesBoardSettings) => void;
}) {
  // Global preference updates change drawing defaults, never remount the scene.
  const isMobile = useIsMobile();
  const [viewMode, setViewMode] = useState(isMobile);
  const [initialData] = useState(() => parseScene(content, board, view, isMobile));
  const api = useRef<ExcalidrawImperativeAPI | null>(null);
  const takeApi = useCallback((instance: ExcalidrawImperativeAPI) => { api.current = instance; }, []);
  const lastStyle = useRef(JSON.stringify(boardAppState(board)));
  useEffect(() => {
    const appState = boardAppState(board);
    lastStyle.current = JSON.stringify(appState);
    api.current?.updateScene({ appState, captureUpdate: CaptureUpdateAction.NEVER });
  }, [board]);
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
  const boardRef = useRef<HTMLDivElement>(null);
  const [shapesOpen, setShapesOpen] = useState(false);
  const toggleShapes = useCallback(() => {
    // Under 730px wide Excalidraw drops the desktop island and moves the panel
    // into its bottom-bar menu — which the Coding app's right panel always is.
    // There the button drives that menu instead of the CSS class.
    if (!boardRef.current?.querySelector(".layer-ui__wrapper")) {
      const open = api.current?.getAppState().openMenu !== "shape";
      api.current?.updateScene({
        appState: { openMenu: open ? "shape" : null },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
      setShapesOpen(open);
      return;
    }
    setShapesOpen((open) => !open);
  }, []);
  // Keyed off the device, not Excalidraw's container width: a narrow desktop
  // panel still needs the button, only a phone gets the bottom-bar menu.
  const renderShapesTrigger = useCallback(() => (isMobile ? null : (
    <button
      type="button"
      className={`notes-shapes-trigger${shapesOpen ? " active" : ""}`}
      onClick={toggleShapes}
      aria-pressed={shapesOpen}
    >
      样式
    </button>
  )), [isMobile, shapesOpen, toggleShapes]);
  // Excalidraw re-runs its onChange effect when the callback's identity
  // changes. A fresh arrow on every render (this component renders whenever
  // the save status changes) would save forever; keep it stable.
  const handleChange = useCallback((...args: SceneChange) => {
    const [elements, appState, files] = args;
    // Excalidraw reports its own restore as a change; saving then would
    // overwrite the file with a half-loaded scene.
    if (appState.isLoading) return;
    setViewMode(appState.viewModeEnabled);
    const next = boardSettingsFromAppState(appState);
    const style = JSON.stringify(boardAppState(next));
    if (style !== lastStyle.current) {
      lastStyle.current = style;
      onBoardChange(next);
    }
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
  }, [onChange, onViewChange, onBoardChange]);
  // Right-click -> 导出图片: the whole scene as a PNG named after the board.
  // The export dialog does the same, but a board is usually exported to paste
  // somewhere, and that is one click and a dialog too many.
  const downloadImage = useCallback(async () => {
    const scene = api.current;
    if (!scene) return;
    const appState = scene.getAppState();
    const elements = scene.getSceneElements();
    const files = scene.getFiles();
    // The menu is Excalidraw's, and it closes on an outside pointerdown: send
    // one so the download does not leave the menu hanging under the cursor.
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    const blob = await exportToBlob({
      elements,
      appState: { ...appState, exportBackground: true, exportWithDarkMode: appState.theme === "dark" },
      files,
      exportPadding: 16,
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${name}.png`;
    document.body.append(link);
    link.click();
    link.remove();
    // Revoking right away kills the download in Safari/Firefox.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [name]);
  // Excalidraw builds its context menu from a fixed action list and has no prop
  // for extra entries, so the item is appended to the rendered menu.
  useEffect(() => {
    const root = boardRef.current;
    if (!root) return;
    const addExportItem = () => {
      const menu = root.querySelector<HTMLElement>(".context-menu");
      if (!menu || menu.querySelector('[data-testid="board-export-image"]')) return;
      const item = document.createElement("li");
      item.dataset.testid = "board-export-image";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "context-menu-item";
      const label = document.createElement("div");
      label.className = "context-menu-item__label";
      label.textContent = "导出图片";
      button.append(label);
      button.addEventListener("click", () => void downloadImage());
      item.append(button);
      menu.append(item);
    };
    const observer = new MutationObserver(addExportItem);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [downloadImage]);
  return (
    <div ref={boardRef} className={`notes-board${shapesOpen ? " is-shapes-open" : ""}`}>
      {/* Excalidraw hides renderTopRightUI in mobile view mode. Keep the way
          back to editing outside its toolbar so it is always reachable. */}
      {isMobile && (
        <button
          type="button"
          className="notes-mode notes-board-mode"
          onClick={() => api.current?.updateScene({
            appState: { viewModeEnabled: !api.current.getAppState().viewModeEnabled },
            captureUpdate: CaptureUpdateAction.NEVER,
          })}
          title={viewMode ? "切换到编辑模式" : "切换到查看模式"}
        >
          {viewMode ? "编辑" : "查看"}
        </button>
      )}
      <Excalidraw
        excalidrawAPI={takeApi}
        initialData={initialData}
        langCode="zh-CN"
        theme={theme}
        autoFocus={!isMobile}
        UIOptions={{
          // Save-as-image stays on: a scene lives only in this app, and that
          // dialog is the one way to get a PNG/SVG out of it. The rest of the
          // canvas menu (JSON export, load scene, theme) stays hidden.
          canvasActions: { export: false, loadScene: false, saveAsImage: true, toggleTheme: false },
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
