# DSH Autoresearch

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that ports the durable experiment loop from [grok-autoresearch](https://github.com/aa2246740/grok-autoresearch) / [pi-autoresearch](https://github.com/aa2246740/pi-autoresearch). The ledger stays in `.auto/`. **Create, run, and monitor in the official Web GUI** (plus `/autoresearch`). Build and cold-boot through [dshx](https://github.com/aa2246740/dsh-external-plugin-devkit).

中文：[README.md](./README.md)

## Activation boundary

This is not ordinary chat. A random prompt must not start the loop. Only:

- `/autoresearch` → **Start a new Autoresearch** → configure, then confirm
- the composer tool-row **新开 Autoresearch** button (same config GUI)

set `active` to true. After that the model edits code, runs `.auto/measure.sh`, and must call `autoresearch_log_experiment`. `keep` commits; `discard` / `crash` / `checks_failed` revert code and preserve `.auto/`. Process and results render in the dedicated Lab overlay, not as a home-page chip.

Same-session auto-resume uses Host `agent.followup` until `maxIterations`, `/autoresearch off`, a stuck state, or an interrupt.

## Install

Requires `dsh` CLI (for example `@deepseek-ai/dsh@0.1.1-rc.2`), a Web profile, and **Node 22.19+** (`dsh web` uses `zlib.createZstdDecompress`).

```sh
pnpm install --ignore-workspace
pnpm build
dsh plugin --profile web add . -w
dsh web --port 43123
```

dshx against a Harness checkout:

```sh
dshx setup --harness /path/to/deepseek-harness
dshx check dsh-autoresearch
dshx verify-boot dsh-autoresearch --port 43123
dshx start web dsh-autoresearch
```

Do not commit machine-absolute paths in `cordis.yml`.

## License

MIT. Loop semantics ported from grok-autoresearch (Copyright Tobi Lutke, David Cortes). The DSH host and Web slots are new.
