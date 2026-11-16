// The loop document: one YAML file per project that records a development flow
// as a time-ordered state machine.
//
// The shape the supervisor sees:
//
//   inbound ─ 入站        (a phase)
//     inbound/flow ─ 开发流程
//       inbound/flow/test ─ 写测试
//       inbound/flow/impl ─ 实现
//     inbound/trial-401 ─ 试错 401   (a branch pulled out when something broke)
//
// So the document holds two things at once: the **structure** (which loops exist,
// and what each one is) and the **run** (a sequence of timestamped transitions
// between positions). A position is `loop + state`; the transition between two
// positions is the thing a file of steps cannot express — it entered here at
// 09:10, it was thrown out into a trial chain at 09:12, it came back at 09:24.
//
// Everything mechanical is here and pure: parse, validate, append, derive the
// transition kind from the paths, render. The transition kind is never asked of
// the model — a move that goes deeper is a branch, one that goes shallower is a
// return, and a typo therefore cannot invent a kind.

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

/** Current document format. */
export const LOOP_VERSION = 1

/** A state label longer than this stops being a label. */
const STATE_LIMIT = 120

/** What a node is for. Only `trial` changes rendering (a detour, not a phase). */
export const NODE_KINDS = ['phase', 'flow', 'step', 'trial']

// 一个 loop 节点离开时可能处于的生命周期状态。
// 形状相同的转移（离开→别处）背后意图是不同的：做完、放弃、卡住、暂挂、还在推进。
// 程序分不出来，所以模型通过工具显式填，schema 卡住，不填或填错一律拒收。
//   done       这个子任务做完了（成功）
//   abandoned  这条路不走了（必须带 note）
//   blocked    卡住了，等外部（必须带 note）
//   suspended  暂时离开，预期还会回来
//   progress   同节点内推进 / 停留，没有收尾意味
export const LOOP_OUTCOMES = ['done', 'abandoned', 'blocked', 'suspended', 'progress']

// 哪些 outcome 会把节点标成「已关闭」（写到节点上）。progress 不关闭。
const CLOSING_OUTCOMES = new Set(['done', 'abandoned', 'blocked', 'suspended'])

export const UNSTATED = '未声明'

function nowIso() {
  return new Date().toISOString()
}

function cleanOneLine(text, limit = STATE_LIMIT) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}

/**
 * How many columns a character takes in a label.
 *
 * CJK and full-width punctuation take two, everything else one: a label budget
 * counted in `String.length` would make `workingDirectory` as wide as six hanzi.
 */
function characterWidth(char) {
  const code = char.codePointAt(0) ?? 0
  const wide = code >= 0x1100 && (
    code <= 0x115f
    || code === 0x2329
    || code === 0x232a
    || (code >= 0x2e80 && code <= 0xa4cf)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe30 && code <= 0xfe4f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
  )
  return wide ? 2 : 1
}

function labelWidth(text) {
  let width = 0
  for (const char of text) width += characterWidth(char)
  return width
}

/** Where a label may break without cutting a word: after these, never inside. */
const BREAK_AFTER = new Set([' ', '›', '·', '：', '，', '、', '；', '/', '|', '）', ')'])

/**
 * Break one paragraph into lines of at most `columns` CJK characters.
 *
 * A break is taken at a separator when there is one; a word longer than a whole
 * line is cut by width, because a mermaid node cannot scroll its own text.
 */
function wrapParagraph(text, columns) {
  const limit = Math.max(4, columns) * 2
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (flat === '') return []
  const tokens = []
  let buffer = ''
  for (const char of flat) {
    buffer += char
    if (BREAK_AFTER.has(char)) {
      tokens.push(buffer)
      buffer = ''
    }
  }
  if (buffer !== '') tokens.push(buffer)

  const lines = []
  let line = ''
  let used = 0
  const flush = () => {
    // A separator that ended up at the edge carries nothing — but a closing
    // bracket does: `workingDirectory.get()` must not lose its `)`.
    const kept = line.replace(/[\s›·，、；/|]+$/u, '').trim()
    if (kept !== '') lines.push(kept)
    line = ''
    used = 0
  }
  for (const token of tokens) {
    const width = labelWidth(token)
    if (width > limit) {
      if (used > 0) flush()
      for (const char of token) {
        const charWidth = characterWidth(char)
        if (used > 0 && used + charWidth > limit) flush()
        line += char
        used += charWidth
      }
      continue
    }
    if (used > 0 && used + width > limit) flush()
    line += token
    used += width
  }
  flush()
  return lines.length === 0 ? [] : lines
}

