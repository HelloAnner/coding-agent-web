# omp harness 适配方案

状态：讨论稿，尚未登记菜单、尚未实现聊天。本文中的接口、文件及环境变量，除明确标为现状的部分外，都是实施建议。

调研日期：2026-10-30。仓库基线：`common@935268d`。

## 一、结论与目标

建议把 **Oh My Pi（`can1357/oh-my-pi`，命令 `omp`）作为独立 harness** 接入：

- harness id 和菜单名称均为 `omp`，与 `pi`、`dsh`、`grok`、`Claude Code` 并列。
- 使用本机 `omp --mode rpc`，每条活跃会话一个可多轮复用的子进程。
- 复用网页的项目导航、消息/工具卡、文件面板、SSE 传输；协议和前端兼容逻辑归 `harness/omp/`。
- 模型、凭据、agent 循环、工具、MCP、skills、扩展和原生日志由 OMP 自己管理。
- 不接模型 API 来假装 OMP；不把 OMP 塞入 `lib/rpc-manager.ts`；不引入第二套 OMP SDK 到 Next.js 进程内。
- 首版锁定 **OMP 18.3.0 方言**。协议传输 v2 不等于应用语义也兼容最新 OMP。

目标闭环：同一项目同时开 pi 与 omp，会话互不串用；OMP 能两轮对话、展示工具、审批/提问、停止、刷新重连、服务重启后按原生日志续聊。

本轮只提交这份方案，不创建空代码文件，也不把“菜单里有名字”当成接入完成。

## 二、调研依据与实测边界

### 2.1 已确认的事实

| 项目 | 结果 |
| --- | --- |
| 本机命令 | PATH 中存在 `omp`，`omp --version` 返回 `omp/18.3.0` |
| 启动方式 | 支持 `--mode rpc`，也提供 `omp acp`；不是只能抓终端输出 |
| 可执行文件 | 本机入口最终指向编译后的 macOS arm64 可执行文件，不能根据 `.js` 后缀强行用 Node/Bun 启动 |
| 原生模型 | `omp models --json` 提供机器可读目录；RPC 有 `get_available_models`、精确 `set_model` |
| 配置 | 原生 YAML 配置及 SQLite 状态，不是 pi 的 `models.json` / `auth.json` |
| 会话 | OMP JSONL，带树结构、模型变更、压缩、标题槽和 blob 引用；不是严格兼容 Pi 的日志 |
| 本机附带源码 | `package.json` 标为 `18.0.11`，与实际可执行文件不一致，不能拿旁边的源码当 18.3.0 协议依据 |
| 版本基线 | 已查到上游 `v18.3.0`，提交 `62bc57be1b03ef0802a33cf7f5f530e534527531` |

### 2.2 本轮实际做过的原生探针

全部使用临时 HOME、cwd、配置目录，关闭扩展、skills、rules、LSP、PTY 和工具；未使用用户真实凭据，未发送模型问题。

1. 无任何可用模型/认证时，CLI 在 `ready` 前退出，提示 `No models available`。因此启动失败不能只等握手超时。
2. 用测试用假 key 激活内置模型目录、但不调用模型，确认：
   - `ready` 广告 `[1, 2]`，物理帧上限 `1048576`，重组上限 `67108864`。
   - `negotiate_protocol(2)` 成功。
   - `get_state`、`get_available_commands`、`get_messages_page`、`get_available_thinking_levels`、`get_entries`、`get_tree` 均能响应。
3. 持久化模式启动后，第一次 `get_state.sessionFile` 有值但文件尚不存在；执行 `new_session` 且返回 `cancelled:false` 后，文件真实落盘，包含 `title`、`session` 等记录，header id 与原生 sessionId 一致。
4. 本地 `/stats` 指令产生 `command_output`，返回 `agentInvoked:false`，不产生 agent 对话结束事件。它还会启动本地统计界面，说明原生命令不是无副作用的普通文本；探针退出后已确认无遗留监听。

**这些只证明本机协议和空会话行为。** 真实 provider、模型调用、图片、审批/ask、多轮上下文、崩溃恢复和浏览器展示都还没有验收，不能写成“已支持”。

本轮变更仅为文档，校验章节、代码围栏、本地引用和 diff 格式；未运行项目类型检查、lint 或测试套件。它们是后续实施交付的必检项，不是本轮已通过的证据。

### 2.3 为什么必须按版本读协议

18.3.0 的结束语义：

- `prompt` 成功响应只是接收确认，后面还可能出现同 id 的异步错误响应。
- 普通 agent 工作以 `agent_end.isTerminal !== false` 为结束边界。
- `isTerminal:false` 是维护/后续工作中间态，不得清 busy 或完成通知。
- 本地指令通过响应中的 `data.agentInvoked:false`，或稍后的 `prompt_result {agentInvoked:false}` 完成，可能根本没有 `agent_end`。
- 18.3.0 的 `get_state` 没有新版 `isSettled`，也不能假定每个问题都有新版 `prompt_result.status/sessionSettled` 或 `session_settled`。

调研时最新 main 已加入后一套语义。实施时以锁定标签和可执行文件实测为准；升级单独做兼容测试，不顺手写一个“兼容所有 pi-family”的通用协议层。

## 三、现有接入点与必须修正的问题

现状参见 [harness 总览](../../docs/harness.txt) 与 [接入自检清单](../../docs/harness-checklist.txt)。

