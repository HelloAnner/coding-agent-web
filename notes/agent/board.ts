import type { NotesBoardSettings } from "../types";

/**
 * A whiteboard's scene, built from a shape list instead of hand-written
 * Excalidraw JSON: the agent names boxes, arrows and text, this module fills in
 * the element fields Excalidraw needs (ids, seeds, bindings, version fields).
 *
 * Coordinates are scene coordinates; 20px grid steps keep a generated board
 * tidy without any layout engine.
 */

export type BoardShapeType = "rectangle" | "ellipse" | "diamond" | "text" | "arrow" | "line";

export interface BoardShape {
  type: BoardShapeType;
  x: number;
  y: number;
  width?: number;
  height?: number;
  /** Text inside a shape, or the text of a `text` shape. */
  label?: string;
  /** The arrow's or line's end point, in scene coordinates. */
  to?: { x: number; y: number };
  strokeColor?: string;
  backgroundColor?: string;
  fontSize?: number;
}

// 主体/中性的语义色对：没显式给颜色的形状也落在色板的基调上，
// 不会出现一块纯白框（见 notes/skills/whiteboard-style/references/color-palette.md）。
const STROKE = "#263d8f";
const FILL = "#e8ecf7";
// 字压在浅色填充上：用色板里的 on-light 文字色，不用描边色。
const TEXT = "#2d302e";
const LINE_HEIGHT = 1.25;
const DEFAULT_SIZE: Partial<Record<BoardShapeType, { width: number; height: number }>> = {
  rectangle: { width: 200, height: 100 },
  ellipse: { width: 160, height: 100 },
  diamond: { width: 160, height: 120 },
};

function randomId(): string {
  return Math.random().toString(36).slice(2, 12) || "element";
}

function randomInt(): number {
  return Math.floor(Math.random() * 2 ** 31);
}

function textWidth(text: string, fontSize: number): number {
  let width = 0;
  for (const char of text) width += char.codePointAt(0)! > 0x2e80 ? fontSize : fontSize * 0.6;
  return Math.max(fontSize, Math.round(width));
}

function labelSize(label: string, fontSize: number): { width: number; height: number } {
  const lines = label.split("\n");
  return {
    width: Math.max(...lines.map((line) => textWidth(line, fontSize))),
    height: Math.round(lines.length * fontSize * LINE_HEIGHT),
  };
}

function baseElement(type: string, x: number, y: number, width: number, height: number) {
  return {
    id: randomId(),
    type,
    x,
    y,
    width,
    height,
    angle: 0,
    strokeColor: STROKE,
    backgroundColor: FILL,
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    groupIds: [] as string[],
    frameId: null,
    roundness: { type: 3 },
    seed: randomInt(),
    version: 1,
    versionNonce: randomInt(),
    isDeleted: false,
    boundElements: [] as { type: string; id: string }[],
    updated: 1,
    link: null,
    locked: false,
  };
}

function textElement(
  x: number,
  y: number,
  width: number,
  height: number,
  label: string,
  fontSize: number,
  board: NotesBoardSettings,
  containerId: string | null,
) {
  return {
    ...baseElement("text", x, y, width, height),
    strokeColor: TEXT,
    backgroundColor: "transparent",
    roundness: null,
    text: label,
    originalText: label,
    fontSize,
    fontFamily: board.fontFamily,
    textAlign: "left" as const,
    verticalAlign: "middle" as const,
    lineHeight: LINE_HEIGHT,
    containerId,
    autoResize: containerId === null,
  };
}

function shapeElement(shape: BoardShape, board: NotesBoardSettings) {
  const fontSize = shape.fontSize ?? board.fontSize;
  const fallback = DEFAULT_SIZE[shape.type] ?? { width: 120, height: 40 };
  const width = Math.max(1, Math.round(shape.width ?? fallback.width));
  const height = Math.max(1, Math.round(shape.height ?? fallback.height));
  const x = Math.round(shape.x);
  const y = Math.round(shape.y);
  const label = shape.label?.trim();

  if (shape.type === "text") {
    const size = label ? labelSize(label, fontSize) : { width, height };
    return [textElement(x, y, size.width, size.height, label ?? "", fontSize, board, null)];
  }

  if (shape.type === "arrow" || shape.type === "line") {
    const dx = Math.round((shape.to?.x ?? x + width) - x);
    const dy = Math.round((shape.to?.y ?? y) - y);
    // A line is the same element without heads: dividers inside a container,
    // and relations that have no direction.
    return [{
      ...baseElement(shape.type, x, y, Math.abs(dx), Math.abs(dy)),
      points: [[0, 0], [dx, dy]],
      lastCommittedPoint: null,
      startBinding: null,
      endBinding: null,
      startArrowhead: null,
      endArrowhead: shape.type === "arrow" ? "arrow" : null,
      elbowed: false,
      roundness: { type: 2 },
      strokeColor: shape.strokeColor ?? STROKE,
    }];
  }

  const box = {
    ...baseElement(shape.type, x, y, width, height),
    backgroundColor: shape.backgroundColor ?? FILL,
    ...(shape.strokeColor ? { strokeColor: shape.strokeColor } : {}),
  };
  if (!label) return [box];
  // A shape's label is a separate text element bound to it, which is how
  // Excalidraw keeps the text centered when the box moves or resizes.
  const size = labelSize(label, fontSize);
  const text = textElement(
    x + (width - size.width) / 2,
    y + (height - size.height) / 2,
    size.width,
    size.height,
    label,
    fontSize,
    board,
    box.id,
  );
  box.boundElements = [{ type: "text", id: text.id }];
  return [box, text];
}

