# Father's Health 看板数据目录

这个目录是 Dashboard → Health → Father's Health 看板的**唯一数据源**，也是该看板右侧对话的固定工作目录。
在这个目录里启动的 harness 会话，读到这份文件就知道自己在做什么、数据长什么样、该怎么改。

## 这是什么

父亲的个人健康档案看板：体检/化验的关键指标、趋势、用药、随访、影像与原始资料索引。
给家人和本人在浏览器里看，不对外发布。

看板前端与数据校验代码在 `dashboard/boards/father-health/`（`model.ts` 是完整类型定义，`data.ts` 是读取与校验）。
本目录只放数据，不改代码。

## 数据文件

| 路径 | 作用 |
|---|---|
| `health.json` | 全部结构化数据（约 8MB 上限，UTF-8） |
| `attachments/报告/<日期>/*.jpg` | 化验单、报告原件照片 |
| `attachments/用药/*` | 药盒、处方照片 |
| `attachments/就诊录音/*` | 录音转写文本 / PDF |
| `attachments/笔记/…` | 原始笔记、饮食营养笔记等 Markdown/文本 |
| `attachments/历史数据快照/*.json` | 早期迁移留下的原始快照，只作来源，不直接展示 |

## health.json 结构

顶层：`version: 1`、`updatedAt`、`profile`、`metrics`、`reports`、`events`、`medications`、`followUp`、`alerts`、`emergency`、`nutrition`、`findings`、`documents`、`attachments`、`provenance`。

- `metrics[]`：`id`（英文小写，稳定不变）、`label`、`shortLabel`、`unit`、`decimals`、`group`、`core`（是否进 Key Metrics）、`note`
- `reports[]`：一张报告一条 —— `id`、`date`（YYYY-MM-DD，实际采血/检查日）、`hospital`、`sourceId`、`attachmentIds`、`results[]`
- `results[]`：`metricId`（必须存在于 `metrics`）、`value`（数值或定性文本）、`unit`、`min`/`max`、`reference`（原文参考范围写法）、`flag`（`high` | `low` | `normal` | `unclassified`）、`note`
- `medications[]`：`name`、`status`（`confirmed` | `unconfirmed`）、`asOf`、`dose`、`purpose`、`note`、`sourceId`
- `documents[]`：原文全文与分类，`sourcePath` 记录来源文件名
- `attachments[]`：`id`、`title`、`kind`（`report` | `medication` | `transcript` | `document`）、`date`、`path`（相对本目录）、`status`（`available` | `missing`）、`mime`、`sizeBytes`、`sha256`
- `events[]` / `findings[]` / `alerts[]` / `followUp`：只作文字时间线与待核实事项，**不混入正式测点**

## 加数据怎么加

1. 新报告：在 `reports` 加一条（`id` 用 `报告日期+医院缩写`），逐项写入 `results`；`value` 用报告原文数字，`reference` 照抄原文区间，`flag` 按原文高低标判断，拿不准就 `unclassified` 并在 `note` 写原因。
2. 原件照片放 `attachments/报告/<YYYY-MM-DD>/`，在 `attachments` 登记：`path` 用相对路径、`sha256` 用原文件摘要、`sizeBytes` 用字节数、`status: "available"`。
3. 新指标先加到 `metrics`（含单位与小数位），再在 `results` 引用，`id` 一旦定下不改名。
4. 用药变化追加到 `medications` 并更新 `asOf`；只在真正确认后才用 `confirmed`。
5. 改完把 `updatedAt` 改成当前 ISO 时间；返回看板点「↻ 刷新」即可看到，不需要重启服务。

## 硬规则

- **不编造数值、单位、参考范围、日期。** 原文没有的就写空或 `null`，并在 `note` 说明缺失。
- 只有正式报告的结果进 `metrics`/`reports`；口述、估算、聊天记录里的数字只能进 `events`/`documents` 的文字里。
- 日期一律 `YYYY-MM-DD`，不做时区换算；只有年月时不要假装精确到日。
- 单位按原文保留（`μmol/L`、`mL/min`、`mmol/L`、`g/24h` 等），换算要同时写清原值与换算方式。
- 不删除历史记录；错的记录保留并把修正写进 `note`。
- 本目录是隐私数据：不要提交到 Git，不要上传到外部服务，不要在截图或日志里泄露。
- 需要新增字段或改变结构时，先说明改动，再动 `model.ts`。

## 快速自检

```bash
node -e 'const d=require("./data/dashboard/健康/父亲/health.json");const ids=new Set(d.metrics.map(m=>m.id));for(const r of d.reports)for(const x of r.results)if(!ids.has(x.metricId))throw new Error("unknown metric "+x.metricId);console.log("ok",d.reports.length,"reports")'
node --experimental-strip-types --test dashboard/boards/father-health/tests/health.test.mjs
```

## 常见请求对应做法

- 「最近一次肌酐多少、比上次变化」→ 读 `reports` 里该 `metricId` 的最后两个测点，直接回答，不改文件。
- 「把 8 月 25 日那张报告补进来」→ 加 `reports` + `results` + 附件登记，改 `updatedAt`。
- 「药换了」→ 追加 `medications`，更新 `asOf` 与 `note`。
- 「这段笔记归一下档」→ 放进 `attachments/笔记/` 并在 `documents` 登记，不改结构化指标。