/** Columns a diagram label is wrapped at: the sidebar is narrow, not wide. */
export const LABEL_COLUMNS = 18

/**
 * A mermaid label as short lines.
 *
 * Paragraphs are forced breaks — a caller passes the loop and its state as two —
 * and each paragraph is then wrapped, so a node reads as "where" over "what".
 */
export function wrapMermaidLabel(paragraphs, columns = LABEL_COLUMNS) {
  const lines = []
  for (const paragraph of Array.isArray(paragraphs) ? paragraphs : [paragraphs]) {
    lines.push(...wrapParagraph(paragraph, columns))
  }
  return lines
}

/**
 * Split a loop path into segments.
 *
 * `''` and `'.'` mean the top loop. `a//b` says nothing, so it is an error.
 */
export function normalizeLoopPath(raw) {
  const text = String(raw ?? '').trim()
  if (text === '' || text === '.' || text === '/') return []
  const parts = text.split('/').map(part => part.trim())
  if (parts.some(part => part === '')) throw new Error(`loop 路径里有空段：「${text}」`)
  for (const part of parts) {
    if (part === '.' || part === '..') throw new Error(`loop 路径里不能用「${part}」：「${text}」`)
    if (/\s/.test(part)) throw new Error(`loop 路径的每一段不能有空格：「${part}」（用短横线连起来）`)
  }
  return parts
}

export function joinLoopPath(parts) {
  return (parts ?? []).join('/')
}

/** Depth of a path: the root is 0. */
export function loopDepth(path) {
  const parts = normalizeLoopPath(path)
  return parts.length
}

export function parentLoopPath(path) {
  const parts = normalizeLoopPath(path)
  if (parts.length === 0) return undefined
  return joinLoopPath(parts.slice(0, -1))
}

/** True when `ancestor` is a strict ancestor of `descendant`. */
export function isLoopAncestor(ancestor, descendant) {
  if (ancestor === '') return descendant !== ''
  return String(descendant).startsWith(`${ancestor}/`)
}

/** A fresh document: one top loop, no nodes, no transitions. */
export function emptyLoopDocument({ id, title, goal = '' } = {}) {
  const at = nowIso()
  return {
    version: LOOP_VERSION,
    loop: {
      id: cleanOneLine(id, 60) || 'project',
      title: cleanOneLine(title, 120) || cleanOneLine(id, 60) || 'project',
      goal: cleanOneLine(goal, 300),
    },
    nodes: [],
    transitions: [],
    createdAt: at,
    updatedAt: at,
  }
}

/**
 * Parse and validate.
 *
 * Lenient about extra fields (a hand-edited file keeps its notes), strict about
 * what the renderer and the validation rely on.
 */
