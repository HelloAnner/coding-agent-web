任务看板

入口
  Dashboard -> Fine -> 任务看板
  /dashboard?board=fine-tasks

数据流
  服务启动 -> 每 10 分钟 -> Meegle CLI -> data.db 独立表
                                              |
                                  页面 GET 只读数据库

  打开页面和点击刷新都不查询 Meegle。
  服务必须持续运行；停机期间不执行同步，启动时补一次过期同步。
  使用本机 meegle 的当前登录用户。MEEGLE_BIN 可覆盖可执行文件路径。
  数据库沿用 CODING_AGENT_WEB_DATA 或 ~/.coding-agent-web/data.db。
  fine_tasks 保存任务；fine_task_sync 保存最近成功时间及错误。

规则
  跨空间读取个人待办，按项目和任务 ID 去重。
  当前负责人包含自己才显示；不再负责的任务本地标记完成并保留。
  同步失败不覆盖上次成功的数据，不修改 Meegle。
  支持搜索、状态和分类筛选、各列独立排序、详情弹窗、复制链接。
  版本优先使用解决版本，没有时使用规划版本。
  Meegle 当前接口没有可靠的分配时间，在手天数暂时显示 —；不以创建时间冒充。

边界
  本目录负责看板所有业务代码，其他看板不依赖它。
  app/api/dashboard/tasks 只转发 GET；服务启动注册定时器。
  页面复用 shell 主题，不引入单独的图表或配色体系。
