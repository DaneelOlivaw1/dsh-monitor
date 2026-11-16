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
| `/monitor loop [路径] [--all] [--json]` | 看项目的 loop 树与状态转移（缺文件时自动建） |
| `/monitor inject <sessionId> <text...>` | 手工往目标会话塞一句话 |

监督者在每一轮会收到一条 inbox 通知，里面带快照，并且手上有两个工具：

- `monitor_snapshot(session_id, limit?)` —— 想看得更细就再拉一次；
- `monitor_inject(session_id, text, reason, kind, mode?)` —— 往目标会话说一句话。
  `reason` 是**判断依据**，会连同注入一起进回执；`kind` 取 `stuck | off_track | needs_context | idle | guidance`；
  `mode` 默认 `steer`（下一步生效，空闲时会把对方唤醒），`queue` 表示等它下一轮。

监督者被明确要求：**不要替目标干活**，只在它真的没推进时才注入，而且注入要点名命令/文件/下一步动作。

## loop 文件：开发流程本身

一个项目的开发流程不是一串轮次，是一棵树：**顶层是整件事**，下面挂阶段（入站 / 出站 / 部署 / 回滚），每个阶段自己又是一个开发流程（写测试 → 实现 → 验证）。顺利就一遍过；一旦出错，就从出问题的那一步**分叉出一条试错链**，解决完再**回到原来的 loop**。

`monitor/loops.yml` 同时装两样东西：

- **结构**：有哪些 loop、每个是阶段 / 流程 / 步骤 / 试错链；
- **时序**：每一次位置变化一条转移，`上一位置 --因为这条事实--> 新位置`。

转移的**类型由程序按路径关系推导**（变深 = 进入子 loop，进 `trial` 节点 = 分叉，离开 = 回归，同层换步 = 推进），所以模型不用填 kind，也不会填错；路径写错会直接报错。

文件不用手写，监管者通过工具维护：

| 动作 | 作用 |
|---|---|
| `monitor_loop declare` | 声明一个阶段 / 流程 / 步骤 / 试错链（缺的中间层按 `phase`、`flow` 自动补齐） |
| `monitor_loop move` | 这一轮把工作挪了位置时，记一条转移 |
| 裁决里的 `loop` / `state` / `updates` | 最省的一条路：每轮说清现在在哪、什么状态、改了什么 |
| `/monitor loop [路径] [--all] [--json]` | 读回来看 |

规矩是程序化的：漏写 `loop` 就留在原地（不会跳回根），漏写 `state` 记成「停留」——连续停留就是打转的样子。**改了 state 才是有信息量的那条**：被替换掉的旧状态作为 `from` 留在边上，「这里它想错了、是这条事实推翻的」就写在一条边里。

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

写入是原子的，每次写之前校验：路径不合法、时间早于上一条、状态为空，都会被拒，并指出该改哪一行——坏文档不会覆盖好文档。

## 侧栏 Loop 页

同一份文件也是右侧栏里的一个页面：入口在右栏工具条上（“Loop”）。正文把整条运行画成 mermaid 状态图——每个不同的位置是一个节点，每条转移是一条边，边上带触发它的事实，所以试错链读起来就是一条从主线分出去、又回来的支线。

图默认开在「全图」：缩放到整张图刚好放进面板，先看清形状；要读字就点 ＋、⌘/Ctrl+滚轮，或者双击，放大后按住拖动平移，一个位置一个位置往下捋。缩放以光标（按钮则以面板中心）为锚点，字不会跑位；`全图`一键回到整张。侧栏很窄，所以标签由宿主按显示宽度折行（CJK 记两列、一行最多 18 列），边上的事实截到 40 字——完整的那句在下面的转移行里。

图下面按行列出结构与每一条转移：编号、时间、类型（进入 / 推进 / 停留 / 分叉 / 回归 / 跨支）、`从 → 到`、事实、以及更新了什么。图里的节点 id 由宿主渲染器生成（`n1`、`n2`……），以后做点击交互可以直接把节点绑到位置上。

页面只读，取数是 `GET /monitor/loop?session=<id>`：文件在磁盘上、页面在浏览器里，打开或刷新时读一次就够（裁决落盘是分钟级的，不需要轮询）。

客户端产物用 esbuild 打包（mermaid 约 3 MiB，而 Harness 每个包只加载一个 `client/client.js`）：

```bash
npm run build                        # client/src/client.js + mermaid → client/client.js
DSH_MONITOR_DEBUG=1 npm run build    # 不压缩，堆栈可读
```

`mermaid`、`esbuild` 是 devDependencies，产物已提交，装插件不需要构建。

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