| 现有位置 | 现状 / OMP 所需改动 |
| --- | --- |
| `harness/types.ts`、`harness/registry.ts` | 当前只描述发现、配置位置和模型读写，不是通用运行时；新增 descriptor 不等于聊天可用 |
| `components/harness/panels.tsx` | 设置页面板登记，登记 OMP 自有只读模型面板 |
| `components/ChatInput.tsx` | 菜单来自 `/api/harnesses`；但非 pi 的模型获取/选择仍内置，需给 OMP 委派接点，不能只更新索引 |
| `hooks/useAgentSession.ts` | 仍有各家发送、历史、状态、SSE、审批分支；OMP 新逻辑放自己的 client hook，只在公共处组合/转发 |
| `components/ChatWindow.tsx` | 非 pi 默认隐藏思考/压缩等控件；按 OMP 已实现能力传回调，不直接取消所有非 pi 限制 |
| `app/api/catalog/sessions/route.ts` | 侧栏首屏运行/待输入列表必须包含 OMP web id |
| `app/api/agent/running/route.ts` | 周期权威快照同样必须包含 OMP；不能只修首屏转圈 |
| `lib/catalog-db.ts` | 可沿用会话索引；目前只给 Claude 加了更强身份锁，OMP 的 cwd/原生路径/配置根也需要服务端保护 |
| `lib/catalog-sync.ts` | 只修已索引行的路径；OMP 不得落入 Pi 路径解析或扫描导入全部终端历史 |
| `app/api/sessions/[id]/auto-name/route.ts` | 非 pi 有原生专属分流；OMP 初期返回本地标题，不启动 pi 或额外模型来命名 |
| `notes/ingest.ts` | 已有原生历史分流；OMP 未接时明确不支持，不能兜底到 Pi reader |
| `lib/usage-types.ts`、`lib/usage-collectors.ts` | 全站统计只认识四家；OMP 属于单独后续交付，不得混记为 pi |

### P0：现有文件名猜测会把 OMP 误判为 pi

`components/session-catalog-helpers.ts` 的 `isPiSessionFile()` 只根据 `<时间戳>_<UUID>.jsonl` 判断；`composerHarnessFor()` 优先采用它，`AppShell.tsx` 还有 effect 强制纠正 harness。OMP 实测生成同样形式的文件名。

**必须同时修正 helper 的所有调用方与 AppShell 的纠正逻辑：**

- 已确认的 catalog `harness` 是路由依据，文件后缀不是 harness 身份。
- 对遗留脏索引的修复，改为服务端在明确的 Pi 原生根目录内验证；不能全局按名字“纠正”为 pi。
- 新增回归：同名样式日志位于 OMP 根、`harness:"omp"`，打开后仍为 omp；同时保留真正 Pi 旧索引的修复验证。
- 不能只在 helper 最前加一条 `if (harness === "omp")`，然后留下其他调用继续猜文件名。

## 四、方案选择与模块边界

### 4.1 选择原生 RPC，不选择其他路线

| 路线 | 评价 |
| --- | --- |
| **原生 RPC 子进程（推荐）** | 能直接控制 OMP 模型、状态、历史、交互；依赖 CLI 而不是其内部 SDK，升级边界清晰 |
| 原生 ACP | 可以单独验证，但不能因为现有 dsh 用 ACP 就复用它的内核、补丁、目录、权限默认值；本次不同时维护两种协议 |
| 进程内 OMP SDK | 会把另一套 Bun/native 依赖、配置单例和版本耦合带入 Next.js；没有必要 |
| PTY / ANSI 抓屏 | 没有可靠消息、工具、权限和恢复语义，不采用 |
| 直接调用模型 API | 不是 OMP harness，不采用 |

```text
已有网页：会话列表 / 对话 / 输入框 / 文件
                    │
             OMP client 适配
                    │ HTTP + 现有 SSE
          /api/omp/[webId]（薄路由）
                    │
           harness/omp/runtime.ts
                    │ JSONL RPC，协商 v2
              本机 omp 子进程
                    │
        OMP 配置 / 工具 / 原生会话与附件
```

### 4.2 后续按需创建的文件

```text
harness/omp/
  README.md                本方案（本轮唯一新增文件）
  index.ts                 descriptor、二进制和配置根解析
  rpc.ts                   spawn、握手、命令关联、分块、退出清理
  runtime.ts               身份、创建/恢复、发送/停止、快照、忙态
  events.ts                OMP -> 网页消息/工具/交互与终态
  transcript.ts            OMP 原生历史只读解析与内容规范化
  client/
    api.ts                 浏览器端 URL 和受限命令封装
    use-session.ts         OMP 专属发送/恢复/归并/控件策略
    Models.tsx             OMP 原生模型只读展示
  *.test.mjs               随实现加入，不先铺空测试
```

框架入口留在 `app/api/omp/[id]/route.ts` 与 `events/route.ts`；图片按需增加会话内媒体路由。它们只做输入校验、授权、调用和响应，不解释原生 entry/工具协议。

不复制整套 ChatWindow，不趁机重写另外四家。公共 hook 保留通用展示状态，通过窄回调与 OMP client 组合；OMP 的 React hook 必须按 Hooks 规则无条件调用、用 `enabled` 控制副作用，不能在 harness 分支里条件调用 hook。

如确需提取现有 UUID 生成器或无 harness 归属的展示 helper，迁移实现、调用和测试到公共模块；OMP 不为 UUID 或归并去引用 grok/Claude 内部文件。

## 五、模型、配置和凭据

### 5.1 模型来源与只读边界

