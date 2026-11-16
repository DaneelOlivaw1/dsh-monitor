import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { buildTickText, DEFAULT_IDLE_ROUNDS, evidenceProblems, loadBundledSkills, maxEventId, parseGovernanceCommand, loadSupervisorSkill, parseMonitorCommand, parseSkillDocument, renderSnapshot, snapshotFingerprint, TICK_FORMAT } from './index.mjs'
import { appendLoopTransition, emptyLoopDocument, ensureLoopNode, findLoopNode, LABEL_COLUMNS, loopPosition, normalizeLoopPath, parseLoopDocument, renderLoopDocument, renderLoopGraph, serializeLoopDocument, wrapMermaidLabel } from './loop.mjs'
import { clampScale, fitScale, initialScale, scrollAfterZoom } from './client/src/viewport.js'

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
  // 证据有固定落脚处：跟着计划编号走，不另建顶层目录
  assert.ok(gates.includes('plans/NNNN-*/evidence/INDEX.md'), '闸门缺证据目录判据')
  const entry = readFileSync(join(root, 'AGENTS.md'), 'utf8')
  assert.ok(entry.includes('计划同目录的 `evidence/`'), '入口缺交付证据位置')
})

test('parseGovernanceCommand: 不带参数就用会话目录，带了就用它', () => {
  assert.deepEqual(parseGovernanceCommand(''), {})
  assert.deepEqual(parseGovernanceCommand('   '), {})
  assert.deepEqual(parseGovernanceCommand('/Users/x/proj'), { path: '/Users/x/proj' })
})

test('loadBundledSkills: 两个技能都能读出来，且都带判断方法', () => {
  const skills = loadBundledSkills()
  const names = skills.map((skill) => skill.name).sort()
  assert.deepEqual(names, ['governance-init', 'monitor-supervisor'])
  const governance = skills.find((skill) => skill.name === 'governance-init')
  // 走查技能必须写清「先读后补、不覆盖、只补必要条件」
  for (const token of ['先读', '不覆盖', '必要条件']) assert.ok(governance.content.includes(token), `缺 ${token}`)
  // 不按文件数卡上限；AGENTS.md 重排、台账只改格式、证据跟着计划目录走
  for (const token of ['重写成四层结构', '改格式，不改事实', 'plans/NNNN-YYYY-MM-DD-标题/evidence/']) {
    assert.ok(governance.content.includes(token), `缺 ${token}`)
  }
  assert.ok(!governance.content.includes('最多新增 4 个文件'), '文件数上限应已删除')
})

// ── loop 状态机：结构 + 时序转移 ─────────────────────────────────────────────

test('loop: 路径校验（空段/空格/点段都是错）', () => {
  assert.deepEqual(normalizeLoopPath(''), [])
  assert.deepEqual(normalizeLoopPath('.'), [])
  assert.deepEqual(normalizeLoopPath('inbound/trial-401'), ['inbound', 'trial-401'])
  assert.throws(() => normalizeLoopPath('inbound//x'), /空段/)
  assert.throws(() => normalizeLoopPath('in bound'), /空格/)
  assert.throws(() => normalizeLoopPath('..'), /不能用/)
})

test('loop: 声明节点会自动补齐中间层，父不存在的深层不会静默丢', () => {
  const doc = emptyLoopDocument({ id: 'wecom', title: '企微入站上线' })
  const ensured = ensureLoopNode(doc, 'inbound/flow/test', { title: '写测试', kind: 'step' })
  assert.deepEqual(ensured.created, ['inbound', 'inbound/flow', 'inbound/flow/test'])
  assert.equal(findLoopNode(doc, 'inbound/flow/test').title, '写测试')
  assert.equal(findLoopNode(doc, 'inbound/flow/test').kind, 'step')
  assert.equal(findLoopNode(doc, 'inbound').kind, 'phase')
  assert.equal(findLoopNode(doc, 'inbound/flow').kind, 'flow')
})

