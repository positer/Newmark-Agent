# Newmark2DSH 0.3.0：NewMate、heartBeat 与短期记忆

2026-10-12 更新：已完成 Windows 本地安装与关键实机验收，详见 [最终报告](../archive/20261012-installed-030/REPORT.md)。冷启动入口改读宿主 name/mounted；Agent API 加单次 run 的传输 sessionId 以满足 opencode-go，不创建持久 DSH 会话；短记忆显示完整日期。下文初次“未安装”状态保留为阶段记录。

状态：源码实现及隔离行为验收，未发布、未覆盖本地安装、未对用户正在运行的 DSH 发起重启。0.3.0 按新增子组件规则计一次 +0.1.0；两个新组件不累加为 0.4.0。

## 交互与组件

Newmark Core 组合 MemoryLab、ComputerUse、Agent API、NewMate、heartBeat 五个独立开关。MemoryLab 侧栏下方（order 21）有 NewMate 对话入口；关闭 NewMate 释放入口、HTTP/MCP 路由、工具、计时器与监听器，保留其状态。关闭 heartBeat 不影响 NewMate。

NewMate 对话先将任务写入 `~/.Newmark/newMate/state.json`，后台串行调用现有 `agent_api_send`。重启前中断的任务保持 interrupted，失败保持 failed，仅显式重试，避免重复模型花费。最近对话保留 200 条，单次推理引用最近 12 条；活动任务上限 100，历史任务上限 2000。任务达到上限会报错，当前不自动清理历史。

`newmate_chat` 是 DSH 与 MCP 共用的入口，返回任务 ID；`newmate_task_status` 查询任务与回答，`newmate_memory_context` 查看原生记忆背景，`newmate_state` 查看状态。`newmate_task` 只给调用方当前 DSH 对话创建持久唤起任务。由 DSH 对话发起的 companion chat 保存宿主识别的 origin；模型可调用 `newmate_task` 把工作交回该原对话，来源不能由模型参数覆盖。普通侧栏/MCP 调用无该身份，不开放该唤起工具。后台文件测量也不开放唤起工具。

伴随推理默认只允许四个只读长期记忆工具；无 shell、ComputerUse、文件删除、任意执行、递归 Agent API 工具。原对话收到 followup 后以 DSH 自身权限继续运行。这是工具能力边界，并非声称进程具备操作系统级沙箱。

## MemoryLab shortMemory

`shortMemory_add({content, expires_at?})` 写一条短期记忆，建议 100 token 内，硬上限 4000 字符。默认严格七天，可单独指定 ISO 到期时间。`shortMemory_recall({})` 直接返回最近十条及 expired 标志；`shortMemory_where({})` 返回完整文件绝对位置；`shortMemory_size({})` 返回总条数，含过期项。

文件 `~/.Newmark/Memory Lab/short-memory.json` 是 JSON 列表，每条包含 seq、createdAt、expiresAt、content。过期只灰显，不删除；MemoryLab 界面为“总览 / 详细 / 短期”，短期页读取所有项并显示序号、存入时间和到期时间。页面每分钟刷新到期显示；重新进入读取最新文件。

NewMate 创建时即只读加载 index.json 的全部 tag 名及 parents/children/aliases，保留多父关系和环，同时加载最近十条短期记忆。每次模型调用前复核内容指纹；相同内容复用同一个前缀和对象，原生系统前缀先于常规 Agent API 指令，动态任务放后段。到期标志、标签或最近记忆变化会使指纹失效。普通 DSH/Agent API 对话没有自动注入，仍需工具读取。cacheHits 是本地前缀复用次数，不代表提供商实际 token cache 命中或实测节省。

## 稀疏测量

配置 `newMateWatchRoot` 必须显式设置目录，默认空即不监听。使用 fs.watch 去抖和浅层 lstat，只记录 basename 文件的 size/mtime 或 missing，不扫描全盘，不读取正文，不跟随目录/符号链接。相同标记无推理；最多记录 512 个路径、每批最多 256 个名称，每小时最多一次测量判断。判断默认为 notify=false，只有明确记忆责任才提示；这是一小时粗粒度预算，并非所有变化必被处理的可靠文件审计。没有完整目录对账，平台可能合并/遗漏通知。成本降低机制已实现，真实日常 token/耗电节省尚未测量。

## heartBeat 的重启投递

`heartbeat_after_restart({prompt})` 的目标只从当前 DSH 调用身份取得，不接受目标参数。`heartbeat_restart({})` 发起 DSH 全局重启；准备 helper 后先返回工具收据，再提交重启。组件更新流程的重启和更新后 NewMate 任务统一委托 heartBeat，关闭 heartBeat 则更新重启不可用。