1. 设置页及新建框使用原生命令 `omp models --json`，通过当前项目 cwd 获取目录；活跃会话最终以 `get_available_models` 校验。
2. 优先复用已有异步 `readChatModels` 接点。该签名当前没有 cwd，需要增加可选上下文，并由模型路由/输入框传入和校验 cwd；其他 harness 可忽略，不新增另一套模型注册系统。
3. OMP 模块让设置页走同一个异步读取入口，不把“同步解析 models.yml”当成全量可运行目录。
4. 设置页无项目时标明“全局目录”；项目目录、配置、扩展可能改变实际可选模型，不能把 home 下的探测结果缓存成全局事实。
5. 探测不创建聊天、不写 catalog、不调用模型推理；但可能加载插件/刷新目录或认证，因此仍受项目信任和超时约束。
6. 缓存按二进制版本、规范 cwd、配置根区分，短 TTL、失败可见、支持手动刷新；不缓存凭据，不在每次轮询启动 CLI。

模型行只白名单返回：`key/name/provider/model/enabled/isDefault` 及确实用到的图片/思考能力。原生完整 `Model` 可能带网关、headers 和认证相关字段，不能原样回浏览器。

模型标识保留完整 `(provider, modelId)`，菜单 key 可编码为二元组；不根据 `/` 随意切分有多级路径的 modelId。不发显示名、`smol`、`slow`、`plan` 等模糊别名给执行端。

原生 available 表示“有可解析的认证或无需认证”，不是保证远端可用。无模型、认证过期、模型被禁用/移除时保留旧标签和历史，发送明确报错，不偷偷换默认模型。

### 5.2 同一会话的模型策略

- 新建时可选精确 provider/model；已有会话锁 harness 和 cwd，不锁 OMP 模型身份。
- 首版允许**空闲时切模**：发送原生 `set_model`，确认响应与后续 `get_state.model`，再更新 catalog、项目偏好和标签。
- 启动参数即使使用精确选择，也要比对实际模型；CLI 的模糊匹配/默认回退不能作为“已选中”的证据。
- 运行/启动/停止期间先锁模型按钮，不照搬 pi 的热切模，也不做“下一问才会偷偷应用”的假切换。
- 原生 `model_changed`、`config_update`、fallback 事件要更新实际模型并提示；不宣称 OMP 自身绝不会按原生策略使用备用模型或角色模型。
- 思考控件只用 `get_available_thinking_levels` 的结果；切换后读回实际档位。首版不把 OMP `auto/inherit/max` 生硬映射到 Pi 的枚举。
- 不因选择一条会话的模型去改写全局 `models.yml` 或模型角色配置。

### 5.3 原生目录与环境隔离

常见默认位置（必须考虑原生目录覆盖/XDG）：

```text
~/.omp/agent/config.yml
~/.omp/agent/models.yml 或 models.yaml
~/.omp/agent/agent.db          原生设置/认证状态
~/.omp/agent/models.db         原生模型缓存
~/.omp/agent/sessions/...      原生 JSONL
~/.omp/agent/blobs/...         内容寻址附件
```

建议提供 `PI_WEB_OMP_BIN` 和可选 `PI_WEB_OMP_AGENT_DIR`，都仅在服务端读取；这是拟新增配置，不是现有可用变量。二进制默认找 PATH 的 `omp`，需要时明确填写绝对路径，不依赖个人 shell alias 或脚本。

**高风险：OMP 也使用 `PI_CODING_AGENT_DIR`。** 子进程不能直接继承 pi 路线的目录覆盖、`PI_CONFIG_DIR`、`PI_PACKAGE_DIR` 等选路环境：

- 只在子进程 env 副本中清理冲突项，再应用明确的 OMP 设置；不修改服务端 `process.env`、HOME 或 pi 配置。
- 默认使用 OMP 原生默认根；自定义根显式指定，不能指向 Pi 根，不能只靠 `.omp` 字符串判断是否安全。
- OMP 的 XDG 数据目录可能与配置目录分开，不能假设所有数据库、日志、blob 都在一个硬编码路径下。解析规则以锁定版本为准，无法确认时拒绝读取任意路径。
- 首版只接一个确定的 OMP 原生身份，不提供 Web 内的多 profile 切换。明确选择默认 profile，防止 `OMP_PROFILE`/兼容 `PI_PROFILE` 隐式改绑；需要 named profile 时单独接入并持久化身份。
- 原生 provider key/代理等环境按明确继承策略交给 OMP；这是配置隔离，不是 OS 沙箱或凭据绝对隔离。
- Web 不读取/迁移 `agent.db` 中的 secret，不提供登录或模型文件编辑器。用户通过 OMP CLI 配置/登录，网页显示脱敏状态与配置位置。

## 六、会话身份、创建和恢复

### 6.1 持久化映射

建议使用独立 web id，避免与 Pi/其他 harness 原生 id 共用命名空间：

```text
webId         = omp-<Web 生成的随机标识>
harness       = omp
cwd           = 规范化后的既有项目目录
provider      = 实际 provider
model         = 实际 modelId
session_path  = get_state 返回并验证的原生 JSONL 绝对路径
nativeId      = 原生 sessionId；可从该文件 header 恢复，不只存在内存中
configRoot    = 该会话绑定的 OMP 配置身份
```

现有 `sessions` 表足以保存主要映射。可复用 `profile_path` 记录绑定的配置身份，但要更新其当前“Claude 专用”的类型说明与校验；这里的配置身份不是“一个模型一个 Claude profile”。无需先新建 OMP 会话表。

catalog 是索引，不存第二份正文。浏览器不提交可任意改写的原生路径、配置根或 nativeId；续聊从索引定位，服务端核对文件 header、cwd、身份和允许根。catalog 的 POST/PATCH 也必须防改绑，不能只在 OMP prompt 路由校验。

### 6.2 首次创建

```text
校验项目/信任/模型 -> 为 webId 占启动锁（任何 await 之前）
  -> spawn omp --mode rpc --no-pty --approval-mode always-ask
  -> 等 ready、协商 v2
  -> 对新会话执行一次 new_session，要求 cancelled:false
  -> 精确 set_model / get_state；验证 sessionId、sessionFile、文件 header
  -> 原生日志真实创建后写 catalog，确认索引写入成功
  -> 提交 prompt，返回 accepted；回复走 SSE
```

