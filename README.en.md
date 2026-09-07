# DSH Autoresearch

[中文](./README.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web plugin for the experiment loop from [grok-autoresearch](https://github.com/aa2246740/grok-autoresearch) / [pi-autoresearch](https://github.com/aa2246740/pi-autoresearch). `/autoresearch` creates a goal. The agent edits, measures, keeps or rolls back. A collapsible bar at the top of the session reports results.

Needs DSH `0.1.2-rc.1`, a Web profile, and Node.js 22.19+. `dsh web` uses `zlib.createZstdDecompress`.

The plugin does not upload or push project code. There is no install-time `prepare` / `preinstall` / `postinstall`. Build with `pnpm build` after clone. `lib/` is not in git.

## Install

```sh
git clone https://github.com/aa2246740/dsh-autoresearch.git
cd dsh-autoresearch
pnpm install --ignore-workspace
pnpm build
dsh plugin --profile web add . -w
dsh web --port 43123
```

Open a project session, type `/autoresearch`, pick a new run, fill the goal and round limit, confirm. DSH STORE review may still block the install because the loop reads project files and runs local commands. That is expected.

Official `@deepseek-ai/*` packages come from the DSH host. This plugin only lists them in `peerDependencies`. If the Web profile ever set `nodeLinker: hoisted`, delete that line from that profile's `pnpm-workspace.yaml` and run `pnpm install` there.

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

```sh
pnpm install --ignore-workspace
pnpm typecheck
pnpm test
pnpm build
dshx check dsh-autoresearch
dshx verify-boot dsh-autoresearch --port 43123
```

## License

[MIT](./LICENSE). The loop core is ported from grok-autoresearch (Copyright Tobi Lutke, David Cortes). DSH Host integration and the Web UI are new in this repo.
