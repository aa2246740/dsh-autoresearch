# DSH Autoresearch

[中文](./README.md)

```sh
dsh plugin --profile web add github:aa2246740/dsh-autoresearch
```

You need official `dsh` (or `npx @deepseek-ai/dsh`) and **pnpm** on `PATH`. `dsh plugin add` runs pnpm in `$DSH_HOME/profiles/web` and, because this package declares `dsh.bundle.patch`, appends the bundle to that profile. `lib/` is committed, so a git install does not need a local build, `prepare`, or `allowBuilds`.

Then **restart that Host and reload the page**. The command writes the profile. It does not hot-load a running process.

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web plugin for the experiment loop from [grok-autoresearch](https://github.com/aa2246740/grok-autoresearch) / [pi-autoresearch](https://github.com/aa2246740/pi-autoresearch). `/autoresearch` creates a goal. The agent edits, measures, keeps or rolls back. A collapsible bar at the top of the session reports results.

Official DeepSeek Harness **0.1.5-rc.2**, and Node.js 22.19+. `dsh web` uses `zlib.createZstdDecompress`.

The plugin does not upload or push project code.

Open a project session, type `/autoresearch`, pick a new run, fill the goal and round limit, confirm. DSH STORE review may still block the install because the loop reads project files and runs local commands. That is expected.

Official `@deepseek-ai/*` packages come from the DSH host. This plugin only lists them in `peerDependencies`. If the Web profile ever set `nodeLinker: hoisted`, delete that line from that profile's `pnpm-workspace.yaml` and run `pnpm install` there.

From a clone:

```sh
git clone https://github.com/aa2246740/dsh-autoresearch.git
dsh plugin --profile web add ./dsh-autoresearch
```

That path also needs pnpm, then a Host restart and page reload. `lib/` is already in the repo, so you do not need to build first.

```sh
dsh plugin --profile web remove dsh-autoresearch
```

DSH.app's `desktop` profile rejects `github:`. Use `dsh web` and install into the `web` profile.

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