`new_session` 只用于首次绑定，不用于每轮发送或恢复；初始 CLI 自带的懒会话不对外暴露。这样避开“拿到了路径但日志还没创建”的首轮崩溃窗口，也不用网页自己伪造 OMP header。

- 两次并发创建只允许一个 native new；其余返回 busy 或复用同一初始化 promise。
- `new_session` 被扩展取消不是创建成功；不把 bootstrap 会话冒充新会话。
- catalog 写失败，不继续发问题；保留本次已创建路径供重试/诊断，不重复 new，不删除用户历史。
- 模型或原生创建失败不写假侧栏行；临时空文件只有确认属于本次创建时才允许做受控清理。
- 请求有稳定 requestId，至少在进程内识别进行中/近期重复提交；断网不自动重发。跨服务崩溃不承诺 exactly-once，状态不确定时先核对原生日志。

### 6.3 恢复

1. 校验 catalog 的 harness、配置身份和 cwd。
2. **在启动 CLI 前**只读校验原生日志有效 header 和 nativeId；缺失、空文件、损坏、越界直接报错。
3. 使用精确 `--resume <session_path>`，不用 `--continue`、最近会话或 id 前缀猜测。
4. 握手后比较 `get_state` 的 id、路径和模型。身份不符，停止该实例，不自动接受新空会话。
5. 保存模型不可用时明确拒绝续聊，不被 CLI 默认模型悄悄替换；历史保持可读。显式用户切模是另一条操作。

OMP 18.3.0 的 loader 可能把缺失/无效文件视为空会话并初始化，因此“CLI 没报错”远远不够。仅打开历史优先使用只读 reader，不为显示旧消息就启动可能迁移/重写文件的 CLI。

禁止首版透传改变会话归属的原生命令：new/fresh/reset/clear、resume/switch/session、move、fork、worktree/目录切换等，以及它们的别名。使用服务端命令允许列表，不仅在前端隐藏。

同一原生日志不能同时在终端 OMP 和 Web 中写入；Web 内锁不能约束外部 CLI。首版明确不支持这种双写，不宣称普通文件锁可以约束不配合的终端进程；身份/路径意外变化应失败关闭而不是跟随。

## 七、运行时、协议与结束态

### 7.1 生命周期

```text
idle -> starting[已占锁] -> running -> settling -> idle
                    │        │
                    │        +-> awaiting-input -> running
                    │        +-> stopping -> 原生结算/有界升级 -> idle 或 failed
                    +-> 启动失败 -> 清理 -> failed

failed/空闲回收 -> 下一轮按原路径 resume，不隐式 new
```

- Map 按 webId 管理，保留 child、nativeId、cwd、配置身份、状态、待回复请求和当前 generation。
- 使用现有 `Symbol.for + globalThis` 模式应对 Next dev 热重载；旧 child/旧轮次事件不能清理新状态。
- 进程 alive 不代表 busy。busy 包括 starting、运行、审批、停止、压缩和已知未结算工作。
- 首版一个活跃会话一个进程；同项目两条 OMP 对话是两个原生会话、两个进程。
- 建议空闲 10 分钟回收，待审批/已知后台活动时不回收；断开浏览器不回收正在工作的进程。
- 退出清理所有 pending、监听、timer；异常必须发出一次可见错误和终态，不留下永远转圈。
- 服务关闭时先请求原生收口/关闭 stdin，继续消费 stdout 直到 drain/close，再有界升级信号；不要因停止读取而卡住退出。

这是本机单服务进程方案。`globalThis` 不能跨 Next worker、蓝绿两实例或多副本共享；首版必须保证每条活跃会话的 HTTP/SSE/轮询落在同一 owner，不能部署成 serverless/随机负载均衡后仍宣称可用。确需多进程时再做 owner 路由，不先引入 broker。

### 7.2 JSONL 与 v2 分块

使用 Node 标准库 `spawn`、流、Buffer 和 JSON，`shell:false`，argv 传参。用户文本、模型名和路径不参与 shell 拼接。

- stdout 按字节增量分行，支持半行、粘包、UTF-8 边界；设置物理帧缓冲上限。stderr 单独保存脱敏、限长尾部。
- `ready` 后协商 v2；必须实现 `rpc_chunk`，不能把它当未知事件丢掉。
- 校验 chunkId/index/count/byteLength、base64、严格 UTF-8、实际总长、顺序及重组上限；中断/交错/超时则终止不可信流并结算错误，不能交付半段 JSON。
- v2 **只对 stdout 分块**。stdin 的命令仍是完整单行 JSON；发送前检查序列化后的 UTF-8 字节数，而不只是文字长度或单张图片大小。
- `response` 用 id 关联，不能按先后顺序配对；控制请求有超时，模型运行不套 30 秒硬截止。
- 接收成功响应后保留当前 prompt 的生命周期记录，以处理同 id 的晚到调度错误；不能删掉 pending 后把错误吞掉。
- OMP 自己返回的 recoverable `command:"parse"` 错误与无法解码的 stdout 是不同故障；未知普通事件可忽略并诊断，未知交互请求不能默认批准。
- 不新增 JSON-RPC/ACP 框架，也不从机器上的任意绝对 npm 路径导入 OMP 类型/实现。

### 7.3 原生事件到网页事件

