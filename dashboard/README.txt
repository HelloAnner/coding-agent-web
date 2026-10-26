dashboard 独立应用

机制
  Coding 与 Dashboard 共用 app/(apps)/layout.tsx 里的同一个 AppShell。
  切换只改显示与 URL，不刷新、不卸载另一个应用；两个页面本身是空的。
  侧边栏树与看板内容都由本目录提供。

  dashboard/
    boards.ts                左侧树：分组与看板，全部硬编码
    server.mjs               自己的后端，只依赖 Node 内置模块
    server.d.mts             只给 Next 接口层用的类型
    ui/DashboardApp.tsx      看板视图：左侧树 + 右侧内容
    ui/dashboard.css         只放 dashboard 自己的布局，颜色与字体沿用 shell

  左侧树直接复用 coding 侧边栏的 .session-tree 样式，所以行高、字号、
  缩进、选中态和右侧 meta 的密度与 coding 一致。

路由
  /                                     Coding
  /dashboard                            概览
  /dashboard?board=memory|load|host|requests

接入
  页面    app/(apps)/layout.tsx               AppShell 与两个应用
          app/(apps)/dashboard/page.tsx       看板路由与标题
  接口    app/api/dashboard/overview          调用 server.mjs 的 dashboardOverview()

边界
  UI 不 import coding 的组件与业务代码，只复用 shell 的 AppSwitcher 和
  全局样式类；看板内容与数据都来自 dashboard/ 自己。