export function parseLoopDocument(text) {
  let doc
  try {
    doc = parseYaml(String(text ?? ''))
  } catch (error) {
    throw new Error(`loops.yml 不是合法 YAML：${error instanceof Error ? error.message : String(error)}`)
  }
  if (doc === null || doc === undefined) throw new Error('loops.yml 是空的')
  if (typeof doc !== 'object' || Array.isArray(doc)) throw new Error('loops.yml 的顶层必须是对象')
  if (doc.version !== LOOP_VERSION) {
    throw new Error(`loops.yml 的 version 必须是 ${LOOP_VERSION}，现在是 ${String(doc.version)}`)
  }
  if (doc.loop === null || typeof doc.loop !== 'object' || Array.isArray(doc.loop)) {
    throw new Error('loops.yml 缺少根部的 loop: 对象')
  }
  if (typeof doc.loop.id !== 'string' || doc.loop.id.trim() === '') throw new Error('根 loop 缺少 id')
  if (doc.nodes !== undefined && !Array.isArray(doc.nodes)) throw new Error('nodes 必须是数组')
  if (doc.transitions !== undefined && !Array.isArray(doc.transitions)) throw new Error('transitions 必须是数组')
  const seen = new Set()
  for (const [index, node] of (doc.nodes ?? []).entries()) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) {
      throw new Error(`nodes 第 ${index + 1} 项必须是对象`)
    }
    if (typeof node.path !== 'string' || node.path.trim() === '') throw new Error(`nodes 第 ${index + 1} 项缺少 path`)
    normalizeLoopPath(node.path)
    if (seen.has(node.path)) throw new Error(`nodes 里的 path 重复：${node.path}`)
    seen.add(node.path)
    if (node.kind !== undefined && !NODE_KINDS.includes(node.kind)) {
      throw new Error(`nodes 里的 ${node.path} 的 kind 只能是 ${NODE_KINDS.join(' / ')}`)
    }
  }
  for (const [index, transition] of (doc.transitions ?? []).entries()) {
    if (transition === null || typeof transition !== 'object' || Array.isArray(transition)) {
      throw new Error(`transitions 第 ${index + 1} 项必须是对象`)
    }
    const where = `transitions 第 ${index + 1} 项`
    if (typeof transition.at !== 'string' || transition.at.trim() === '') throw new Error(`${where} 缺少 at（时间）`)
    if (transition.to === null || typeof transition.to !== 'object' || Array.isArray(transition.to)) {
      throw new Error(`${where} 缺少 to`)
    }
    if (typeof transition.to.loop !== 'string' || transition.to.loop.trim() === '') throw new Error(`${where} 的 to.loop 是空的`)
    if (typeof transition.to.state !== 'string') throw new Error(`${where} 的 to.state 必须是字符串`)
  }
  return doc
}

/** Serialize stably: two-space indent, no wrapping of long prose. */
export function serializeLoopDocument(doc) {
  return `${stringifyYaml(doc, { lineWidth: 0, indent: 2 })}`
}

/** All nodes as `{ path, node }`, root first, each branch's children adjacent. */
export function listLoopNodes(doc) {
  const nodes = [...(doc.nodes ?? [])]
  const byParent = new Map()
  for (const node of nodes) {
    const parent = parentLoopPath(node.path) ?? ''
    if (!byParent.has(parent)) byParent.set(parent, [])
    byParent.get(parent).push(node)
  }
  const out = []
  const visit = (parent) => {
    for (const node of byParent.get(parent) ?? []) {
      out.push({ path: node.path, node })
      visit(node.path)
    }
  }
  visit('')
  return out
}

export function findLoopNode(doc, path) {
  const wanted = joinLoopPath(normalizeLoopPath(path))
  return (doc.nodes ?? []).find(node => node.path === wanted)
}

/** True when the path exists as a node (the root counts). */
export function loopExists(doc, path) {
  const wanted = joinLoopPath(normalizeLoopPath(path))
  if (wanted === '') return true
  return (doc.nodes ?? []).some(node => node.path === wanted)
}

/**
 * Create a node, plus any missing ancestors under the deepest existing one.
 *
 * Missing ancestors are created as `phase` only when they are directly under the
 * root; everything deeper defaults to `flow`. The created node's own `kind` is
 * what the caller passed. `auto: true` marks what the command invented, so a
 * reader can tell a declared branch from one that grew out of a move.
 */
export function ensureLoopNode(doc, rawPath, { title, kind, goal } = {}) {
  const parts = normalizeLoopPath(rawPath)
  if (parts.length === 0) return { path: '', node: doc.loop, created: [] }
  const created = []
  doc.nodes ??= []
  for (let index = 1; index <= parts.length; index += 1) {
    const path = joinLoopPath(parts.slice(0, index))
    if (loopExists(doc, path)) continue
    const isTarget = index === parts.length
    const segment = path.split('/').pop() ?? path
    // A path segment starting with `trial` is a detour even when the caller did
    // not say so: the convention is part of the format, so a forgotten `kind`
    // cannot silently turn a trial chain into another step of the flow.
    const inferred = /^trial\b|^trial[-_]/i.test(segment)
      ? 'trial'
      : (index === 1 ? 'phase' : 'flow')
    const trialMatch = /^trial[-_]?(.*)$/i.exec(segment)
    const readable = trialMatch === null ? segment : (trialMatch[1] === '' ? '试错' : `试错 ${trialMatch[1]}`)
    const node = {
      path,
      title: isTarget && typeof title === 'string' && title.trim() !== ''
        ? cleanOneLine(title, 120)
        : readable,
      kind: isTarget && NODE_KINDS.includes(kind) ? kind : inferred,
      auto: true,
      createdAt: nowIso(),
    }
    if (isTarget && typeof goal === 'string' && goal.trim() !== '') node.goal = cleanOneLine(goal, 300)
    doc.nodes.push(node)
    created.push(path)
  }
  const node = findLoopNode(doc, rawPath)
  if (typeof title === 'string' && title.trim() !== '' && node !== undefined) {
    node.title = cleanOneLine(title, 120)
    delete node.auto
  }
  if (typeof goal === 'string' && goal.trim() !== '' && node !== undefined) node.goal = cleanOneLine(goal, 300)
  if (NODE_KINDS.includes(kind) && node !== undefined) node.kind = kind
  return { path: joinLoopPath(parts), node, created }
}

