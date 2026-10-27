notes 独立应用

机制
  Coding / Dashboard / Notes 共用 AppShell，切换不刷新、不卸载别的应用。
  左侧为目录树，右侧为选中的 Markdown 笔记或 Excalidraw 白板。
  目录树与 data/notes 一一对应；data/ 不在 git 里。

目录
  notes/types.ts                 前后端共享的类型
  notes/files.ts                 文件树、读写、新建、重命名和路径校验
  notes/db.ts                    notes_entries / notes_meta / notes_board_views 的 SQLite 索引
  notes/index.ts                 扫描文件树并写入 DB；@ 菜单的 mentions 接口
  notes/ui/NotesApp.tsx          侧边栏树、新建/拖动/删除、标题和保存状态
  notes/ui/NoteEditor.tsx        Markdown 编辑与预览
  notes/ui/Whiteboard.tsx        白板读取与自动保存
  notes/ui/WhiteboardCanvas.tsx  Excalidraw 实例与默认元素样式
  notes/ui/notes.css             编辑器、白板和树的样式

路由
  /notes                         页面（?path= 打开指定文件）
  GET  /api/notes                整个目录树，并重建 DB 索引
  GET  /api/notes/mentions       @ 菜单用的文件列表（含系统绝对路径）
  POST /api/notes                create / mkdir / rename / move / remove
  GET  /api/notes/file?path=     读文件
  PUT  /api/notes/file?path=     写文件
  GET  /api/notes/view?path=     取白板的滚动位置和缩放（首次为 null）
  PUT  /api/notes/view?path=     存白板的滚动位置和缩放 {scrollX, scrollY, zoom}

存储
  data/notes/<目录>/<标题>.md            Markdown 笔记，文件名即标题
  data/notes/<目录>/<标题>.excalidraw    Excalidraw scene JSON

数据库索引
  DB 文件：CODING_AGENT_WEB_DATA，默认 ~/.coding-agent-web/data.db
  notes_entries：path / parent / name / type(dir|note|board) / abs_path
  notes_meta：root（笔记库绝对路径）、synced_at
  notes_board_views：path / scroll_x / scroll_y / zoom（白板上次的视口）
  服务启动时同步一次；每次 GET /api/notes 或 /api/notes/mentions 再整表重建。
  文件系统仍是唯一源数据，DB 只做索引；白板视口例外，Excalidraw 的 scene
  JSON 不保存 scrollX/scrollY/zoom，所以视口只能落在 DB。

Coding 的 @ 联动
  @ 菜单在项目文件下面追加“笔记”分组，数据来自 /api/notes/mentions。
  选中后输入框只显示文件 chip（相对路径，不出现系统绝对路径），发送时把
  @"<系统绝对路径>" 追加到消息末尾，harness 收到的是绝对路径；消息气泡里把
  该绝对路径渲染成带文件图标的 chip（lib/notes-mention-display.ts），
  不展示绝对路径。

白板偏好（沿用 ~/Notes 里调好的设置）
  - 新元素：Cascadia 等宽字体、20px、#1b1b1f 细实线、round 圆角、round 箭头
  - 画布背景 #ffffff；语言 zh-CN
  - 隐藏导出 / 载入场景 / 存图片 / 切换主题等画布菜单
  - 深色界面用 JetBrains Mono 与洋红主题，见 notes.css

边界
  - 只允许 .md 和 .excalidraw；隐藏文件、符号链接、.. 路径都不进入树。
  - 重命名、移动都保留扩展名，目标重名时拒绝，不覆盖。
  - 删除文件或目录前弹确认；删目录会连里面的全部内容一起删除。
  - 顶部 + 只在根目录新建；目录行悬停出现 + 和垃圾桶，目录的 + 在该目录下新建笔记、白板或子目录。
  - 白板桌面端不显示顶栏（没有名称、路径、保存状态）；移动端只保留一个展开目录的按钮。
  - 笔记和白板可拖到目录行；拖到树的空白处即移到根目录；拖动前会先保存当前打开的编辑器。
  - 点树里的空白处把新建目标切回根目录（没有单独的根目录行）。
  - 触摸屏没有 HTML5 拖拽，删除按钮仍然可用；移动可在桌面浏览器上做。
  - 拖拽排序、全文搜索暂未实现。