| OMP 原生事件/结果 | 网页处理 |
| --- | --- |
| `agent_start` | 开始当前活动段，进入等待模型 |
| `message_start/update/end` | 规范化文本、thinking、图片、toolCall、toolResult；完整 end 覆盖流式快照 |
| `tool_execution_*` | 复用工具卡，保留 toolCallId/父子关系；不丢错误和取消 |
| `agent_end.isTerminal:false` | 仅关闭当前生成段，保持忙态，不发最终完成通知 |
| `agent_end.isTerminal !== false` | 本基线的 agent 结束边界；归并最终历史后发网页的 `agent_settled` 一次 |
| `agentInvoked:false` / 本地 `prompt_result` | 结束对应本地指令，转换为网页 `prompt_done`，不等不存在的 `agent_end` |
| `command_output` | 受限命令结果展示，不当成模型回答或原生持久消息 |
| 同 id 异步失败、模型消息 error | 可见 `prompt_error`，正确收口，accepted 不等于成功 |
| `extension_ui_request` | 暂存真实 id，展示交互或状态；取消事件关闭对应请求 |
| `model_changed`、`config_update` | 同步实际模型/思考，不仅更新显示名称 |
| 原生 `notice` / 持久化错误 | 按级别可见告警；不能在日志写失败时提示“已安全保存” |

网页的 `agent_settled` 是适配层输出词汇，不意味着 OMP 原生就有这个事件，更不是创建 Pi AgentSession。

消息转换不能靠 `as PiMessage`：OMP 工具调用常见 `{id,name,arguments}`，网页要 `{toolCallId,toolName,input}`；图片 `{data,mimeType}` 要转网页 `source`。OMP 额外 role/entry 保持可诊断、可读投影，不能粗暴拼成普通 assistant 正文。

### 7.4 停止

- 正常停止先发原生 `abort`；进入 stopping 后拒绝新 prompt，直到原生结算。
- 启动中停止只置取消意图；ready 之后不得继续把原问题送出去。
- 无运行时/空闲停止不启动新进程；重复停止幂等。
- 超时按 child/generation 逐级退出，例如 3 秒 SIGINT、8 秒 SIGTERM、最终 SIGKILL；具体时间和平台行为在原生验证后固定。
- 强制杀死不承诺完整保存最后流式文本或杀掉所有外部守护任务，必须提示恢复边界。
- 首版不开放 steer/followUp 队列按钮。18.3.0 没有本方案所需的可靠单条撤回/恢复队列接口，不手搓一份平行队列，也不能把 abort 当成“清空所有原生后续工作”。

## 八、历史、消息归并、SSE 与附件

### 8.1 历史只读投影

`transcript.ts` 负责 OMP 专属解析；活跃运行时可用 `get_entries/get_tree/get_messages_page` 校验，但不依赖它们才能在认证失效后看历史。

必须处理：

- 可选物理 `title` 槽，再读取真正 `type:"session"` header；不能把第一行强行解成 session。
- 按 `id/parentId` 和叶子重建有效分支，不把所有分支按文件顺序拼起来；活跃 leaf 可从 RPC 得到，离线按该版本原生重建规则处理。
- `model_change` 的 OMP `model`/role/fallback 字段，不拿 Pi 的 `provider/modelId` entry schema 生套。
- compaction、branch summary、reset boundary 的展示边界；网页历史投影不反过来充当恢复上下文。
- 保留 `toolResult` 的原生大小写、toolCallId、错误/取消状态以及 custom message 的 display 语义。
- `blob:sha256:` 图片/附件引用只从绑定身份的可信 blob 根解析；缺 blob 显示附件缺失，不把 hash 当 base64。
- 未完成末行可以等待后续读取；损坏 header/中间结构错误须可见诊断，不能静默当空历史再覆盖。
- 正文解析不触发原生迁移，不写回 OMP 文件；旧版日志能做只读展示则展示，不能完整支持时明确限制。

分页使用 OMP 自有 cursor，不能直接塞进 Pi 的 entry cursor。原生分页在 busy/stale_cursor 时会失败；不得把不同快照的半页拼在一起。首版可先只读流式扫文件、返回有界历史窗口，长历史分页后续独立补齐并标明限制。

### 8.2 去重与重连

- 持久消息以 OMP entry id 为稳定键；工具以原生 toolCallId；流式消息用当前 generation/段内身份，在持久 entry 到来后对齐。
- 不假定 18.3.0 一定提供新版 messageId，不用正文字符串当唯一标识；两次相同问题必须仍是两条消息。
- 增量、完整消息、离线历史、重连快照走同一套 OMP 规范化及归并逻辑，不重复追加。
- SSE 复用 `lib/agent-event-stream.ts` 的心跳、背压、工具更新合并和清理。
- 重连先建立订阅再发布一致快照：当前正文、运行工具、待交互 id、忙态；已在快照内的 delta 不再重放。
- 现有 SSE helper 不是 durable event log，且部分快照过滤依赖对象身份。OMP 必须配合其契约并实测，不能假设它自动消除任意重复。
- 断线期间已经完成的轮次，通过状态+原生历史收口，不重发 prompt，不重复完成音效/通知。
- 不无限缓存 raw 事件，尤其图片和大工具结果。超出 SSE/历史响应限制时保留原生日志、给出可见限制，不能悄悄截断后还声称完整。

### 8.3 图片：第二阶段再开放

原生支持 `prompt.images: [{type:"image", data, mimeType}]`，但要单独验收：

1. 同时检查模型 `input` 与实际传输限制（例如 `compat.stripImageInput`）；不是目录声明 image 就一定能送达。
2. 输入遵守现有 MIME/格式/数量校验，并额外检查整条 JSONL 帧。通用附件可能允许数 MiB，而 OMP 入站建议上限只有 1 MiB；v2 不能解决入站超大图片。
3. 超限时明确拒绝或经用户可见的压缩流程处理，不静默丢图、换模型或改成文件路径假装视觉输入。
4. 支持纯图片提问、重启后 blob 恢复、图片工具结果和缺失附件。
5. 延迟加载媒体使用 OMP 自有、按 webId+entryId 授权的端点，不借用 Pi 的 tool-result-image 路由，不接受任意文件路径。