/** The current position: where the last transition arrived. `null` before any. */
export function loopPosition(doc) {
  const transitions = doc.transitions ?? []
  if (transitions.length === 0) return null
  const last = transitions[transitions.length - 1]
  return { loop: last.to.loop, state: last.to.state, at: last.at }
}

/** True when this loop is a trial chain — a detour that is expected to close. */
export function isTrialLoop(doc, path) {
  return findLoopNode(doc, path)?.kind === 'trial'
}

/**
 * Derive the transition kind from the two positions and the structure.
 *
 * The model never states a kind: a wrong label would be invisible, while a path
 * relation is checkable.
 *
 * - entering or leaving a `trial` node is a branch / return, wherever it sits,
 *   because a trial is an episode rather than a step;
 * - moving into a child loop enters it, moving to its parent closes it;
 * - a step to a sibling (same parent, no trial involved) is the flow advancing;
 * - anything else crosses branches and is reported as a jump.
 */
export function deriveTransitionKind(doc, from, to) {
  if (from === null || from === undefined) return 'enter'
  if (from.loop === to.loop) return from.state === to.state ? 'stay' : 'advance'
  const toTrial = isTrialLoop(doc, to.loop)
  const fromTrial = isTrialLoop(doc, from.loop)
  if (toTrial && !fromTrial) return 'branch'
  if (fromTrial && !toTrial) return 'return'
  if (isLoopAncestor(from.loop, to.loop)) return 'enter'
  if (isLoopAncestor(to.loop, from.loop)) return 'exit'
  if ((parentLoopPath(from.loop) ?? '') === (parentLoopPath(to.loop) ?? '')) return 'advance'
  return 'jump'
}

/**
 * Append one transition to the run.
 *
 * @param doc - document, mutated in place.
 * @param entry - { at?, loop, state, fact?, updates?, verdict?, round?, by? }
 * @returns { transition, kind, created, moved }
 */