Agent 内核（pi）
  目录
    notes/agent/settings.ts      笔记设置：agent 模型、白板字体字号
    notes/agent/board.ts         形状列表 -> Excalidraw scene（纯函数）
    notes/agent/tools.ts         自定义 tool：notes_write、notes_board、notes_manage
    notes/agent/skills.ts        notes/skills 下的技能清单
    notes/agent/runtime.ts       交互面板：pi AgentSession、事件流、转录
    notes/agent/profile.ts       会话工厂：共享 ModelRuntime + 每个任务自己的提示词/技能/工具
    notes/agent/schedule.ts      下一次触发时间（纯函数，可单测）
    notes/agent/scheduler.ts     定时线程池：FIFO、并发上限、超时、运行记录
    notes/agent/tasks.ts         定时任务清单（在这里加任务）
    notes/agent/index.ts         /api/notes/agent 与 /api/notes/tasks 的处理
    notes/skills/<名字>/SKILL.md 技能（frontmatter 里写 name、description）

  内置技能
    note-writing          笔记结构：结论先行、删掉空小节
    whiteboard-style      白板风格：先一句话主张、按概念选构图、留白、只画核心关系
                          借鉴 excalidraw-diagram-skill 的方法：同构检验、构图模式表、
                          容器纪律、留白即权重、画完核坐标
    whiteboard-drawing    notes_board 的字段、坐标、追加和重画规则

  流程
    浏览器 NotesAgentPanel
        |  POST /api/notes/agent  {message}      NDJSON 逐行回事件
        v
    NotesAgent（一个进程一个 pi 会话）
        |  read / ls / notes_write / notes_board / notes_manage
        v
    data/notes 里的 .md 与 .excalidraw

  事件
    message / assistant_start / text / thinking / tool_start / tool_end / error / done
    GET  /api/notes/agent    整段转录 + 模型名 + 技能
    POST /api/notes/agent    发一条消息，返回事件流
    DELETE /api/notes/agent  停止当前这一轮

  模型
    notes-settings.json 的 agent：baseUrl / apiKey / model / api / contextWindow / maxTokens
    这个 provider 只注册在笔记 agent 的 ModelRuntime 上，不写 models.json。
    baseUrl 或 model 留空 = 用本机 pi 已配好的默认模型。
    改模型会重建会话并清空对话：新会话看不到旧上下文。

  范围
    - 工具只碰笔记库：notes_write 只写 .md，notes_board 只写 .excalidraw，路径一律相对。
    - notes_manage 管目录树：mkdir / create / rename / move / remove，删非空目录要显式 recursive=true。
    - 技能只加载 notes/skills；用户自己的 coding skills、扩展、MCP 都不进笔记 agent。
    - 会话在内存里，重启清空；长期记忆是落盘的文件。
    - GET /api/notes/settings 返回设置、字体选项、技能；PUT 合并保存。
    - API Key 不回传浏览器：设置里的 key 只显示“已保存”，留空表示不修改。
    - 白板字体、字号来自设置，写入新元素和新白板的 appState；已有元素不改。

白板偏好（可配置的部分）
  设置 -> 白板：字体（Excalidraw 内置 8 种）、字号（10~64）。
  不配时是 Cascadia、20px；描边 #1b1b1f、细实线、round 圆角、白底是固定默认。
  想要截图那种手写感：字体选 Excalifont 或 Virgil，字号 16~18，画法按 whiteboard-style。
  notes_board 的形状：rectangle / ellipse / diamond / text / arrow / line。
