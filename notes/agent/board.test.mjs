import assert from "node:assert/strict";
import { test } from "node:test";

const { buildBoardScene, describeScene, readSceneElements } = await import("./board.ts");

const board = { fontFamily: 3, fontSize: 20 };

test("a labeled box becomes a shape with a bound text element", () => {
  const scene = JSON.parse(buildBoardScene([{ type: "rectangle", x: 0, y: 0, label: "浏览器" }], board));
  assert.equal(scene.type, "excalidraw");
  assert.equal(scene.elements.length, 2);
  const [shape, text] = scene.elements;
  assert.equal(shape.type, "rectangle");
  assert.equal(shape.width, 200);
  assert.equal(shape.boundElements.length, 1);
  assert.equal(shape.boundElements[0].id, text.id);
  assert.equal(text.containerId, shape.id);
  assert.equal(text.text, "浏览器");
  assert.equal(text.fontFamily, 3);
  assert.equal(text.fontSize, 20);
  // Every element carries the fields Excalidraw needs to restore it.
  for (const element of scene.elements) {
    for (const key of ["id", "seed", "version", "versionNonce", "updated", "strokeColor"]) {
      assert.ok(element[key] !== undefined, `${element.type} is missing ${key}`);
    }
  }
});

test("arrows keep their own point list and end at `to`", () => {
  const scene = JSON.parse(buildBoardScene([
    { type: "arrow", x: 200, y: 50, to: { x: 260, y: 50 } },
  ], board));
  const [arrow] = scene.elements;
  assert.equal(arrow.type, "arrow");
  assert.equal(arrow.endArrowhead, "arrow");
  assert.deepEqual(arrow.points, [[0, 0], [60, 0]]);
});

test("a line is a connector without arrowheads", () => {
  const scene = JSON.parse(buildBoardScene([{ type: "line", x: 40, y: 220, to: { x: 280, y: 220 } }], board));
  const [line] = scene.elements;
  assert.equal(line.type, "line");
  assert.equal(line.endArrowhead, null);
  assert.equal(line.startArrowhead, null);
  assert.deepEqual(line.points, [[0, 0], [240, 0]]);
});

test("drawing again appends, replace clears, and broken JSON does not throw", () => {
  const first = buildBoardScene([{ type: "text", x: 0, y: 0, label: "标题" }], board);
  const appended = buildBoardScene([{ type: "text", x: 0, y: 100, label: "副标题" }], board, { existing: first });
  assert.equal(readSceneElements(appended).length, 2);
  const replaced = buildBoardScene([{ type: "text", x: 0, y: 0, label: "只有一个" }], board, { existing: first, replace: true });
  assert.equal(readSceneElements(replaced).length, 1);
  const recovered = buildBoardScene([{ type: "text", x: 0, y: 0, label: "还能画" }], board, { existing: "{ broken" });
  assert.equal(readSceneElements(recovered).length, 1);
});

test("appending and redrawing preserve images and their file data", () => {
  const image = {
    id: "user-image", type: "image", fileId: "image-file",
    x: 120.5, y: -40.25, width: 320, height: 180,
    angle: 0.2, scale: [-1, 1], version: 7, isDeleted: false,
  };
  const deletedImage = { ...image, id: "deleted-image", isDeleted: true };
  const files = {
    "image-file": {
      id: "image-file", mimeType: "image/png", created: 1,
      dataURL: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=",
    },
  };
  const old = JSON.parse(buildBoardScene([{ type: "text", x: 0, y: 0, label: "旧文字" }], board));
  const existing = JSON.stringify({ ...old, elements: [...old.elements, image, deletedImage], files });

  for (const replace of [false, true]) {
    let content = buildBoardScene([{ type: "text", x: 0, y: 200, label: "新文字" }], board, { existing, replace });
    for (let pass = 0; pass < 2; pass++) {
      const scene = JSON.parse(content);
      assert.deepEqual(scene.files, files, `replace=${replace}: image bytes must survive`);
      assert.deepEqual(scene.elements.filter((element) => element.type === "image"), [image, deletedImage]);
      assert.equal(scene.elements.some((element) => element.text === "旧文字"), !replace);
      content = buildBoardScene([], board, { existing: content, replace });
    }
  }
});

test("a text shape is sized from its content", () => {
  const scene = JSON.parse(buildBoardScene([{ type: "text", x: 0, y: 0, label: "第一行\n第二行" }], board));
  const [text] = scene.elements;
  assert.equal(text.containerId, null);
  assert.equal(text.autoResize, true);
  assert.ok(text.height >= 20 * 1.25 * 2);
  assert.ok(text.width > text.height);
});

test("a board reads back as one line per element, labels from their shapes", () => {
  const scene = buildBoardScene([
    { type: "rectangle", x: 0, y: 0, width: 200, height: 100, label: "浏览器" },
    { type: "text", x: 0, y: -40, label: "先渲染\n再对齐" },
    { type: "arrow", x: 200, y: 50, to: { x: 400, y: 50 } },
    { type: "ellipse", x: 400, y: 0, label: "后端" },
  ], board);
  assert.deepEqual(describeScene(scene), [
    "- rectangle 0,0 200x100「浏览器」",
    "- text 0,-40 60x50「先渲染 / 再对齐」",
    "- arrow 200,50 -> 400,50",
    "- ellipse 400,0 160x100「后端」",
  ]);
  assert.deepEqual(describeScene(null), []);
  assert.deepEqual(describeScene("{ broken"), []);
});