/** Read the elements of a stored scene, tolerating a broken or empty file. */
export function readSceneElements(content: string | null): unknown[] {
  if (!content) return [];
  try {
    const parsed = JSON.parse(content) as { elements?: unknown };
    return Array.isArray(parsed?.elements) ? parsed.elements : [];
  } catch {
    return [];
  }
}

interface SceneElement {
  id?: unknown;
  type?: unknown;
  x?: unknown;
  y?: unknown;
  width?: unknown;
  height?: unknown;
  text?: unknown;
  fontSize?: unknown;
  containerId?: unknown;
  points?: unknown;
}

function numberAt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 0;
}

function oneLine(text: string): string {
  return text.trim().split("\n").map((line) => line.trim()).filter(Boolean).join(" / ");
}

/**
 * A stored board as one line per element: what it is, where it sits, what it
 * says. Text bound to a shape shows up as that shape's label, and coordinates
 * are exact so an edited board can be redrawn without moving anything. Raw
 * scene JSON is mostly ids and bindings; the agent needs the layout, not those.
 */
export function describeScene(content: string | null): string[] {
  const elements = readSceneElements(content) as SceneElement[];
  const bound = new Map<string, SceneElement>();
  for (const element of elements) {
    if (typeof element.containerId === "string") bound.set(element.containerId, element);
  }
  const lines: string[] = [];
  for (const element of elements) {
    if (typeof element.containerId === "string") continue;
    const type = typeof element.type === "string" ? element.type : "element";
    const x = numberAt(element.x);
    const y = numberAt(element.y);
    if (type === "arrow" || type === "line") {
      const points = Array.isArray(element.points) ? element.points as unknown[] : [];
      const last = Array.isArray(points[points.length - 1]) ? points[points.length - 1] as unknown[] : [0, 0];
      const to = `${x + numberAt(last[0])},${y + numberAt(last[1])}`;
      const own = typeof element.text === "string" ? oneLine(element.text) : "";
      lines.push(`- ${type} ${x},${y} -> ${to}${own ? `「${own}」` : ""}`);
      continue;
    }
    const size = `${numberAt(element.width)}x${numberAt(element.height)}`;
    const ownText = typeof element.text === "string" ? oneLine(element.text) : "";
    const boundId = typeof element.id === "string" ? element.id : "";
    const boundElement = boundId ? bound.get(boundId) : undefined;
    const boundText = typeof boundElement?.text === "string" ? oneLine(boundElement.text) : "";
    const text = ownText || boundText;
    const label = text ? `「${text}」` : "";
    lines.push(`- ${type} ${x},${y} ${size}${label}`);
  }
  return lines;
}

/**
 * The scene JSON to write: the shapes, appended to what the board already has
 * (or replacing it), with the vault's whiteboard style as the app state.
 */
export function buildBoardScene(
  shapes: readonly BoardShape[],
  board: NotesBoardSettings,
  options: { existing?: string | null; replace?: boolean } = {},
): string {
  const kept = options.replace ? [] : readSceneElements(options.existing ?? null);
  const created = shapes.flatMap((shape) => shapeElement(shape, board));
  return JSON.stringify({
    type: "excalidraw",
    version: 2,
    source: "coding-agent-web",
    elements: [...kept, ...created],
    appState: {
      viewBackgroundColor: "#ffffff",
      currentItemStrokeColor: STROKE,
      currentItemBackgroundColor: FILL,
      currentItemStrokeWidth: 2,
      currentItemStrokeStyle: "solid",
      currentItemRoughness: 0,
      currentItemRoundness: "round",
      currentItemArrowType: "round",
      currentItemFontFamily: board.fontFamily,
      currentItemFontSize: board.fontSize,
      currentItemTextAlign: "left",
    },
    files: {},
  }, null, 2);
}
