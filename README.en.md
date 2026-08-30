# DSH Autoresearch

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that ports the durable experiment loop from [grok-autoresearch](https://github.com/aa2246740/grok-autoresearch) / [pi-autoresearch](https://github.com/aa2246740/pi-autoresearch). The ledger stays in `.auto/`. **Create, run, and monitor in the official Web GUI** (plus `/autoresearch`). Build and cold-boot through [dshx](https://github.com/aa2246740/dsh-external-plugin-devkit).

中文：[README.md](./README.md)

## Activation boundary

This is not ordinary chat. A random prompt must not start the loop. The home page and composer tool row have **no** standing experiment control.

Type `/autoresearch` (or pick **Start a new Autoresearch** in the slash menu) to open a reserved init dock **above the composer**. Confirm is required before `active` becomes true. The init card has two fields: a natural-language goal (same as grok-autoresearch `/autoresearch <goal>`) and a round budget. Users never need to configure Git: the plugin reuses a clean repository when safe, creates local protection when needed, and silently falls back to private file snapshots when Git is missing, busy, or the project already has local work. Nothing is uploaded and an existing index/history is not polluted. New edit targets are added to protection before their first mutation. After confirm, the composer dock disappears completely. Waiting, running, and result monitoring move into a collapsed flask control in the session header, so the transcript keeps its reading height. The first `run_experiment` exposes the running state; the first `log_experiment` enables an anchored, bordered result board with the outcome and recent experiments. Click the trigger again, click outside, or press Escape to hide it.

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

## Maintainers: repairing legacy sessions

Plugin versions before 2026-08-30 constructed automatic follow-up prompts as plain objects and omitted DSH's required `message.id`. Current code creates every follow-up with the official `createUserMessage()` helper, and its regression test JSON-round-trips each message through the official session loader.

For an already affected session, stop the Host that can write it and create a separate candidate:

```sh
pnpm build
pnpm repair-session -- --input /path/to/session.jsonl.zstd --output /tmp/session.repaired.jsonl.zstd
```

The repair tool never overwrites its input. It only accepts fingerprints of released Autoresearch create/continue playbooks and requires each Inbox insertion to pair with the later `user/message`; unknown unidentified messages, broken pairs, and invalid splices fail closed. Fully load the candidate with the target DSH release before backing up and atomically replacing the original.

## License

MIT. Loop semantics ported from grok-autoresearch (Copyright Tobi Lutke, David Cortes). The DSH host and Web slots are new.