## 九、审批、提问、原生命令与扩展

### 9.1 审批安全默认

OMP 原生 `tools.approvalMode` 的默认是 **yolo**。Web 建议显式用 `--approval-mode always-ask` 启动，而不是继承宽松默认；yolo 只在后续显式配置并展示风险时开放。

这不是“每个工具都询问”：always-ask 通常自动允许 read，write/exec 询问，原生工具/用户策略仍参与决策。子代理在原生实现中以 headless/yolo 工作，父级 task 的批准是重要边界；不能承诺子代理内部每步都经 Web 人工确认。

- 18.3.0 的工具审批通过 extension UI `select`，不是 Claude 的 `can_use_tool`，也不是名为 `approval_request` 的帧。
- 保留原生选项值、完整待执行信息和 request id；不自动选择第一项，不把取消映射为批准。
- 按原生 id 精确回传，校验它仍属于当前 web 会话/代际；重复或过期回复明确拒绝。
- `cancel {targetId}` 转换为网页对话框关闭事件；断网仅断订阅，未答请求保留在服务端并在重连时重现。
- 超时/退出按原生取消/拒绝语义处理。OMP ask 可能按原生配置超时选择推荐项，发布前须确认并展示/约束该策略，不能声称所有提问都永不自动作答。
- 缺少 Web 展示能力时明确取消/拒绝，不加 `--auto-approve` 来掩盖适配缺口。

### 9.2 ask 与 extension UI

首版复用已有 select/confirm/input/editor、状态、通知和简单 widget 展示；需要补齐 `optionDetails`、`promptStyle` 等真实使用字段时，在 OMP 转换/控件接点实现。

18.3.0 的 ask 走通用 select/editor 交互，不能照搬新版 opt-in `ask` 一次性表单，也不能复用 Claude 的 questions JSON 格式冒充等价。多题、多选、“其他”、取消、超时必须用该版本原生数据验收。

原生 TUI 自定义组件不等于浏览器可渲染组件，任意扩展 UI 不列为首版兼容承诺。`open_url` 只允许安全协议、由用户主动打开，不自动在服务端或浏览器执行任意地址。

### 9.3 MCP、skills、hooks、斜杠命令

- OMP 自行加载原生配置和项目资产；Web 的 Pi MCP/skills/扩展设置只影响 pi，不同步、不覆盖、不伪造 OMP 资产。
- 首次在一个项目启动 OMP 或加载其项目插件前，明确确认信任：扩展、hooks、MCP 可能在任何工具审批之前执行本机代码。
- 首版信任可只在本服务生命周期内按 cwd+配置身份记忆，重启重新确认；不为了“记住”立即复制 Claude 的信任表或改通用数据库。
- 仅浏览旧历史不需要执行原生扩展。模型探测如加载项目扩展，同样先获得信任。
- 初版斜杠命令使用服务端允许列表，只开放已验证、不改变身份且有可显示结果的命令；未知命令明确拒绝，不当普通文本悄悄发送。
- 原生命令目录使用 `get_available_commands`，不请求 Pi `get_commands`；控制权限、切目录、开服务、分享/上传等有副作用命令不因被发现就自动开放。
- 不注册 host tools / host URI，因此不会把网页工具循环又嵌回 OMP；未注册功能的异常请求显式失败，不悬挂。

## 十、API 与前端契约

以下是 Web 自己的受限 API，不把原生 RPC 任意透传给浏览器。

| 端点 | 职责 |
| --- | --- |
| `GET /api/harnesses` | 增加 `omp` descriptor，返回配置位置，不返回 secret |
| `GET /api/harnesses/omp/models?live=1&cwd=...` | 获取/刷新相应项目的可选模型；无 cwd 时明确为全局目录 |
| `POST /api/omp/[webId]` | 允许的 prompt/abort/set_model/set_thinking_level/get_state/extension_ui_response；不接受 switch_session 等任意原生命令 |
| `GET /api/omp/[webId]` | 已索引会话的只读历史、规范化状态/模型；正文不通过 URL 传入 |
| `GET /api/omp/[webId]?state=1` | 不启动 idle CLI 的轻量状态快照，进程不存在不伪装成历史丢失 |
| `GET /api/omp/[webId]/events` | 已授权会话的 SSE；订阅本身不新建原生会话/执行 prompt |
| catalog / running 现有端点 | 聚合 webId 维度的忙态与待输入状态，更新索引/目录偏好 |

SSE 首次创建前的订阅可以绑定“已授权项目的一次性临时 webId”，只有完成项目校验才能注册；或者先完成原生创建再订阅、最后发送。不能允许仅凭任意 URL id 启动 CLI。

建议状态码：输入错误 400，未授权项目/越界 403，非本 harness 或不存在 404，busy/身份冲突 409，帧超限 413，缺二进制/认证/原生不可用使用明确业务错误和合适 5xx。错误只返回脱敏原因，不回传 env、headers 或完整 systemPrompt。

前端规则：

- 新建框选择 omp 后只读 OMP 模型；切回 pi 不清掉另一家的全局配置或草稿。
- 已有会话始终使用自身 harness；启动、发送、等待输入、停止中都锁 harness。
- OMP 空闲切模必须执行成功后才更新显示/索引；回调不能像现有 foreign-model 选择那样直接记 catalog 就结束。
- 不支持的图片、队列、分支、Pi 工具预设、MCP 设置入口隐藏或说明，不留下点击无效的按钮。
- 思考、审批、提问、工具失败、断网/恢复都要有明确可见状态；使用现有基础无障碍与移动端交互。
- 新增错误/设置文案按项目 i18n 方式登记；demo/mock 遵循同一控件契约，不能用演示成功替代真机验收。

