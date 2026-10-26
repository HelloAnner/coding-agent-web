dashboard 独立应用

结构
  dashboard/
    index.html   页面骨架，{{styles}} 与 {{script}} 是注入位置
    styles.css   独立样式，不引用主项目 CSS
    app.js       独立前端，轮询自己的接口
    server.mjs   独立后端，自带数据与独立 HTTP 服务
    server.d.mts 只给 Next 适配层用的类型

接入方式
  /dashboard                    Next 适配层，返回拼好的整页 HTML
  /api/dashboard/overview       Next 适配层，调用 server.mjs 的 dashboardOverview()

  Next 的接入文件只有下面两个，各自几行：
    app/dashboard/route.ts
    app/api/dashboard/overview/route.ts

独立运行
  node dashboard/server.mjs
  打开 http://127.0.0.1:4310/dashboard

边界
  不 import 主项目的 components / lib / hooks。
  前端只用原生 HTML + CSS + JS。
  后端只依赖 Node 内置模块。
