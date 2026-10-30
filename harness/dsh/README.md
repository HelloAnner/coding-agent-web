# dsh 原生 Web 接入

## 运行方式

- 固定并验证 `dsh 0.2.0-rc.2`，Host、Client 资源与 Remote 协议必须来自同一版本。未升级全局 dsh；不要直接换成官方 master 的较新 Client。
- `web-host.ts` 启动独立的官方 Web Host，仅监听 `127.0.0.1` 随机端口，不打开浏览器。
- 独立 profile：`$DSH_HOME/profiles/coding-agent-web`；不存在时由官方 `web` 模板创建。默认 `DSH_HOME=~/.dsh`，`PI_WEB_DSH_BIN` 可指定可执行文件。
- 模型、凭据、会话、队列、历史、标题、审批、插件均以原生服务为准。网页数据库仅保留目录索引与原生会话路径，不另存正文。
- 不启动 TUI，不加载 TUI OAuth，不生成 ACP overlay，不解压或自行解释会话文件。旧 ACP 运行时已经删除。
- 收到应用退出信号时关闭原生 Host 和流连接。开发热更新若仍保留旧 ACP 进程，会拒绝启动第二个写入同一会话的 Host；请先结束旧任务，再由操作者重启 coding-agent-web。

## 使用入口

- **设置 → 插件**：横向 pi/dsh Tab，默认当前 harness；未访问的 Tab 不初始化。pi 保留原有项目插件管理，dsh 使用跨项目共享的专属 profile，不要求先选择项目。
- **设置 → 模型 → dsh**：使用官方原生设置。必要时点原生侧栏的 **Models and credentials → Models**；首次使用可能先显示官方预览提示或登录引导。
- **聊天 → 原生扩展视图**：打开当前索引映射到的同一原生会话，不偷偷另建一条对话。插件专有的侧栏、渲染器、配置页由官方 Client Modules/Slots 加载；不承诺它们自动出现在公共聊天中。
- 公共聊天直接呈现原生审批与结构化提问。授权只有“仅允许一次”或拒绝，没有自动批准。可见的原生 Client 通过有期限的 lease 接管其选中会话的审批；隐藏或关闭后释放。
- 插件与设置的结构变更、显式“应用重启”会检查全部原生会话及后台任务，运行中拒绝操作。原生服务支持热生效时不强制重启。

## 旧配置与会话

常规运行不读取 `ds.toml` 或 `dsh-tui`。**设置 → 模型 → dsh → 预览旧 dsh 配置迁移** 是唯一的旧配置读取入口：

1. 默认读取 `~/bin/ds/ds.toml`（可用 `DSH_DS_TOML` 指定）以及旧 `dsh-tui/cordis.patch.yml` 中的声明式网关。只解析 YAML，不执行 `!!js`。
2. 预览只列提供方、模型数量和不能迁移的原因，不返回密钥。源文件变化后必须重新预览。
3. 确认后将新提供方写入原生设置，API key 保存为新建的原生凭据引用；不覆盖已有提供方，不修改旧文件或旧 token，不复制 OAuth 登录。
4. 无法安全识别协议、动态表达式或认证时跳过，改在原生 Models 中重新配置/登录。默认模型也在原生设置中明确选择，不用隐藏 fallback。
5. Native RPC 丢失响应不等于写入失败：仅清理能确认未使用的新凭据，结果不明时提示先核对原生设置。

已有网页会话保留原索引 ID，使用原生路径的 basename 定位原会话；新会话明确让原生 ID 与网页 ID 一致。原生历史读取有 10k 条消息的公共渲染器上限，返回 `hasMore`，不截断原始文件。断线不会自动重发 prompt；重开历史或下一次操作从原生 snapshot 恢复。

Notes 只借用可移植的原生 API 网关认证（服务端环境变量/原生本地凭据），不读取 TUI 配置。OAuth、动态凭据来源或不能安全确定的文件路径明确报错，不拿 pi 的同名 key 或默认模型替代。

## 插件与安全边界

- 官方 Plugin Manager 负责安装、取消、授权、日志、启停、卸载和当前版本具备的更新能力；不另写包管理器或文件锁。
- `embed/` 是一个普通的本地 `link:` 原生 bundle，提供初始导航与会话选择通知；第三方 Client 插件不需要逐个改本项目代码。
- 浏览器仅访问认证保护下的 `/api/harnesses/dsh/native/`。启动 token 和原生 Cookie 留在服务端；代理固定本机 Host、受限路径、HTTP 动词和 Remote envelope，拒绝路径穿越及意外重定向。
- 官方流协议由服务端 WebSocket 接入，浏览器通过 HTTP NDJSON/uplink 使用官方 transport hook，不额外公开 WS 端口。
- iframe 隔离 React/CSS/Client 环境，**不是安全沙箱**。安装 Host 插件及授权构建脚本等同于运行本机代码，必须信任来源。profile 也不是凭据或文件系统安全隔离。

## 验证

普通回归不启动真实 Host：

```sh
node --test harness/dsh/*.test.mjs components/HarnessPlugins.test.mjs
node_modules/.bin/tsc --noEmit
npm run lint
npm test
```

以下使用隔离的临时 profile、独立测试 HTTP 服务和本地假模型，不操作用户的 Next 服务、日常 profile 或真实模型：

```sh
DSH_NATIVE_TEST=1 node --test harness/dsh/web-host.integration.test.mjs harness/dsh/web-session.integration.test.mjs
DSH_BROWSER_TEST=1 node --test harness/dsh/web-view.integration.test.mjs
```

浏览器检查覆盖：真实官方 Client、带自定义配置页的本地插件、模型配置、旧网页 ID 到同一原生会话的导航、资源代理，以及页面不包含启动 token。