test('loop: 转移类型由路径关系推导，不靠模型填', () => {
  const doc = emptyLoopDocument({ id: 'wecom', title: '企微入站上线' })
  const first = appendLoopTransition(doc, { at: '2026-11-14T09:00:00+08:00', loop: 'inbound', state: '未部署' })
  assert.equal(first.kind, 'enter')
  const held = appendLoopTransition(doc, { at: '2026-11-14T09:05:00+08:00', loop: 'inbound', state: '未部署' })
  assert.equal(held.kind, 'stay')
  const advanced = appendLoopTransition(doc, { at: '2026-11-14T09:06:00+08:00', loop: 'inbound', state: '已部署' })
  assert.equal(advanced.kind, 'advance')
  const branch = appendLoopTransition(doc, { at: '2026-11-14T09:10:00+08:00', loop: 'inbound/trial-401', state: '试 token', outcome: 'suspended' })
  assert.equal(branch.kind, 'branch')
  const back = appendLoopTransition(doc, { at: '2026-11-14T09:24:00+08:00', loop: 'inbound', state: '修域名', outcome: 'done' })
  assert.equal(back.kind, 'return')
  assert.deepEqual(back.transition.from, { loop: 'inbound/trial-401', state: '试 token' })
  // 顶层阶段之间的推进是 advance；跨分支才算 jump
  const nextPhase = appendLoopTransition(doc, { at: '2026-11-14T09:30:00+08:00', loop: 'outbound', state: '开始', outcome: 'done' })
  assert.equal(nextPhase.kind, 'advance')
  assert.equal(appendLoopTransition(doc, { at: '2026-11-14T09:31:00+08:00', loop: 'outbound/flow/probe', state: '探活', outcome: 'suspended' }).kind, 'enter')
  assert.equal(appendLoopTransition(doc, { at: '2026-11-14T09:32:00+08:00', loop: 'deploy/flow/build', state: '构建', outcome: 'abandoned', note: '换阶段' }).kind, 'jump')
})

test('loop: 时间倒退、空状态都被挡下（转移链只往后接）', () => {
  const doc = emptyLoopDocument({ id: 'wecom', title: '企微' })
  appendLoopTransition(doc, { at: '2026-11-14T09:10:00+08:00', loop: 'inbound', state: '未部署' })
  assert.throws(
    () => appendLoopTransition(doc, { at: '2026-11-14T09:05:00+08:00', loop: 'inbound', state: '已部署' }),
    /时间倒退/,
  )
  // 有上一位置：空 state 按「原地停留」记，不是错
  const stay = appendLoopTransition(doc, { at: '2026-11-14T09:20:00+08:00', loop: 'inbound', state: '' })
  assert.equal(stay.kind, 'stay')
  assert.equal(stay.transition.to.state, '未部署')
  // 没有上一位置、也没给 state：报错
  assert.throws(() => appendLoopTransition(emptyLoopDocument({ id: 'x', title: 'x' }), { at: '2026-11-14T09:20:00+08:00' }), /state/)
  assert.throws(() => appendLoopTransition(doc, { at: '不是时间', loop: 'inbound', state: 'x' }), /时间读不出来/)
})

test('loop: 试错链分叉后能回到原 loop，当前位置跟着最后一条走', () => {
  const doc = emptyLoopDocument({ id: 'wecom', title: '企微入站上线' })
  appendLoopTransition(doc, { at: '2026-11-14T09:00:00+08:00', loop: 'inbound', state: '未部署' })
  appendLoopTransition(doc, { at: '2026-11-14T09:10:00+08:00', loop: 'inbound/trial-401', state: '试 token', fact: '401 ×3', outcome: 'suspended' })
  appendLoopTransition(doc, { at: '2026-11-14T09:24:00+08:00', loop: 'inbound', state: '修域名', fact: '域名指错', outcome: 'done' })
  assert.deepEqual(loopPosition(doc), { loop: 'inbound', state: '修域名', at: '2026-11-14T09:24:00+08:00' })
})

test('loop: 序列化后能原样读回来', () => {
  const doc = emptyLoopDocument({ id: 'wecom', title: '企微入站上线', goal: '收一条真实消息' })
  appendLoopTransition(doc, { at: '2026-11-14T09:00:00+08:00', loop: 'inbound', state: '未部署', updates: ['bridge/a.mjs#换 token'] })
  const again = parseLoopDocument(serializeLoopDocument(doc))
  assert.equal(again.loop.id, 'wecom')
  assert.equal(again.transitions.length, 1)
  assert.deepEqual(again.transitions[0].updates, ['bridge/a.mjs#换 token'])
})