任务状态 waiting → armed；helper 确认新的 DSH 进程启动且路径匹配、创建时间变化后才投递。真实对话投递经 agents.get/resume、agent.followup，并等待 sessions.flush 返回 true；消息身份固定 `newmark-task:<id>`。崩溃后用已持久化的 inbox/spliced 事件去重，再完成持久化屏障。

成功交接的同一次原子写会从 tasks 列表移除可执行任务正文、目标和 helper 目录，只保留 receipts 的 id/时间。后续启动没有该可执行载荷；旧版 delivered 记录也迁移为无载荷收据。投递失败保留任务及错误，不伪报成功。NewMate 投递的完成含义为其持久队列已接受任务，并非模型已完成任务。重启控制器目前仅支持官方 Windows Desktop 进程；Linux 不假报可用。

## 两阶段重启（广播 + 回执屏障，0.3.16）

默认仍是即时重启：`heartbeat_restart {}` 先准备 helper，先返回工具收据，1500 ms 后提交，行为与 0.3.15 相同；两阶段是可选形式。

`heartbeat_restart {broadcast:true}` 不重启，只开一次「准备」：

- 参与者由宿主取得（`agents().roots()`），不接受调用方传入的目标名——由被保护方之外的人点名参与者，等于没有屏障。**0.3.17 起参与者不再等于「宿主载入的对话」，而等于「确认在工作的对话」**：`roots()` 返回的每个 agent 只有 `status === 'running'`（宿主自己的判据，dsh-agent 的 `installTurnArchiveAdmission` 用的就是它，注释写明「a turn waiting for an approval or an answer included」）才算参与者，requester 无论如何都在（它是发起方）。载入但空闲的对话没有在飞的回合，重启打断不了它，给它登记接续只会把它白叫醒——这正是 0.3.17 修的过度广播：此前组件读的是 `agent.running` / `agent.session.running` 这两个宿主**从不设置**的字段，于是每个载入的对话都被当成在工作的，重启后统统被叫醒。此外（0.3.17）**用户暂停的对话不进参与者**：判据在 `agent.status === 'running'` 之外并入宿主的 goal 服务（`ctx.goals.get(agent)?.phase`，与 `dsh-tool-goal` 同一个读法），`phase:'paused'` 的对话既不被广播唤醒、也不由更新路由接续——被唤醒会真的起一轮用户没有要求的模型回合。requester 永远在列；`goals` 服务缺失 / 没有 goal / 读取抛错都按「没有暂停记录」处理，绝不因此拒绝重启。同一时刻只允许一个进行中的 intent；第二次 begin 返回 `intent_in_progress` 与进行中 intent 的进度。
- `ackMode:'auto'`（默认）为每个参与者登记一条持久接续任务，不花模型 token，忙会话也覆盖；这条登记本身就是回执（`ackSource:'auto'`）。
- `ackMode:'agent'` 把一条持久通知投进每个会话，要求该会话自己调用 `heartbeat_after_restart {intentId}` 登记（`ackSource:'schedule'`），或 `heartbeat_restart_ack {intentId, continuation:'none'}` 声明无需接续。通知走与任务相同的 `sessions.flush` 持久化屏障，所以「已通知」表示消息已落盘，而不是某个 socket 收下了字节。
- 回执只按宿主给的会话身份归属，一个会话无法替另一个会话回执；通知不投给 requester 本身（它就在这次调用里，用自己的工具回执）。
- 准备期间消失的参与者移出必需集合（记为 `closed`），记录保留，因为它的接续任务仍欠着、仍要在重启后投递；准备期间新出现的会话：**在工作的**被加入而不是忽略——在它背后重启它，正是这个屏障要防的事；新出现但仍然空闲的不加入，理由与上面同一条（出现 ≠ 在工作）。

`heartbeat_restart_commit {intentId}` 等回执：只有全部参与者终态**且** requester 自己已登记，才准备并提交重启（返回 `committed`）；否则返回 `aborted` 并点名缺失的会话，宿主继续运行。原因分类：`no_intent`、`not_requester`、`deadline_exceeded`、`missing_acks`、`requester_not_registered`、`intent_mismatch`。`intent_mismatch` 是 0.3.17 加的：commit 只认被点名的那个 intent，否则一个已被撤销的 `intentId` 能花掉重新打开的新屏障并真的重启宿主。`not_requester` 与 `no_intent` 不关闭 intent（别人的失败不是 requester 的放弃），其余中止都会把它关进历史。`onTimeout:'abort'`（默认）超时后拒绝重启；`'proceed'` 记录缺失者后照常重启；`force` 跳过检查，并在 intent 里留下「这次是强制的」。

