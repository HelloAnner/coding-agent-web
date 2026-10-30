# 任务看板 数据目录

这是 Dashboard → Fine → 任务看板 右侧对话的固定工作目录，也是这个看板放导出快照和工作笔记的地方。
在这个目录里启动的 harness 会话，读到这份文件就知道数据从哪来、能改什么、不能改什么。

## 这是什么

个人在 Meegle 上的「进行中待办」任务看板：跨空间汇总当前负责人是自己的任务，支持搜索、状态/分类筛选、排序和详情。
看板代码在 `dashboard/boards/fine-tasks/`。

## 数据从哪来

```
Meegle CLI ──每 10 分钟──> data.db(fine_tasks / fine_task_sync) ──> 页面 GET 只读
```

- 数据库文件：`CODING_AGENT_WEB_DATA` 或 `~/.coding-agent-web/data.db`（**不在本目录**）。
- 同步由服务进程定时执行；打开页面和点刷新都不会去查 Meegle。
- 只读个人进行中待办（`in_progress`），按项目 + 任务 ID 去重，服务端从不修改 Meegle。

## 本目录放什么

| 内容 | 说明 |
|---|---|
| 导出快照 | 从数据库或 Meegle 导出的 JSON/CSV，文件名带日期，例如 `export-2026-10-01.json` |
| 工作笔记 | 任务拆解、周报草稿、复盘等 Markdown |
| 分析结论 | 对任务分布、卡点、在手时长的统计结论 |

## 硬规则

- **不要直接写 `~/.coding-agent-web/data.db`。** 那是同步产物，下一次同步会覆盖；要加任务请去 Meegle，要加分析请放本目录。
- 不要手工编辑 Meegle 上的数据来让看板好看 —— 看板以真实待办为准。
- 导出的快照是**当时**的状态，不自动更新；引用时写清导出时间。
- 本目录的笔记可以自由增删；不含真实项目机密时才可以提交 Git（默认被 .gitignore 忽略）。
- 需要看板展示新字段时，先说明改动，再动 `dashboard/boards/fine-tasks/` 的类型与同步代码。

## 常见请求对应做法

- 「我现在手上有哪些任务、哪些卡住了」→ 读数据库或最近的导出，按状态/在途时间回答。
- 「帮我排一下今天的优先级」→ 基于当前待办给顺序，不改数据。
- 「导出今天的任务清单」→ 在这里写 `export-<日期>.json`，注明导出时间与来源。
- 「加一条任务」→ 说明要去 Meegle 建卡；本目录不代建。

## 检查

```bash
node --experimental-strip-types --test dashboard/boards/fine-tasks/tests/task-board-ui.test.mjs
node --experimental-strip-types --test dashboard/boards/fine-tasks/tests/db.test.mjs
```
