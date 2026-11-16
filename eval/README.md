# eval/

记录层正确性的回放评测。不启动 dsh、不调模型，只把 `loop.mjs` 的纯函数当作被测对象。

跑：

```
npm run eval            # 跑全部
node eval/run.mjs <用例目录名>
```

## 用例目录

```
eval/cases/<name>/
  script.jsonl         每行一条 op：{ op: 'declare' | 'move' | 'close', ...args, at? }
  expected/
    log.json           期望的每条 op 结果：[{ op, outcome: 'ok' | 'reject' }, ...]
    loops.yml          （可选）跑完 loops 文档该长什么样，比对时忽略时间字段
  notes.md             （可选）这个用例在考什么
```

op 字段直接对应 `appendLoopTransition` / `ensureLoopNode` / `closeLoopNode` 的入参。回放用固定时钟，每步 +1 分钟，避免时间倒退校验误伤。

## 现在的三条基线

- `move-missing-outcome` —— 跨 loop move 不填 outcome 必须拒收。
- `move-abandoned-without-note` —— outcome=abandoned/blocked 必须带 note。
- `close-done-on-leaf` —— close 要能标 outcome + closedAt，且下一次 close 会被拒。

加新用例时：先写 `script.jsonl` 把场景跑出来，`node eval/run.mjs <name>` 看一眼实际输出，确认符合预期再把输出固化成 `expected/`。
