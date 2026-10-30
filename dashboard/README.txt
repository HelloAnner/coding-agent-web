dashboard 独立应用

机制
  Coding 与 Dashboard 共用 AppShell，切换不刷新、不卸载另一个应用。
  左侧按导航分组：Fine -> 任务看板；财务 -> 收入支出分析；Health -> Father's Health。
  分组只是目录，不定义共用风格或业务；财务后续可以挂其他独立看板。
  默认打开任务看板，未知看板链接自动回退到任务看板。

目录
  dashboard/boards.ts             看板注册与分组
  dashboard/ui/DashboardApp.tsx   公共导航和布局
  dashboard/ui/dashboard.css     布局，主题沿用 shell
  dashboard/boards/fine-tasks/    任务看板全部业务与测试
  dashboard/boards/income-expenses/ 收入支出分析独立代码、组件、CSS、数据读取和测试
  data/dashboard/财务/*.json     收入支出分析的本地数据
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
  /api/dashboard/father-health/attachments/<id>  仅按清单 ID 读取本地附件

边界
  每个 boards/<board-id>/ 是独立交付边界，可单独拆仓；分组名不是代码边界。
  每个看板自有内容、设计语言、组件、CSS 和数据模型，不互相依赖。
  公共层仅负责注册、导航和挂载，不抽共享图表、表格或财务组件。
  样式必须限定在本看板内，不得修改 shell 或其他看板的选择器。
  新看板按需挂载；收入支出分析使用独立 CSS Module 和本地设计 token。
  左侧树复用 coding 的 session-tree 样式，导航样式不约束看板内容。
  各看板的数据规则见其目录内 README.txt。
