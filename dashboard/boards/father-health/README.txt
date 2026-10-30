Father's Health（独立看板）

入口
  Dashboard -> Health -> Father's Health
  /dashboard?board=father-health

数据与隐私
  只在运行时读取 data/dashboard/健康/父亲/health.json；不依赖 ~/notes、数据库或外网。
  同目录的 AGENTS.md 是看板对话给 harness 的背景说明（数据格式、加数据规则）。
  原始报告、截图、药盒、PDF、笔记副本存放在同目录 attachments/ 下。
  该目录由现有 .gitignore 排除。不要 force add 健康数据、原件、截图或带真实数据的测试产物。
  仓库只提交看板代码与虚构测试数据；不附带真实数据或自动演示数据。
  打开看板、返回 Dashboard 和点击刷新都会重新读 JSON，无需构建。
  缺文件或格式错误明确显示，不补造数值，不静默跳过损坏的医疗记录。

JSON
  version: 1，完整结构见 model.ts 的 HealthData。
  profile       档案、既往病史和明确缺失项
  metrics       指标名称、单位、分组、精度、核心指标标识、注意说明
  reports       正式检查日期、医院、原文来源、附件 ID、逐项结果
  events        病史与就诊时间线（允许月份/近似日期，仅作文字，不混入正式测点）
  medications   药名、用途、剂量、最后确认日期、confirmed/unconfirmed、注意事项
  followUp      原计划日期、状态、待查项目；计划不算检查结果
  alerts        待核实事项与原文来源
  nutrition     日常管理摘要；原始餐单保存在 documents 中
  findings      影像等文字检查结果
  documents     原文全文、分类、来源路径、附件副本 ID
  attachments   附件 ID、相对路径、SHA-256、类型、大小、来源、available/missing
  provenance    来源与核对说明

  检测结果 value 可为数值或定性文本；reference/min/max/flag 按每张报告分别保留。
  报告未测的项目不添加结果，不写 0；没有参考区间时 min/max 为 null。
  不把尿总蛋白等同于尿白蛋白/UACR，不把不同医院的 eGFR 增幅等同于真实疗效。
  CO₂ 等历史单次结果标明日期与“历史值”；缺少后续检查不表示恢复正常。
  既往 confirmed 只说明当时确认在服，不代表今天仍在服；规格不当作每次用量。

界面
  仅借用参考图的暖灰底、白色细边框、四色趋势和环形状态标签，不复刻双栏布局。
  看板为单列纵向分区，字号与间距优先保证完整可读；核心卡片按可用宽度自动换行。
  导航、主标题和分区标题统一使用英文；医疗正文、原始资料和数据标签保留中文。
  标题简短、留白统一，不重复展示指标摘要；详细解读放右侧，主页面突出数值、日期与状态。
  用药逐项展示完整功效、剂量、注意事项和确认时间；病史、表格与用药不限制高度。
  只滚动整个看板；时间趋势与多次报告对照在窄屏可横向滚动，不压缩数据。
  不设报告数量、指标数量或用药条数的展示上限；新增 JSON 数据自然向下扩展。
  后续添加 reports/metrics/medications/events 时无需改 UI，同时应核对 profile/alerts 等文字记录的时效。
  环形标签只是参考范围状态，不是健康评分或剩余肾功能比例。
  趋势横坐标使用实际日期，仅连真实报告测点，不生成每日数据、不外推预后。
  日期范围影响指标卡、趋势和化验对照；病史、用药与原复查计划保留各自日期。
  近30天/近90天/今年以“最新正式报告日”为基准，默认全部报告。
  主看板没有报告缩略图、附件列表或外部来源路径。
  点击指标、用药“查看”、病历入口或资料索引，右侧原生 dialog 才展示原文与相关附件。
  dialog 支持 Escape、关闭按钮、焦点约束和返回；移动端全宽。

隔离与安全
  UI、SVG 图表、CSS Module、数据模型和 API 实现都只在本目录。
  不修改 shell/任务/财务看板的样式，不引入图表依赖，不把个人数据打入 JS bundle。
  app/api/dashboard/father-health 仅做路由转发，继承已有 proxy 的访问控制。
  JSON 与附件响应 private/no-store；附件按清单 ID 解析，不接受客户端文件路径。
  拒绝清单越界路径、越界软链接、不支持类型、非普通文件和超16MB文件。
  私有报告图像直接读取受保护 API，不经图片优化缓存，也不复制到 public/。

检查
  node --experimental-strip-types --test dashboard/boards/father-health/tests/health.test.mjs lib/dashboard.test.mjs
  HEALTH_E2E_URL=http://127.0.0.1:<已有开发服务端口> node e2e/father-health.mjs
  node_modules/.bin/tsc --noEmit
  npm run lint
  不运行 next build 或 make start/restart/stop；浏览器检查脚本仅连接已有开发服务。
