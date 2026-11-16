// 评测回放：把 eval/cases/<name>/script.jsonl 一条一条喂给 loop.mjs 的纯函数，
// 跑完和 expected/loops.yml 比对。
//
// 目的：在不启动 dsh、不调模型的前提下，验证「记录层的形式正确性」——
// schema 校验、拒收消息、loops.yml 的落盘形状。判断质量不在这里考。
//
// 用例结构：
//   eval/cases/<name>/
//     script.jsonl        # 每行一条 op：{ op, ...args }；可选 expect: 'ok' | 'reject'
//     expected/loops.yml  # 跑完该长这样（忽略时间字段）
//     notes.md            # 这个用例在考什么
//
// 跑：node eval/run.mjs           跑全部
//     node eval/run.mjs <name>    跑单个
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  appendLoopTransition,
  closeLoopNode,
  emptyLoopDocument,
  ensureLoopNode,
  parseLoopDocument,
  serializeLoopDocument,
} from '../loop.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const casesDir = join(here, 'cases')

// 固定一个「时钟」，让回放跑出来的时间戳可预测。用例里 op 可以带 at；不带就用递增默认。
function makeClock(start = '2026-01-01T00:00:00Z') {
  let t = Date.parse(start)
  return () => {
    const iso = new Date(t).toISOString()
    t += 60_000 // 每步 +1 分钟，避免「时间倒退」校验误伤
    return iso
  }
}

// 跑一个用例的脚本：返回 { doc, log } ——
//   doc：跑完的 loop 文档
//   log：每条 op 的执行结果 { op, outcome: 'ok'|'reject', message? }
function replay(scriptPath) {
  const lines = readFileSync(scriptPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('//'))
  const ops = lines.map((line, index) => {
    try {
      return JSON.parse(line)
    } catch (error) {
      throw new Error(`${scriptPath}:${index + 1} 不是合法 JSON：${error.message}`)
    }
  })
  const clock = makeClock()
  const doc = emptyLoopDocument({ id: 'eval', title: '评测用例' })
  const log = []
  for (const op of ops) {
    const at = op.at ?? clock()
    try {
      switch (op.op) {
        case 'declare': {
          ensureLoopNode(doc, op.loop, { title: op.title, kind: op.kind, goal: op.goal })
          log.push({ op: op.op, outcome: 'ok' })
          break
        }
        case 'move': {
          appendLoopTransition(doc, { ...op, at })
          log.push({ op: op.op, outcome: 'ok' })
          break
        }
        case 'close': {
          closeLoopNode(doc, { ...op, at })
          log.push({ op: op.op, outcome: 'ok' })
          break
        }
        default:
          throw new Error(`未知 op: ${op.op}`)
      }
    } catch (error) {
      log.push({ op: op.op, outcome: 'reject', message: error.message })
    }
  }
  return { doc, log, ops }
}

// 比对 loops.yml：忽略 createdAt/updatedAt/at 这些时间字段（评测的是结构，不是壁钟）。
function stripTimes(value) {
  if (Array.isArray(value)) return value.map(stripTimes)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (k === 'createdAt' || k === 'updatedAt' || k === 'at' || k === 'closedAt') continue
      out[k] = stripTimes(v)
    }
    return out
  }
  return value
}

function canonical(value) {
  return JSON.stringify(stripTimes(value), null, 2)
}

function compareAgainstExpected(caseDir, actualDoc, log) {
  const problems = []
  const expectedPath = join(caseDir, 'expected', 'loops.yml')
  if (existsSync(expectedPath)) {
    const expected = parseLoopDocument(readFileSync(expectedPath, 'utf8'))
    const a = canonical(actualDoc)
    const e = canonical(expected)
    if (a !== e) problems.push(`loops.yml 不一致。\n--- expected\n${e}\n--- actual\n${a}`)
  }
  const expectLogPath = join(caseDir, 'expected', 'log.json')
  if (existsSync(expectLogPath)) {
    const expectedLog = JSON.parse(readFileSync(expectLogPath, 'utf8'))
    // 只比对 op + outcome，拒收消息太脆不比。
    const actualTrim = log.map(({ op, outcome }) => ({ op, outcome }))
    const expectedTrim = expectedLog.map(({ op, outcome }) => ({ op, outcome }))
    if (JSON.stringify(actualTrim) !== JSON.stringify(expectedTrim)) {
      problems.push(`log 不一致。\n--- expected\n${JSON.stringify(expectedTrim, null, 2)}\n--- actual\n${JSON.stringify(actualTrim, null, 2)}`)
    }
  }
  return problems
}

function runCase(name) {
  const caseDir = join(casesDir, name)
  if (!statSync(caseDir).isDirectory()) throw new Error(`不是目录：${caseDir}`)
  const scriptPath = join(caseDir, 'script.jsonl')
  if (!existsSync(scriptPath)) throw new Error(`缺 script.jsonl：${scriptPath}`)
  const { doc, log } = replay(scriptPath)
  const problems = compareAgainstExpected(caseDir, doc, log)
  return { name, problems, doc, log }
}

function main() {
  const wanted = process.argv[2]
  const names = wanted !== undefined
    ? [wanted]
    : readdirSync(casesDir).filter((entry) => statSync(join(casesDir, entry)).isDirectory()).sort()
  let failed = 0
  for (const name of names) {
    try {
      const result = runCase(name)
      if (result.problems.length === 0) {
        process.stdout.write(`✓ ${name}\n`)
      } else {
        failed += 1
        process.stdout.write(`✗ ${name}\n`)
        for (const problem of result.problems) process.stdout.write(`  ${problem}\n`)
      }
    } catch (error) {
      failed += 1
      process.stdout.write(`✗ ${name}: ${error.message}\n`)
    }
  }
  if (failed > 0) {
    process.stdout.write(`\n${failed}/${names.length} 个用例未通过\n`)
    process.exit(1)
  } else {
    process.stdout.write(`\n${names.length}/${names.length} 个用例通过\n`)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main()