export function appendLoopTransition(doc, entry = {}) {
  const from = loopPosition(doc)
  // Omitting the loop means "still where we are", not "back at the root": a
  // round that forgets to name its loop must not teleport the run.
  const namedLoop = normalizeLoopPath(entry.loop ?? '')
  const loop = namedLoop.length > 0 ? joinLoopPath(namedLoop) : (from?.loop ?? '')
  // Omitting the state means "nothing moved": recording it as a stay is honest,
  // and a run of stays is exactly what a stuck loop looks like.
  const state = cleanOneLine(entry.state ?? '') || (from?.state ?? '')
  if (state === '') throw new Error('状态转移必须给 state：这一轮之后这个 loop 处于什么状态（一句话）')
  const at = entry.at === undefined ? nowIso() : String(entry.at)
  if (Number.isNaN(Date.parse(at))) throw new Error(`时间读不出来：「${at}」（用 ISO 8601，如 2026-11-14T09:10:00+08:00）`)
  const transitions = doc.transitions ?? []
  const last = transitions[transitions.length - 1]
  if (last !== undefined && Date.parse(at) < Date.parse(last.at)) {
    throw new Error(`时间倒退：${at} 早于上一条 ${last.at}（转移链只往后接）`)
  }
  const ensured = ensureLoopNode(doc, loop, { kind: entry.kind })
  if (from !== null && !loopExists(doc, loop)) {
    throw new Error(`目标 loop「${loop}」不存在；先用 monitor_loop 的 declare 声明它`)
  }
  const to = { loop, state }
  const kind = deriveTransitionKind(doc, from, to)
  const transition = {
    at,
    kind,
    from: from === null ? null : { loop: from.loop, state: from.state },
    to,
  }
  if (typeof entry.fact === 'string' && entry.fact.trim() !== '') transition.fact = cleanOneLine(entry.fact, 400)
  if (Array.isArray(entry.updates)) {
    const updates = entry.updates.map(item => cleanOneLine(item, 200)).filter(item => item !== '')
    if (updates.length > 0) transition.updates = updates
  }
  if (Number.isFinite(entry.round)) transition.round = entry.round
  if (typeof entry.verdict === 'string' && entry.verdict !== '') transition.verdict = entry.verdict
  if (typeof entry.by === 'string' && entry.by !== '') transition.by = entry.by

  // outcome 挂在「离开的那个节点」上，不是新位置。
  // 没有 from（第一次进入根 loop）就不要求 outcome；同节点内推进（kind=stay/advance）
  // 也不强制 outcome，因为没离开任何节点。真正「离开上一个节点」的 kind 才要。
  const leavesPrevious = from !== null && from.loop !== to.loop
  if (leavesPrevious) {
    const outcome = typeof entry.outcome === 'string' ? entry.outcome.trim() : ''
    if (outcome === '') {
      throw new Error(
        `从「${from.loop}」离开到「${loop}」，必须说清上一个节点收尾时是什么状态：`
        + `outcome ∈ ${LOOP_OUTCOMES.join(' | ')}`,
      )
    }
    if (!LOOP_OUTCOMES.includes(outcome)) {
      throw new Error(`outcome 只能是 ${LOOP_OUTCOMES.join(' | ')}，收到「${outcome}」`)
    }
    const note = typeof entry.note === 'string' ? cleanOneLine(entry.note, 300) : ''
    if ((outcome === 'abandoned' || outcome === 'blocked') && note === '') {
      throw new Error(`outcome=${outcome} 必须带一句 note 说明为什么`)
    }
    transition.outcome = outcome
    if (note !== '') transition.note = note
    if (CLOSING_OUTCOMES.has(outcome)) {
      const previous = findLoopNode(doc, from.loop)
      if (previous !== undefined) {
        previous.outcome = outcome
        previous.closedAt = at
        if (note !== '') previous.closedNote = note
      }
    }
  } else if (typeof entry.outcome === 'string' && entry.outcome.trim() !== '') {
    // 同节点内（没离开）就说 outcome，意思不清，直接拒。想收尾就走 closeLoopNode。
    throw new Error('没有离开上一个节点时不要带 outcome；如果是收尾当前节点，请用 close')
  }

  transitions.push(transition)
  doc.transitions = transitions
  doc.updatedAt = at
  return { transition, kind, created: ensured.created, moved: from === null || from.loop !== to.loop || from.state !== to.state }
}

/**
 * 关闭当前节点（不挪位置），同时写一条 `from == to` 的 transition 让时序里看得见。
 *
 * @param doc - document, mutated in place.
 * @param entry - { at?, loop?, outcome, note?, fact?, round?, by? }
 *                loop 默认为当前位置；outcome 必填且必须是收尾型（done/abandoned/blocked/suspended）。
 * @returns { transition, node }
 */
