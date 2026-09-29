# DSH Autoresearch

[中文](./README.md)

A durable research loop for DeepSeek Harness: set a goal, then let the agent edit, measure, keep or revert changes while the session panel shows progress. Current release: **1.0.10**, targeting official **DeepSeek Harness 0.2.0-rc.2**.

## Install

**Desktop / DSH Studio:** open **Settings → Plugins → Add plugin** and enter:

```text
github:aa2246740/dsh-autoresearch#v1.0.10
```

Follow the plugin manager's installation result. No clone or local build is required.

**Web:** with official `dsh`, Node.js 22.19+ and `pnpm` on PATH, run:

```sh
dsh plugin --profile web add github:aa2246740/dsh-autoresearch#v1.0.10
```

The CLI manages the Web profile only, not Desktop. Reopen that Web Host after CLI installation, then open its page. The repository and [Release](https://github.com/aa2246740/dsh-autoresearch/releases/latest) contain precompiled files. You can also download the Release `.tgz` and install it through the same official entry point.

To upgrade, install the latest Release. To uninstall, use the desktop plugin manager or:

```sh
dsh plugin --profile web remove dsh-autoresearch
```

## Start a run

Open a project session, enter `/autoresearch`, choose a new run, supply the goal and round limit, and confirm. Runs modify project files and execute local commands. The plugin does not upload or push project code. It uses the session's model and consumes that model's allowance while running.

This release retargets the Host peers to `>=0.2.0-rc.1 <0.2.1`. That range accepts `0.2.0-rc.2` and stable `0.2.0`, rejects alphas, and rejects `0.1.7-rc.2`.

The loop is based on [grok-autoresearch](https://github.com/aa2246740/grok-autoresearch) / [pi-autoresearch](https://github.com/aa2246740/pi-autoresearch).

## Commands

| Command | Meaning |
|---|---|
| `/autoresearch` | New run, continue, status, stop, or clear |
| `/autoresearch resume` | Continue a paused run |
| `/autoresearch status` | Current durable state |
| `/autoresearch off` | Stop auto-continue, keep results |
| `/autoresearch clear` | Clear this project's Autoresearch ledger |

Before a run it takes a local safety point: a Git baseline when that works, otherwise a private snapshot. `discard` / `crash` / `checks_failed` restore protected files. A model saying "done" does not finish the loop. The ledger must write `complete`. Value tradeoffs pause for you.

The ledger lives in project `.auto/`: `prompt.md`, `measure.sh`, optional `checks.sh`, `log.jsonl`, `ideas.md`, `config.json`.

## Develop

Skip this for a normal install. Rebuild the committed `lib/` with **pnpm** after TypeScript changes:

```sh
pnpm install --ignore-workspace
pnpm typecheck
pnpm test
pnpm build
```

## License

[MIT](./LICENSE). The loop core is ported from grok-autoresearch (Copyright Tobi Lutke, David Cortes). DSH Host integration and the Web UI are new in this repo.
