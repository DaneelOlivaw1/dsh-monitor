import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { buildTickText, DEFAULT_IDLE_ROUNDS, evidenceProblems, maxEventId, loadSupervisorSkill, parseMonitorCommand, parseSkillDocument, renderSnapshot, snapshotFingerprint, TICK_FORMAT } from './index.mjs'

test('parseMonitorCommand: empty input is usage', () => {
  assert.deepEqual(parseMonitorCommand(''), { action: 'usage' })
  assert.deepEqual(parseMonitorCommand('   '), { action: 'usage' })
})

test('parseMonitorCommand: subcommands', () => {
  assert.deepEqual(parseMonitorCommand('status'), { action: 'status' })
  assert.deepEqual(parseMonitorCommand('list'), { action: 'status' })
  assert.deepEqual(parseMonitorCommand('stop'), { action: 'stop', sessionId: 'all' })
  assert.deepEqual(parseMonitorCommand('stop session-abc'), { action: 'stop', sessionId: 'session-abc' })
  assert.deepEqual(parseMonitorCommand('once'), { action: 'once', sessionId: 'latest' })
  assert.deepEqual(parseMonitorCommand('once session-abc 200'), {
    action: 'once',
    sessionId: 'session-abc',
    limit: 200,
  })
  // 非法条数不产生字段，退化成默认设置
  assert.deepEqual(parseMonitorCommand('once session-abc abc'), { action: 'once', sessionId: 'session-abc' })
  assert.deepEqual(parseMonitorCommand('once session-abc'), { action: 'once', sessionId: 'session-abc' })
  assert.deepEqual(parseMonitorCommand('inject session-abc 别再重跑 这条测试'), {
    action: 'inject',
    sessionId: 'session-abc',
    text: '别再重跑 这条测试',
  })
})

test('parseMonitorCommand: start with and without an interval', () => {
  assert.deepEqual(parseMonitorCommand('session-abc'), {
    action: 'start',
    sessionId: 'session-abc',
    everyMinutes: 5,
  })
  assert.deepEqual(parseMonitorCommand('session-abc 7'), {
    action: 'start',
    sessionId: 'session-abc',
    everyMinutes: 7,
  })
  // A junk interval falls back to the default instead of producing NaN minutes.
  assert.equal(parseMonitorCommand('session-abc abc').everyMinutes, 5)
  assert.equal(parseMonitorCommand('session-abc 0').everyMinutes, 5)
})

/** Minimal live-agent stand-in: only the shapes renderSnapshot touches. */
function fakeAgent({ events, status = 'idle', stats }) {
  return {
    id: 'session-target',
    status,
    session: {
      snapshotEvents: () => events,
      projections: { sessionStats: stats },
    },
  }
}

function event(type, data, seq) {
  return { type, data, seq }
}

test('renderSnapshot: names the session, its status and its goal', () => {
  const agent = fakeAgent({ events: [] })
  const text = renderSnapshot({
    agent,
    goal: { phase: 'active', roundsStarted: 3, maxGoalRounds: 200, objective: '把对拍清单全部打钩' },
    now: Date.parse('2026-11-13T01:40:00Z'),
  })
  assert.match(text, /目标会话快照 · session-target/)
  assert.match(text, /状态：idle/)
  assert.match(text, /goal：active · 3\/200 轮 · 把对拍清单全部打钩/)
  assert.match(text, /2026-11-13T01:40:00\.000Z/)
})

test('renderSnapshot: reports repeated calls and repeated results as facts', () => {
  const events = [
    event('tool/call', { name: 'bash', arguments: '{"command":"pnpm vitest run test/a.test.ts"}' }, 1),
    event('tool/result', { message: { content: [{ type: 'text', text: 'FAIL 1 failed' }] } }, 2),
    event('tool/call', { name: 'bash', arguments: '{"command":"pnpm vitest run test/a.test.ts"}' }, 3),
    event('tool/result', { message: { content: [{ type: 'text', text: 'FAIL 1 failed' }] } }, 4),
    event('assistant/message', { message: { content: [{ type: 'text', text: '再跑一次看看。' }] } }, 5),
  ]
  const text = renderSnapshot({ agent: fakeAgent({ events }), goal: undefined })
  assert.match(text, /窗口内重复调用：/)
  assert.match(text, /×2 bash \{"command":"pnpm vitest run test\/a\.test\.ts"\}/)
  assert.match(text, /窗口内重复结果：/)
  assert.match(text, /×2 FAIL 1 failed/)
  assert.match(text, /assistant「再跑一次看看。」/)
  assert.match(text, /goal：\(无\)/)
})

