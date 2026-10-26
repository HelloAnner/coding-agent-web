dashboard 独立应用

机制
  Coding 与 Dashboard 共用 AppShell，切换不刷新、不卸载另一个应用。
  左侧只保留 Fine -> 任务看板，默认打开任务看板。
  旧看板链接自动回退到任务看板。

目录
  dashboard/boards.ts             看板注册与分组
  dashboard/ui/DashboardApp.tsx   公共导航和布局
  dashboard/ui/dashboard.css     布局，主题沿用 shell
  dashboard/boards/fine-tasks/    任务看板全部业务与测试

路由
  /                              Coding
  /dashboard                     任务看板
  /dashboard?board=fine-tasks     任务看板
  /api/dashboard/tasks           只读数据库

边界
  各看板逻辑放在各自目录，不互相依赖。
  左侧树复用 coding 的 session-tree 样式。
  任务同步规则见 boards/fine-tasks/README.txt。
