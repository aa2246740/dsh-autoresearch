# DSH Autoresearch

[English](./README.en.md)

为 DeepSeek Harness 添加持久化的自动研究循环：创建目标后，Agent 连续修改、测量、保留或回滚，会话顶部面板显示结果。当前正式版 **1.0.10**，适配官方 **DeepSeek Harness 0.2.0-rc.1**。

## 安装

**桌面版 / DSH Studio**：打开 **设置 → 插件 → 添加插件**，输入：

```text
github:aa2246740/dsh-autoresearch#v1.0.10
```

按插件管理器提示完成安装。普通用户无需 clone 仓库或本地构建。

**Web 版**：确保官方 `dsh`、Node.js 22.19+ 和 `pnpm` 在 PATH，运行：

```sh
dsh plugin --profile web add github:aa2246740/dsh-autoresearch#v1.0.10
```

Web CLI 只管理 Web profile，不会安装进桌面版。CLI 安装后正常重开该 Web Host，再打开页面。仓库和 [Release](https://github.com/aa2246740/dsh-autoresearch/releases/latest) 提供预编译产物；也可下载 Release 的 `.tgz`，从同一官方入口安装本地包。

升级时安装最新 Release。卸载使用桌面插件管理器，或：

```sh
dsh plugin --profile web remove dsh-autoresearch
```

## 开始使用

打开一个项目会话，输入 `/autoresearch`，选择新建研究，填写目标和轮次并确认。运行会修改项目文件并执行本机命令；插件不会上传或 push 项目代码。它沿用该会话的模型，持续执行会消耗模型额度。

本版把 Host peer 对齐到 `>=0.2.0-rc.1 <0.2.1`：接受 `0.2.0-rc.1` 和稳定版 `0.2.0`，拒绝 alpha，也拒绝 `0.1.7-rc.2`。

实验循环源自 [grok-autoresearch](https://github.com/aa2246740/grok-autoresearch) / [pi-autoresearch](https://github.com/aa2246740/pi-autoresearch)。

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
