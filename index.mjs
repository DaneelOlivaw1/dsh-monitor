/**
 * DSH bundle plugin: `/monitor` — put an AI supervisor on another session.
 *
 * The problem is not that a long-running agent is slow. It is that it can spend
 * an hour returning to the same place: run the same command, read the same log,
 * re-apply the same fix, declare victory without evidence. Nothing in the
 * transcript announces the loop; only a reader who compares "what it tried" with
 * "what changed" notices it.
 *
 * So this plugin deliberately does **not** hard-code detection rules. It does the
 * mechanical half and leaves the judgement to a model:
 *
 * - the **mechanics**: a timer, a compact snapshot of the target session (what it
 *   called, what came back, what it said, whether it is running, what its goal
 *   says), and a reliable way to push a message into that session;
 * - the **judgement**: the supervising session — the one where you typed
 *   `/monitor` — reads the snapshot and decides whether to intervene, and with
 *   what words. Its reasoning is visible to you and lands in a receipt file.
 *
 * Usage (typed in any interactive session):
 *
 *   /monitor <sessionId|latest> [everyMinutes]   start supervising (first tick now)
 *   /monitor status                              what is being watched
 *   /monitor once [sessionId]                    one snapshot round, off-schedule
 *   /monitor stop [sessionId|all]                stop supervising
 *
 * The supervisor gets a notice in its inbox on every tick, with two tools:
 * `monitor_snapshot` (look deeper) and `monitor_inject` (push guidance into the
 * target, and record why).
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'monitor'

/** Services this plugin needs. */
export const inject = ['agents', 'goals', 'tools', 'commands']

/** Source kind stamped on every injected user message, so the UI can label it. */
export const SOURCE_KIND = 'monitor'

/** Default interval between supervision ticks. */
export const DEFAULT_EVERY_MINUTES = 5

/** Package root, used to locate the bundled supervisor skill. */
const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url))

/** The judgement method the supervisor must follow on every tick. */
export const SUPERVISOR_SKILL = 'monitor-supervisor'

/** Event types worth putting in a snapshot; everything else is noise at this zoom. */
const INTERESTING = new Set([
  'tool/call',
  'tool/result',
  'assistant/message',
  'user/message',
  'turn/start',
  'turn/end',
  'goal/change',
  'compaction/end',
  // An unapproved tool is the most literal way a session stops moving: it is
  // waiting for a human. Surfacing it beats guessing at "stuck".
  'approval/asked',
  'approval/decided',
])

/**
 * Runtime schema for the plugin config. Every field is `.volatile()`, which puts
 * it on the settings page; an empty row is a valid row because `apply` falls back
 * to these defaults.
 */
export const Config = z.object({
  /** Master switch: off stops every tick and both tools. */
  enabled: z.boolean().default(true).volatile(),
  /** Interval used when `/monitor` names none. */
  defaultEveryMinutes: z.number().step(1).min(1).default(DEFAULT_EVERY_MINUTES).volatile(),
  /** How many recent interesting events one snapshot carries. */
  snapshotLimit: z.number().step(1).min(5).default(40).volatile(),
  /** Stop automatically after this many ticks; 0 means never. */
  maxTicks: z.number().step(1).min(0).default(0).volatile(),
  /** Injection receipt file (JSON lines); defaults to `$DSH_HOME/monitor/receipts.jsonl`. */
  receiptsPath: z.string().default('').volatile(),
  /** Live watcher status file; defaults to `$DSH_HOME/monitor/status.json`. */
  statusPath: z.string().default('').volatile(),
  /** Retrospective Markdown appended on a real intervention; empty disables it. */
  pitfallsPath: z.string().default('memory/pitfalls/auto-monitor.md').volatile(),
})

/** Read one config field, unwrapping a volatile reference. */
function read(field, fallback) {
  const value = typeof field?.get === 'function' ? field.get() : field
  return value ?? fallback
}

/**
 * Split a SKILL.md into frontmatter fields and body.
 *
 * Only the flat `key: value` form this package writes is understood; anything
 * nested stays in the raw line, which is enough for `name` and `description`.
 *
 * @param source - full SKILL.md text.
 * @returns `{ meta, body }`; body is the text after the frontmatter block.
 */
