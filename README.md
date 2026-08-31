# DSH Autoresearch

> 真正可用的 Autoresearch，不该要求用户先学会 Git、回滚、实验账本和循环协议。用户应该只负责说清目标；保护现场、运行实验、验证结果和收拾失败路径，才是自动化该承担的工作。

DSH Autoresearch 是一个面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的外部插件。它把 [grok-autoresearch](https://github.com/aa2246740/grok-autoresearch) / [pi-autoresearch](https://github.com/aa2246740/pi-autoresearch) 的耐久实验循环带进 DSH Web：用 `/autoresearch` 创建目标，由 Agent 连续修改、测量、保留或回滚，再用会话顶部一个可展开的轻量面板持续汇报结果。

它不修改 DSH 源代码，也不会上传项目代码。开发、构建与冷启动验证通过非官方工具 [dshx](https://github.com/aa2246740/dsh-external-plugin-devkit) 完成。

English: [README.en.md](./README.en.md)

## 为什么“能一直跑”还不够

许多 Autoresearch 实现把“自动”理解成反复向模型发送提示词。这解决了连续执行，却把真正困难的部分留给了用户：项目是否能安全回滚、未提交代码会不会被覆盖、一次失败是否污染下一轮、目标完成后为什么仍显示运行、开启第二个目标时旧结果又该怎么办。

这不是小问题。一个循环只要不能可靠回答“现在是什么状态”和“失败后能否恢复”，运行得越久，风险就越大。

因此，本插件坚持四个判断。

### 一、自动化必须包含失败路径

用户不需要预先配置 Git。开始前，插件会先建立本地保护：适合使用 Git 时复用或初始化本地仓库并保存安全基线；遇到 Git 不可用、仓库忙碌或项目已有未提交内容时，自动切换到插件私有文件快照。已有暂存区和历史不会被污染，新编辑文件也会在首次修改前进入保护范围。

实验有效时保留结果；`discard`、`crash` 或 `checks_failed` 时恢复受保护文件并清理本轮新增文件。这些保护与恢复动作都发生在项目本机；创建本地提交不等于推送，插件从不替用户上传代码。

### 二、状态必须来自事实，而不是模型的语气

模型说“已经完成”不代表循环真的结束。每次实验入账时都必须结构化选择下一步：`continue`、`complete` 或 `needs_user`。只有完成状态真正写入账本后，自动续跑才会停止，顶部状态才会切换为“目标已完成”。

如果继续优化需要牺牲画质、扩大范围或接受其他取舍，插件不会擅自拍板，而是暂停并把一个明确问题交给用户。该自动的全部自动；涉及价值判断的，必须让用户决定。

### 三、监控应该留在视野里，而不是占用视野

研究过程可能很长，但对话仍然是主要工作区。确认目标后，创建卡会完全收起；等待、运行和结果都进入会话顶部栏。烧瓶入口默认折叠，展开后才显示最佳指标、相对基线、保留次数和最近实验，因此不会长期挤占对话内容区或输入区。

绿色不是装饰，而是“有一份尚未阅读的新结果”。用户打开面板后，它会恢复为中性状态；阅读回执保存在浏览器本地，刷新不会再次把旧结果伪装成新消息。

### 四、研究的单位是目标，不是对话

同一个项目可能先优化速度，再降低内存，之后又研究画质。新的明确目标会创建一轮独立研究，并立即取代顶部面板里的旧结果；历史实验仍保留在 `.auto/log.jsonl`，但不会阻碍下一轮，也不会把不同目标混成一张永远关不掉的卡。

## 一次 Autoresearch 如何发生

1. 用户输入 `/autoresearch`，选择“新开一次 Autoresearch”。
2. 只填写自然语言目标和轮次，确认前不会执行。
3. 插件自动保存本地保护点；Git 是否存在不再是使用门槛。
4. Agent 建立稳定测量与正确性检查，然后修改、运行、比较并记录实验。
5. 更好的结果被保留，无效或失败的结果被恢复；同会话由 Host 安全续跑。
6. 达成目标后自动结束；需要取舍时暂停等待用户；结果留在顶部面板，下一目标随时可以开始。

日常 prompt 不会偷偷激活循环。内部的 create / finalize / hooks 支持技能也不会出现在普通用户的技能自动补全中。

## 一分钟开始

当前包依赖 DSH `0.1.1-rc.2` 系列、一个 Web profile，以及 **Node.js 22.19+**。`dsh web` 会使用 `zlib.createZstdDecompress`，更早的 Node 22 版本可能无法启动。

```sh
git clone https://github.com/aa2246740/dsh-autoresearch.git
cd dsh-autoresearch
pnpm install --ignore-workspace
pnpm build
dsh plugin --profile web add link:/absolute/path/to/dsh-autoresearch -w
dsh web --port 43123
```

打开 DSH Web，进入一个项目会话，然后输入：

```text
/autoresearch
```

在弹出的菜单中选择“新开一次 Autoresearch”，填写目标与轮次，确认即可。无需创建 Git 仓库，无需编辑 `.auto/config.json`，也无需理解 keep / discard 协议。

### 常用命令

| 命令 | 含义 |
|---|---|
| `/autoresearch` | 新开一次、继续、查看、停止或清除 |
| `/autoresearch resume` | 继续一轮已暂停的研究 |
| `/autoresearch status` | 查看当前持久状态 |
| `/autoresearch off` | 停止自动续跑，保留已有结果 |
| `/autoresearch clear` | 清除当前项目的 Autoresearch 账本 |

活动循环也可以在顶部面板中暂停。已经结束的结果不显示“暂停”或没有持久意义的“关闭”按钮。

## 什么会自动，什么不会

| 场景 | 插件的处理 |
|---|---|
| 项目没有 Git | 尝试在本地初始化并保存安全基线；不可用时自动使用私有快照 |
| 项目已有未提交代码 | 保留现状并切换到私有快照，不改用户的 index 与历史 |
| 实验失败或检查不通过 | 恢复受保护文件，不允许作为有效改进保留 |
| 指标改善且检查通过 | 保留本轮结果，并把证据写入账本 |
| 下一步涉及质量或范围取舍 | 暂停并请用户确认，不替用户做价值判断 |
| 上传、推送或发布代码 | 永远不会自动执行，必须由用户另行明确决定 |
| 修改 DSH 核心 | 不会；本项目始终作为外部插件运行 |

这里的“自动”并不意味着“魔法”。可靠的研究仍然需要可重复的 `.auto/measure.sh` 和必要的 `.auto/checks.sh`。插件负责让循环、保护、记录与恢复可靠；指标是否真正代表产品目标，仍需要人来定义和审视。

## `.auto/` 是可审计的研究账本

| 文件 | 作用 |
|---|---|
| `.auto/prompt.md` | 实验说明书，换会话后仍可继续 |
| `.auto/measure.sh` | 稳定基准，输出 `METRIC name=number` |
| `.auto/checks.sh` | 可选正确性检查；失败不能保留 |
| `.auto/log.jsonl` | 权威实验日志，保留所有目标轮次 |
| `.auto/ideas.md` | 尚未尝试的假设与想法 |
| `.auto/config.json` | 轮次、续跑和工作目录等高级设置 |
| `.auto/hooks/{before,after}.sh` | 可选生命周期钩子，标准输入为 JSON |

完成、暂停和等待用户都是持久状态，不依赖聊天窗口里的一句文案。上下文被压缩或会话重开后，Agent 可以从这些文件恢复实验事实，而不是靠猜测接着跑。

## 开发与验证

```sh
pnpm install --ignore-workspace
pnpm typecheck
pnpm test
pnpm build
```

用 dshx 对一份 DeepSeek Harness checkout 检查外部插件合同与隔离冷启动：

```sh
dshx setup --harness /path/to/deepseek-harness
dshx check dsh-autoresearch
dshx verify-boot dsh-autoresearch --port 43123
```

外部 Web client 使用 dshx 的 `externalClientBundle()` 生成 lazy-CJS `lib/client.js`。`cordis.yml` 只保留相对路径；不要把本机绝对路径、`.env` 或 `.dshx/` 提交进仓库。构建通过只证明源码产物有效，真实 DSH Host 与浏览器界面仍应分别验证。

<details>
<summary>维护者：旧会话兼容与离线修复</summary>

从 `1.0.4` 起，插件不再向 DSH 会话日志写入外部自定义事件，只折叠官方 `command/run`、`command/done` 和 `tool/result`。升级时若发现旧版 `autoresearch/state`，插件会先保存字节级备份，仅补充 `ignorable: true`，原子替换后再交给当前 DSH 的官方会话加载器完整验证；任何失败都会恢复原文件。

2026-08-30 之前的版本还曾创建缺少 DSH `message.id` 的自动续跑消息。下面的工具只用于维护者在 Host 停止写入后生成独立候选文件，不会覆盖输入：

```sh
pnpm build
pnpm repair-session -- --input /path/to/session.jsonl.zstd --output /tmp/session.repaired.jsonl.zstd
```

修复器只接受已发布的 Autoresearch playbook 指纹，并要求 Inbox 插入与后续 `user/message` 成对出现。未知无 ID 消息、断开的配对或非法 splice 都会失败关闭。替换原会话前，仍须使用目标 DSH 版本完整加载候选文件。

</details>

## 许可

[MIT](./LICENSE)。实验循环核心移植自 grok-autoresearch（Copyright Tobi Lutke, David Cortes）；DSH Host 集成与 Web 界面为本仓库的新代码。
