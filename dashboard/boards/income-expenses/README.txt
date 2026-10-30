收入支出分析（独立看板）

入口
  Dashboard -> 财务 -> 收入支出分析
  /dashboard?board=income-expenses

边界
  「财务」只是导航分组，未来可以挂完全不同的看板。
  本目录只属于收入支出分析，不是其他财务看板的共享核心或组件库。
  组件、数据模型、读取逻辑、测试均留在本目录；API route 只转发 GET。
  ui/income-expenses.module.css 自有白底、细边框、橙色选中线及图表配色。
  不依赖 shell 主题 token、任务看板组件或通用 dashboard 图表样式。
  不为将来的财务看板预设风格、数据接口或目录；各自新增独立模块即可。

数据
  运行时读取 <项目目录>/data/dashboard/财务/ 下全部普通 .json 文件并合并。
  不递归子目录，不读取软链接，不访问数据库、网络或其他看板的数据。
  打开看板、返回 Dashboard、点击刷新时重新读文件，不需要重新构建。
  示例-2026-08/09/10.json 是明确标注的虚构数据。首次使用请先移除这些文件。
  只有上述三份示例文件纳入版本控制，其他 JSON 默认被 gitignore 保护。
  文件名不限，可按月份、账户或其他方式拆分。所有文件使用同一格式：

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

规则
  type 为 income / expense，amountCents 为大于零的整数分，12345 代表 123.45 元。
  日期为 2000–2099 年内的真实 YYYY-MM-DD 日期；不做时区偏移。
  所有文本字段必填，id 在所有文件中唯一；重复 ID 报错，避免重复计账。
  目前只接受人民币，不静默合并不同币种；sample 可省略或为布尔值。
  金额全程用安全整数分求和，超出范围拒绝；仅显示时转换为元。
  任一文件无效则整次读取失败，不用不完整的数据生成看似正常的合计。
  刷新失败会明确提示并保留上次成功的快照；空目录显示空态，不补示例数据。
  默认选择数据中最新月份。月份与账户影响所有汇总、趋势、分类和明细。
  明细内搜索、收支类型和排序只影响明细，不改变上方汇总。
  结余是当期收入减支出，不是账户余额；当期无收入时比例显示 —。
  刻度条限制在 0–100%，旁边数值保留真实负数或超额比例。
  页面只读，不提供编辑、导入、删除或外部同步。

检查
  node --experimental-strip-types --test dashboard/boards/income-expenses/tests/income-expenses.test.mjs lib/dashboard.test.mjs