export function closeLoopNode(doc, entry = {}) {
  const from = loopPosition(doc)
  if (from === null) throw new Error('还没有任何位置，close 没有可关闭的节点')
  const namedLoop = normalizeLoopPath(entry.loop ?? '')
  const loop = namedLoop.length > 0 ? joinLoopPath(namedLoop) : from.loop
  if (!loopExists(doc, loop)) throw new Error(`loop「${loop}」不存在，无法 close`)
  const outcome = typeof entry.outcome === 'string' ? entry.outcome.trim() : ''
  if (outcome === '') throw new Error(`close 必须给 outcome ∈ ${LOOP_OUTCOMES.filter(x => x !== 'progress').join(' | ')}`)
  if (!CLOSING_OUTCOMES.has(outcome)) {
    throw new Error(`close 的 outcome 只能是 done | abandoned | blocked | suspended，收到「${outcome}」`)
  }
  const note = typeof entry.note === 'string' ? cleanOneLine(entry.note, 300) : ''
  if ((outcome === 'abandoned' || outcome === 'blocked') && note === '') {
    throw new Error(`outcome=${outcome} 必须带一句 note 说明为什么`)
  }
  const at = entry.at === undefined ? nowIso() : String(entry.at)
  if (Number.isNaN(Date.parse(at))) throw new Error(`时间读不出来：「${at}」`)
  const transitions = doc.transitions ?? []
  const last = transitions[transitions.length - 1]
  if (last !== undefined && Date.parse(at) < Date.parse(last.at)) {
    throw new Error(`时间倒退：${at} 早于上一条 ${last.at}`)
  }
  // close 不改变位置：from == to，都写成要关闭的这个 loop 和它的当前 state。
  // 当前 state 从上一条 transition 推（loop 相同就沿用，不同就查这个节点最后一次到达的 state）。
  let state = from.loop === loop ? from.state : ''
  if (state === '') {
    for (let i = transitions.length - 1; i >= 0; i -= 1) {
      if (transitions[i].to.loop === loop) { state = transitions[i].to.state; break }
    }
  }
  if (state === '') state = UNSTATED
  const position = { loop, state }
  const transition = {
    at,
    kind: 'close',
    from: position,
    to: position,
    outcome,
  }
  if (note !== '') transition.note = note
  if (typeof entry.fact === 'string' && entry.fact.trim() !== '') transition.fact = cleanOneLine(entry.fact, 400)
  if (Number.isFinite(entry.round)) transition.round = entry.round
  if (typeof entry.by === 'string' && entry.by !== '') transition.by = entry.by
  transitions.push(transition)
  doc.transitions = transitions
  doc.updatedAt = at
  const node = findLoopNode(doc, loop)
  if (node !== undefined) {
    node.outcome = outcome
    node.closedAt = at
    if (note !== '') node.closedNote = note
  }
  return { transition, node }
}

/** Visits per node: rounds spent, last arrival, last state. */
export function loopVisitStats(doc) {
  const stats = new Map()
  const bump = (path, transition) => {
    const current = stats.get(path) ?? { visits: 0, stays: 0, lastAt: undefined, state: undefined }
    current.visits += 1
    current.lastAt = transition.at
    current.state = transition.to.state
    stats.set(path, current)
  }
  for (const transition of doc.transitions ?? []) {
    bump(transition.to.loop, transition)
    if (transition.kind === 'stay' || transition.kind === 'advance') {
      const current = stats.get(transition.to.loop)
      current.stays += 1
    }
  }
  return stats
}

function formatStamp(iso) {
  const value = new Date(iso)
  if (Number.isNaN(value.getTime())) return String(iso)
  const pad = number => String(number).padStart(2, '0')
  return `${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}`
}

const KIND_MARK = {
  enter: '▶',
  advance: '→',
  stay: '=',
  branch: '├▶',
  return: '◀┤',
  exit: '◀',
  jump: '⇢',
}

/** A loop as `入站 › 开发流程 › 实现`, so a row names its place without indent. */
function loopCrumb(doc, path) {
  if (path === '' || path === undefined) return doc.loop.title
  const titles = []
  for (const segment of normalizeLoopPath(path)) {
    const prefix = [...titles.map(() => ''), segment]
    const depth = titles.length + 1
    const at = normalizeLoopPath(path).slice(0, depth).join('/')
    const node = findLoopNode(doc, at)
    titles.push(node?.title ?? prefix[prefix.length - 1] ?? segment)
  }
  return titles.join(' › ')
}

/**
 * The run as edge rows.
 *
 * No leading whitespace: indentation is a fragile carrier (a proportional font,
 * a copy-paste, or a deep nesting turns it into noise), so every row names both
 * ends of the edge. A trial chain gets an instance id (`b1`, `b2`) at the moment
 * it is entered, and the row that closes it names the same id — episodes stay
 * distinguishable without drawing anything.
 */
