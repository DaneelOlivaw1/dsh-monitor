# dsh-monitor

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）bundle 插件：**给另一个会话派一个 AI 监督者**。

## 它治什么病

长会话不会「慢慢变慢」，它会**停在原地**：反复跑同一条命令、反复读同一个日志、改了代码再跑同一个测试、然后把「我做完了」当成结论交掉。转录里没有任何一行写着「我在打转」，只有把「它试了什么」和「世界变了什么」并排看的人才看得出来。

所以这个插件**故意不写死判定规则**。它只做机械的一半，判断留给模型：

- **机械的一半**：定时器、目标会话的紧凑快照（叫了什么、回了什么、它说了什么、是否在跑、goal 什么状态）、以及一个能可靠把话塞进那个会话的通道；
- **判断那一半**：你在里面敲 `/monitor` 的那个会话。它读快照、自己判断要不要介入、介入说什么。它的判断你看得见，也会落成回执。

这和「正则抓重复」的区别：同一个测试在两次修复之间重跑，参数完全一样但结果变了 —— 那是正常推进，不是打转。只有**同样的调用 + 同样的结果**才说明上一轮改动没有生效。

## 用法

在任意交互会话里敲：

| 输入 | 作用 |
|---|---|
| `/monitor <sessionId\|latest> [everyMinutes]` | 开始监督；默认 5 分钟一轮，首轮立刻，快照当场显示 |
| `/monitor status` | 现在在监督谁、巡检了几轮、上次注入了什么 |
| `/monitor once [sessionId]` | 立刻出一次快照，不排进定时 |
| `/monitor stop [sessionId\|all]` | 停止 |
| `/monitor inject <sessionId> <text...>` | 手工往目标会话塞一句话 |

监督者在每一轮会收到一条 inbox 通知，里面带快照，并且手上有两个工具：

- `monitor_snapshot(session_id, limit?)` —— 想看得更细就再拉一次；
- `monitor_inject(session_id, text, reason, kind, mode?)` —— 往目标会话说一句话。
  `reason` 是**判断依据**，会连同注入一起进回执；`kind` 取 `stuck | off_track | needs_context | idle | guidance`；
  `mode` 默认 `steer`（下一步生效，空闲时会把对方唤醒），`queue` 表示等它下一轮。

监督者被明确要求：**不要替目标干活**，只在它真的没推进时才注入，而且注入要点名命令/文件/下一步动作。

## 安装

DSH 插件装在 **profile**（`$DSH_HOME/profiles/<name>`）里，不是全局：

```bash
cd ~/.dsh/profiles/web
dsh plugin --profile web add file:/Users/daneel/project/dsh-monitor
```

然后把 `dsh-monitor` 加进 profile `package.json` 的 `dsh.profile.bundles`（插件管理器通常会自动追加）。
插件管理器里出现 `include:monitor` 且 `fiberPhase: active` 即为生效；改代码后用 `set_plugin` 关一次再开一次即可重载，不必重启 host。

## 配置

包内 `cordis.patch.yml` 声明一行；全部字段都是 `.volatile()`，所以设置页会从 schema 自动生成表单。

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关；关掉后定时与两个工具都停 |
| `defaultEveryMinutes` | `5` | `/monitor` 未指定间隔时用这个 |
| `snapshotLimit` | `40` | 一次快照带多少条最近事件 |
| `maxTicks` | `0` | 巡检多少轮后自动停；0 = 不停 |
| `receiptsPath` | 空 → `$DSH_HOME/monitor/receipts.jsonl` | 注入/停止的回执（JSON Lines） |
| `statusPath` | 空 → `$DSH_HOME/monitor/status.json` | 运行态状态文件，供外部观察 |
| `pitfallsPath` | `memory/pitfalls/auto-monitor.md` | 判定为 stuck/off_track/idle 时追加的复盘条目；空则只走回执 |

`pitfallsPath` 相对于**目标会话的工作目录**解析，所以踩坑记录会落进那个仓库自己的记忆里，下次会话能读到。

## 回执长什么样

`receipts.jsonl` 一行一条：

```json
{"at":"2026-11-13T01:55:00.000Z","event":"inject","target":"session-…","supervisor":"session-…","kind":"stuck","mode":"steer","reason":"连续 3 次同一 bash + 同一 FAIL 输出，代码未变","text":"别再重跑；先读 test/x.test.ts:88 的断言"}
```

`auto-monitor.md` 则是给人看的：

```markdown
## 2026-11-13 01:55 · monitor · session-a36e9d30

- 判定：stuck
- 依据：连续 3 次同一 bash + 同一 FAIL 输出，代码未变
- 注入：别再重跑；先读 test/x.test.ts:88 的断言
```

## 边界

- 只监督**在线**的会话；目标被关闭或未加载时，那一轮会告诉监督者「目标离线」，监督者掉线则自动停表。
- 快照只读最近 `snapshotLimit` 条事件，长会话的早期上下文不在里面；要看早期证据就调 `monitor_snapshot` 并调大 `limit`。
- 定时器活在 host 进程里：host 重启后监控不会自动恢复，需要重新 `/monitor`。
- 它不碰目标的 goal、不替目标提交、不改目标的工作目录。

## 测试

```bash
node --test test.mjs
```

只测纯函数（命令解析、快照渲染、surface 回退路径），不依赖 host。
