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
/monitor loop [path] [--all] [--json]        the loop document: structure + state transitions
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

## The loop document

A project's development flow is not a flat log of rounds. It is a tree — the whole
task at the top, its phases (inbound / outbound / deploy / rollback) below, and each
phase's own sub-flow (write the test, implement, verify). When something breaks, the
work leaves that flow along a **trial chain** and comes back when it is fixed.

`monitor/loops.yml` holds that tree plus the run through it: one time-stamped
transition per position change, `previous --because of this fact--> next`. The
transition *kind* is derived from the paths — deeper is entering a child loop, a
`trial` node is a detour, leaving it is a return, a sibling step is the flow
advancing — so a typo cannot invent a kind, and the model never labels an edge.

Nobody hand-writes the file. The supervisor maintains it through tools:

| verb | what it does |
| --- | --- |
| `monitor_loop declare` | create a phase / flow / step / trial node (missing ancestors are created as `phase`/`flow`) |
| `monitor_loop move` | record one transition when a round moved the work |
| `monitor_verdict` `loop` / `state` / `updates` | the cheap path: every round states where the loop now stands and what changed |
| `/monitor loop [path] [--all] [--json]` | read it back, for humans |

Omitting `loop` keeps the run where it is; omitting `state` records a stay, so a loop
that is going nowhere shows up as consecutive stays. A changed `state` is the useful
one: the state it replaced stays on the edge as `from`, and that pair is "it was wrong
here, and this fact is why".

```
企微入站上线（wecom-shift）
  入站（inbound） phase · 1 次到达 · 上次「链路通，等真实入站」
    开发流程（inbound/flow） flow · 经由其下步骤
      写测试（inbound/flow/test） step · 1 次到达 · 上次「写冒烟测试」
      实现（inbound/flow/impl） step · 2 次到达 · 上次「改域名后握手成功」
    试错：401（inbound/trial-401） 试错链 · 3 次到达 · 上次「定位：域名指错」

现在：部署 · 生产已上线（11-14 09:45）

── 状态转移 ──
11-14 09:08 → 实现 · 实现 bridge
11-14 09:10 ├▶ 试错：401 · 怀疑 token 错
            （实现 · 实现 bridge）
            事实：#525/#532/#586 三个 token 全 401
  11-14 09:16 → 试错：401 · 怀疑未部署
              事实：deploy#658 生产镜像 = 4f72e1f，非 HEAD
  11-14 09:20 → 试错：401 · 定位：域名指错
              事实：domains#766 .com 指到 web:3000；.ai 为空
11-14 09:24 ◀┤ 实现 · 改域名后握手成功
            更新：deploy/compose.yml#切 .com
```

The file is written atomically and validated on every write: bad paths, a timestamp
older than the last one, or a missing state are rejected with the line that has to
change, so a broken document never replaces a working one.

## The Loop page (right Sidebar)

The same document is also a page in the right Sidebar. Its entry sits on that
column's tool rail ("Loop"), and the page draws the run as a mermaid state graph:
a node per distinct position, an edge per transition with the fact that caused
it, so a trial chain reads as a detour that leaves the main line and comes back.

The graph opens on **the whole run**: scaled so the entire drawing fits the pane,
which is how the shape (where the main line goes, where it detours and returns)
becomes legible before any text is. To read it, zoom (＋, ⌘/Ctrl+wheel, or a
double-click) and drag to pan, one position at a time; `全图` puts the whole graph
back. Zooming is anchored on the pointer (the pane's centre for the buttons), so
the line under the cursor stays put instead of jumping to a corner. Because the
sidebar is narrow, the Host wraps labels by display width (CJK counts two, 18
columns per line) and cuts an edge's fact at 40 characters — the full sentence is
in the transition row below.

Under the graph the page lists the structure and every transition as rows —
number, time, kind (进入 / 推进 / 停留 / 分叉 / 回归 / 跨支), `from → to`, the fact,
and what was updated. Node ids in the graph come from the Host's own renderer
(`n1`, `n2`, …), so a later interaction can bind one node to one position without
guessing.

The page is read-only and fetches `GET /monitor/loop?session=<id>` from the Host:
the document lives on disk, the page runs in the browser, and one read per open
or refresh is enough (the document changes when a verdict lands, which is minutes
apart).

The browser half is bundled with esbuild — mermaid is ~3 MiB and the Harness
loads exactly one `client/client.js` per package:

```bash
npm run build          # client/src/client.js + mermaid → client/client.js
DSH_MONITOR_DEBUG=1 npm run build   # unminified, for readable stack traces
```

`mermaid` and `esbuild` are devDependencies; the built file is committed, so
installing the plugin needs no build step.

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