## 十一、能力范围与实施顺序

### 11.1 能力矩阵

以下“首版/后续”是计划，不是当前支持状态。

| 能力 | 原生基线 | Web 计划 |
| --- | --- | --- |
| 原生 agent、多轮文本、工具输出 | RPC 支持 | 首版必须 |
| 确定的 new/resume、停止与忙态 | 支持，但需处理身份/结束语义 | 首版必须 |
| 模型目录、空闲切模 | models CLI / RPC 支持 | 首版只读目录+执行端切模 |
| thinking 展示与可选档位 | 支持动态发现 | 首版按真实能力接入，不套 Pi 枚举 |
| 工具审批、ask、基础 extension UI | 支持通用 UI 帧 | 首版必须闭环 |
| 图片输入/结果、blob | 支持，受帧和模型限制 | 第二阶段，首版不宣称支持 |
| 用量/上下文 | 原生 stats / contextUsage | 首版可显示已有原始值；全站 usage 单独接入 |
| steer/followUp | 支持原生队列 | 后续，先解决撤回、停止和重连语义 |
| compaction | 原生自动/手动接口 | 自动运行不拦截；手动控件与取消单独验收 |
| branch/tree | 原生有部分接口 | 历史需正确读树；Web 分支操作后续 |
| MCP/skills/hooks/扩展执行 | 原生拥有 | 沿用原生；不承诺 Web 配置管理和任意 TUI |
| 子代理状态/正文 | 有订阅与读取 | 首版按父工具展示；专属运行面板后续 |
| 单独停止后台任务/子代理 | 18.3.0 文档无新版完整控制面 | 不套 Claude 任务 API，不承诺已支持 |
| OAuth 登录、profile 管理、host tools/URI | 部分原生支持 | 本轮/首版不做 |
| 全量终端历史自动导入 | 可从磁盘发现不等于产品要求 | 不做；只列 Web 已索引会话 |
| Notes、搜索、导出、全站统计 | 公共功能需逐项分流 | 未接时明确禁用/不支持，不能落到 Pi 默认路径 |

### 11.2 阶段 0：原生风险闸门

实施前以实际 18.3.0 完成真实两轮、停止、恢复、审批与 ask 探针。记录 provider、模型、精确启动命令和未验证边界。确认：

- new_session 持久化与索引身份的顺序可重复验证。
- terminal/non-terminal 与本地命令完成不会误判。
- 默认权限符合 Web 预期，取消不执行工具。
- 目标模型存在且能真实调用；假 key 探针不算。

这一阶段不登记一个点击后无法聊天的正式菜单。

### 11.3 阶段 1：完整基础闭环

交付 `rpc/runtime/events/transcript/client` 最小实现与薄 API，同时接入菜单、只读模型页、身份修正、运行/待输入聚合。

必须一次完成首版的两轮、工具、审批/提问、停止、历史和重启恢复，不以“文本能回”提前宣布接入完成。无关高级按钮明确禁用；自动命名采用首条问题摘要/已有原生标题，不另开模型调用。

### 11.4 阶段 2：媒体与现有产品联动

图片/原生 blob、Notes 原生 reader 分流、标题同步、长历史分页、真实用量/统计，以及搜索/导出的明确支持边界。每项通过才开放 UI；费用未知保持未知，累计快照不重复累加，原生 cost 是原生记录/估算而非远端账单承诺。

### 11.5 阶段 3：有需求再扩展

原生队列、树/分支操作、手动压缩、子代理专属面板、named profiles、原生登录配置。若升级 OMP，先适配新生命周期语义，再单独开放新能力，不同时重做所有现有 harness。

每个完成的交付单独 commit 并 push `origin/common`。不 push upstream，不执行 `next build` 或 `make start/restart/stop`；服务重启由用户操作。

## 十二、测试与发布验收

沿用 `node --experimental-strip-types --test` / 现有 `.test.mjs` 组织，不添加测试框架。协议复杂分支要留下可运行回归测试，而不是只做一次手工演示。

| 层次 | 最小覆盖 |
| --- | --- |
| 协议单测 | 半行/UTF-8、乱序 response、v2 分块与上限、EOF/非法帧、超时、晚到同 id 错误、stderr 脱敏 |
| 原生历史 | title 槽、有效分支/循环保护、compaction/reset、OMP 模型 entry、toolResult、blob、残缺末行/坏 header |
| 生命周期假进程 | ready 慢启动双发、启动中停止、abort 后立即续聊、崩溃、generation、索引失败重试不 new |
| 路由 | 所有身份/路径校验；OMP 两个 running 聚合接口；待输入快照；非法命令/伪造 UI id |
| UI/归并 | 同文两问题不去重，partial/final/历史各一份，重连收口，模型失败不改标签，切 harness 不落 Pi |
| 跨 harness | 同项目两条 OMP + 一条 pi/Claude/dsh/grok；模型、停止、正文、文件权限互不污染 |

真实验收矩阵（实际结果在实施时填写）：

