---
name: whiteboard-drawing
description: 用 notes_board 工具的规则：形状字段、坐标、追加和重画。画架构图、流程图、概念图之前用，风格按 whiteboard-style 执行。
---

# 画白板：工具规则

`notes_board` 接收形状列表，工具生成合法的 Excalidraw scene。**不要手写 scene JSON。**

改已有的白板之前，先用 `notes_board` `action: "read"` 读它现在的元素（每行一个：类型、坐标、尺寸、文字）。用户可能自己手改过，以读到的为准。

风格（几个节点、多大字、怎么留白）不在这里，先读 `whiteboard-style`。

## 形状

| type | 用途 | 默认尺寸 |
| --- | --- | --- |
| `ellipse` | 概念、角色、外部系统 | 160×100 |
| `rectangle` | 容器、模块、界面 | 200×100 |
| `diamond` | 判断 | 160×120 |
| `text` | 说明、标签、旁注 | 按内容 |
| `arrow` | 有方向的流向，用 `to` 给终点 | — |
| `line` | 分隔线、无方向的连接，用 `to` 给终点 | — |

`label` 是形状里的字，`\n` 换行。`fontSize` 显式给（节点 16~18，说明和旁注 13~14）。描边默认 `#1b1b1f`、细实线、无填充；不要给 `backgroundColor`，除非确实要分区底色。

## 坐标

- 场景坐标，从 `x=0, y=0` 起；说明文字可以放在负 y。
- 节点间距 ≥160；长箭头 120~240，横平竖直。
- 箭头从边界到边界：`{ "type": "arrow", "x": 240, "y": 50, "to": { "x": 400, "y": 50 } }`。
- 容器分格：先画 `rectangle`，再用 `line` 横切或竖切，最后把 `text` 放在格子里。
- 不要重叠；箭头不要穿过方框。

## 例子

```json
{ "path": "架构/请求链路.excalidraw", "replace": true, "elements": [
  { "type": "ellipse", "x": 0, "y": 0, "label": "浏览器", "fontSize": 16 },
  { "type": "rectangle", "x": 280, "y": 0, "label": "pi-web\nNext.js 路由", "fontSize": 16 },
  { "type": "rectangle", "x": 560, "y": 0, "label": "harness\npi / claude / dsh", "fontSize": 16 },
  { "type": "text", "x": 300, "y": -30, "label": "POST", "fontSize": 14 },
  { "type": "arrow", "x": 160, "y": 50, "to": { "x": 280, "y": 50 } },
  { "type": "arrow", "x": 480, "y": 50, "to": { "x": 560, "y": 50 } },
  { "type": "text", "x": 0, "y": 150, "label": "笔记面板走同一条路由，只是 harness 换成 notes agent", "fontSize": 14 }
] }
```

## 边界

- 同一块白板重复画时，`replace: true` 重画，否则会追加到已有内容后面。
- 改已有的白板：先 `action: "read"`，再把整张图（包括要保留的旧元素）一次 `replace: true` 重画。只补一部分就追加，不要半张图换一半。
- 大段文字也画在白板上：用 `text`，每行 20~26 个汉字自己用 `\n` 换行，一段一个 text，别拉成一根长条。
