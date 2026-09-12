# DSH Autoresearch

[English](./README.en.md)

```sh
dsh plugin --profile web add github:aa2246740/dsh-autoresearch
```

PATH 上要有官方 `dsh`（没有就用 `npx @deepseek-ai/dsh`）和 **pnpm**。`dsh plugin add` 会在 `$DSH_HOME/profiles/web` 里跑 pnpm，并因为本包装了 `dsh.bundle.patch` 而写入 profile bundles。仓库已提交编译好的 `lib/`，git 安装不用 `prepare`，也不用改 profile 的 `allowBuilds`。

然后重启这个 Host，再刷新页面。`dsh plugin add` 只写 profile，不会热挂正在跑的进程。

把 [grok-autoresearch](https://github.com/aa2246740/grok-autoresearch) / [pi-autoresearch](https://github.com/aa2246740/pi-autoresearch) 的实验循环接到 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web。`/autoresearch` 创建目标，Agent 连续修改、测量、保留或回滚，会话顶部一个可展开面板汇报结果。

面向官方 DeepSeek Harness **0.1.5-rc.2**，以及 Node.js 22.19+。`dsh web` 会用 `zlib.createZstdDecompress`，更早的 Node 22 可能起不来。

不会上传或 push 项目代码。

打开一个项目会话，输入 `/autoresearch`，选「新开一次 Autoresearch」，填目标和轮次，确认。STORE 自动核验可能会拦截，因为循环要读写项目文件并跑本机命令。这是预期行为。

官方 `@deepseek-ai/*` 由 DSH 宿主提供，本插件只在 `peerDependencies` 里声明。如果 Web profile 曾经写过 `nodeLinker: hoisted`，从该 profile 的 `pnpm-workspace.yaml` 删掉这一行，再 `pnpm install`。

已经 clone 过的目录也可以：

```sh
git clone https://github.com/aa2246740/dsh-autoresearch.git
dsh plugin --profile web add ./dsh-autoresearch
```

同样需要 pnpm，然后重启 Host 并刷新页面。`lib/` 已在仓库里，不必再本地构建。

```sh
dsh plugin --profile web remove dsh-autoresearch
```

DSH.app 的 `desktop` profile 不接受 `github:`。用 `dsh web` 装进 web profile。

## 命令

| 命令 | 含义 |
|---|---|
| `/autoresearch` | 新开一次、继续、查看、停止或清除 |
| `/autoresearch resume` | 继续一轮已暂停的研究 |
| `/autoresearch status` | 查看当前持久状态 |
| `/autoresearch off` | 停止自动续跑，保留已有结果 |
| `/autoresearch clear` | 清除当前项目的 Autoresearch 账本 |

开始前会建本地保护：能用 Git 就保存基线，否则用插件私有快照。`discard` / `crash` / `checks_failed` 时恢复受保护文件。模型说「完成」不算结束，账本写入 `complete` 才会停。需要取舍时暂停问你。

账本在项目 `.auto/`：`prompt.md`、`measure.sh`、可选 `checks.sh`、`log.jsonl`、`ideas.md`、`config.json`。

## 开发

日常安装不用这一步。改 TypeScript 后用 **pnpm** 重建已提交的 `lib/`：

```sh
pnpm install --ignore-workspace
pnpm typecheck
pnpm test
pnpm build
```

## 许可

[MIT](./LICENSE)。实验循环核心移植自 grok-autoresearch（Copyright Tobi Lutke, David Cortes）。DSH Host 集成与 Web 界面是本仓库的新代码。