test('renderSnapshot: errors are rendered before their body', () => {
  const events = [
    event('tool/result', { error: { code: 'EXIT_1', reason: 'tsc failed' }, message: { content: [] } }, 9),
  ]
  const text = renderSnapshot({ agent: fakeAgent({ events }), goal: undefined })
  assert.match(text, /Error EXIT_1: tsc failed/)
})

test('renderSnapshot: an assistant step without prose is called out', () => {
  const events = [event('assistant/message', { message: { content: [{ type: 'tool-call' }] } }, 3)]
  const text = renderSnapshot({ agent: fakeAgent({ events }), goal: undefined })
  assert.match(text, /assistant \(无正文，仅工具\/推理\)/)
})

test('renderSnapshot: falls back to surface + eventAt when snapshotEvents is missing', () => {
  const stored = new Map([
    [1, event('tool/call', { name: 'read', arguments: '{"file_path":"a.md"}' }, 1)],
    [2, event('tool/result', { message: { content: [{ type: 'text', text: 'ok' }] } }, 2)],
  ])
  const agent = {
    id: 'session-fallback',
    status: 'running',
    session: {
      surface: { nodes: [1, 2] },
      eventAt: seq => stored.get(seq),
    },
  }
  const text = renderSnapshot({ agent, goal: undefined })
  assert.match(text, /call read/)
  assert.match(text, /result ok/)
})

test('renderSnapshot: only the most recent `limit` events are rendered', () => {
  const events = Array.from({ length: 30 }, (_, index) => (
    event('tool/call', { name: 'bash', arguments: `{"command":"step-${index}"}` }, index + 1)
  ))
  const text = renderSnapshot({ agent: fakeAgent({ events }), goal: undefined, limit: 5 })
  assert.match(text, /最近 5 条事件/)
  assert.match(text, /step-29/)
  assert.doesNotMatch(text, /step-24/)
})

test('renderSnapshot: an unanswered approval is surfaced as the reason it stopped', () => {
  const events = [
    event('approval/asked', { id: 'a1', toolName: 'bash' }, 10),
    event('tool/call', { name: 'bash', arguments: '{"command":"rm -rf /tmp/x"}' }, 11),
  ]
  const text = renderSnapshot({ agent: fakeAgent({ events }), goal: undefined })
  assert.match(text, /⚠ 正在等审批：bash/)
})

test('renderSnapshot: a decided approval is no longer reported', () => {
  const events = [
    event('approval/asked', { id: 'a1', toolName: 'bash' }, 10),
    event('approval/decided', { id: 'a1', outcome: 'approved' }, 12),
  ]
  const text = renderSnapshot({ agent: fakeAgent({ events }), goal: undefined })
  assert.doesNotMatch(text, /正在等审批/)
})

test('parseSkillDocument: splits frontmatter from body', () => {
  const { meta, body } = parseSkillDocument('---\nname: demo\ndescription: 一句话\n---\n\n正文\n')
  assert.equal(meta.name, 'demo')
  assert.equal(meta.description, '一句话')
  assert.equal(body.trim(), '正文')
})

test('loadSupervisorSkill: the bundled skill is readable and carries the judgement', () => {
  const skill = loadSupervisorSkill()
  assert.equal(skill.name, 'monitor-supervisor')
  assert.ok(skill.description.length > 0)
  // 四值裁决和「第 3 次升闸门」是这份技能的存在理由，被删掉就等于没接。
  for (const token of ['CONTINUE', 'INVESTIGATE', 'PIVOT_PROPOSAL', 'NO_NEW_EVIDENCE', '闸门', '台账']) {
    assert.ok(skill.content.includes(token), `skill body must mention ${token}`)
  }
})

