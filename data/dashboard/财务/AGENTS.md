# 收入支出分析 看板数据目录

这个目录是 Dashboard → 财务 → 收入支出分析看板的**唯一数据源**，也是该看板右侧对话的固定工作目录。
在这个目录里启动的 harness 会话，读到这份文件就知道数据格式、加数据的规则和边界。

## 这是什么

个人/家庭收支分析看板：按月汇总收入、支出、结余、储蓄率，看趋势、分类占比和明细账。
看板前端与数据校验代码在 `dashboard/boards/income-expenses/`（`model.ts` 是类型定义，`data.ts` 是读取与校验）。
本目录只放 JSON 数据，不改代码。

## 数据文件

- 本目录下**所有** `.json` 文件会被一起读取并合并（不递归子目录，不读软链接）。
- 文件名不限，建议一个月一个文件：`2026-10.json`。
- 目前纳入版本控制的只有 `示例-2026-08.json`、`示例-2026-09.json`、`示例-2026-10.json`，它们是**虚构数据**，正式使用前删除。
- 其他 JSON 默认被 .gitignore 保护，不会进 Git。

## 文件格式

```json
{
  "currency": "CNY",
  "sample": false,
  "transactions": [
    {
      "id": "2026-10-001",
      "date": "2026-10-01",
      "type": "income",
      "amountCents": 12345,
      "description": "项目回款",
      "counterparty": "客户名称",
      "category": "项目收入",
      "account": "银行账户"
    }
  ]
}
```

## 加数据怎么加

1. 确定账期月份，打开或新建该月的 `<YYYY-MM>.json`（新建时 `currency` 必须是 `"CNY"`，`sample` 写 `false`）。
2. 在 `transactions` 末尾追加记录，字段全填：
   - `id`：`<YYYY-MM>-<三位序号>`，**跨所有文件唯一**（重复会报错，防止重复计账）
   - `date`：`YYYY-MM-DD`，2000–2099 之间的真实日期，不做时区偏移
   - `type`：`income` 或 `expense`
   - `amountCents`：**整数分**，`12345` = 123.45 元，必须大于 0
   - `description`、`counterparty`、`category`、`account`：非空字符串
3. 保存后返回看板点「刷新」即可看到，不需要重启服务。
4. 明细里已有相似记录时先看是否是同一笔，避免重复。

## 硬规则

- 只接受人民币。不做币种换算、不静默合并不同币种。
- 金额用安全整数分求和；不要写浮点元数、不要写负数（退款按 `income` 记并写清 `description`）。
- 任一文件格式错误，整次读取失败并提示文件名 —— 不要为了让它读过去而删字段。
- 不编造交易；无法确定的记录先写进对话说明，不要写进 JSON。
- 看板是只读的：页面不提供编辑、导入、删除、外部同步，改数据只能改这里的文件。
- 本目录是隐私数据：不要提交到 Git（示例文件除外），不要上传外部服务。
- 需要新增字段（如子分类、标签）时先说明改动，再动 `model.ts` 和 `data.ts` 的校验。

## 快速自检

```bash
node -e 'const fs=require("fs"),p=require("path");const dir="data/dashboard/财务";const ids=new Set();let n=0;for(const f of fs.readdirSync(dir).filter(f=>f.endsWith(".json"))){const d=JSON.parse(fs.readFileSync(p.join(dir,f),"utf8"));if(d.currency!=="CNY")throw new Error(f+" currency");for(const t of d.transactions){if(ids.has(t.id))throw new Error("dup id "+t.id);ids.add(t.id);if(!Number.isInteger(t.amountCents)||t.amountCents<=0)throw new Error(f+" amount "+t.id);n++}}console.log("ok",n,"transactions")'
node --experimental-strip-types --test dashboard/boards/income-expenses/tests/income-expenses.test.mjs
```

## 常见请求对应做法

- 「这个月花了多少、结余多少」→ 只读汇总回答，不改文件。
- 「把 10 月这笔补进去」→ 追加到对应的月文件，检查 `id` 唯一。
- 「这个分类归错了」→ 改那笔的 `category`，不要改金额和日期。
- 「导出一份月报」→ 从 JSON 汇总生成文本回答，不新建报表文件（除非明确要求）。
