# OMP harness

已接入基础聊天。原生基线：`omp/18.3.0`，上游固定提交 [`62bc57be`](https://github.com/can1357/oh-my-pi/tree/62bc57be1b03ef0802a33cf7f5f530e534527531)。其他版本明确拒绝启动，不假定协议 v2 等于应用语义兼容。

## 一、模型和配置与 Pi 共用

**Pi 能提供给聊天界面的模型，OMP 使用同一来源；不维护另一份 OMP 模型列表或配置副本。**

- 设置 → Models → omp 复用 Pi 的编辑器，修改影响 Pi 和 OMP。
- 输入框直接读取同一个 `/api/models?cwd=…`；`lib/project-models.ts` 共用项目 trust、provider 扩展、deferred models 和 `enabledModels` 解析。
- `models.json`、`settings.json`、认证/OAuth、自定义 provider/API、网关、动态 key/headers、采样与兼容参数都由 **Pi `ModelRuntime`** 加载和执行，不翻译成 OMP `models.yml`，不限定 OpenAI-compatible API。
- 修改后下一次发送重读 Pi 模型配置和认证；已在执行的模型请求不改变。重选同一模型可刷新原生侧的模型元数据。
- 思考能力来自 Pi 模型元数据；新建使用 Pi 的 scoped pin / per-model / 默认档位。切模应用 Pi 的模型默认设置，精确恢复保留会话中已选的档位。
- 原有会话的模型不再可用、被 scope 排除或配置损坏时明确报错，不静默切到另一模型。
- **Pi 会话型 provider 扩展有边界**：若只在 `session_start` 注册，目录可能有 deferred 元数据，但独立模型服务尚未挂载。OMP 会在创建/发送前明确拒绝；扩展须在初始化阶段提供 provider，不伪建 Pi agent 激活。普通 `models.json` 配置与初始化注册的 provider 不受此限制。

这不是用 Pi agent 冒充 OMP：

```text
网页控件 / 会话索引
        |
        v
原生 OMP：agent 循环、系统提示、上下文、工具、审批、MCP、skills、扩展、日志
        |
        | OMP 原生 provider 扩展，继承的私有 fd 3/4
        v
Pi ModelRuntime.streamSimple()：模型配置、认证、provider、模型传输
```

OMP 不创建 Pi `AgentSession`，不进入 `lib/rpc-manager.ts`，不写 Pi 会话日志。这里只共享模型服务，不共享 agent、工具或 MCP 生命周期。

私有管道只发送模型显示/能力元数据与推理事件，不复制 endpoint、headers、凭据或认证文件，不监听额外 HTTP 端口。assistant 保留原始 API 标记供 Pi 的签名/replay 检查；浏览器事件移除签名。远端错误正文可能回显凭据，因此只展示脱敏后的模型标识、可识别的 HTTP 状态及排查提示。

## 二、原生协议与生命周期

运行方式：

```sh
omp --mode rpc-ui --no-pty --no-title --approval-mode yolo …
```

默认 **`yolo`：全部工具（read/write/exec）自动允许，不弹网页项目确认，也不弹工具审批。** 这是用户明确要求的模式，含 bash、写文件、MCP 与子智能体；只应在你确实允许本机全面改动的环境里使用。

`rpc-ui` 与 `rpc` 使用同一 RPC 传输，但 18.3.0 只有前者把原生工具 UI 接到 RPC；使用普通 `rpc` 会缺少可向人提问的 `ask` 工具。不能以自造一个 ask 工具补洞。

- 每条活跃会话一个 CLI，可多轮复用；空闲 10 分钟回收，下次精确 `--resume <sessionPath>`。
- 启动/控制操作在第一个 await 前占锁。模型控制的 busy 不冒充 agent 正在回答。
- 协商传输 v2；stdout 支持严格 JSONL、跨字节 UTF-8、`rpc_chunk` 重组，坏帧/断流令 pending 失败并关闭进程。
- `prompt` 成功响应只是 ACK；同 id 的后续异步错误仍处理。
- `agent_end.isTerminal:false` 不清 busy；`isTerminal !== false` 才结束主轮。兼容 `agentInvoked:false` 的本地完成语义，但网页不开放原生 slash commands。
- 网页拥有 steer / followUp 队列：steer 通过原生 `abort` 中断当前轮，等终态后优先执行；followUp 按轮依次发送。队列切换不发网页完成通知，重连/状态读取回放当前队列；同 requestId 不重复入队。
- Recall 返回未发送的文字和图片；停止清空队列、取消待回答 UI 并发原生 `abort`，仍未收口时关闭进程。未结算前保持锁，启动中取消不会继续提交 prompt。原生准备期间新增队列请求明确拒绝并保留草稿，不冒充已接收。
- 队列仅存于服务进程；原生断开或后续准备失败时不自动重发，尚未发送的消息保留给 Recall，不伪报持续运行。
- 断开浏览器只取消订阅，不停止 agent。重连恢复快照/工具/待回答问题，不重发 prompt；HTTP 发送结果不确定时保留草稿、查询状态，不自动重试。
- 首屏 `/api/catalog/sessions` 和权威 `/api/agent/running` 均聚合 OMP **web id** 与待输入状态；轻量状态读取不会启动已回收的 CLI。

协议依据：[18.3.0 RPC 文档](https://github.com/can1357/oh-my-pi/blob/62bc57be1b03ef0802a33cf7f5f530e534527531/docs/rpc.md)。不能套用新版 `session_settled` / `isSettled`，也不能按本机旁边的旧 `package.json` 判断二进制版本。

## 三、身份、目录与安全

| 项目 | 约定 |
| --- | --- |
| harness | `omp`，菜单与模型设置独立入口 |
| web id | `omp-…`，支持 LAN HTTP 下的 `crypto.getRandomValues` |
| native id | 从原生 session header 恢复，不与 web id 混用 |
| CLI | PATH 的 `omp`；可用 `PI_WEB_OMP_BIN` 指定可执行文件 |
| 原生配置 | 默认 `~/.omp/agent`；可用 `PI_WEB_OMP_AGENT_DIR` 显式隔离 |
| 原生数据 | 默认同配置根；已有 XDG data 根时沿用 OMP 的数据根选择 |
| 网页会话日志 | `<OMP data root>/sessions/web/<webId>/*.jsonl` |
| catalog | 保存 web id、harness、cwd、确认后的 provider/model、原生日志和配置根身份 |

创建先执行一次 `new_session`，确认 `cancelled:false`、文件存在、native id/cwd 一致后才写索引。恢复前后核对精确路径、header id、cwd 和原配置根；缺失/损坏不能初始化空会话冒充恢复成功。通用 catalog API 不能创建 OMP 会话、改绑身份或假装已切模；模型须由原生端确认后再更新索引。

Pi 与 OMP 都可能使用 `<时间戳>_<UUID>.jsonl`，**文件名不是 harness 身份**。前端相信 catalog；旧标签只在文件确实位于 Pi 的 realpath 根内且 header id/cwd 匹配时修复，符号链接越界不作证据。

子进程使用独立 env 副本，清理 Pi 的目录/模型/profile 选路，显式选择 `.omp` 配置和 OMP 根，不修改服务端全局环境。Pi 与 OMP 配置目录不能相同，包括符号链接指向同一个根的情形。

默认 `yolo` 全权限，不启用网页项目 trust 确认，也不弹工具审批。若 OMP 原生配置显式写了 `tools.approval.<tool>: prompt|deny`，该原生策略仍优先（`yolo` 只自动放行没有显式策略的调用）；需要完全无提示时不要在 OMP 配置里添加 `prompt` 规则。原生 `ask` 是向用户提问，不是权限审批，仍会按原生 request id 回传、显示选项说明。日志、blob 与 cwd 均做 realpath/归属检查，新 API 沿用现有站点认证。

**全权限不等于沙箱，也不是“安全已解决”。** 原生 hooks、扩展、MCP、配置命令和工具都可直接执行本地代码；`yolo` 还会忽略 critical-pattern 的提示。网页侧的项目访问检查只限制能开哪个目录，不限制该目录里的命令。Pi 的模型 provider 扩展仍遵循 Pi 的项目 trust。

## 四、能力与边界

| 能力 | 当前状态 |
| --- | --- |
| 菜单、模型设置、Pi 模型列表 | 已接；同一份模型配置，不另存 YAML |
| 文本、多轮、正文/思考增量、工具卡 | 已接原生 RPC 事件 |
| 工具执行与 ask | 默认 `yolo` 全权限，无工具审批；原生 `ask` 提问仍通过网页 UI 回答 |
| 空闲切模、思考档位 | 原生确认后更新；运行/待输入时锁控件 |
| 停止、刷新、SSE 重连、精确恢复 | 已接；发送结果不确定不自动重发 |
| 原生日志、当前分支、压缩摘要、标题、Notes 导入 | 自有只读解析；标题本地生成，不额外启动 Pi agent |
| 图片 | 接线与服务端校验已具备；原生 stdin 物理帧合计最多 1 MiB，含 JSON/base64 开销；未完成真实视觉 provider/大 blob 验收 |
| 用量 | 原生上下文状态和会话历史统计；未接全站 OMP 用量聚合/独立统计面板 |
| MCP、skills、扩展 | 由 OMP 原生加载；网页没有 OMP 专属管理面板，custom TUI 请求明确取消 |
| steer / followUp 队列、召回、停止清队 | 已接网页队列与原生中断/逐轮发送，支持文字和图片召回 |
| 原生 slash commands、手动分支/压缩、后台任务面板 | 未开放，不借 Pi API 伪造这些能力 |

历史读取有 **64 MiB** 上限，暂不分页；超限明确报错，不截断覆盖日志。只索引网页创建的 OMP 会话，不批量导入终端历史。网页/终端不能同时写同一日志；目前仅单服务 owner，不支持多服务实例共同管理原生进程，也不承诺重启后接回后台任务。

模型配置同源不等于每个模型都适合 OMP 的 agent/tool 提示，也不代表所有 provider、视觉、签名类型、原生插件组合都已实测。

## 五、代码入口

- `index.ts`、`models.ts`：登记、配置身份、Pi 模型能力。
- `model-extension.mjs`、`model-bridge.ts`：原生 provider 与 Pi 模型传输的私有管道。
- `rpc.ts`、`runtime.ts`：RPC v2、进程、锁、恢复与生命周期。
- `events.ts`、`transcript.ts`：事件/UI 转换、原生历史读取。
- `api.ts`、`catalog.ts`：请求校验、SSE、索引保护；`app/api/omp/` 只转发。
- `client/`：专属浏览器 API、发送/恢复/切模 workflow、复用 Pi 模型设置。
- `../../lib/project-models.ts`：Pi/OMP 共用模型服务加载，不创建 agent。

## 六、验证证据与发布

2026-10-30，本机 `omp/18.3.0`：

```sh
node_modules/.bin/tsc --noEmit
npm run lint
npm test
node harness/omp/client/browser-check.mjs
```

已通过类型检查、lint 和全量回归（3229 tests，3223 pass、6 skip、0 fail）。测试数量会随并行开发变化，以本次运行记录为准。

- `omp.test.mjs`：分块/UTF-8/坏帧、元数据不泄密、原始 API/签名保留、启动期取消、原生有效分支。
- `omp.integration.test.mjs`：真实 OMP CLI，临时 HOME/cwd/Pi/OMP 根，**本地假网关和假 key**；两轮上下文、动态认证/header、采样/输出限制、切模/思考默认、yolo 下 bash 直接执行且无审批、原生 ask、错误脱敏、停止、启动锁、精确恢复、catalog 保护与输入帧限制。未安装 18.3.0 时此项显式 skip。
- `queue.test.mjs`：steer 优先、requestId 去重、终态边界、准备期间停止不复活队列、附件召回与断流收口。
- `omp.integration.test.mjs` 另覆盖真实 CLI 的 steer→followUp 顺序、整个队列只结算一次及两种侧栏状态入口。
- `client/use-session.test.mjs`：队列发送/召回、无 trust 重试的 ensure→SSE→prompt、离页后仍发送已捕获的问题、失败草稿与不确定发送不重试、准备阶段/ACK 竞态取消、迟到历史不覆盖新事件、原生确认后才改模型。
- `client/browser-check.mjs`：真实 React 输入框和会话 hook 的独立 Chromium 夹具；同 Pi 模型列表、OMP 菜单、控件锁、ask 回答、刷新、两轮、steer/排队/召回/停止，确认没有 Pi agent 请求。不启动 Next、不写用户数据库。
- 公共回归覆盖 catalog 身份、旧 Pi 标签修复、模型加载、原有 harness 运行路径。
- `npm pack --dry-run` 确认扩展包含在发布包；打包探针把扩展复制到无仓库 `node_modules` 祖先的临时目录，真实 CLI 仍能加载 OMP 自带模型 SDK；未进行推理。

**未用用户真实凭据调用远端模型；未重启用户服务；未跑 `next build`。** 独立浏览器夹具不等于现有部署已重启验收。发布由用户按原流程重启，再用真实 provider 检查两轮/工具执行/停止与跨服务重启恢复；新增 OMP 版本须重新跑上述原生测试。

原先的设计讨论保存在 Git 历史中；本文件描述当前实现，不再把旧“OMP 独立模型配置”方案当作运行事实。
