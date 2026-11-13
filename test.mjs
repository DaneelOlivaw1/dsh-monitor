import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildTickText, loadSupervisorSkill, parseMonitorCommand, parseSkillDocument, renderSnapshot, TICK_FORMAT } from './index.mjs'

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
  for (const line of TICK_FORMAT) assert.ok(text.includes(line.split('<')[0]), `tick text must ask for ${line}`)
  assert.ok(text.includes('session_id="session-abc"'))
  assert.ok(text.includes('monitor_inject'))
  assert.ok(text.includes('第 3 次'))
})