export function collectLoopEdges(doc) {
  const transitions = doc.transitions ?? []
  // Instance ids must be assigned over the whole run, or a window would renumber
  // the same episode differently depending on where it starts.
  const instances = new Map()
  const open = []
  const edges = []
  for (const [index, transition] of transitions.entries()) {
    const labelOf = (loopPath) => {
      const held = open.find(item => item.path === loopPath)
      return held === undefined ? loopCrumb(doc, loopPath) : held.label
    }
    const fromLabel = transition.from === null ? '(起点)' : `${labelOf(transition.from.loop)} · ${transition.from.state}`
    if (transition.kind === 'return' && open.length > 0) open.pop()
    // A move inside an open trial keeps its instance id; only the branch that
    // opens one gets a fresh number.
    let toLabel = `${labelOf(transition.to.loop)} · ${transition.to.state}`
    if (transition.kind === 'branch') {
      const count = (instances.get(transition.to.loop) ?? 0) + 1
      instances.set(transition.to.loop, count)
      const label = `b${count} ${loopCrumb(doc, transition.to.loop)}`
      open.push({ path: transition.to.loop, label })
      toLabel = `${label} · ${transition.to.state}`
    }
    edges.push({
      n: index + 1,
      at: transition.at,
      stamp: formatStamp(transition.at),
      from: transition.from === null ? null : { ...transition.from },
      to: { ...transition.to },
      fromLabel,
      toLabel,
      kind: transition.kind,
      fact: transition.fact,
      updates: transition.updates,
      round: transition.round,
    })
  }
  return edges
}

/**
 * The run as edge rows.
 *
 * No leading whitespace: indentation is a fragile carrier (a proportional font,
 * a copy-paste, or a deep nesting turns it into noise), so every row names both
 * ends of the edge.
 */
export function renderLoopTimeline(doc, { all = true, limit = 40 } = {}) {
  const transitions = doc.transitions ?? []
  if (transitions.length === 0) return '还没有状态转移。'
  const edges = collectLoopEdges(doc)
  const shown = all ? edges : edges.slice(-limit)
  const lines = []
  if (shown.length < edges.length) lines.push(`… 前 ${edges.length - shown.length} 条省略（--all 看全部）`)
  for (const edge of shown) {
    const mark = KIND_MARK[edge.kind] ?? '→'
    const parts = [`${edge.n}`, edge.stamp, `${edge.fromLabel} → ${edge.toLabel}`, `[${mark} ${edge.kind}]`]
    if (edge.fact !== undefined) parts.push(`事实：${edge.fact}`)
    if (edge.updates !== undefined) parts.push(`更新：${edge.updates.join('；')}`)
    lines.push(parts.join('  '))
  }
  return lines.join('\n')
}

/** The structure as flat rows: the path is the hierarchy, indentation is not. */
export function renderLoopStructure(doc) {
  const stats = loopVisitStats(doc)
  const lines = [`${doc.loop.title}（${doc.loop.id}）`]
  if (doc.loop.goal !== undefined && doc.loop.goal !== '') lines.push(`目标：${doc.loop.goal}`)
  for (const { path, node } of listLoopNodes(doc)) {
    const current = stats.get(path)
    const viaChild = (doc.transitions ?? []).some(item => item.to.loop.startsWith(`${path}/`))
    const reached = current === undefined
      ? (viaChild ? '经由其下步骤' : '未进入')
      : `${current.visits} 次到达 · 上次「${current.state ?? ''}」`
    const marks = [
      node.kind === 'trial' ? '试错链' : node.kind,
      reached,
      node.auto === true ? '自动建' : undefined,
    ].filter(item => item !== undefined)
    lines.push(`${path}  [${marks.join(' · ')}]  ${node.title}`)
  }
  return lines.join('\n')
}

/**
 * The run as a state graph, for a viewer that draws mermaid.
 *
 * Nodes are distinct positions (`loop` + `state`), so a run that returns to the
 * same state is a cycle, and consecutive stays collapse into one counted edge.
 * Labels are wrapped into short lines: the reader is a narrow sidebar, and a
 * mermaid node cannot wrap or scroll its own text.
 */
