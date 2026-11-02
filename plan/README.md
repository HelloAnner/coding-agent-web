# Plan

独立的全局人生规划系统，不是看板，也不依赖 Coding / Dashboard / Notes 的运行时。

- `plan/ui/`：独立页面、组件与 CSS Modules 设计
- `plan/db.ts`：人生领域、愿景、目标、里程碑、附件索引
- `plan/api.ts`：规划数据 API
- `plan/files.ts`：附件上传、下载、删除
- `app/plan/`、`app/api/plan/`：仅保留 Next.js 薄路由入口

## 数据

默认全部位于 `data/plan/`：

```
data/plan/plan.db       SQLite（含 WAL 文件）
data/plan/files/<目标 ID>/  原始附件
```

首次打开会创建六个可修改的人生领域和一组可编辑、可删除的示例目标；之后删除目标不会重新生成。测试可用 `PLAN_DATA_DIR` 指向临时目录。

## 初版

全局总览、人生蓝图、目标清单；按 90 天 / 今年 / 1–3 年组织路线图；目标编辑、进度、里程碑、附件；蓝图和领域愿景失焦自动保存。