| 场景 | 预期 | 当前 |
| --- | --- | --- |
| 连续两轮，写入 `omp-check-42` 再追问 | 同 nativeId、上下文连续 | 未测 |
| 用户重启服务后追问标记 | 精确 resume，同文件，不创建空上下文 | 未测 |
| 首屏与权威轮询，切页观察至少三个周期 | webId 忙态不被清掉，停止按钮一致 | 未测 |
| 工具需批准，分别允许/拒绝/取消/重连 | 真实工具结果；取消不执行；同 id 只答一次 | 未测 |
| ask 单选/多选/其他/超时 | 与 18.3.0 原生语义一致，无自动代答伪装 | 未测 |
| 延迟启动，双标签发送，中途停止 | 一次创建，无偷偷提交；错误可重试 | 未测 |
| 停止 A 立即发送 B、模拟旧事件迟到 | B 等 A 收口，旧事件不污染 B | 未测 |
| SSE 在正文后、终态前断开 | 不丢终态、不重复通知/回复 | 未测 |
| 空闲切模型，认证/模型缺失 | 精确 set_model；失败保留选择与历史，无默认回退 | 未测 |
| 删除或破坏原生日志 | 查看/恢复明确报错，不写新文件覆盖 | 未测 |
| OMP 文件名与 Pi 格式相同 | 始终路由 OMP，Pi 旧索引修复不回归 | 代码风险已确认，修复未实施 |
| LAN HTTP、手机、多标签 | 随机 webId 可生成，基本控件可用 | 未测 |
| 伪造路径、symlink、secret、跨会话 UI 回复 | 403/404/409；API/SSE/bundle 无凭据 | 未测 |

实施后的基础检查：

```bash
node_modules/.bin/tsc --noEmit
npm run lint
npm test
```

假进程测试不替代真实 CLI/provider/browser；工具审批不替代项目信任，项目信任不等于 OS 沙箱；服务恢复历史不等于恢复崩溃前的后台进程。

## 十三、优先关注的风险与待定项

### 13.1 阻断发布的风险

1. **文件名撞 Pi 判定**：先修身份根因及全部调用点，否则 OMP 会被错误路由。
2. **共享 `PI_*` 目录变量**：子进程 env 明确隔离，否则会读写错配置和日志。
3. **版本漂移**：实际二进制、包附带源码、main 文档三者可能不同；v2 握手不能证明结束语义兼容。
4. **ACK 被当完成 / 中间 agent_end 被当最终**：会早退、漏错、丢续作或永远转圈。
5. **假恢复**：日志不存在/损坏时原生可能初始化，必须启动前后都校验身份。
6. **审批与插件执行边界**：yolo 不能默认开启；扩展/MCP 启动可能早于工具审批；task 批准不等于逐步子代理审批。
7. **仅前端写模型索引**：必须打到原生 set_model，不能复制现有 foreign-model 菜单的缺口。
8. **SSE/入站图片不同限制**：v2 重组不能解决 stdin 超限，图片必须单独做总帧字节检查。
9. **只接首屏漏掉权威轮询**：运行态会被下一次快照覆盖，两个聚合点一起验收。
10. **多实例/终端双写**：本方案不自带跨进程 owner，不以 globalThis 或普通文件锁掩盖限制。

### 13.2 建议采用的默认决策

无需等待这些讨论才能继续原生验证；如无不同偏好，按以下默认实施：

- 协议：RPC；基线：18.3.0；进程：每活跃会话一个。
- 权限：显式 always-ask；首次项目启动前确认信任。
- 模型：OMP 自有只读目录，空闲切模；不提供 Pi provider 编辑器。
- 配置身份：首版一个默认 OMP 根，不做多 profile UI。
- 会话：只索引 Web 创建的 OMP 会话，不自动导入终端全量历史。
- 标题：本地摘要/已有原生标题，不额外调用模型。
- 范围：先完成可靠基础闭环，再开放图片、队列、分支及专属后台面板。
- 兼容：明确目标版本，不先构建自动兼容所有 OMP/Pi 分支的框架。

## 十四、参考资料

仓库资料与代码均以上述 `common@935268d` 为调研基线，未来实现时重新核对。

- [本项目 harness 定位与隔离规则](../../docs/harness.txt)
- [本项目完整接入自检清单](../../docs/harness-checklist.txt)
- [OMP 仓库](https://github.com/can1357/oh-my-pi)
- [OMP v18.3.0 / RPC 协议](https://github.com/can1357/oh-my-pi/blob/62bc57be1b03ef0802a33cf7f5f530e534527531/docs/rpc.md)
- [OMP v18.3.0 / RPC 类型](https://github.com/can1357/oh-my-pi/blob/62bc57be1b03ef0802a33cf7f5f530e534527531/packages/coding-agent/src/modes/rpc/rpc-types.ts)
- [OMP v18.3.0 / RPC 实现](https://github.com/can1357/oh-my-pi/blob/62bc57be1b03ef0802a33cf7f5f530e534527531/packages/coding-agent/src/modes/rpc/rpc-mode.ts)
- [OMP v18.3.0 / 模型与认证](https://github.com/can1357/oh-my-pi/blob/62bc57be1b03ef0802a33cf7f5f530e534527531/docs/models.md)
- [OMP v18.3.0 / 原生会话与 blob](https://github.com/can1357/oh-my-pi/blob/62bc57be1b03ef0802a33cf7f5f530e534527531/docs/session.md)
- [OMP v18.3.0 / 审批语义](https://github.com/can1357/oh-my-pi/blob/62bc57be1b03ef0802a33cf7f5f530e534527531/docs/approval-mode.md)
- [OMP v18.3.0 / 目录、profile 与 XDG](https://github.com/can1357/oh-my-pi/blob/62bc57be1b03ef0802a33cf7f5f530e534527531/packages/utils/src/dirs.ts)
- [新版生命周期对照，仅作升级参考](https://github.com/can1357/oh-my-pi/blob/338d2ce6658dfdbfba19efe0f006f0d5a8edd66d/docs/rpc.md)