test('buildTickText: names the skill, asks for the five lines, keeps the inject verbs', () => {
  const text = buildTickText({
    tick: 3,
    everyMinutes: 5,
    snapshot: '（快照）',
    targetId: 'session-abc',
  })
  assert.ok(text.includes('`monitor-supervisor`'))
  for (const label of ['**裁决**', '**前提**', '**证据**', '**理由**', '**下一轮盯**']) {
    assert.ok(text.includes(label), `tick text must ask for ${label}`)
  }
  // 排版是这次修复的重点：模板必须是分行的，挤成一段就说明退回去了
  assert.ok(TICK_FORMAT.includes(''), '模板必须留空行分块')
  assert.ok(TICK_FORMAT.some((line) => line.startsWith('- ')), '证据必须是列表项')
  assert.ok(text.includes('session_id="session-abc"'))
  assert.ok(text.includes('monitor_inject'))
  assert.ok(text.includes('第 3 次'))
  // 工具在旧会话里可能已失效：提示词必须给出命令那条退路，否则监督者会卡在报错上
  assert.ok(text.includes('/monitor once session-abc 200'))
  assert.ok(text.includes('/monitor inject session-abc'))
  assert.ok(text.includes('unknown tool'))
  // 给它上一轮的结论，否则它只能从零复述状态
  const withRound = buildTickText({ tick: 2, everyMinutes: 5, snapshot: 'x', targetId: 'sid', lastRound: 'stuck · 同一报错第 3 次' })
  assert.ok(withRound.includes('上一轮：stuck · 同一报错第 3 次'))
  // 明令禁止状态总结
  assert.ok(text.includes('不要复述目标在做什么'))
})

test('DEFAULT_IDLE_ROUNDS: 默认不自动停（跳过不花模型回合，停只会漏掉它重新开工那轮）', () => {
  assert.equal(DEFAULT_IDLE_ROUNDS, 0)
})

test('snapshotFingerprint: 只有时间变了的快照算「没动静」', () => {
  const a = '- 时间：2026-11-14T04:00:00.000Z\n- 状态：running\n- 最近 1 条事件：\n  #1 call bash hi'
  const b = '- 时间：2026-11-14T04:05:00.000Z\n- 状态：running\n- 最近 1 条事件：\n  #1 call bash hi'
  const c = '- 时间：2026-11-14T04:05:00.000Z\n- 状态：running\n- 最近 1 条事件：\n  #2 call bash hi'
  assert.equal(snapshotFingerprint(a), snapshotFingerprint(b))
  assert.notEqual(snapshotFingerprint(a), snapshotFingerprint(c))
})

test('maxEventId: 取快照里最大的事件号', () => {
  assert.equal(maxEventId('a #3 b #12 c'), 12)
  assert.equal(maxEventId('没有事件号'), 0)
})

test('evidenceProblems: 复述旧事件、指针解析不开都要被挡', () => {
  const snapshot = '- 最近事件：\n  #10 call bash\n  #11 result ok'
  // 新事件 + 可解析 → 干净
  assert.deepEqual(evidenceProblems({ snapshot, lastEventId: 9, evidence: ['#11 → ok'] }), [])
  // 旧事件（<= 上轮最大号）= 复述
  assert.ok(evidenceProblems({ snapshot, lastEventId: 11, evidence: ['#10 → 旧'] }).some((p) => p.includes('上一轮之前')))
  // 快照里没有这个号
  assert.ok(evidenceProblems({ snapshot, lastEventId: 9, evidence: ['#99 → 不存在'] }).some((p) => p.includes('不在本轮快照')))
  // 裸指针找不到原文
  assert.ok(evidenceProblems({ snapshot, lastEventId: 9, evidence: ['完全不存在的一句话'] }).length > 0)
  // 空证据
  assert.ok(evidenceProblems({ snapshot, lastEventId: 9, evidence: [''] }).length > 0)
})

test('治理模板：角色/流程/台账/闸门都在', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), 'templates', 'governance')
  const need = [
    'AGENTS.md', 'README.md', '.dsh/gates.yml',
    'agents/developer.md', 'agents/test-runner.md', 'agents/reviewer.md',
    'agents/deploy-ops.md', 'agents/data-analyst.md',
    'docs/dev-flow.md', 'docs/dispatch-protocol.md', 'docs/ledger-standard.md', 'docs/project-rules.md',
    'memory/MEMORY.md', 'memory/TEMPLATE.md',
  ]
  for (const rel of need) assert.ok(existsSync(join(root, rel)), `模板缺 ${rel}`)
  const gates = readFileSync(join(root, '.dsh', 'gates.yml'), 'utf8')
  for (const id of ['plan-before-code', 'test-red-first', 'review-pass-before-merge', 'no-empty-report', 'deliver-with-evidence', 'ledger-sync', 'third-time-becomes-gate']) {
    assert.ok(gates.includes(`id: ${id}`), `闸门缺 ${id}`)
  }
  // deliver-with-evidence 必须同时要 L1 与 L3，只有接口返回不算完成
  assert.ok(gates.includes('L1') && gates.includes('L3'))
})
