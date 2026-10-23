# coding-agent-web

pi-web 的 fork。一个开源 Web 客户端，接本机上的多个 coding harness。

上游：https://github.com/agegr/pi-web
本仓库：https://github.com/HelloAnner/coding-agent-web

## 初衷

不想再守着终端。要一个好看、稳定的开源客户端，在浏览器里做开发。pi-web 的交互已经够用，但它只接 pi。

要接的是本机上的不同 harness，每个 harness 自己配模型：

- pi
- Claude Code CLI
- dsh

没有现成的客户端能同时做到，所以 fork pi-web，在它的界面上接多个 harness。

## 分支

```
upstream   agegr/pi-web
origin     HelloAnner/coding-agent-web

main       只同步 upstream/main。AGENTS.md 是空的，不在这里做产品改动
common     产品分支。允许破坏式改动。开发停在这里
```

同步不要为了少冲突而绑住 common。先把 upstream/main 更新到 main，再用 AI 把需要的功能合进 common。合不上就按 common 的产品目标改，不必保持和上游逐行对应。

只 push 到 origin。不要 push upstream。

common 上的这份 AGENTS.md 不要被上游那份盖掉。

## 做法

界面沿用 pi-web：会话列表、对话、输入框、文件。

运行时按 harness 分开接。不要把 pi 的 SDK 改成一套假的通用核心，否则每次跟上游都会缠在 `lib/rpc-manager.ts` 上。

```
界面（会话列表、对话、输入框、文件）
        |
        v
harness：列表、启动、发送、中断、事件流
        |
        +-- pi           现有 rpc-manager、pi 会话文件
        +-- claude-code  本机 Claude Code CLI
        +-- dsh          本机 dsh
```

例子：同一个项目目录，开一条 pi 会话，再开一条 Claude Code 会话。两条的模型各自设置，互不影响。

pi 的会话文件、MCP、skills、扩展只留在 pi 这条路上。Claude Code 和 dsh 不套这套格式。

## 开发

日常改 common。main 只做上游同步。

类型检查：`node_modules/.bin/tsc --noEmit`
Lint：`npm run lint`
开发服务器：`npm run dev`（端口 30141）

不要在开发时跑 `next build`，它会弄脏 `.next/`，接着 `npm run dev` 会坏。
