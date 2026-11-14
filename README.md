# dsh-monitor

A [DeepSeek Harness](https://github.com/deepseek-ai/dsh) bundle plugin: put an AI
supervisor on another session.

`/monitor` runs a timer, hands the supervising session a compact snapshot of the
watched session, and gives it two verbs — look (`monitor_snapshot`) and speak
(`monitor_inject`). Judgement is left to the model; the plugin only does the
mechanical half. A 「派生监管者」 button in the session header derives a supervisor
for the session you are looking at.

中文说明见 [README.zh.md](./README.zh.md)。

## Install

```bash
# from this repository
dsh plugin add github:DaneelOlivaw1/dsh-monitor#main
```

or add it to a profile's `package.json` dependencies and `dsh.profile.bundles`.

## Use

In the session that should supervise:

```
/monitor <sessionId|latest> [everyMinutes]   start (first snapshot immediately)
/monitor status                              what is being watched
/monitor once [sessionId]                    one snapshot, off-schedule
/monitor inject <sessionId> <text>           push a note into the target
/monitor stop [sessionId|all]                stop
```

A session cannot supervise itself. The supervisor must stay alive; when it goes
away the watcher stops instead of ticking into the void.

## The supervisor skill

`skills/monitor-supervisor/SKILL.md` is the judgement method, registered as a
skill at boot and named by every tick. It fixes four verdicts —

`CONTINUE` · `INVESTIGATE` · `PIVOT_PROPOSAL` · `NO_NEW_EVIDENCE`

— requires an evidence pointer on each, forbids restating what a previous round
already said, and says that a failure shape seen a third time becomes a gate
(`.dsh/gates.yml`) instead of a third injection.

## Project governance template

`templates/governance/` is a framework-agnostic skeleton for a project's agent
workflow, in four layers: **roles** (`agents/*.md`), **process**
(`docs/dev-flow.md`), **gates** (`.dsh/gates.yml`), and **ledger** (`memory/`).

In a session:

```
/governance [<project dir>]
```

The command hands the work to a model, not to a copy script: it reads what the
project already has (`AGENTS.md`, `agents/`, `memory/`, `docs/`, `.dsh/gates.yml`,
and the real test/build commands), then only fills the missing layer — at most four
new files — instead of dropping a second parallel system next to the first one.

Each gate states a *necessary* condition only — something a program can count,
grep, or run — because a sufficient condition needs judgement and misfires.
`/monitor` supervises the same loop: the clock decides when to look, the gates
decide what counts as finished.

## Files

| path | role |
| --- | --- |
| `index.mjs` | server half: timer, snapshot, inject tools, receipts, skill registration |
| `client/client.js` | browser half: the 「派生监管者」 header button |
| `skills/monitor-supervisor/SKILL.md` | the judgement method |
| `cordis.patch.yml` | bundle patch with the default config |
| `templates/governance/` | project governance skeleton (roles / process / gates / ledger) |
| `skills/governance-init/SKILL.md` | the merge procedure `/governance` follows |

## Runtime data

| what | where |
| --- | --- |
| injection receipts | `$DSH_HOME/monitor/receipts.jsonl` |
| live watchers | `$DSH_HOME/monitor/status.json` |
| retrospective notes | `<target cwd>/memory/pitfalls/auto-monitor.md` |

## Development

The Harness reloads plugin source while it runs (`@deepseek-ai/dsh-hmr` watches the
package), so a change to `index.mjs` takes effect without restarting `dsh web`; a
change under `client/` needs a page refresh in the browser. Only dependency
installs, a port/instance change, or a new package entry need a real restart.

## Test

```bash
node --test test.mjs
```