intent 写进 `~/.Newmark/heartBeat/state.json`（schema 3，新增 `intent` 与最多 20 条 `intents` 历史，旧 schema 2 文件照常读），所以新宿主能收尾：`committing` 在 helper 报告新进程身份（路径相同、创建时间不同）后变成 `committed`，并把本次投递的任务写进 `delivery.tasks`；旧进程留下的 `preparing` 变成 `interrupted` 并通知 requester「上一次没有提交就中断，DSH 仍在原进程中」。没有这条清扫，这个功能本身就会制造它要防止的静默丢失——用户以为重启了，其实没有。过期且无人提交的准备会自行关闭，否则一个被遗忘的 intent 会永久拒绝新的广播。

`heartbeat_restart_cancel {intentId}` 已在 0.3.17 补上：一次状态转换 `preparing -> aborted(reason:'cancelled')` + 向 requester 的持久通知；非 requester / 未知 intent / 非 preparing 分别以 `not_requester` / `unknown_intent` / `not_preparing` 拒绝，`not_requester` 不关闭 intent；取消后屏障可重开、该 intent 不可再 commit。取消只覆盖 `preparing`：`committing` 之后不可撤回，仍走 committing -> committed 的清扫（helper 已启动）。它的门禁证据是 fixture 级的 —— 通知确实写进 durable state，但「requester 真的看到了」没有活体会话证据，与 `ackMode:'agent'` / `onTimeout:'proceed'` / `force` / 「不回执参与者 → aborted」一样。intent 打开时向 NewMate 发一条气泡提示这件事（气泡带取消/立即重启的说明文字，不是客户端按钮）；陪伴开关关闭或气泡被静音时记为 `skipped:*`，不影响屏障判定，也不伪报「已告知用户」。

## Agent API 视觉

新增 images base64 输入，经模型图像能力核验与 DSH attachments.saveImages，产生真实 ImageBlock，而非仅文件路径文本。ComputerUse 当前完整捕获自动附图，稀疏要求重新完整观察的结果只给收据；只接纳临时捕获专用目录内最新一分钟、大小受限的文件。隐藏 Windows BMP 转 RGB PNG，再入宿主附件库。默认每批最多四张、合计 8 MiB；实际宿主 JSON walker 验证附件结构，但尚未用真实提供商完成视觉问题黑盒验收。

## MCP 接入

运行中的 DSH 启用 NewMate 后，调用 `newmate_mcp_info({})` 获得路径 `/newmark-newmate/mcp` 与本地 tokenFile。该操作首次创建凭证，工具结果不回传 token。其他 agent 使用 DSH HTTP 服务的实际 base URL 加该路径，Authorization 为 `Bearer <tokenFile内容>`；若宿主 HTTP 服务另有鉴权，亦须满足宿主要求。凭证由宿主环境保护，不写入对话/文档。

实现 Streamable HTTP JSON 响应，协议 2025-06-18 / 2025-03-26；POST 为 application/json，Accept 同时包含 application/json 与 text/event-stream。支持 initialize、ping、tools/list、tools/call，通知 202；无 SSE 时 GET 405。工具仅 chat/status/native memory，不暴露跨对话、重启和删除。验证 Origin、Bearer、协议、体积和参数。此接口是内嵌 DSH HTTP 路由，不新增常驻服务器。

## 验证与边界

专项脚本 `verify-newmate-heartbeat.mjs` 覆盖视觉请求、只读权限、持久任务、真实宿主 followup 形状、flush、消费后多次启动、独立开关；可通过 NEWMARK_HOST_WALKER 指定已安装 DSH 的纯 JSON walker 验证官方输出边界。`verify-short-memory-mcp.mjs` 覆盖七天过期、完整列表、原生缓存、原对话唤起、实际 HTTP MCP。客户端执行真实组件函数核对三标签、全部短记忆和灰显；不是实机截图。

总门禁与最终打包收据见本次 archive/REPORT.md。仍须已安装 DSH 的 UI、真实视觉提供商与实际全局重启黑盒验证；本轮未修改运行安装和未执行用户会话重启。多进程共享同一用户根目录尚无跨进程锁，使用单 DSH 写入实例；同步原子写提供单进程组件重载安全，不承诺跨进程事务。

---

## 0.3.52 追加：重启接续**不能**替用户重新武装 goal（宿主权限边界，实测）

**现场**：重启后的自动续跑轮里，模型按照续跑提示词调用 `update_goal{action:"resume"}`，被宿主拒绝：

> `this goal operation requires a direct human turn on a top-level agent`