export function parseSkillDocument(source) {
  const text = String(source ?? '')
  if (!text.startsWith('---\n')) return { meta: {}, body: text }
  const end = text.indexOf('\n---\n', 4)
  if (end < 0) return { meta: {}, body: text }
  const meta = {}
  for (const line of text.slice(4, end).split('\n')) {
    const match = /^([a-zA-Z-]+):\s*(.*)$/.exec(line)
    if (match === null) continue
    const value = match[2].trim().replace(/^['"]|['"]$/g, '')
    if (value !== '') meta[match[1]] = value
  }
  return { meta, body: text.slice(end + 5).trimStart() }
}

/**
 * Load the bundled supervisor skill from this package.
 *
 * The judgement method lives in `skills/monitor-supervisor/SKILL.md` so it can be
 * read by a human, edited without touching code, and registered as a real skill.
 *
 * @param root - package root containing `skills/`.
 * @returns the arguments for `ctx.skills.register`.
 */
export function loadSupervisorSkill(root = PACKAGE_ROOT) {
  const path = join(root, 'skills', SUPERVISOR_SKILL, 'SKILL.md')
  const { meta, body } = parseSkillDocument(readFileSync(path, 'utf8'))
  if (body === '') throw new Error(`${path}: empty skill body`)
  return {
    name: meta.name ?? SUPERVISOR_SKILL,
    description: meta.description ?? '',
    content: body,
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'bundled',
    path,
    resourceBase: { kind: 'directory', path: root },
  }
}

/**
 * Fingerprint a snapshot for skip decisions.
 *
 * The rendered snapshot always carries a timestamp, so comparing raw text would
 * never match. The time line is the only field that changes when nothing else
 * does, so it is dropped before the comparison.
 *
 * @param snapshot - rendered snapshot text.
 * @returns the comparison key.
 */
export function snapshotFingerprint(snapshot) {
  return String(snapshot ?? '').replace(/^- 时间：.*$/gm, '').trim()
}

/** The five fixed lines every tick asks the supervisor for. */
export const TICK_FORMAT = [
  '**裁决** CONTINUE | INVESTIGATE | PIVOT_PROPOSAL | NO_NEW_EVIDENCE',
  '',
  '**前提**',
  '<一句话：它在验什么>',
  '',
  '**证据**',
  '- <指针> → <一句话说明>',
  '- <指针> → <一句话说明>',
  '',
  '**理由**',
  '<一句话：为什么是这个裁决>',
  '',
  '**下一轮盯**',
  '<一句话：下一轮看什么变了没有>',
]

/**
 * Build the tick instruction that wakes the supervisor.
 *
 * The instruction names the skill instead of restating it: one source of truth,
 * and a session that already loaded the skill does not pay for the text twice.
 *
 * @param options - tick number, interval, snapshot text, and the watched session.
 * @returns the message the supervisor receives.
 */
export function buildTickText({ tick, everyMinutes, snapshot, targetId, skill = SUPERVISOR_SKILL }) {
  return [
    `（monitor 巡检 · 第 ${tick} 次 · 每 ${everyMinutes} 分钟）`,
    '',
    snapshot,
    '',
    `按 \`${skill}\` 技能判断，严格按下面模板输出（字段各占一行、块与块之间空一行，不要把字段挤成一段）：`,
    ...TICK_FORMAT,
    '',
    '快照已经在上面了，不用再拉一次。要看更多 / 要说话，各两条路：',
    `- 看更多：优先 monitor_snapshot（session_id="${targetId}"，limit 调大）；`,
    `  工具报 unknown tool 就改用命令 /monitor once ${targetId} 200，不要重试工具。`,
    `- 要介入：优先 monitor_inject（session_id="${targetId}"，text=你要对目标说的话，`,
    '  reason=判断依据，kind=stuck|off_track|needs_context|idle）；',
    `  工具报 unknown tool 就改用命令 /monitor inject ${targetId} <你要说的话>。`,
    '- 不需要介入：裁决写 CONTINUE 或 NO_NEW_EVIDENCE，然后继续你手上的事。',
    '- 同一形态第 3 次出现：不要注入第 3 遍，改提议一条闸门（.dsh/gates.yml）并写进台账。',
    '- 你是监督者，不要替目标干活；注入要具体（点名命令/文件/下一步动作）。',
    '- 每块最多两句；证据 2–4 条，一条一个指针；没有新增就写「无新增」。',
  ].join('\n')
}

/** `$DSH_HOME`, falling back to `~/.dsh`. */
function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** Flatten text and bound it. */
function oneLine(text, limit = 200) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`
}

/**
 * Parse the text after `/monitor`.
 * @param raw - `invocation.rawInput`.
 * @returns a plain action record; never throws on user input.
 */
export function parseMonitorCommand(raw) {
  const tokens = String(raw ?? '').trim().split(/\s+/).filter(token => token !== '')
  if (tokens.length === 0) return { action: 'usage' }
  const head = tokens[0].toLowerCase()
  if (head === 'status' || head === 'list') return { action: 'status' }
  if (head === 'stop') return { action: 'stop', sessionId: tokens[1] ?? 'all' }
  if (head === 'once' || head === 'tick' || head === 'now') {
    const limit = Number(tokens[2])
    const action = { action: 'once', sessionId: tokens[1] ?? 'latest' }
    // A third token asks for a deeper snapshot; without one the plugin setting wins.
    if (Number.isFinite(limit) && limit > 0) action.limit = Math.trunc(limit)
    return action
  }
  if (head === 'inject') {
    return { action: 'inject', sessionId: tokens[1] ?? 'latest', text: tokens.slice(2).join(' ') }
  }
  const everyMinutes = Number(tokens[1])
  return {
    action: 'start',
    sessionId: tokens[0],
    everyMinutes: Number.isFinite(everyMinutes) && everyMinutes > 0 ? everyMinutes : DEFAULT_EVERY_MINUTES,
  }
}

/** Build the user-role message the harness persists for an injected note. */
function monitorMessage(text, summary) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: SOURCE_KIND, form: 'notice', summary },
  }
}

/** Read every event a live agent's session holds, oldest first. */
function eventsOf(agent) {
  const session = agent?.session
  if (session === undefined) return []
  try {
    if (typeof session.snapshotEvents === 'function') return session.snapshotEvents()
  } catch {
    // fall through to the surface walk
  }
  const nodes = session.surface?.nodes
  if (!Array.isArray(nodes) || typeof session.eventAt !== 'function') return []
  const events = []
  for (const seq of nodes) {
    const event = session.eventAt(seq)
    if (event !== undefined) events.push(event)
  }
  return events
}


/** Pending questions a root agent is waiting on, from the user-questions projection. */
export function pendingQuestionsOf(agent) {
  try {
    const projection = agent?.session?.projections?.userQuestions
    const value = typeof projection?.get === 'function' ? projection.get() : projection
    const active = value?.questions?.active
    return Array.isArray(active) ? active : []
  } catch {
    return []
  }
}

/** Render the text of one assistant message. */
function assistantText(event) {
  const content = event?.data?.message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block?.type === 'text')
    .map(block => String(block.text ?? ''))
    .join(' ')
    .trim()
}

/** Render one tool result, error first. */
function resultText(event) {
  const error = event?.data?.error
  const content = event?.data?.message?.content
  const body = Array.isArray(content)
    ? content.map(block => (typeof block?.text === 'string' ? block.text : '')).join(' ')
    : ''
  if (error !== undefined) return `Error ${error.code ?? ''}: ${error.reason ?? body}`
  return body
}

/**
 * Compact, model-readable snapshot of one session.
 *
 * Deterministic facts only — repetition counts are stated, never interpreted.
 * The supervisor reads this and decides.
 * @param input.agent - the live target agent.
 * @param input.goal - the current goal view, if any.
 * @param input.limit - how many recent interesting events to render.
 * @param input.now - timestamp for the header.
 * @returns the snapshot text.
 */
export function renderSnapshot({ agent, goal, limit = 40, now = Date.now() }) {
  const id = agent?.id ?? '(unknown)'
  const status = agent?.status ?? 'unknown'
  const events = eventsOf(agent)
  const picked = []
  for (let index = events.length - 1; index >= 0 && picked.length < limit; index -= 1) {
    const event = events[index]
    if (INTERESTING.has(event?.type)) picked.push(event)
  }
  picked.reverse()

  // Count identical (tool, arguments) calls and identical results: the cheapest
  // honest signal of a loop, stated as fact rather than as a verdict.
  const callCounts = new Map()
  const resultCounts = new Map()
  for (const event of picked) {
    if (event.type === 'tool/call') {
      const key = `${event.data?.name} ${oneLine(event.data?.arguments, 160)}`
      callCounts.set(key, (callCounts.get(key) ?? 0) + 1)
    }
    if (event.type === 'tool/result') {
      const key = oneLine(resultText(event), 160)
      resultCounts.set(key, (resultCounts.get(key) ?? 0) + 1)
    }
  }
  const repeated = [...callCounts.entries()].filter(([, count]) => count > 1).sort((a, b) => b[1] - a[1]).slice(0, 3)
  const repeatedResults = [...resultCounts.entries()].filter(([, count]) => count > 1).sort((a, b) => b[1] - a[1]).slice(0, 3)

  const asked = new Map()
  for (const event of events) {
    if (event?.type === 'approval/asked') asked.set(event.data?.id, event.data?.toolName ?? 'unknown')
    else if (event?.type === 'approval/decided') asked.delete(event.data?.id)
  }

  const lines = [
    `## 目标会话快照 · ${id}`,
    `- 时间：${new Date(now).toISOString()}`,
    `- 状态：${status}`,
    `- goal：${goal === undefined ? '(无)' : `${goal.phase} · ${goal.roundsStarted ?? 0}/${goal.maxGoalRounds ?? '?'} 轮 · ${oneLine(goal.objective, 160)}`}`,
  ]
  const boundary = safeTurnBoundary(agent)
  if (boundary !== undefined) lines.push(`- 当前 turn：${boundary}`)
  if (asked.size > 0) {
    lines.push(`- ⚠ 正在等审批：${[...asked.values()].join(', ')}（无人批准就会一直停在这）`)
  }
  const pending = pendingQuestionsOf(agent)
  if (pending.length > 0) {
    lines.push('- ❓ 挂起提问（它在等人回答，不算卡死但也推不动）：')
    for (const item of pending) {
      for (const question of item.questions ?? []) {
        const options = Array.isArray(question.options)
          ? `（选项：${question.options.map(option => option.label).join(' / ')}）`
          : ''
        lines.push(`  - callId=${item.callId} · [${question.id}] ${oneLine(question.question, 160)}${options}`)
      }
    }
  }
  if (repeated.length > 0) {
    lines.push('- 窗口内重复调用：')
    for (const [key, count] of repeated) lines.push(`  - ×${count} ${key}`)
  }
  if (repeatedResults.length > 0) {
    lines.push('- 窗口内重复结果：')
    for (const [key, count] of repeatedResults) lines.push(`  - ×${count} ${key}`)
  }
  lines.push(`- 最近 ${picked.length} 条事件（旧→新）：`)

  for (const event of picked) {
    const seq = event.seq === undefined ? '?' : event.seq
    switch (event.type) {
      case 'tool/call':
        lines.push(`  #${seq} call ${event.data?.name} ${oneLine(event.data?.arguments, 180)}`)
        break
      case 'tool/result':
        lines.push(`  #${seq} result ${oneLine(resultText(event), 180)}`)
        break
      case 'assistant/message': {
        const text = assistantText(event)
        if (text !== '') lines.push(`  #${seq} assistant「${oneLine(text, 200)}」`)
        else lines.push(`  #${seq} assistant (无正文，仅工具/推理)`)
        break
      }
      case 'user/message':
        lines.push(`  #${seq} user「${oneLine(event.data?.content?.map?.(b => b?.text ?? '').join(' ') ?? '', 160)}」`)
        break
      case 'turn/end':
        lines.push(`  #${seq} turn/end ${oneLine(JSON.stringify(event.data?.reason ?? ''), 80)}`)
        break
      case 'goal/change':
        lines.push(`  #${seq} goal/${event.data?.operation ?? 'change'}`)
        break
      default:
        lines.push(`  #${seq} ${event.type}`)
    }
  }
  return lines.join('\n')
}

