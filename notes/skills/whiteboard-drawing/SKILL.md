---
name: whiteboard-drawing
description: 用 notes_board 画 Excalidraw 白板：架构图、流程图、时序图、思维导图、对比图。用户要画图、要把方案画出来、做白板时使用。
---

# 画白板

`notes_board` 接收形状列表，工具负责生成合法的 Excalidraw scene。**不要手写 scene JSON。**

## 形状

| type | 用途 | 默认尺寸 |
| --- | --- | --- |
| `rectangle` | 服务、模块、步骤 | 200×100 |
| `diamond` | 判断 | 160×120 |
| `ellipse` | 起点、终点、外部角色 | 160×100 |
| `text` | 标题、注释 | 按内容 |
| `arrow` | 流向，用 `to` 给终点 | — |

`label` 是形状里的字，`\n` 换行。`strokeColor`、`backgroundColor`、`fontSize` 可覆盖默认值，默认描边 `#1b1b1f`、填充透明。

## 排版

- 网格：节点宽 200，横向间距 60，纵向间距 160，从 `x=0, y=0` 开始。
- 一屏放得下 5~7 个节点；再多就分块，用大矩形做分区（填充 `#f8f9fa`）。
- 箭头从右边界中点到左边界中点：`from (x+200, y+50)` → `to (x+260, y+50)`。
- 标题用 `text`，字号比正文大 4~8px，放在内容上方 60px。
- 不要重叠；箭头不要穿过方框。

## 例子

```json
{ "path": "架构/请求链路.excalidraw", "replace": true, "elements": [
  { "type": "text", "x": 0, "y": -60, "label": "请求链路", "fontSize": 28 },
  { "type": "rectangle", "x": 0, "y": 0, "label": "浏览器" },
  { "type": "rectangle", "x": 260, "y": 0, "label": "pi-web\nNext.js 路由" },
  { "type": "rectangle", "x": 520, "y": 0, "label": "harness\npi / claude / dsh" },
  { "type": "arrow", "x": 200, "y": 50, "to": { "x": 260, "y": 50 } },
  { "type": "arrow", "x": 460, "y": 50, "to": { "x": 520, "y": 50 } },
  { "type": "text", "x": 0, "y": 140, "label": "笔记面板走同一条路由，只是 harness 换成 notes agent", "fontSize": 16 }
] }
```

## 边界

- 同一块白板重复画时，`replace: true` 重画，否则会追加到已有内容后面。
- 白板是给人看的：少写句子，多写名词。节点的字超过 12 个字就拆行或换短词。
