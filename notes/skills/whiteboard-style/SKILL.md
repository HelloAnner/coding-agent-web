---
name: whiteboard-style
description: 白板要画成什么样子：稀疏、抽象、留白、手绘感的草图，而不是花里胡哨的框图清单。画架构图、流程图、概念图、对比图之前先读这个。
---

# 白板风格

一句话：**少、准、留白**。画的不是功能清单，是一张能讲清核心关系的草图。

判断标准不是「信息全不全」，而是「别人看 20 秒能不能说出这张图在讲什么」。

## 硬约束

- **3~8 个节点**。放不下就不画，改成一句旁注写旁边。
- 节点里只写**名词**（2~7 个字），不写句子、不写说明。
- 每条关系只配**一句短语**（≤12 字），写在箭头上方。
- **不用颜色、不用图标、不用填充、不用阴影、不嵌套边框**。黑白细线就是这个风格的全部。
- **大片留白**：节点间距 ≥160，整张图占画布一半以内。空白是排版的一部分，不是浪费。
- 不要标题大横幅，不要图例，不要边框围住整张图。

## 形状的语义（不要混用）

| 形状 | 只用来表示 | 例子 |
| --- | --- | --- |
| `ellipse` | 概念、角色、外部系统 | `global config`、`kms/飞书文档`、`自动化` |
| `rectangle` | 容器、模块、界面；要分格就加 `line` 分隔 | `coding`（三格）、`notes`（两列） |
| `arrow` | 唯一表示流向 / 因果 / 调用的形状 | `pi + notes skill` |
| `line` | 分隔线、没有方向的连接 | rectangle 内部的分格线 |
| `text` | 形状上方的说明、箭头标签、孤立旁注 | `保存到全局的配置文件` |

终点是**一句人话**时不要套框：直接从概念拉一条 `arrow` 指向 `text`。

## 尺寸（场景坐标，px）

| 东西 | 值 |
| --- | --- |
| ellipse 概念 | 160×90，label 居中，16~18px |
| rectangle 容器 | 220×(90~200)，label 16~18px |
| 形状上方的说明 | 13~14px，落在形状上方 24~36px |
| 箭头 / 连线长度 | 120~240，横平竖直，倾斜 ≤15° |
| 节点间距 | ≥160（横向）、≥140（纵向） |
| 旁注 | 13~14px，行距 1.6，放在图的空白区 |

字少的图上 `fontSize` 显式给：节点 16~18，说明和旁注 13~14。不要用 20 以上，除非只有两三个词。

## 画法顺序

1. 先定 **2~3 个主角**，横排或竖排，间距 240。主角是「谁和谁有关系」，不是每一步操作。
2. 只连主角之间的关系，箭头标签一句话（`automatic`、`指导代码生成`）。
3. 需要解释的地方，从概念拉一条 arrow 或 line 到一句 `text`，**不要再画一个框**。
4. 补 2~4 条旁注：为什么这样、边界在哪、结论是什么。旁注写人话，不写术语。
5. 自检：**删掉任意一个节点，图还讲得通吗？** 讲得通就删掉它。

细节、异常分支、字段名都不进白板，那是笔记的事。

## 例子

需求：画 coding 和 notes 的关系。

```json
{ "path": "架构/notes 与 coding.excalidraw", "replace": true, "elements": [
  { "type": "text", "x": 40, "y": -46, "label": "保存到全局的配置文件", "fontSize": 14 },
  { "type": "ellipse", "x": 40, "y": 0, "width": 160, "height": 90, "label": "global config", "fontSize": 16 },
  { "type": "arrow", "x": 200, "y": 30, "to": { "x": 320, "y": 14 } },
  { "type": "text", "x": 330, "y": 6, "label": "HOME", "fontSize": 14 },
  { "type": "arrow", "x": 200, "y": 56, "to": { "x": 320, "y": 70 } },
  { "type": "text", "x": 330, "y": 62, "label": "harness 偏好 选择", "fontSize": 14 },

  { "type": "rectangle", "x": 40, "y": 260, "width": 220, "height": 180 },
  { "type": "line", "x": 40, "y": 320, "to": { "x": 260, "y": 320 } },
  { "type": "line", "x": 40, "y": 380, "to": { "x": 260, "y": 380 } },
  { "type": "text", "x": 60, "y": 274, "label": "coding", "fontSize": 16 },
  { "type": "text", "x": 60, "y": 334, "label": "harness 1", "fontSize": 16 },
  { "type": "text", "x": 60, "y": 394, "label": "harness 2", "fontSize": 16 },

  { "type": "text", "x": 420, "y": 296, "label": "automatic", "fontSize": 14 },
  { "type": "arrow", "x": 280, "y": 330, "to": { "x": 560, "y": 330 } },
  { "type": "text", "x": 420, "y": 340, "label": "pi + notes skill", "fontSize": 14 },

  { "type": "rectangle", "x": 560, "y": 260, "width": 240, "height": 180 },
  { "type": "line", "x": 620, "y": 260, "to": { "x": 620, "y": 440 } },
  { "type": "text", "x": 576, "y": 274, "label": "notes", "fontSize": 16 },
  { "type": "text", "x": 636, "y": 274, "label": "chat area", "fontSize": 16 },
  { "type": "text", "x": 636, "y": 320, "label": "设计架构", "fontSize": 14 },

  { "type": "arrow", "x": 560, "y": 452, "to": { "x": 280, "y": 452 } },
  { "type": "text", "x": 400, "y": 462, "label": "指导代码生成", "fontSize": 14 },

  { "type": "text", "x": 40, "y": 480, "label": "manual coding，人控制方向和产物", "fontSize": 14 },
  { "type": "text", "x": 700, "y": 480, "label": "just create and manage the folder and notes", "fontSize": 14 },

  { "type": "text", "x": 900, "y": 260, "label": "自动化", "fontSize": 16 },
  { "type": "arrow", "x": 970, "y": 268, "to": { "x": 1120, "y": 236 } },
  { "type": "text", "x": 1130, "y": 226, "label": "采集对话里的思路，转成架构文档", "fontSize": 14 },
  { "type": "arrow", "x": 970, "y": 276, "to": { "x": 1120, "y": 300 } },
  { "type": "text", "x": 1130, "y": 292, "label": "把代码 diff 转成架构图", "fontSize": 14 },

  { "type": "text", "x": 900, "y": 420, "label": "1. 笔记不是越多越好，是删减和讲清楚", "fontSize": 14 },
  { "type": "text", "x": 900, "y": 452, "label": "2. 白板不是信息越多越好，是抽象和形象", "fontSize": 14 },
  { "type": "text", "x": 900, "y": 484, "label": "3. 风格越简单越好，不要花里胡哨", "fontSize": 14 }
] }
```

画面大概是这样（不要照着排版，照这个密度）：

```
保存到全局的配置文件
   (global config) --> HOME
                  --> harness 偏好 选择

                    (kms/飞书文档)
                          ^
                          |  做好发布和更新体系。
                          |  全部笔记都要发布出去。

+---------+  automatic               +------------+
| coding  | -----------------------> | notes      | chat area
+---------+  pi + notes skill        |            | 设计架构
| harness 1| <----------------------- +------------+
+---------+     指导代码生成
| harness 2|
+---------+

自动化 --> 采集对话里的思路，转成架构文档
       --> 把代码 diff 转成架构图
```

## 字体

字体来自笔记设置（设置 → 白板）。想要截图那种手写感，字体选 `Excalifont`（或 `Virgil`）；默认 `Cascadia` 等宽也成立，前提是**字少**。