/** Best-effort open-turn rendering; a projection shape change must not break a tick. */
function safeTurnBoundary(agent) {
  try {
    const stats = agent?.session?.projections?.sessionStats
    const value = typeof stats?.get === 'function' ? stats.get() : stats
    const open = value?.openStep
    if (open !== undefined && open !== null) return `turn ${open.turn} step ${open.step}（进行中）`
    const lastTurn = value?.lastTurn
    return lastTurn === undefined ? undefined : `last turn ${lastTurn}（已结束）`
  } catch {
    return undefined
  }
}

/** Write the live watcher status file (atomic, never throws). */
function writeStatus(path, watchers) {
  try {
    const body = JSON.stringify({
      version: 1,
      plugin: name,
      updatedAt: new Date().toISOString(),
      watchers,
    }, null, 2)
    mkdirSync(dirname(path), { recursive: true })
    const temporary = `${path}.${process.pid}.tmp`
    writeFileSync(temporary, `${body}\n`, 'utf8')
    renameSync(temporary, path)
  } catch {
    // Status is a convenience; a failure must not stop a tick.
  }
}

/** Append one JSON receipt line (never throws). */
function appendReceipt(path, record) {
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8')
  } catch {
    // Receipts are best-effort.
  }
}

/** Append one retrospective Markdown entry (never throws). */
function appendPitfall(path, entry) {
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, entry, 'utf8')
  } catch {
    // Retrospective is best-effort.
  }
}

