# DSH Autoresearch

[English](./README.en.md)

把 [grok-autoresearch](https://github.com/aa2246740/grok-autoresearch) / [pi-autoresearch](https://github.com/aa2246740/pi-autoresearch) 的实验循环接到 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web。`/autoresearch` 创建目标，Agent 连续修改、测量、保留或回滚，会话顶部一个可展开面板汇报结果。

需要 DSH `0.1.2-rc.1` 系列、一个 Web profile，以及 Node.js 22.19+。`dsh web` 会用 `zlib.createZstdDecompress`，更早的 Node 22 可能起不来。

不会上传或 push 项目代码。本仓库没有安装时自动跑的脚本。克隆后自己 `pnpm build`。`lib/` 不进 Git。

## 安装

```sh
git clone https://github.com/aa2246740/dsh-autoresearch.git
cd dsh-autoresearch
pnpm install --ignore-workspace
pnpm build
dsh plugin --profile web add link:/absolute/path/to/dsh-autoresearch -w
dsh web --port 43123
```

打开一个项目会话，输入 `/autoresearch`，选「新开一次 Autoresearch」，填目标和轮次，确认。STORE 自动核验可能会拦截，因为循环要读写项目文件并跑本机命令。这是预期行为。

官方 `@deepseek-ai/*` 由 DSH 宿主提供，本插件只在 `peerDependencies` 里声明。如果 Web profile 曾经写过 `nodeLinker: hoisted`，从该 profile 的 `pnpm-workspace.yaml` 删掉这一行，再 `pnpm install`。

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

```sh
pnpm install --ignore-workspace
pnpm typecheck
pnpm test
pnpm build
dshx check dsh-autoresearch
dshx verify-boot dsh-autoresearch --port 43123
```

## 许可

[MIT](./LICENSE)。实验循环核心移植自 grok-autoresearch（Copyright Tobi Lutke, David Cortes）。DSH Host 集成与 Web 界面是本仓库的新代码。