test('loop: 渲染出结构、当前位置和带事实的转移，试错链缩进在分叉处下面', () => {
  const doc = emptyLoopDocument({ id: 'wecom', title: '企微入站上线' })
  ensureLoopNode(doc, 'inbound', { title: '入站', kind: 'phase' })
  ensureLoopNode(doc, 'inbound/trial-401', { title: '试错 401', kind: 'trial' })
  appendLoopTransition(doc, { at: '2026-11-14T09:00:00+08:00', loop: 'inbound', state: '未部署' })
  appendLoopTransition(doc, { at: '2026-11-14T09:10:00+08:00', loop: 'inbound/trial-401', state: '试 token', fact: '401 三次', outcome: 'suspended' })
  appendLoopTransition(doc, { at: '2026-11-14T09:24:00+08:00', loop: 'inbound', state: '修域名', outcome: 'done' })
  const text = renderLoopDocument(doc, { all: true })
  assert.match(text, /企微入站上线（wecom）/)
  assert.match(text, /现在：入站 · 修域名/)
  assert.match(text, /├▶/)
  assert.match(text, /◀┤/)
  assert.match(text, /事实：401 三次/)
})

test('parseMonitorCommand: loop 子命令的路径与开关', () => {
  assert.deepEqual(parseMonitorCommand('loop'), { action: 'loop' })
  assert.deepEqual(parseMonitorCommand('loop inbound'), { action: 'loop', path: 'inbound' })
  assert.deepEqual(parseMonitorCommand('loop inbound --all --json'), { action: 'loop', path: 'inbound', all: true, json: true })
  assert.deepEqual(parseMonitorCommand('loop --target=session-x'), { action: 'loop', sessionId: 'session-x' })
})

test('loop: 图标签先按段落断开，再按显示宽度折行', () => {
  const lines = wrapMermaidLabel(['设计 › 数据模型', '只记轮次，没有 loop 标识'])
  assert.equal(lines[0], '设计 › 数据模型')
  assert.match(lines.slice(1).join(' '), /只记轮次/)
  const width = text => [...text].reduce((sum, char) => { const code = char.codePointAt(0) ?? 0; return sum + ((code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xff00 && code <= 0xff60) ? 2 : 1) }, 0)
  for (const line of lines) assert.ok(width(line) <= LABEL_COLUMNS * 2, '行超宽：' + line)
})

test('loop: 折行不吃掉行尾的右括号', () => {
  const lines = wrapMermaidLabel(['改走 workingDirectory.get()'], 8)
  assert.ok(lines.at(-1).endsWith('()'), lines.join('|'))
})

test('loop: 状态图不产生一行超宽的节点标签', () => {
  const doc = emptyLoopDocument({ id: 'demo', title: '演示' })
  ensureLoopNode(doc, 'impl', { title: '实现', kind: 'phase' })
  appendLoopTransition(doc, { loop: 'impl', state: '把很长的一句话状态写进来看看它会不会溢出节点框' })
  const graph = renderLoopGraph(doc)
  assert.match(graph, /^flowchart TB/)
  assert.ok(graph.includes('<br/>'))
  const width = text => [...text].reduce((sum, char) => { const code = char.codePointAt(0) ?? 0; return sum + ((code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xff00 && code <= 0xff60) ? 2 : 1) }, 0)
  for (const label of [...graph.matchAll(/"([^"]+)"/g)].map(match => match[1])) {
    for (const line of label.split('<br/>')) assert.ok(width(line) <= LABEL_COLUMNS * 2, '标签超宽：' + line)
  }
})

test('viewer: 全图取较紧的一轴，锚点缩放不跑位', () => {
  assert.equal(fitScale({ width: 200, height: 1000 }, { width: 300, height: 400 }), 0.4)
  assert.equal(initialScale({ width: 200, height: 100 }, { width: 300, height: 400 }), 1)
  assert.equal(clampScale(99), 4)
  const moved = scrollAfterZoom({ scrollLeft: 100, scrollTop: 500, x: 50, y: 100, prev: 0.5, next: 1 })
  assert.equal(moved.left, 250)
  assert.equal(moved.top, 1100)
  assert.equal((moved.left + 50) / 1, (100 + 50) / 0.5)
  assert.deepEqual(scrollAfterZoom({ scrollLeft: 7, scrollTop: 9, x: 1, y: 1, prev: 0, next: 1 }), { left: 7, top: 9 })
})