/**
 * Register the `/monitor` command, the timer, and the two supervisor tools.
 * @param ctx - plugin context.
 * @param config - resolved {@link Config}.
 */
export function apply(ctx, config) {
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })

  // The bundled skill is the judgement method itself. Registering it means the
  // supervising session can load it by name, and code and prose stay one artifact.
  ctx.inject(['skills'], (child) => {
    try {
      const skill = loadSupervisorSkill()
      child.effect(() => child.skills.register(skill), 'monitor: supervisor skill')
    } catch (error) {
      ctx.logger?.warn?.(`monitor: supervisor skill not registered: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  const enabled = read(config.enabled, true) !== false
  const defaultEveryMinutes = Math.max(1, Math.trunc(Number(read(config.defaultEveryMinutes, DEFAULT_EVERY_MINUTES))))
  const snapshotLimit = Math.max(5, Math.trunc(Number(read(config.snapshotLimit, 40))))
  const maxTicks = Math.max(0, Math.trunc(Number(read(config.maxTicks, 0))))
  const receiptsSetting = String(read(config.receiptsPath, ''))
  const statusSetting = String(read(config.statusPath, ''))
  const pitfallsSetting = String(read(config.pitfallsPath, 'memory/pitfalls/auto-monitor.md'))
  const receiptsPath = receiptsSetting === '' ? join(dshHome(), 'monitor', 'receipts.jsonl') : receiptsSetting
  const statusPath = statusSetting === '' ? join(dshHome(), 'monitor', 'status.json') : statusSetting

  /** targetSessionId → watcher. */
  const watchers = new Map()
  /** Recently seen agents, for `latest` and for liveness checks. */
  const known = new Map()

  ctx.on('agent/created', ({ agent }) => {
    if (agent?.id !== undefined) known.set(agent.id, agent)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    if (agent?.id !== undefined) known.delete(agent.id)
  })

  let lastRegistryDump = []

  /** Resolve a live agent by session id. */
  function agentOf(sessionId) {
    try {
      const live = ctx.agents.get(sessionId)
      if (live !== undefined) return live
    } catch {
      // fall through to a full scan
    }
    // A session that was disposed and resumed may not be keyed by the id we were
    // given, and it may predate this plugin's `agent/created` listener. Scan the
    // live registry before declaring it offline.
    try {
      const all = ctx.agents.list()
      const items = all instanceof Map ? [...all.values()] : (Array.isArray(all) ? all : [])
      {
        lastRegistryDump = items.slice(0, 20).map(a => ({
          id: a?.id,
          sessionId: a?.sessionId,
          sessionSessionId: a?.session?.id ?? a?.session?.sessionId,
        }))
      }
      const found = items.find(candidate => (
        candidate?.id === sessionId
        || candidate?.sessionId === sessionId
        || candidate?.session?.id === sessionId
        || candidate?.session?.sessionId === sessionId
      ))
      if (found !== undefined) return found
    } catch {
      // fall through to the seen map
    }
    return known.get(sessionId)
  }

  /** Resolve `latest` to the most recently active agent other than the caller. */
  function resolveTarget(sessionId, caller) {
    if (sessionId !== undefined && sessionId !== '' && sessionId !== 'latest') return agentOf(sessionId)
    let best
    for (const agent of known.values()) {
      if (caller !== undefined && agent.id === caller.id) continue
      if (agent.parentAgent !== undefined) continue
      const at = agent.session?.projections?.sessionStats
      const value = typeof at?.get === 'function' ? at.get() : at
      const stamp = value?.openStep?.startTime ?? 0
      if (best === undefined || stamp > best.stamp) best = { agent, stamp }
    }
    return best?.agent
  }

  /** Snapshot text for one agent. */
  function snapshotOf(agent, limit = snapshotLimit) {
    const goal = (() => {
      try {
        return ctx.goals.get(agent)
      } catch {
        return undefined
      }
    })()
    return renderSnapshot({ agent, goal, limit })
  }

  /** Deliver one tick notice to the supervising agent. */
  function deliverToSupervisor(supervisor, text, summary) {
    if (supervisor === undefined) return false
    const message = monitorMessage(text, summary)
    try {
      if (supervisor.status === 'running') supervisor.inject(message)
      else supervisor.followup(message)
      return true
    } catch {
      return false
    }
  }

  /** Build the tick instruction that wakes the supervisor. */
  function tickText(watcher, tick, snapshot) {
    return buildTickText({
      tick,
      everyMinutes: watcher.everyMinutes,
      snapshot,
      targetId: watcher.targetId,
    })
  }

  /** Run one supervision tick for one watcher. */
  function tick(watcher) {
    if (!enabled) return
    const target = agentOf(watcher.targetId)
    if (target === undefined) {
      deliverToSupervisor(
        agentOf(watcher.supervisorId),
        `（monitor）目标会话 ${watcher.targetId} 已不在线（可能已关闭或未被加载）。`
          + `用 /monitor stop ${watcher.targetId} 停掉，或换一个会话重新 /monitor。`,
        'monitor：目标离线',
      )
      return
    }
    watcher.ticks += 1
    watcher.lastTickAt = Date.now()
    const snapshot = snapshotOf(target)
    const fingerprint = snapshotFingerprint(snapshot)
    // A tick with nothing new to say costs a full supervisor turn. When the target
    // has not moved since the last round, skip the delivery entirely.
    if (fingerprint === watcher.lastFingerprint) {
      watcher.skipped = (watcher.skipped ?? 0) + 1
      writeStatus(statusPath, describe())
      if (maxTicks > 0 && watcher.ticks >= maxTicks) stopWatcher(watcher.targetId, 'reached maxTicks')
      return
    }
    watcher.lastFingerprint = fingerprint
    watcher.lastSnapshot = snapshot
    const delivered = deliverToSupervisor(
      agentOf(watcher.supervisorId),
      tickText(watcher, watcher.ticks, snapshot),
      `monitor 巡检 #${watcher.ticks}`,
    )
    if (maxTicks > 0 && watcher.ticks >= maxTicks) stopWatcher(watcher.targetId, 'reached maxTicks')
    writeStatus(statusPath, describe())
    if (!delivered) {
      // The supervisor is gone; stop rather than ticking into the void.
      stopWatcher(watcher.targetId, 'supervisor offline')
    }
  }

  /** Start (or restart) one watcher. */
  function startWatcher(target, supervisor, everyMinutes) {
    stopWatcher(target.id, 'restarted', { silent: true })
    const watcher = {
      targetId: target.id,
      targetTitle: oneLine(target.session?.title ?? '', 60),
      supervisorId: supervisor?.id ?? '',
      everyMinutes,
      startedAt: Date.now(),
      lastTickAt: 0,
      ticks: 0,
      lastSnapshot: '',
      lastFingerprint: undefined,
      skipped: 0,
      timer: undefined,
      lastInjection: undefined,
    }
    watcher.timer = setInterval(() => {
      try {
        tick(watcher)
      } catch (error) {
        ctx.logger?.warn?.(`monitor: tick failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }, everyMinutes * 60_000)
    watcher.timer?.unref?.()
    watchers.set(target.id, watcher)
    writeStatus(statusPath, describe())
    tick(watcher)
    return watcher
  }

  /** Stop one watcher, or every watcher with `all`. */
  function stopWatcher(targetId, reason = 'stopped', options = {}) {
    const targets = targetId === 'all' ? [...watchers.keys()] : [targetId]
    let stopped = 0
    for (const id of targets) {
      const watcher = watchers.get(id)
      if (watcher === undefined) continue
      if (watcher.timer !== undefined) clearInterval(watcher.timer)
      watchers.delete(id)
      stopped += 1
      if (options.silent !== true) {
        appendReceipt(receiptsPath, { at: new Date().toISOString(), event: 'stop', target: id, reason })
      }
    }
    writeStatus(statusPath, describe())
    return stopped
  }

  /** Plain description of every watcher, for status output and the status file. */
  function describe() {
    return [...watchers.values()].map(watcher => ({
      targetId: watcher.targetId,
      targetTitle: watcher.targetTitle,
      supervisorId: watcher.supervisorId,
      everyMinutes: watcher.everyMinutes,
      ticks: watcher.ticks,
      skipped: watcher.skipped ?? 0,
      lastTickAt: watcher.lastTickAt === 0 ? '' : new Date(watcher.lastTickAt).toISOString(),
      startedAt: new Date(watcher.startedAt).toISOString(),
      lastInjection: watcher.lastInjection,
    }))
  }

  /** Inject one message into a target session and record why. */
  function injectInto(target, text, reason, kind, mode) {
    const content = String(text ?? '').trim()
    if (content === '') return { ok: false, message: 'text 不能为空。' }
    const body = mode === 'queue'
      ? content
      : `${content}`
    const message = monitorMessage(body, `monitor 注入（${kind || 'guidance'}）`)
    try {
      if (mode === 'queue') target.followup(message)
      else target.steer(message)
    } catch (error) {
      return { ok: false, message: `注入失败：${error instanceof Error ? error.message : String(error)}` }
    }
    const watcher = watchers.get(target.id)
    if (watcher !== undefined) {
      watcher.lastInjection = { at: new Date().toISOString(), kind: kind || 'guidance', reason: oneLine(reason, 160) }
    }
    appendReceipt(receiptsPath, {
      at: new Date().toISOString(),
      event: 'inject',
      target: target.id,
      supervisor: watcher?.supervisorId ?? '',
      kind: kind || 'guidance',
      mode: mode === 'queue' ? 'queue' : 'steer',
      reason: oneLine(reason, 400),
      text: content,
    })
    if (pitfallsSetting.trim() !== '' && (kind === 'stuck' || kind === 'off_track' || kind === 'idle')) {
      const base = safeWorkingDirectory(target) ?? process.cwd()
      const retroPath = isAbsolute(pitfallsSetting) ? pitfallsSetting : resolve(base, pitfallsSetting)
      const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
      appendPitfall(retroPath, [
        '',
        `## ${stamp} · monitor · ${oneLine(target.id, 28)}`,
        '',
        `- 判定：${kind}`,
        `- 依据：${oneLine(reason, 300)}`,
        `- 注入：${oneLine(content, 300)}`,
        '',
      ].join('\n'))
    }
    writeStatus(statusPath, describe())
    return { ok: true, message: `已注入到 ${target.id}（${mode === 'queue' ? '下一轮' : '下一步'}生效）。` }
  }

  /** Best-effort working directory of a target agent. */
  function safeWorkingDirectory(agent) {
    try {
      const projection = agent?.session?.projections?.workingDirectory
      const value = typeof projection?.get === 'function' ? projection.get() : projection
      if (typeof value === 'string' && value !== '') return value
    } catch {
      // ignore
    }
    return undefined
  }

  if (enabled) {
    ctx.commands.register({
      definitionId: '@deepseek-ai/dsh-monitor/monitor',
      name: 'monitor',
      description: 'Put an AI supervisor on another session: snapshot it, judge it, inject guidance',
      input: { hint: '[<sessionId|latest> [everyMinutes] | status | once [id] | stop [id|all]]' },
      handler: (invocation) => {
        const parsed = parseMonitorCommand(invocation.rawInput)
        if (parsed.action === 'usage') {
          return {
            kind: 'success',
            text: [
              '用法：',
              '  /monitor <sessionId|latest> [everyMinutes]   开始监控（默认 5 分钟一轮，首轮立即）',
              '  /monitor status                              看正在监控谁',
              '  /monitor once [sessionId]                    立即巡检一次',
              '  /monitor stop [sessionId|all]                停止',
              '',
              watchers.size === 0 ? '当前没有在监控任何会话。' : `当前监控 ${watchers.size} 个会话。`,
            ].join('\n'),
          }
        }
        if (parsed.action === 'status') {
          if (watchers.size === 0) return { kind: 'success', text: '当前没有在监控任何会话。用 /monitor <sessionId> 开始。' }
          return {
            kind: 'success',
            text: describe().map(item => [
              `目标：${item.targetId}${item.targetTitle === '' ? '' : `（${item.targetTitle}）`}`,
              `  监督者：${item.supervisorId}`,
              `  间隔：${item.everyMinutes} 分钟 · 已巡检 ${item.ticks} 次（没动静跳过 ${item.skipped} 次） · 上次 ${item.lastTickAt || '(尚未)'}`,
              item.lastInjection === undefined ? '  尚未注入' : `  上次注入：${item.lastInjection.kind} · ${item.lastInjection.reason}`,
            ].join('\n')).join('\n\n'),
          }
        }
        if (parsed.action === 'stop') {
          const stopped = stopWatcher(parsed.sessionId)
          return stopped === 0
            ? { kind: 'error', text: `没有在监控 ${parsed.sessionId}。` }
            : { kind: 'success', text: `已停止 ${stopped} 个监控。` }
        }
        if (parsed.action === 'once') {
          const target = resolveTarget(parsed.sessionId, invocation.agent)
          if (target === undefined) return { kind: 'error', text: `找不到会话 ${parsed.sessionId}。` }
          return { kind: 'success', text: snapshotOf(target, parsed.limit ?? snapshotLimit) }
        }
        if (parsed.action === 'inject') {
          const target = resolveTarget(parsed.sessionId, invocation.agent)
          if (target === undefined) return { kind: 'error', text: `找不到会话 ${parsed.sessionId}。` }
          const outcome = injectInto(target, parsed.text, '手动注入', 'guidance', 'steer')
          return { kind: outcome.ok ? 'success' : 'error', text: outcome.message }
        }
        const target = resolveTarget(parsed.sessionId, invocation.agent)
        if (target === undefined) {
          return { kind: 'error', text: `找不到在线会话 ${parsed.sessionId}。它可能已关闭；先用 /monitor status 看有哪些在监控。` }
        }
        if (invocation.agent !== undefined && target.id === invocation.agent.id) {
          return { kind: 'error', text: '不能监控自己：换一个目标会话 id。' }
        }
        const watcher = startWatcher(target, invocation.agent, parsed.everyMinutes)
        return {
          kind: 'success',
          text: [
            `已开始监控 ${target.id}（每 ${parsed.everyMinutes} 分钟一轮，首轮快照如下）。`,
            '',
            watcher.lastSnapshot === '' ? snapshotOf(target) : watcher.lastSnapshot,
            '',
            '每一轮我会收到这条快照并自己判断；要介入就调用 monitor_inject。',
            '停止：/monitor stop ' + target.id,
          ].join('\n'),
        }
      },
    })
  }

  if (!enabled) return

  // The tools are the supervisor's hands. Deliberately two small verbs: look, and speak.
  // Registered as plain definitions (the shape `tools.register` validates) rather
  // than through `defineTool`, so this package needs no import from the host.
  ctx.tools.register({
    name: 'monitor_snapshot',
    description: 'Read a compact snapshot of another session: recent tool calls and their results, what the agent said, whether it is running, and its goal state. Use it to judge whether that session is making progress.',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Target session id (the value after /monitor).' },
        limit: { type: 'number', description: 'How many recent events to render; defaults to the plugin setting.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      // A tool result is content blocks, not a bare string: the pipeline stores
      // whatever this returns as `result.content`.
      render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
    },
    execute: (args) => {
      const sessionId = String(args?.session_id ?? '')
      const target = agentOf(sessionId)
      if (target === undefined) return `会话 ${sessionId} 不在线。registry=${JSON.stringify(lastRegistryDump).slice(0, 600)}`
      const limit = Number.isFinite(Number(args?.limit)) && Number(args?.limit) > 0
        ? Math.trunc(Number(args?.limit))
        : snapshotLimit
      return snapshotOf(target, limit)
    },
  })

  ctx.tools.register({
    name: 'monitor_inject',
    description: 'Push one guidance message into another session (steer: takes effect on its next step and wakes it if idle; queue: waits for its next turn). Record the judgement behind it — the reason is the retrospective.',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Target session id.' },
        text: { type: 'string', description: 'What to tell the target agent. Be concrete: name the command, file, or next action.' },
        reason: { type: 'string', description: 'Why you judge it stuck or off track: the evidence from the snapshot.' },
        kind: { type: 'string', description: 'One of stuck | off_track | needs_context | idle | guidance.' },
        mode: { type: 'string', description: 'steer (default, next step) or queue (next turn).' },
      },
      required: ['session_id', 'text'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      // A tool result is content blocks, not a bare string: the pipeline stores
      // whatever this returns as `result.content`.
      render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
    },
    execute: (args) => {
      const sessionId = String(args?.session_id ?? '')
      const target = agentOf(sessionId)
      if (target === undefined) return `会话 ${sessionId} 不在线，无法注入。`
      const outcome = injectInto(
        target,
        String(args?.text ?? ''),
        String(args?.reason ?? ''),
        String(args?.kind ?? 'guidance'),
        String(args?.mode ?? 'steer'),
      )
      return outcome.message
    },
  })

  ctx.tools.register({
    name: 'monitor_answer',
    description: 'Answer a pending ask_user_question on another session so it stops waiting for a human. `answers` must name every question of that call exactly once: [{ id, selected?: string[], custom?: string }]. Read the pending callId and question ids from monitor_snapshot.',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Target session id.' },
        call_id: { type: 'string', description: 'callId of the pending ask_user_question, from monitor_snapshot.' },
        answers: {
          type: 'array',
          description: 'One entry per question of that call. Empty selected + no custom means skipped.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              selected: { type: 'array', items: { type: 'string' } },
              custom: { type: 'string' },
            },
            required: ['id'],
            additionalProperties: false,
          },
        },
        reason: { type: 'string', description: 'Why you answered this way: the goal rule you applied.' },
      },
      required: ['session_id', 'call_id', 'answers'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
    },
    execute: (args) => {
      const sessionId = String(args?.session_id ?? '')
      const target = agentOf(sessionId)
      if (target === undefined) return `会话 ${sessionId} 不在线，无法回答。`
      const service = ctx.get?.('userQuestions')
      if (service === undefined || typeof service.answer !== 'function') return '这个 host 没有 userQuestions 服务，无法回答挂起提问。'
      const callId = String(args?.call_id ?? '')
      try {
        const accepted = service.answer(target, callId, {
          answers: Array.isArray(args?.answers) ? args.answers : [],
        })
        if (!accepted) return `没有 callId=${callId} 的挂起提问（可能已答过或它已经继续了）。`
        appendReceipt(receiptsPath, {
          at: new Date().toISOString(),
          event: 'answer',
          target: target.id,
          supervisor: watchers.get(target.id)?.supervisorId ?? '',
          callId,
          reason: oneLine(String(args?.reason ?? ''), 400),
          answers: args?.answers,
        })
        return `已回答 ${callId}，它会带着这个答案继续。`
      } catch (error) {
        return `回答失败：${error instanceof Error ? error.message : String(error)}`
      }
    },
  })

  ctx.tools.register({
    name: 'monitor_policy',
    description: 'Set the approval policy of another session: never | ask. "never" lets it run unattended instead of stopping on a permission prompt; only use it when you accept that its tool calls stop asking.',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Target session id.' },
        policy: { type: 'string', description: 'never or ask. Omit to leave the approval policy alone.' },
        preset: { type: 'string', description: 'Permission preset to apply instead, e.g. danger-full-access: writes outside the workspace stop asking.' },
        reason: { type: 'string', description: 'Why this policy change is safe for the current task.' },
      },
      required: ['session_id'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
    },
    execute: (args) => {
      const sessionId = String(args?.session_id ?? '')
      const target = agentOf(sessionId)
      if (target === undefined) return `会话 ${sessionId} 不在线。registry=${JSON.stringify(lastRegistryDump).slice(0, 600)}`
      const preset = String(args?.preset ?? '')
      if (preset !== '') {
        const presets = ctx.get?.('permissionPresets')
        if (presets === undefined || typeof presets.set !== 'function') return '这个 host 没有 permissionPresets 服务。'
        try {
          presets.set(target.session, preset)
          appendReceipt(receiptsPath, {
            at: new Date().toISOString(),
            event: 'preset',
            target: target.id,
            preset,
            reason: oneLine(String(args?.reason ?? ''), 400),
          })
          return `已把 ${target.id} 的权限预设设为 ${preset}（注意：已挂起的那次审批不会因此自动放行）。`
        } catch (error) {
          return `设置预设失败：${error instanceof Error ? error.message : String(error)}`
        }
      }
      const policy = String(args?.policy ?? '')
      if (policy !== 'never' && policy !== 'ask') return 'policy 只能是 never 或 ask（或者给 preset）。'
      const service = ctx.get?.('approval')
      if (service === undefined || typeof service.setPolicy !== 'function') return '这个 host 没有 approval 服务，无法改审批策略。'
      try {
        service.setPolicy(target, policy)
        appendReceipt(receiptsPath, {
          at: new Date().toISOString(),
          event: 'policy',
          target: target.id,
          policy,
          reason: oneLine(String(args?.reason ?? ''), 400),
        })
        return `已把 ${target.id} 的审批策略设为 ${policy}。`
      } catch (error) {
        return `设置失败：${error instanceof Error ? error.message : String(error)}`
      }
    },
  })

  ctx.tools.register({
    name: 'monitor_goal',
    description: 'Resume or pause the goal of another session without relying on that session to do it itself. A cancelled turn pauses the goal, and a paused goal stops automatic continuation.',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Target session id.' },
        action: { type: 'string', description: 'resume, pause, cancel (abort the open turn), or rounds (raise the round cap).' },
        max_rounds: { type: 'number', description: 'With action=rounds: the new cap.' },
        reason: { type: 'string', description: 'Why this change is right for the objective.' },
      },
      required: ['session_id', 'action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
    },
    execute: (args) => {
      const sessionId = String(args?.session_id ?? '')
      const target = agentOf(sessionId)
      if (target === undefined) return `会话 ${sessionId} 不在线。registry=${JSON.stringify(lastRegistryDump).slice(0, 600)}`
      const action = String(args?.action ?? '')
      const goal = (() => {
        try {
          return ctx.goals.get(target)
        } catch {
          return undefined
        }
      })()
      if (goal === undefined) return `${sessionId} 当前没有 goal。`
      const ref = { id: goal.id, revision: goal.revision }
      try {
        if (action === 'resume') ctx.goals.resume(target, ref)
        else if (action === 'pause') ctx.goals.pause(target, ref)
        else if (action === 'cancel') {
          // Abort the open turn. A turn blocked on ask_user_question never admits
          // an inbox message, so a supervisor must be able to clear it in-process.
          target.cancel('monitor: cancelled a blocked turn')
        }
        else if (action === 'rounds') {
          const cap = Math.trunc(Number(args?.max_rounds ?? 0))
          if (!Number.isFinite(cap) || cap <= 0) return 'action=rounds 需要 max_rounds 是正整数。'
          ctx.goals.edit(target, ref, { maxGoalRounds: cap })
        } else return 'action 只能是 resume / pause / rounds。'
        appendReceipt(receiptsPath, {
          at: new Date().toISOString(),
          event: 'goal',
          target: target.id,
          goalId: goal.id,
          action,
          maxRounds: args?.max_rounds,
          reason: oneLine(String(args?.reason ?? ''), 400),
        })
        return `已 ${action} ${target.id} 的 goal（此前 phase=${goal.phase}）。`
      } catch (error) {
        return `${action} 失败：${error instanceof Error ? error.message : String(error)}`
      }
    },
  })

  // Stop the timers when the plugin unloads.
  ctx.on('dispose', () => {
    for (const watcher of watchers.values()) {
      if (watcher.timer !== undefined) clearInterval(watcher.timer)
    }
    watchers.clear()
  })
}
