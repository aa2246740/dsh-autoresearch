# DSH Autoresearch

把 [grok-autoresearch](https://github.com/aa2246740/grok-autoresearch) / [pi-autoresearch](https://github.com/aa2246740/pi-autoresearch) 的**耐久实验循环**做成可安装的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件。账本仍在项目的 `.auto/` 里；**创建、运行、监控都走官方 Web GUI**（也保留 `/autoresearch`）。开发与冷启动走 [dshx](https://github.com/aa2246740/dsh-external-plugin-devkit)。

English: [README.en.md](./README.en.md)

## 这不是普通聊天

循环必须被**显式激活**。随便发一句 prompt 不会启动实验。日常首页和 composer 工具行**没有**实验入口。

只有输入 `/autoresearch`（或斜杠菜单里选 **新开一次 Autoresearch**）会弹出输入框正上方的引导卡；点 **确认并开始** 才会把 `active` 设为 true。之后模型改代码、跑 `.auto/measure.sh`、调用 `autoresearch_log_experiment`。keep 会提交；discard / crash / checks_failed 会回滚代码但保留 `.auto/`。

同会话自动续跑由 Host `agent.followup` 完成，直到 `maxIterations`、`/autoresearch off`、卡住或你打断。

## 安装

需要已安装的 `dsh` CLI（例如 `@deepseek-ai/dsh@0.1.1-rc.2`）、一个 Web profile，以及 **Node 22.19+**（`dsh web` 会用到 `zlib.createZstdDecompress`；22.14 会直接起不来）。

```sh
pnpm install --ignore-workspace
pnpm build
dsh plugin --profile web add /path/to/dsh-autoresearch -w
dsh web --port 43123
```

`pnpm install` 会把 Host 用来解析 `defineTool` 的 `@deepseek-ai/*` 装进插件自己的 `node_modules`。这是 `dsh plugin add <目录>`（`link:`）所必需的，并不是再装一份完整 Harness。

本地开发：

```sh
pnpm install --ignore-workspace
pnpm build
pnpm test
```

用 dshx 对着一份 Harness checkout 做合同检查和冷启动：

```sh
# 旁边 clone Harness，把 dshx 放到 tools/dshx，然后：
dshx setup --harness /path/to/deepseek-harness
dshx check dsh-autoresearch
dshx verify-boot dsh-autoresearch --port 43123
dshx start web dsh-autoresearch
```

`cordis.yml` 只写相对路径。不要把机器绝对路径提交进 git。

## 在 GUI 里怎么用

首页和侧栏**不会**常显「实验循环」。composer 工具行也没有常驻「新开 Autoresearch」按钮。

1. 打开官方 Web，进入一个项目会话；用户不需要预先配置 Git。
2. 在输入框输入 `/autoresearch`，选 **新开一次 Autoresearch**。输入框正上方出现引导卡（不是全屏 overlay，不挡上面的 Agent 输出）。
3. 卡上只填两件事：目标（自然语言，和 grok-autoresearch 的 `/autoresearch <goal>` 一样）和轮次。不要填主指标、方向、measure.sh。点 **确认并开始** 后，插件会自动保存本地保护点；有 Git 就安全复用，没有 Git、Git 忙碌或项目已有未提交内容时就无感切换到插件自己的文件快照。不会上传代码，也不会要求用户配置 Git。
4. 确认后 dock 收起（最多留一句「等 agent 在对话里对齐需求」）。此时没有进度卡；agent 可以先在对话里对齐需求。
5. 第一次 `run_experiment` 才出现一行 `running…`。第一次 `log_experiment` 入账后出现一张人话进度卡（Runs / kept / discarded / Baseline / Progress Δ% / 短表）。没有第二层「更大视图」。

暂停续跑：进度卡上的「暂停」或 `/autoresearch off`。清除账本用 `/autoresearch clear`。

斜杠 `/autoresearch` 会弹出：新开一次 / 继续 / 状态 / 停止 / 清除。进度卡从对话里的 run/log 工具更新，不会把账本 JSON 写进聊天。

## 账本

| 文件 | 作用 |
|------|------|
| `.auto/prompt.md` | 实验说明书，换会话也能接着跑 |
| `.auto/measure.sh` | 稳定基准，输出 `METRIC name=number` |
| `.auto/log.jsonl` | 权威结果日志 |
| `.auto/ideas.md` | 想法积压 |
| `.auto/checks.sh` | 可选正确性检查；失败不能 keep |
| `.auto/config.json` | `maxIterations`、`maxAutoResumeTurns`、`workingDir`；普通用户无需配置 Git |
| `.auto/hooks/{before,after}.sh` | 可选生命周期钩子（stdin 为 JSON） |

循环会保存有效实验，并回滚无效实验。干净的 Git 项目可以保留本地实验提交；其他项目使用插件私有快照，不会污染用户已有历史或暂存区。首次确认时会先保护当前状态，之后每个新编辑文件也会在修改前自动加入保护；远端上传仍然必须由用户另行明确执行。

## 模型面工具

`autoresearch_control` / `_status` / `_init_experiment` / `_run_experiment` / `_log_experiment` / `_compaction_summary`

普通 prompt 禁止调用 `autoresearch_control` 来激活循环。

## 许可

MIT。实验循环核心移植自 grok-autoresearch（Copyright Tobi Lutke, David Cortes）。本仓库的 DSH 宿主与 Web 槽位是新代码。