**根因（读宿主源码，不是猜）**：`@deepseek-ai/dsh-tool-goal/lib/index.js`（从 `app.asar` 解包）里，
`update_goal` 的 `edit`/`pause`/`resume` 与 `create_goal` 都先走 `requireDirectHuman()`，而它要求
`hasDirectHumanInput()` 为真：本轮的 open turn 里必须有一条 `user/message` 且 `data.source.kind === "user"`，
且该 agent 必须是 runtime root。`complete`/`blocked` 走 `completionAuthority()`，额外允许「本目标自己的那一轮」
（`source.kind === "goal"` 且 goalId/revision/round 都对得上）。**重启接续两者都不是**——它的来源不是 `user`，
也不是 goal round——所以那四个动作在这一轮里**必然被拒**，写多少遍提示词都一样。

**修法**：续跑提示词不再要求写目标；只 `get_goal` 读状态，把「重新武装」交回人类那一句（用户回一句「继续」即可）。
白名单做成数据而不是散文：`CONTINUATION_GOAL_POLICY`（`allowed: ['get_goal']`、`refused` 列全六个写操作、
`authority` 一句说清两种授权来源、`resume_hint` 是给用户的那句话），提示词由它拼出来，门禁断言两者一致。

**为什么不去绕过**：插件直接调 `ctx.goals.resume()` 能成功，但那正是宿主这条守卫拦住的事——
「只有人类能解除/恢复一个目标」是产品决定，不是实现细节。绕过去等于把守卫变成装饰。
---

## 0.3.54 重启后的 goal 恢复：改由组件硬性执行（附宿主语义实读）

**宿主是怎么实现 goal「自动续跑」的**（解包 `app.asar` 读 `@deepseek-ai/dsh-goal/lib/index.js`）：

- `goal` 的 **phase** 是持久的（`sessionProjections.stateOf(session,'goal')`），而 **activation** 是
  **进程级** 的：`runtimeState(session)` 给每个 session 起一个 `{ activation:'disarmed' }`，
  session-start 订阅再按事件把 activation 设成 `disarmed`（只有跟着某条 pendingActivation 边沿才可能是 armed）。
- `dsh-goal-round-driver` 的判据是 `goal.phase === 'active' && goal.activation === 'armed'`；它自己会在
  挂起时 `ctx.goals.disarm(agent)`。所以**重启后目标一定停摆**，直到有人调用 `goals.resume(agent, ref)`。
- `resume(agent, ref)` 的可恢复集合是 **active / paused / blocked**，并且：`assertLive(agent)`（必须是 registry 里
  同一个 agent 实例）、`expectCurrent` 要求 id+revision 精确匹配、active+armed 直接报错、轮次耗尽报错；成功后
  把 phase 置 active、activation 置 armed（`commitCurrent(..., 'armed')`）。
- 宿主工具 `update_goal` 的 `resume` 走 `requireDirectHuman()`：本轮 open turn 里必须有 `user/message` 且
  `source.kind==='user'`。自动续跑轮不满足，所以**模型永远拿不到这条**。

**因此恢复必须发生在组件里，且分两段：**

1. **重启前**：`captureGoalSnapshot(reason)` 在 `restart()`（立即重启与更新路由）和屏障 `commitBarrier`（真正
   `controller.restart` 之前）各调一次，记录每个 live 对话的 `sessionId / running / goalId / phase / activation /
   revision / roundsStarted / maxGoalRounds`，写 `state.goalSnapshot`。**不记录 objective**：快照不是改写通道。
2. **新进程第一个 tick**：`restoreGoalSnapshot()` 用 `agents.roots()` 按 sessionId 找回 live agent，只处理
   「重启前 phase==='active'」的条目，`resume(agent, {id, revision})` 后读回校验，写 `state.goalRestore`
   （`resumed[] / skipped[]` 逐条原因、`resumed_count / verified_count`）。`heartbeat_activity` 的返回里也能
   读到这份回执。

**明确不做的三件事**：paused 不动（用户按的暂停）；blocked 不动（虽然服务把 blocked 列为可 resume，但那是
人的结论，不是重启该改的状态）；complete 不复活。另外轮次耗尽 / agent 未载入 / 目标被改过 / resume 抛错都
记成具名跳过原因；服务不可用最多等 30 个 tick 后写 `gaveUp:'services_unavailable'`，不无限重试。

**`goal_restore` 工具**保留为兜底：参数为空且 sealed，只能恢复当前对话的 paused 或 active+disarmed 目标；
续跑提示词与全部 heartBeat 工具描述都写明「目标由组件自动恢复，只有失败时才用它，不要用原生
`create_goal`/`update_goal`」。