export function renderLoopGraph(doc, { columns = LABEL_COLUMNS } = {}) {
  const transitions = doc.transitions ?? []
  const keyOf = position => `${position.loop}\u0000${position.state}`
  const nodes = new Map()
  const edges = new Map()
  const ensure = (position) => {
    const key = keyOf(position)
    if (!nodes.has(key)) {
      nodes.set(key, {
        id: `n${nodes.size + 1}`,
        place: loopCrumb(doc, position.loop),
        state: position.state,
      })
    }
    return nodes.get(key)
  }
  for (const transition of transitions) {
    const to = ensure(transition.to)
    if (transition.from === null) continue
    const from = ensure(transition.from)
    const key = `${from.id}->${to.id}`
    const held = edges.get(key) ?? { from: from.id, to: to.id, count: 0, kinds: new Set(), fact: undefined }
    held.count += 1
    held.kinds.add(String(transition.kind))
    if (held.fact === undefined && transition.fact !== undefined) held.fact = transition.fact
    edges.set(key, held)
  }
  if (nodes.size === 0) return '还没有状态转移。'

  /** One label: forced breaks between paragraphs, then wrapped to `columns`. */
  const labelOf = (...paragraphs) => paragraphs
    .flatMap(paragraph => wrapMermaidLabel(paragraph, columns))
    .join('<br/>')
    .replace(/"/g, "'")

  // Top-down: the only consumer is a tall, narrow sidebar, where a wide LR
  // chain shows four nodes and hides the rest behind a horizontal scroll.
  const lines = ['flowchart TB']
  for (const node of nodes.values()) {
    lines.push(`  ${node.id}["${labelOf(node.place, node.state)}"]`)
  }
  for (const edge of edges.values()) {
    const head = `${[...edge.kinds].join('/')}${edge.count > 1 ? ` ×${edge.count}` : ''}`
    // The fact is on the edge row below the diagram in full; here it only has to
    // say which move this was, so a long one is cut rather than wrapped forever.
    const fact = edge.fact === undefined
      ? ''
      : (edge.fact.length > 40 ? `${edge.fact.slice(0, 40)}…` : edge.fact)
    lines.push(`  ${edge.from} -->|"${labelOf(head, fact)}"| ${edge.to}`)
  }
  return lines.join('\n')
}

/** The whole document as the human sees it: structure first, then the run. */
export function renderLoopDocument(doc, { all = false, limit = 40, graph = false } = {}) {
  const position = loopPosition(doc)
  const header = [
    renderLoopStructure(doc),
    '',
    position === null
      ? '现在：（还没进入任何 loop）'
      : `现在：${loopCrumb(doc, position.loop)} · ${position.state}（${formatStamp(position.at)}）`,
  ]
  if (graph) return [...header, '', '── 状态图（mermaid） ──', renderLoopGraph(doc)].join('\n')
  return [...header, '', '── 状态转移 ──', renderLoopTimeline(doc, { all, limit })].join('\n')
}

/**
 * One JSON object for the sidebar page: the structure, the edges, the diagram and
 * the text fallback. The page draws it; `/monitor loop` prints it; both read the
 * same shapes, so a row cannot mean two things in two places.
 */
export function loopDocumentView(doc) {
  const stats = loopVisitStats(doc)
  const position = loopPosition(doc)
  return {
    id: doc.loop.id,
    title: doc.loop.title,
    goal: doc.loop.goal ?? '',
    updatedAt: doc.updatedAt,
    position: position === null
      ? null
      : {
          loop: position.loop,
          state: position.state,
          at: position.at,
          stamp: formatStamp(position.at),
          crumb: loopCrumb(doc, position.loop),
        },
    nodes: listLoopNodes(doc).map(({ path, node }) => ({
      path,
      title: node.title,
      kind: node.kind,
      goal: node.goal ?? '',
      visits: stats.get(path)?.visits ?? 0,
      lastState: stats.get(path)?.state ?? '',
      lastAt: stats.get(path)?.lastAt ?? null,
      // A phase is rarely a destination itself: the run enters its steps. Mark
      // that case, so the row does not read as "never touched".
      viaChild: (doc.transitions ?? []).some(item => item.to.loop.startsWith(`${path}/`)),
    })),
    edges: collectLoopEdges(doc),
    mermaid: renderLoopGraph(doc),
    text: renderLoopDocument(doc, { all: true }),
  }
}
