dashboard 独立应用

机制
  Coding 与 Dashboard 共用 AppShell，切换不刷新、不卸载另一个应用。
  左侧按导航分组：Fine -> 任务看板；财务 -> 收入支出分析；Health -> Father's Health。
  分组只是目录，不定义共用风格或业务；财务后续可以挂其他独立看板。
  默认打开任务看板，未知看板链接自动回退到任务看板。

目录
  dashboard/boards.ts             看板注册与分组（含 dataDir 与 tint）
  dashboard/ui/DashboardApp.tsx   外壳：左树、看板内容、右侧对话边栏
  dashboard/ui/dashboard.css      外壳布局与密度
  dashboard/shared/tokens.css     看板公共 token：语义色、明暗、密度刻度
  dashboard/shared/board-chat.css 右侧对话边栏样式
  dashboard/shared/BoardChat.tsx  右侧对话边栏（所有看板同一份）
  dashboard/shared/board-context.ts 看板 -> 固定目录 / 草稿 / 历史会话
  dashboard/shared/tokens.test.mjs 约束：看板样式不得自带颜色
  dashboard/boards/fine-tasks/    任务看板全部业务与测试
  dashboard/boards/income-expenses/ 收入支出分析独立代码、组件、CSS、数据读取和测试
  data/dashboard/财务/*.json     收入支出分析的本地数据
  data/dashboard/fine-tasks/     任务看板导出快照与笔记（数据库不在这里）
  每个 data/dashboard/<看板>/ 都有一份 AGENTS.md（+ 指向它的 CLAUDE.md），
  说明该看板是什么、数据长什么样、怎么加数据；看板对话的 harness 读它。
  dashboard/boards/father-health/ 父亲健康看板独立模型、数据读取、UI、CSS 和测试
  data/dashboard/健康/父亲/      健康 JSON 与附件（私有本地数据，不进 Git）

路由
  /                              Coding
  /dashboard                     任务看板
  /dashboard?board=fine-tasks     任务看板
  /api/dashboard/tasks           只读数据库
  /dashboard?board=income-expenses 收入支出分析
  /api/dashboard/income-expenses  只读本地 JSON
  /dashboard?board=father-health  Father's Health
  /api/dashboard/father-health   只读健康 JSON
  /api/dashboard/chat?board=<id> 返回该看板固定数据目录（对话用），目录不存在则创建
  /api/dashboard/father-health/attachments/<id>  仅按清单 ID 读取本地附件

边界
  每个 boards/<board-id>/ 是独立交付边界，可单独拆仓；分组名不是代码边界。
  每个看板自有内容、布局结构、组件、CSS 和数据模型，不互相依赖。
  公共层负责注册、导航、挂载、颜色 token、密度刻度和右侧对话边栏。
  公共层不抽共享图表、表格或财务组件；也不替看板决定版式。
  看板样式只引 --db-* token，不写颜色字面量（dashboard/shared/tokens.test.mjs 强制）。
  看板样式必须限定在本看板内，不得修改 shell 或其他看板的选择器。
  主题跟随 shell 的 data-theme（light / github-light / dark / one-dark-pro），看板不单独适配。
  左侧树复用 coding 的 session-tree 样式，导航样式不约束看板内容。
  各看板的数据规则见其目录内 README.txt 与 data 目录的 AGENTS.md。

右侧对话
  顶栏气泡图标开关；宽度可拖拽并记忆（pi-dashboard-chat-width），开关状态也记忆。
  对话就是 coding 的 ChatWindow：同一份 harness 列表、模型选择、会话运行时。
  唯一的差别是固定目录：每个看板用自己 boards.ts 里的 dataDir 起会话，
  因此模型偏好按目录记忆（/api/project-preferences），harness 能读到该目录的 AGENTS.md。
  切看板 = 切目录 = 切会话；草稿按看板独立。
