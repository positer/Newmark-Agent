# 16 · 把微信 ClawBot 接成 NewMate 的一条信道（只读调研 + 接入设计）

日期：2026-10-27（Asia/Shanghai）。状态：**调研与设计文档；本轮未改任何源码、未打包、未安装、未重启**。
适用版本：`newmark2dsh` **0.3.43**（源码 `Newmark2DSH/packages/newmark-core/package.json:3` ＝ 本机安装态 `~/.dsh/profiles/desktop/node_modules/newmark2dsh`，两者一致，【实测】）。

> 相关材料：`docs/wechat-clawbot-interface.md`（iLink 协议面，2026-10-27）、`Newmark2DSH/docs/15-wechat-clawbot-research.md`（通道横评与准入，2026-10-25）。
> 本篇**不重复**协议考古，只回答一件事：**"微信来消息 = 用户给 NewMate 发了一条消息，NewMate 答完把纯文本气泡版发回微信"落到 0.3.43 的哪几个函数上，要补哪些语义，代价与风险各是什么。**

证据分级（全文一致）：**【实测】** 本机当前进程真实发起并读到响应；**【源码】** 读到具体文件的具体行；**【门禁】** 仓库 `scripts/verify-*.mjs` 的断言（读断言本身，本轮未重跑）；**【文档】/【社区】/【推测】** 依次降级。

---

## 0. 一句话结论

**入站不需要新内核，出站不需要新协议。**

- 0.3.43 里"一条用户消息进来"只有一个内核入口：`component.js:598 chat(text, execution, threadId)`；页面（`index.js:196`）与 MCP `newmate_chat`（`mcp.js:11`）都汇到它，最终都走 `enqueue → tick → agent_api_send → readReply → messages[] → notify`。
- 出站也只有一个出口：`component.js:338 readReply` → `:356 messages[{text, plain}]` → `:358 notify`。`plain` 就是"气泡/外部渠道"用的纯文本版，**0.3.43 已经把它写进持久状态**（本机状态里实测存在该字段）。
- 微信侧真正缺的只有**传输层**（iLink 长轮询收发）和**渠道身份的三件事**：来源可辨识（`messages[].source`）、入站幂等（`chat()` 没有 id）、授权与线程的显式决定。

**推荐两步走，而不是一步做完**：先用"零插件改动的独立桥进程"验证微信侧准入与端到端（步骤 0），确认可用后再把桥收进插件并补那三件事（步骤 1）。理由见 §4.4：本项目每一次安装/重启都有历史事故，而"微信侧能不能用"根本不由我们的代码决定。

---

## 1. 现状：0.3.43 的信道实况

### 1.1 入站（【源码】）

| 环节 | 位置 | 事实 |
|---|---|---|
| 页面发送 | `client.js:2373 send()` → `client.js:2371 post()` | `POST /newmark-newmate`，头 `x-newmark-newmate: 1`，体 `{action:'chat', text, threadId}` |
| 路由 | `index.js:178`（`webServer.register({kind:'exact',path:'/newmark-newmate'})`） | GET 返回整份 `mate.state()`（`:181`）；POST 走 `switch(input.action)` |
| 来源闸门 | `index.js:183` | 只查 `x-newmark-newmate==='1'` 且 `sec-fetch-site!=='cross-site'`；**没有 token** |
| 分发 | `index.js:196` | `mate.chat(input.text, undefined, input.threadId)` —— 第二参 `execution` 写死 `undefined` |
| 内核 | `component.js:598` | 校验 1–16000 字 → `thread(threadId)` → 运行中同线程则 steer（`:602-606`）、不同线程则 `active.abort()`（`:608`）、已有 pending 则拼 prompt（`:609-610`）、否则 `enqueue(...,'chat',...)`（`:611`）→ 落 user 消息（`:613`）→ `queueMicrotask(tick)`（`:614`） |
| 落库 | `component.js:613` | `{role:'user',text,threadId,at,id:inputId,steerTaskId}` —— **没有 source / channel 字段** |
| MCP 入站 | `mcp.js:11` `newmate_chat` | `execute:(a,execution)=>mate.chat(a.prompt,execution)`；schema **只有 `prompt`，没有 threadId** |
| MCP 派发 | `mcp.js:36` | `await tool.execute(args)` —— **只传一个参数**，所以 HTTP 调 `newmate_chat` 时 `execution===undefined` |

### 1.2 出站（【源码】）

| 环节 | 位置 | 事实 |
|---|---|---|
| 解析 | `component.js:34-42 readReply` | 先看 `envelope.result.structured`（只有自动轮有 `output_schema`），否则 `normalizeReply(output)` |
| 协议 | `reply-format.js:8 REPLY_PROTOCOL` | 最终只输出一个 JSON：`text`（页面，可 Markdown）、`plain`（气泡与外部渠道，单段无 Markdown，**≤80 字**）、`notify`（自动轮必填）、`topic` |
| 落库 | `component.js:356` | `message={id:task.id, threadId, role:'assistant', text:answer, plain:reply.plain, ...}` |
| 气泡 | `component.js:358` | `notify({...message, text: bubbleText(message), rich_text: message.text})` —— 交给气泡的是 **plain** |
| notify 门 | `component.js:166-173` | 只有 `settings.companion` 为真才发；`isQuiet`／`snoozeUntil`／主动消息 30 分钟冷却任一条成立就**只落库不弹** |
| 桌宠 | `index.js:42` → `desktop-pet.js:38-44` | 桌宠不在跑就 `throw '陪伴桌宠未运行'`；按 `message.id` 去重；`bubbleSummary` 再截到 80 码点（`presentation.js:5`） |

**关键判断：`notify()` 是"要不要弹给桌宠"，不是"要不要发出这条消息"。** 它有陪伴开关、静默时段、snooze、冷却四道门，还会因为桌宠进程没起来直接抛错（错误被 `failures` 吞掉）。**任何外部渠道若挂在 `onNotify` 上，就会继承这四道门。**

### 1.3 本机实测（2026-10-27 13:4x，当前运行的 0.3.43）

| 动作 | 结果 |
|---|---|
| `GET /` | **401** `dsh web authentication required`（宿主自己的准入在起作用）【实测】 |
| `GET /newmark-newmate` | **200**，120,525 字节：全部 messages / threads / tasks / todos / settings，**含 `plain`**（102 条消息里 2 条带 plain，与 0.3.43 的活体样本一致）【实测】 |
| `GET /newmark-newmate/loop` | **200**，agentLoop 快照（`running:false, phase:done, kind:chat`）【实测】 |
| `POST /newmark-newmate` 无 `x-newmark-newmate` | **400 `请求来源无效`**（插件自己的闸门）【实测】 |
| `POST /newmark-newmate` 有头 + 未知 action | **400 `未知操作`**（请求已被宿主放行并进入插件分发）【实测】 |
| `POST /newmark-newmate/mcp` initialize（Bearer） | **200**，`serverInfo {name:'newmark-newmate',version:'0.3.14'}`【实测】 |
| `tools/list` | **200**，**7 个工具**；`newmate_chat` 的 inputSchema 只有 `prompt`【实测】 |
| 端口绑定 | `Get-NetTCPConnection -LocalPort 57618` → 只有 `127.0.0.1`（1 个无状态 LISTEN + 4 个 Established），**仅回环**（IPv6 未单独核）【实测】 |
| 安装版本 | `~/.dsh/profiles/desktop/node_modules/newmark2dsh/package.json` = **0.3.43**，与源码一致【实测】 |

两条顺带发现（不影响结论，但要记账）：

1. **`GET /newmark-newmate` 无鉴权即可读到全部对话正文。** 它只受"仅回环 + 宿主对 `/` 的鉴权"保护，而插件自己注册的路径不经那层鉴权。本机任何同用户进程都能读。接微信之前不需要修，但**不能因此把这条通路当成可信边界**。
2. **MCP `serverInfo.version` 是 `0.3.14` 而不是 0.3.43**：`mcp.js:17` 的默认参数 `version='0.3.14'`，`index.js:62` 调用时没传 `version`。任何按版本号分支的桥接客户端都会被误导（本轮实测复现）。

---

## 2. 需求 → 四条可验收判据

| # | 判据 | 怎么证明（不接受"看起来对"） |
|---|---|---|
| A | 微信来的一条文本，与用户在页面里打的一条消息**走同一条内核链路** | 任务 `kind==='chat'`、同一条 `chat()→enqueue→tick→agent_api_send→readReply→messages[]`；页面历史里能看到这条消息 |
| B | 回复落库后，**发给微信的是 `plain`（气泡版）而不是 `text`** | 断言发出的 payload `item_list[0].text_item.text === message.plain`；与 `text` 不同 |
| C | 不破坏现有语义：多用户隔离、授权边界、暂停/静默、去重、错误可见 | 各条单列断言（见 §6） |
| D | 失败可归因：跑失败、被抑制、限速、token 失效，渠道都能区分并给出对应行为 | 门禁用假 iLink 服务端逐条触发（见 §8） |

---

## 3. iLink 传输层：一个渠道要照抄的四个动作

> 协议面以 `docs/wechat-clawbot-interface.md` 为准；本轮由 `clawbot-protocol` 用 `npm pack @tencent-weixin/openclaw-weixin@2.4.10` 解包**重核**（tarball sha256 `69DD18AF…`，131 文件，含 42 个 `src/*.ts` 原文），完整规格与逐行出处见 `archive/20261027-134030-clawbot-newmate-channel/evidence/protocol-sheet.md`。下表每个数字我都抽检过其中三处（getupdates 请求体、sendmessage 判据、进度消息默认值），与源码一致。

| # | 动作 | 端点 | 实现要点（带出处） |
|---|---|---|---|
| 1 | 收 | `POST /ilink/bot/getupdates` | 请求体**只有** `{get_updates_buf, base_info}`（`api.ts:461-464`，**没有 `sync_buf`**）；首轮游标传空串；响应 `{ret, msgs[], get_updates_buf}`，游标为空则不覆盖本地（`monitor.ts:152-156`）；**客户端 35 s 超时被改写成 `{ret:0,msgs:[]}` 并立即重轮询，不算错误**（`api.ts:472-486`，已抽检） |
| 2 | 认 | — | 只处理 `message_type===1`（用户）且 `item_list` 含 `type===1` 的文本项；`message_id` 线上是 uint64，官方在 `parseWeixinApiJson` 的 `LOSSLESS_ID_FIELDS` 里**预包成字符串**防丢精度（`api.ts:518-577`）→ 去重键必须用字符串 |
| 3 | 回 | `POST /ilink/bot/sendmessage` | `{msg:{from_user_id:"",to_user_id:对方,client_id:本地生成,message_type:2,message_state:2,context_token:入站原样回传,item_list:[{type:1,text_item:{text}}]},base_info:{...}}`；**一条消息一个 item**，带媒体要拆两次请求（`send.ts:70-78`、`:192-264`） |
| 4 | 打字中 | `POST /ilink/bot/getconfig` → `POST /ilink/bot/sendtyping` | `getconfig{ilink_user_id, context_token?}` → `typing_ticket`（仅 `ret===0` 时缓存，24 h 随机刷新，失败 2 s→1 h 退避，`config-cache.ts:45-74`）；`sendtyping{ilink_user_id, typing_ticket, status:1|2}`；**没有 ticket 就直接跳过、且不阻塞回复**（`process-message.ts:311-341`） |

**硬边界（决定设计形状，不是细节）**：

- **官方客户端没有入站去重**：`src/` 里 `dedupe`／`seenSet` 命中 **0 处**（本轮 grep 复核）。去重是渠道自己的责任，不是协议给的。
- **官方客户端没有任何节流**：`throttle`／`rate limit` 命中 **0 处**。发送只串行（`sendChain`），不限速。所以"发太快会被拒"这件事**必须由我们自己的令牌桶兜住**。
- `sendmessage` 的判据是 `if (resp.ret && resp.ret !== 0) throw`（`api.ts:592`，已抽检）→ **响应里缺 `ret` 时不会抛错**。"没报错"不等于"已发送"，必须自己记录 `message_id` 并把"已发出/已确认"分开陈述。
- **工具进度消息默认开启**：`replyProgressMessages` 默认 `true`（`config-schema.ts:37`，`config/reply-progress.ts:9` 判 `!== false`），每个工具 start/end **各发一条独立 `sendmessage`**（`reply-progress-sender.ts:62`）。→ 对 NewMate 这种一轮用多工具的 run，**进度消息会把下行额度烧光**。渠道只发最终 `plain`，**永远不开进度消息**。
- 同一 `context_token` 连续回复约 10 条后 `ret=-2` 且无新入站不恢复（issue #81，open、零官方回复，**源码无计数器**，条数与限速无法区分）。→ 一条入站最多回 1–2 条。
- `errcode=-14` 只在 `getUpdates` 判，官方处理是 `pauseSession` **停 60 分钟后 `continue`，不自动重登**（`monitor.ts:115-127`、`session-guard.ts:3-6`）。→ 我们也停手、标状态、等人工扫码。
- `ret:0` 不等于客户端可见（issue #264）；非官方运行环境扫码可能被"运行环境存在风险"硬拦截（issue #333）。→ **准入不由代码决定**，这正是 §4.4 两步走的理由。
- 文本长度：服务端上限**未见**；客户端只声明 `textChunkLimit: 4000`（`channel.ts:269`）且自身不分片。→ 渠道按 4000 字符硬限自截断，绝不拆条刷屏。
- Markdown 不被渲染（官方 `markdown-filter.ts`）。→ 与 `plain` 的设计天然一致。

**一处口径澄清**：`Newmark2DSH/docs/15-wechat-clawbot-research.md:341` 的"30 条/分、1000 条/时、24 小时回复窗"写在 **§9.3 企业微信智能机器人**一节里，指的是 WeCom，**不是 iLink**。原文归属正确，但两条通道的额度容易被串读，引用时必须分开。iLink 侧目前**没有任何公开的条数/QPS 声明**（协议文档未写 ≠ 没有）。

---

## 4. 三种接法

### 4.1 方案 A：独立桥进程（零插件改动）

```
微信 ←→ ilinkai.weixin.qq.com ←(HTTPS 长轮询)→ wechat-bridge（本机 Node 进程）
                                                  │ 入站：POST /newmark-newmate {action:'chat',text,threadId}
                                                  │       + 头 x-newmark-newmate: 1
                                                  │ 出站：轮询 newmate_task_status{id}（Bearer）取回 plain
                                                  ▼
                                       NewMate（chat() → run → messages[{text,plain}]）
                                                  │
                                       取 message.plain → sendmessage 回微信
```

- **今天就能跑**：入站路由与出站读取都已在 0.3.43 存在，且本机实测可达（§1.3）。
- 出站取回复两条路：MCP `newmate_task_status{id}`（Bearer 鉴权、只返回该任务那条消息、含 `plain`，**推荐**）或 `GET /newmark-newmate`（无鉴权但要拉 120 KB 全量，不适合高频轮询）。
- 代价（全部是"语义没补齐"，不是"跑不起来"）：
  1. **没有来源标识**：微信来的消息在页面历史里与用户自己打的字无法区分（`component.js:613` 没有 source）。
  2. **没有入站幂等**：`chat()` 不接受 id，iLink 游标回退/重投会**重复建任务或重复 steer**（对比 `message()` 的 `:591` 去重、待办的 `todoMessageId`、`deliverConversation` 的固定消息 id —— 只有 chat 缺）。
  3. **线程只能是"当前活动线程"**：`thread()`（`:162`）对非活动线程直接抛 `'历史对话只读'`。用户在页面切了线程，微信就来不了或来错地方。
  4. **授权固定为"页面用户"档**：`origin` 恒 `undefined` → 有 CU/搜索/ask，**没有 `newmate_task`**（`:108-111`）。这不是 bug，是"渠道 = 权限更小的用户"，必须写明。
- 好处：桥是独立进程，崩溃/重启不牵连 DSH；反过来 DSH 重启时桥要退避重连。

### 4.2 方案 B：把渠道收进插件（组件化）

新增 `components/wechat-clawbot/`（或 `components/newmate/lib/channel-wechat.js`），在插件作用域里持有长轮询与发送队列，直接调用 `mate.chat(...)`，并在**发布点**接一个显式出站汇。

- 好处：无 HTTP 中转、无 token 文件、无端口发现；能拿到 `plain` 的**发布时刻**（不轮询）；能把来源写进 `messages[].source`；一个门禁覆盖全链路。
- 代价：长轮询跑在 Electron 宿主的插件进程里（35 s 一次请求，要能优雅 `stop()`）；bot_token 要落盘（0600、单独文件、不进日志/文档，与 `mcp-token` 分开）；每次改动都要走"打包 → 安装 → 重启"（本项目历史上这里有事故）。
- **必须同时改三件事**，否则"= 用户发信"只是入口相同：
  1. `chat()` 增可选 `{clientId, source}`：`clientId` 落 `messages[].id`/`tasks[].id` 做幂等；`source` 落 `messages[].source`，页面只做标注、不改语义。
  2. **出站不要挂在 `onNotify` 上**：在 `:353-359` 发布点旁挂第二个汇（`channelSinks`）。桌面气泡维持现有四道门，微信只受它自己的开关与限速约束；两边都拿 `bubbleText(message)`。
  3. 授权与线程**显式化**：渠道轮给不给 `newmate_task`（建议**不给**，渠道没有 DSH 会话身份，给了等于允许微信替用户唤醒任意会话）；线程用"绑定当前活动线程"还是"微信专用线程"——后者要改 `thread()` 的只读规则，属于独立决策。

### 4.3 方案 C：官方 OpenClaw 外挂桥接

装 OpenClaw + 官方 `@tencent-weixin/openclaw-weixin`，把 OpenClaw 的消息桥到 NewMate。

- 唯一的"官方路径"，风控最友好；但引入一整个 OpenClaw 运行时（版本强耦合：2.4.10 就是在修 OpenClaw 兼容），对本项目是重依赖。
- 适合"先确认微信侧到底能不能用"，不适合做产品形态。

### 4.4 推荐：先 A 后 B（分两步，不是一个方案）

| 阶段 | 做什么 | 凭什么现在做 | 什么时候算完成 |
|---|---|---|---|
| 步骤 0（今天） | 写独立桥（方案 A），零插件改动 | 入站/出站通路已存在且实测可达（§1.3）；不改版本、不安装、不重启 | 真机扫码 → 微信发一句 → 页面里能看到同一条消息 → 微信收到 `plain` |
| 步骤 1（确认可用后） | 把桥收进插件（方案 B），补 source / 幂等 / 授权三件事，加门禁 | 三件事都是"语义缺口"，不补则渠道一上线就是"来源不明的第二条输入" | `verify-newmate-wechat-channel` 绿 + 一次活体往返 |

**为什么不直接做 B**：步骤 0 要验证的第一件事是**微信侧准入**（插件权限是否灰度到、扫码是否被"运行环境存在风险"拦截、一条入站能回几条）。这三件事全部不由代码决定；用"零改动桥"去撞它们，比先改插件、装包、重启再撞便宜得多。这也符合本项目一贯口径：**源码、安装、版本三件事分开陈述**。

---

## 5. 若走方案 B：接口契约（建议形态）

```js
// 组件内，与 mate 并列；不注册 HTTP 路由（入站由它自己的长轮询驱动）
const channel = createWechatChannel({
  mate,                                            // 复用 chat()，不另造内核
  stateDir: <root>/newMate/wechat,                 // bot_token(0600)、游标、去重表、发送队列
  selectThreadId: () => mate.state().activeThreadId,   // 或专用线程（需改 thread()）
  limits: { maxRepliesPerInbound: 2, minSendGapMs: 1000, maxTextChars: 4000 },
});

// 入站：一条文本 = 一条用户消息
await mate.chat(text, undefined, threadId, { clientId: messageId, source: 'channel:wechat' });

// 出站：发布点旁的第二汇，不经过 notify 的四道门
channelSinks.add(async message => {
  if (message.source !== 'channel:wechat') return;   // 或按策略镜像全部
  await channel.send(message.plain, message.threadId);   // plain 已是气泡版
});
```

**三个必须现在就定的策略**（不是实现细节）：

| 策略 | 选项 | 建议与理由 |
|---|---|---|
| 出站范围 | 只回"微信发起的这一轮" / 镜像全部回复（含页面与主动消息） | 先"只回发起轮"。镜像全部会让用户在页面里每次说话都收到一条微信；真要做镜像时当独立开关，并复用 `proactiveMessageGate` |
| 线程 | 当前活动线程 / 微信专用线程 | 先"当前活动线程"（= 真的是同一个对话）。专用线程要改 `thread()` 的"历史只读"规则，是新语义，需要单独决策 |
| 授权 | 页面档（CU/搜索/ask） / 更小 | 页面档：用户确实在说话。**不给 `newmate_task`**：渠道没有 DSH 会话身份 |

---

## 6. 必须一起改的语义（缺一条就不算"= 用户发信"）

| # | 语义 | 现状（源码） | 最小做法 |
|---|---|---|---|
| 1 | 来源可辨识 | `component.js:613` 无 `source` | user 消息加 `source`；页面只做标注 |
| 2 | 入站幂等 | `chat()` 无 id（`:598`） | 加 `clientId`，命中 `messages[].id` 就返回 `duplicate` |
| 3 | 授权 | `origin → newmate_task`（`:108-111`） | 渠道显式不给；不要靠"宿主是否传 execution"决定权限 |
| 4 | 线程 | `thread()` 只允许活动线程（`:162`） | 默认绑定活动线程；切线程时应明确告知"微信侧暂不接收"，不要静默失败 |
| 5 | 暂停/静默 | 用户消息**一律放行**（`chat()` 不读 settings；`:300` 只挡自动轮） | 若要"静默时段不打扰"，页面与渠道**两处一起改**，否则两条信道规则不一致 |
| 6 | 去重（出站） | 气泡按 `message.id` 去重（`desktop-pet.js:40`，进程内数组，重启即清） | 渠道用自己的持久表按 `client_id` 去重 |
| 7 | 错误可见 | `chat()` 返回 `{id,mode,inputId}`，页面根本不读（`client.js:2373`） | 渠道必须用 `newmate_task_status` 区分 `pending/running/completed/failed/interrupted`；**注意 `suppressed` 不会出现在 `messages` 里**（`:352/:359` 只写 `tasks[].suppressed`），只轮 messages 会把"被抑制"误判成"还在跑" |
| 8 | 两套丢弃语义 | 运行中同线程 → steer；run 结束后仍有引导 → 任务回 pending 且 **`:326` 用新引导替换 prompt，刚产出的答案被丢弃**；不同线程 → `:608` 直接 abort 旧轮 | 渠道要给用户明确回执（"这条没回，因为你插队/切了对话"），不能沉默 |

**两条额外的读码风险（与渠道无关，但会被渠道放大）**：

- `normalizeReply` 只认**首尾恰好是 `{`/`}`** 的字符串（`reply-format.js:37`），不剥代码围栏、不剥前言。模型若输出"```json … ```"或先写一句"好的："，`protocol=false`，**整段 JSON 会变成正文**——页面看到 JSON，微信也收到 `toPlain(JSON)`。0.3.43 的活体只证明那一次没漏，不是结构保证。
- `plain` 的三个数字不一致：协议 **≤80**（`reply-format.js:8`）、自动轮 schema **≤120**（`component.js:322`）、气泡再截 **80 码点**（`presentation.js:5`）。渠道必须自己定上限并截断。

---

## 7. 失败面（渠道必须逐条有行为）

| 场景 | 触发 | 行为 |
|---|---|---|
| 准入不存在 | 微信侧没有「微信ClawBot」插件入口 / 扫码被"运行环境存在风险"拦截 | 明确报"未开通"，不重试、不降级成别家通道 |
| 名额冲突 | 该微信号已绑过别的助手，再扫码会顶掉 | 二次确认；不得静默替换 |
| token 失效 | `errcode=-14`（整账号暂停 1 h，官方停 60 min 后 continue、不重登） | 立刻停发、标 `paused_until`、状态行写"需人工重新扫码" |
| 限速/重复 token | `ret=-2`（官方源码无节流，我们自建） | 令牌桶 + 最小间隔 1 s + 一条入站最多 2 条回复；`ret!=0` 不刷屏 |
| "没报错但没发出" | `sendmessage` 缺 `ret` 时不抛错（`api.ts:592`） | 记 `client_id`+`message_id`，文案说"已发出"而非"已送达" |
| 进度消息烧额度 | 官方进度消息默认开、每工具事件一条 | 渠道**永不开启**进度消息，只发最终 `plain` |
| 宿主在跑长任务 | 单飞：`tick()` 同时只有一个 run（`:272`） | 微信消息进 steer 缓冲或排队，回一条打字中状态，不刷消息 |
| DSH 未运行/重启中 | 桥的入站请求失败（`GET /` 都是 401，插件路由不在时更甚） | 指数退避重连；游标不前进，重启后从断点续收 |
| 长文本 | 服务端上限未见，客户端 `textChunkLimit: 4000` 且不分片 | 按 4000 字符截断（不是拆条），并在结尾标注截断 |

---

## 8. 门禁建议（写代码前先定）

新增 `scripts/verify-newmate-wechat-channel.mjs`（假 iLink 服务端 + 假 mate，不联外网）：

1. **入站**：一条文本 → 只调用一次 `chat()`，参数含 `source` 与 `clientId`；同 `message_id` 重投 → **不产生第二个任务**。
2. **出站**：发出的是 `message.plain`（且 ≠ `text`）；`plain` 缺失时回退 `toPlain(text)`。
3. **静默时段**：微信回复照发（与页面召回一致），桌宠气泡仍被静默——两边各按自己的门。
4. **`-14`**：停手、写 `paused_until`、后续入站不再发送。
5. **`ret=-2`**：本地队列退避后放弃并记失败，不进死循环。
6. **被抑制**：`tasks[].suppressed` 有值时不发消息、也不谎报"还在处理"。
7. **幂等**：同一任务两次发布只发一条微信（`client_id` 去重）。
8. **线程**：非活动线程 → 明确 `thread_readonly` 回执，不静默。
9. **长度**：`plain` 超限按 4000 字符截断并标注；不拆条。
10. **不烧额度**：断言渠道从不发送工具进度消息（一个多工具 run 只发 1 条）。

---

## 9. 未验证清单（不要当成已证明）

1. **iLink 全链路从未真机调用过**（两轮调研都是读源码/文档）。扫码准入、收发、`-14` 冷却、10 条上限全部是文档/社区结论。
2. **宿主准入**：本机实测 Node 的 `POST /newmark-newmate` 被放行（拿到插件的 `未知操作`），但 `docs/01-dsh-plugin-contract.md:109-116` 写的策略是"renderer token 或 `ordinaryBrowserEnabled`"。这台机器放行 ≠ 别的机器放行，桥必须把 403 当正常失败并给出可读提示。
3. **`newmate_chat` 经 DSH 工具表**（而非 MCP HTTP）调用时，宿主是否把 `{agent:{session:{id}}}` 作为第二参传给 `execute(args, execution)`：仓库内**没有活体验证**（`lib/cu-caller.js` 与门禁 fixture 只证明约定）。
4. **`plain` 在页面上的标注**（"来自微信"）没有浏览器实测；本轮未改任何 UI。
5. **NewMate 一轮 run 的 P50/P95** 未在本轮标定（历史样本 10–60 s 量级），"先回一条在处理"的阈值要实测后再定。
6. **`tasks[].kind==='measurement'`** 在 `component.js:298` 被读，但组件内**没找到写入点**（标记"未找到"，不是"不存在"）。
7. **条数限制 vs 限速**：issue #81 的"约 10 条"无法区分是条数上限还是限速，官方源码无计数器、无节流。
8. 服务端 `sendmessage` 必填字段与 `context_token` TTL，官方文档**明确拒答**；任何自建桥都可能在第一轮踩空。

---

## 10. 与既有文档的关系

- `docs/wechat-clawbot-interface.md`：**协议面**（端点、头、消息模型、媒体、坑位）。本篇不复述。
- `Newmark2DSH/docs/15-wechat-clawbot-research.md`：**通道横评与准入**。本篇采用其结论：**只走 ClawBot，不碰个人号 hook**。
- 本篇：**接入设计**（落在哪几个函数、补哪几个语义、怎么验、失败怎么办）。

---

## 11. 证据索引

**本机实测（2026-10-27 13:4x，当前 0.3.43 进程）**

- `GET /` → 401；`GET /newmark-newmate` → 200 / 120,525 B（含 `plain`）；`GET /newmark-newmate/loop` → 200
- `POST /newmark-newmate`：无头 400 `请求来源无效`；有头 + 未知 action 400 `未知操作`
- `POST /newmark-newmate/mcp` initialize → 200 / `serverInfo.version='0.3.14'`；`tools/list` → 7 工具，`newmate_chat` 仅 `prompt`
- `Get-NetTCPConnection -LocalPort 57618` → 仅 `127.0.0.1`
- 安装态 `newmark2dsh@0.3.43` = 源码版本

**源码（Newmark2DSH/packages/newmark-core，行号已在正文给出，本轮全部读过）**

- `components/newmate/component.js`（631 行）：`chat` 598、`tick` 271、`notify` 166、`enqueue` 194、`message` 582、`thread` 162、`newMateRunTools` 108、发布点 353-359、`output_schema` 322、引导替换 326
- `components/newmate/index.js`（212 行）：路由 178、闸门 183、`case 'chat'` 196、MCP 注册 62-65
- `components/newmate/lib/mcp.js`（57 行）：工具表 7-15、`tools/call` 32-37（`:36` 只传一参）、鉴权 45-52、`version` 默认 17
- `components/newmate/lib/reply-format.js`（57 行）：协议 8、`toPlain` 11、`normalizeReply` 34、`bubbleText` 57
- `components/newmate/lib/presentation.js`：`bubbleSummary` 2-6
- `components/computeruse/lib/desktop-pet.js`：`notifyDesktopPet` 38-44
- `client.js`：发送 2371-2373

**官方 iLink 客户端（`@tencent-weixin/openclaw-weixin@2.4.10` 解包实读，本轮抽检复核）**

- `src/api/api.ts`：getupdates 461-464、超时空响应 472-486、sendMessage 判据 592、无损 id 518-577
- `src/monitor/monitor.ts`：游标落盘 152-156、`-14` 处理 115-127
- `src/config/config-schema.ts:37`、`src/config/reply-progress.ts:9`、`src/messaging/reply-progress-sender.ts:62`：进度消息默认开、每事件一条
- `src/messaging/send.ts`：发送体 70-78、媒体拆两条 192-264
- `src/messaging/process-message.ts`：typing 311-341

**子任务产出（本轮）**

- `archive/20261027-134030-clawbot-newmate-channel/evidence/channel-trace.md`（435 行）：NewMate 信道代码级追踪，逐行证据 + 未验证清单
- `archive/20261027-134030-clawbot-newmate-channel/evidence/protocol-sheet.md`（545 行）：iLink 实现级规格复核


---

## 12. 步骤 0 已交付：`SCRIPTS/clawbot-demo`（2026-10-27 14:2x）

§4.4 的"步骤 0"落地成一个独立 demo，**不碰插件、不改发布物、不写 NewMate 状态**：

```
SCRIPTS/clawbot-demo/
├── clawbot-demo.mjs            单文件 CLI（零运行时依赖）
├── README.md                   用法 / 判据 / 边界 / 本轮实测
└── vendor/qrcode-terminal/     终端二维码渲染（Apache-2.0，未改动）
```

| 命令 | 作用 |
|---|---|
| `selftest` | 离线自检：本机起一个假 iLink 服务端，跑真实客户端代码 |
| `login` | 取二维码 → 打印终端 QR + 备用链接 → 轮询到 `confirmed`，会话写 `~/.Newmark/clawbot-demo/session.json`(0600) |
| `run` | `getupdates` 长轮询收消息，**自动回一条纯文本回执**（`--typing` 加"正在输入"，`--no-echo` 只收） |
| `send <文本>` | 用上一条入站消息的 `context_token` 再发一条 |
| `status` / `logout` | 查看 / 删除本机会话（token 只打印掩码） |

**它是"双向是否可接收"的判据**：手机收到回执 = 发送方向通；终端打印 ⬇ 行 = 接收方向通；退出时直接给判定句。

**实测（本轮）**

- 离线自检 **28 / 28 PASS**，覆盖：登录落盘、二维码内容渲染、token 不外泄、入站计数、`message_id` 去重、长轮询超时不算错、游标续传、`ret=-2` 记为一次失败、`errcode=-14` 停手、`notifystart/stop`、typing、`getupdates` 请求体只有 `get_updates_buf`+`base_info`、首轮空游标、`sendmessage` 五个字段（`from_user_id` 空 / `message_type=2` / `message_state=2` / `context_token` 原样回传 / 单条 `text_item`）、三个必需头、`parseLossless` 的 uint64 精度、超长文本拒绝。
- **种植变异**（把 `message_type: 2` 改成 `1`）→ 27 / 28、exit 1，唯一失败项正是 `sendmessage: message_type=2 / state=2`，证明自检能变红。
- **生产端点探针**（未扫码、未绑定）：`get_bot_qrcode` 992 ms 返回，`qrcode` 32 字符、`qrcode_img_content` 89 字符且是 http(s) 链接；第一次 `get_qrcode_status` 长轮询到客户端 15 s 超时 → `wait`，与官方"超时按空响应"一致。

**边界（必须写清）**

1. **真机扫码与双向收发仍未验证**——需要用户手机扫码；本轮没有绑定任何账号。
2. **demo 不接 NewMate**：它回的是固定格式的回执，不是 NewMate 的 `plain`。把入站改成 `POST /newmark-newmate {action:'chat'}`、把出站改成读取 `message.plain`，是 §4.4 步骤 0 的后半段，尚未做。
3. 认证与准入门槛未变：手机侧没有「微信 ClawBot」入口时，`login` 会一直停在"等待扫码"。


---

## 13. 真机实测：双向已连通（2026-10-27 15:24–15:26，**取代 §12 的"未验证"边界第 1 条**）

§12 写的"真机扫码与双向收发仍未验证"，已被本轮实测**取代**（旧结论保留在此，不修改）：

| 环节 | 实测 |
|---|---|
| 扫码绑定 | 我发出的二维码被扫 → `confirmed` → `login` 退出码 0；`bot_id 11401b9b2fd5@im.bot`，`savedAt 2026-10-27T07:24:52Z` = 15:24:52 +08:00 |
| 收 | 15:25:48 收到 `message_id=7520747357862161160`、`message_type=1`、`message_state=2`、正文 `test`；19 位 uint64 id 被 `parseLossless` 无损保留 |
| 发 | 15:25:49 回执被服务端接受，分配 `message_id=7520747567807017736` |
| **客户端可见性** | 15:26:16 用户把回执原文发回：「确认收到 收到第 1 条：「test」（clawbot-demo 双向探测回执）」——**这条独立证明了回执真的到达了手机**，而不只是服务端受理 |
| 进程判定 | `收到 2 条 / 回执 2 成功 0 失败 / 停止原因 limit / 退出码 0` |

**新增的一条硬事实**：两次 `sendmessage` 的响应都**没有 `ret`，只有 `message_id`**。官方判据
`if (resp.ret && resp.ret !== 0) throw` 因此不会抛错——§3 里那条"缺 `ret` 不报错"从源码结论升级为**实测样本**。
任何桥/渠道都必须以 `message_id` + 用户端确认为准，不能把"没报错"当"已送达"。

**仍未验证**（边界没有变宽）：一条入站能回几条（约 10 条的上限）、连续对话多久出现 `ret=-2`、
`errcode=-14` 的冷却行为、`context_token` TTL、群聊（官方不支持）。本轮只有 2 个来回，不足以标定这些。

证据：`archive/20261027-142000-clawbot-demo/evidence/live-bind-and-echo.md`。


---

## 14. demo 的跨重启保持：已测（2026-10-27 15:31–15:35）

接入之前必须先确认一件事：**扫码换来的凭据与运行位置在进程重启之后还在不在**。结论是**都在，且不需要重新扫码**。

| 保持项 | 落盘位置 | 离线断言（`cross-restart-test.mjs` 19/19） | 活体（真实绑定） |
|---|---|---|---|
| `bot_token` / `botId` / `baseUrl` | `~/.Newmark/clawbot-demo/session.json`（0600） | 进程B 只 `loadSession(dir)` 即恢复，`get_bot_qrcode` 全程只调用 1 次 | 新进程 `send` 成功（15:35:08，`message_id=7520749831237976712`），用户收到 |
| 游标 `get_updates_buf` | 同上 `cursor` | 进程B 第一次轮询带的正是 `c1` | 新进程日志「从游标 ChAIAhCW3YLilzQYxY… 继续」，收到新消息后写回新游标 |
| 去重表 | `seen.json` | 重启前那条被判重复、只投递新的那条 | 新进程日志「已去重 id：2 条」 |
| `lastPeer` + `context_token` | `session.json.lastPeer` | 重启后无新入站也能直接发信 | 15:35:08 直发成功（无新入站） |
| 重启后能收 | — | — | 15:35:13 收到用户消息，15:35:16 回执，exit 0 |

**对新渠道的直接含义**：这条链路上"会话状态"是文件而不是进程内存，所以**桥进程可以随时重启**；
真正需要长期存活的是 iLink 长轮询本身，而它可以从中断处接着轮询（游标 + `message_id` 去重）。


---

## 15. 信道实现：`SCRIPTS/clawbot-newmate`（不改核心代码，2026-10-27）

用户对这条信道的三条硬约束，以及它们**分别落在哪一行**：

| 约束 | 落点 | 可验证的证据 |
|---|---|---|
| 微信发信 = 页面发信（运行中的"插入引导"完全一致） | 桥直接发页面同款请求 `POST /newmark-newmate {action:'chat', text, threadId:<activeThreadId>}` + `x-newmark-newmate: 1`。同一个 `chat()` 判定 start/steer；运行中同线程即 `guide.pending` | 自检 A 组断言请求体/头/`threadId`；第二次投递时 `chat()` 返回**同一 task** 且 `mode:'steer'` |
| 只转发**最终回复的纯文字气泡版** | 按 `taskId` 取 `messages[]` 里 `id===task.id && role==='assistant'`，取 `plain`（缺失时用 NewMate 自己的 `toPlain`）。**永不使用 `text`** | 自检断言发出的正文 == `plain` 且 ≠ 渲染版；**种植变异**（改成转发 `text`）→ 2 条断言变红、exit 1 |
| 接收确认后不再重投 | 账本 `bridge.json`：NewMate 回 `ok` 的那一刻写 `acked`；游标与账本**同一次原子写**，所以游标不会早于确认推进 | 自检 B 组（服务端重放 → `POST` 计数不变）、C 组（NewMate 拒绝 → 留 `pending`，恢复后确认，`attempts>=2`） |

**确认不是回复**：整个过程不给微信发"已收到"。微信只会收到 NewMate 产出的那一条纯文字气泡。
**微信侧没有"已读"接口**：官方 7 个端点里没有标记入站消息已读的调用，"已读取"只存在于桥的账本里。

**未改动核心代码**：`Newmark2DSH/packages/newmark-core/**` 一行未动；桥只用两个既存只读面
（`POST /newmark-newmate` 的 `chat` 动作、MCP `newmate_task_status`，后者不可用时回退 `GET /newmark-newmate`）。

**已知边界**：① NewMate 返回 ok 后、账本落盘前被杀 → 重启后会再投一次（2 次尝试封顶，"至少一次"的固有代价，没有给 `chat()` 加幂等键）；② 一个微信号 = 一个对话，多人共享活动对话是下一步；③ 回复延迟由 run 耗时决定（历史 10–60 s），桥 1 s 轮询 task；④ 15 分钟未出现回复则放弃转发并记日志。


---

## 16. 设置页按钮 + 原生弹窗二维码（0.3.44，源码候选）

用户要求：入口放在「陪伴与工作区监控」里，做成按钮；未连接显示**发起连接**，已连接显示**重新连接**，点它会清除登录信息并重新发起；二维码用 **DSH 原生 CSS 的弹窗**显示。

**落点**

| 层 | 文件 | 做什么 |
|---|---|---|
| 页面 | `client.js` | 设置卡新增一行「微信 ClawBot」+ 状态文字 + 按钮（文案只由连接状态决定）；用 `@deepseek-ai/dsh-client-ui-primitives` 的 `Modal`（与「更新 NewMark Core」同一个原生弹窗）显示二维码，白底 260px，绑定成功自动变为已连接 |
| 路由 | `index.js` | GET 负载新增 `wechat`（状态 + 二维码 data URL + 统计）；新增 `wechat-connect`（连接/重新连接同一入口，先清旧登录）、`wechat-logout`；挂载 4 秒后自动 `resume()`，释放时 `stop()` |
| 通道 | `lib/wechat-channel.js` | 登录状态机（QR → 轮询 → confirmed）、收发循环、账本、重新连接的代号取代 |
| 协议 | `lib/wechat-ilink.js` | 7 个端点的最小客户端（与 `SCRIPTS/clawbot-demo` 同协议，独立一份：已安装插件不能 import 仓库脚本） |
| 二维码 | `lib/wechat-qr.js` + `vendor/qrcode-terminal/` | 把 `qrcode_img_content` 编码成 PNG data URL（zlib + CRC32 手写，编码器 vendored Apache-2.0，`files` 白名单已加 `components/newmate/vendor/**`） |

**语义没有变**：入站仍是 `mate.chat(text, undefined, undefined)`（页面 POST 到达的同一个函数），出站仍只取 `id===task.id` 的 assistant 消息的 `plain`，接收确认仍写账本且不发微信。**`component.js` 未改一行。**

**门禁** `scripts/verify-newmate-wechat-channel.mjs` **30 / 30 PASS**（假 iLink + 假 mate，离线）：

connect 出二维码（PNG 头校验）→ confirmed 落 token → 入站交给 mate.chat（参数等价：无 execution、无 threadId）→ 账本 acked + task + mode → **回复未生成前不发任何微信** → 重放同一条不重投 → 运行中第二条作为插入引导进同一个 task → 最终回复**只发 plain**（≠ 渲染版）、不转发主动消息、用最后一条入站的 `context_token` → 重新连接清 token 与账本并重新取码 → 重启只 `resume()` 即恢复且不重新取码 → `errcode=-14` 停手 → 日志不含 token。

**种植变异**（`bubbleText` → `text`）：28/30，失败项恰为「正文是纯文字气泡版」与「没有转发渲染版或主动消息」，失败详情里能看到 `# 标题`。

**回归**：chat 25、settings、config-panel 37、client 123、reply-and-repeat 15、package 54、version-discipline 12 全绿。

**状态**：**源码候选 0.3.44，未安装、未重启**——安装并重启会结束当前会话，需用户确认后再做。

---

## 17. 三个活体缺陷与修复（0.3.45–0.3.48，2026-10-27）

这一节记的是信道**上线之后**由用户实测发现的三件事。共同点：三条都不是设计错，而是**接线的细节错**，而且两条的根因都是「改错了地方但没报错」。

| # | 用户看到的现象 | 根因（落到具体行） | 修复 |
|---|---|---|---|
| 1 | 一次任务的回复被发到微信 **3 次**（内容完全相同） | `forwardReplies()` 在 `await ilink.sendText()` **之后**才 `delete awaiting[taskId]`；1 s 的定时器与约 1 s 的发送重叠，于是每个 tick 都认为「这个任务还没回」 | claim-before-await（发送前先摘出 awaiting）+ `sent[taskId]` 幂等表 + single-flight 标志，三层各挡一次 |
| 2 | DSH 重启后连接**看起来在但收不到** | 0.3.45 给 `index.js` 打补丁时锚点不匹配，`String.replace` **静默无效**，`wechat.resume()` 从未接线（证据：`receiveSince=0`、`lastPollAt=0`）；另外接收循环 5 次传输失败就放弃 | 0.3.46 重新接线 + **4 条源码契约断言**（`index.js` 必须出现 `wechat.resume()` 等）；循环改无限重试、指数退避封顶 30 s、只有 `errcode=-14` 停手 |
| 3 | 纯文字提醒**没有**发到微信 | 提醒的投递是 assistant 消息 `id='todo:<todoId>'`，**没有 task**，回复路径永远看不到它。0.3.47 连修两次都失败：`reminderWatermark` 的初始化锚点不存在；`lastPeer` 在升级后从未写入 ⇒ 每条提醒被永久标 `skipped:'no_peer'` | 0.3.48：`save()` **之后**初始化水印（读回复核）、peer 回退到 `state.ilinkUserId`（与 `lastPeer.to` 同一身份 `o9cq80…@im.wechat`）、无 peer 时**不标记**（留给下一轮）、30 分钟时效守卫、`status().forwarded` |

**缺陷 1 的证据**（活体，0.3.44）：`wechat.json` 里 3 个 task、`stats.replies=8`，而 `sent` 只有 3 个 key——同一 taskId 被写了 3 次并不是覆盖，而是**3 次真实发送**（每次一个 messageId）。离线可复现：把假 iLink 的 `sendText` 拖到 1.3 s，修复前 `sends=2`、修复后 `sends=1`；活体修复后 `replies 8→9` 只多一个 `sent` key。门禁里这条被钉成断言（慢发送 + 重叠 tick ⇒ 仍只发一次）。

**缺陷 2 的证据**：重启后 `GET /newmark-newmate` 的 `wechat` 块里 `receiveSince` 与 `lastPollAt` 都是 `0`，即状态文件在、循环没跑。这类「`String.replace` 打空」在本仓库已经造成**两次**出厂缺陷，因此现在的规矩是：补丁之后**必须 grep 回插入的符号**，并在门禁里加源码契约断言（`verify-newmate-wechat-channel.mjs` 4 条）。

**缺陷 3 的证据**：`wechat.json` 的 `sent` 里没有**任何** `todo:` 前缀的真实发送记录，只有 4 条 `skipped:'no_peer'`；而 `newmate_todo_list` 显示那几条待办状态是 `delivered`（页面/气泡已投递），所以问题不在待办，而在「提醒不走回复路径」这个事实。

**门禁**：`scripts/verify-newmate-wechat-channel.mjs` 30 → **51 PASS**（新增：慢发送去重、幂等表、重启只 `resume()`、`-14` 停手、升级复用密钥、断网容忍、4 条接线契约、提醒转发、无 `lastPeer` 时回退 `ilinkUserId`）。

**活体状态（2026-10-27 18:15–18:17）**：`phase=connected`、`botId=af330b8418f5@im.bot`、`lastPollAt` 每秒推进（接收循环活着）、`sent` 里 7 条真实回复各自唯一 taskId；4 条 `todo:*` 全是 0.3.47 时期的 `skipped:no_peer`，时间（`1793093969044`…`1793094124179`）都**早于** `reminderWatermark=1793094572588`，即 0.3.48 之后还没有提醒到过点。为此新建一条 `mode=reminder` 待办 `6bb2e6c1-4c7d-441e-9e5e-a16de4b9d74f`（18:17:10 到期）做活体验收。

### 17.5 活体结果：提醒真的到了微信（2026-10-27 18:18）

```
todo:6bb2e6c1-4c7d-441e-9e5e-a16de4b9d74f ->
  { "at": 1793096236409, "messageId": 7520790708907987000, "chars": 52, "reminder": true }
```

同一条待办在 `newmate_todo_list` 里是 `status: "delivered"`、`deliveredAt: 1793096231477`、`deliveries: 1`，而微信侧的 `messageId` 出现在 4.9 s 之后——**两套账本对上了**：待办投递发生在本地（气泡/页面），微信发送是信道自己做的第二次动作，且只做了一次。

这条记录同时确认了三件事：① 0.3.48 的 peer 回退（`lastPeer` 至今是 `null`，但 `state.ilinkUserId=o9cq80…@im.wechat` 顶住了）真的生效；② 水印逻辑没有越界（`at` 远大于 `reminderWatermark=1793094572588`）；③ 提醒路径与回复路径共用同一张 `sent` 表却互不干扰（`reminder:true` 是提醒自己的标记）。结论以本机实测为准，**别人机器上的 0.3.48 仍未验证**。



---

## 18. 发文件到微信：`newmate_wechat_send_file`（0.3.50 源码候选，2026-10-27 20:4x）

文本通道的验收停在 §17.5（纯文字提醒真的到了手机）。本节补的是**另一种下行**：把一个本机文件发到用户微信。

### 18.1 结论先说

| 问题 | 答案 | 级别 |
|---|---|---|
| ClawBot/iLink 有没有文件上传接口 | **有**：`POST /ilink/bot/getuploadurl`（`media_type=3` 为文件）+ 媒体 CDN `POST .../upload` + `sendmessage` 的 `type:4 file_item` | 【源码】官方包 `@tencent-weixin/openclaw-weixin@2.4.10` 的 `src/cdn/upload.ts`、`src/cdn/cdn-upload.ts`、`src/messaging/send.ts`（本轮 `npm pack` 解包实读） |
| 真的能发到手机吗 | **服务端接受并分配了 message_id**（两次活体，见 §18.6）；手机侧可见性要用户确认，我不代答 | 【实测】服务端受理；【未验证】客户端渲染 |
| 工具是不是全局的 | 是：`components/newmate/index.js` 用 **`ctx.tools.register`**（共享工具注册表），与 `newmate_todo_add`/`newmate_chat` 同一层 | 【源码】+ 门禁断言（§18.7） |

### 18.2 契约

```json
{
  "path":     "<必填> 绝对路径，或相对于调用方会话工作区的路径",
  "caption":  "<可选> 一句话说明（≤500 字），作为独立 text 消息先发",
  "receiver": "<可选> 微信接收者 id；缺省 = 最新入站 peer → 扫码登录用户"
}
```

成功回执（每个字段都是可核验的事实，不是一个 ok:true）：

```json
{
  "ok": true,
  "file": { "name": "NewMate 发文件自测.txt", "bytes": 370, "path": "C:\\...\\NewMate 发文件自测.txt" },
  "receiver": "o9cq80...@im.wechat",
  "caption": "【自测】...", "captionMessageId": "7520828719079110280",
  "messageId": "7520828729799831816",
  "receipt": { "accepted": true, "serverMessageId": "7520828729799831816", "ret": null, "state": "accepted_with_message_id" },
  "upload": { "filekey": "7e792da4...", "cipherBytes": 384, "attempts": 1 }
}
```

**messageId 是字符串，不是数字。** 它线上是 uint64，而 JSON.parse 对超过 2^53 的整数会取整——第一次活体实测就撞上了：返回的 id 是 `7520828416397238000`，真实 id 的末几位永远拿不回来，等于"有一个 id 但核验不了这条消息"。修法是官方客户端 `parseWeixinApiJson` / `LOSSLESS_ID_FIELDS` 的同一意图（把 id 字段当字符串），这里收窄成"解析后按原始文本把 message_id / svr_id 的数字抠回来"，`sendText` 与 `sendItem` 两条路都走它。
错误码（每个都是独立文案，不合并成"发不出去"）：

| code | 含义 |
|---|---|
| `file_not_found` / `not_a_regular_file` / `file_empty` / `file_unreadable` / `file_changed` | 路径与文件本身的问题（目录、设备、0 字节、检查与读取之间被改写） |
| `file_too_large` | 超过 **20 MiB**，回执同时给出 bytes 与 limitBytes |
| `file_type_rejected` | 可执行/安装类型（exe msi msp msix appx com scr pif cpl dll sys drv bat cmd vbs vbe hta reg lnk url ps1 psm1 wsf wsh jar apk ipa） |
| `path_forbidden` | 凭据目录（`~/.ssh`、`~/.gnupg`、`~/.aws`、`~/.dsh`、`~/.Newmark`、浏览器配置目录…）或凭据文件（`.env*`、`*.pem`、`*.key`、`*.pfx`、`*.p12`、`*.ppk`、`id_rsa`、`Cookies`、`Login Data`、`mcp-token`…） |
| `wechat_not_connected` / `wechat_session_paused` / `receiver_unavailable` | 通道侧：没扫码、errcode=-14 暂停、拿不到接收者 |
| `upload_url_failed` / `upload_url_refused` / `upload_url_missing` / `upload_url_timeout` | getuploadurl 的三个失败面 |
| `cdn_upload_rejected` / `cdn_upload_failed` | CDN 4xx（不重试）与重试 3 次后仍失败 |
| `caption_failed` / `send_failed` / `send_refused` | 说明文字失败、sendmessage 传输失败、服务端 ret 非 0 |

### 18.3 协议三步（字段级，本轮解包复核）

1. `POST /ilink/bot/getuploadurl`（Bearer，15 s）

   ```json
   { "filekey": "<32 hex>", "media_type": 3, "to_user_id": "<接收者>",
     "rawsize": 370, "rawfilemd5": "<明文 MD5>", "filesize": 384,
     "no_need_thumb": true, "aeskey": "<32 hex>",
     "base_info": { "channel_version": "2.4.10", "bot_agent": "..." } }
   ```

   → `{ ret, upload_param?, upload_full_url? }`；filesize 是**填充后**的密文字节数（`ceil((rawsize+1)/16)*16`）。

2. `POST <upload_full_url 或 {cdn}/upload?encrypted_query_param=<upload_param>&filekey=<filekey>>`

   `content-type: application/octet-stream`，正文 = AES-128-ECB+PKCS#7(明文, aeskey)；**200 且响应头带 x-encrypted-param 才算成功**，4xx 立即失败，5xx 重试（官方 3 次）。

3. `POST /ilink/bot/sendmessage`（message_type 2、message_state 2、from_user_id 空串）：

   ```json
   { "type": 4, "file_item": { "media": { "encrypt_query_param": "<x-encrypted-param>",
     "aes_key": "<base64(hex 字符串的 ASCII 字节)>", "encrypt_type": 1 },
     "file_name": "NewMate 发文件自测.txt", "len": "370" } }
   ```

   aes_key 这里有个**必须照抄的怪点**：官方是 `Buffer.from(uploaded.aeskey).toString('base64')`，aeskey 是 hex **字符串**，所以 base64 的是那 32 个 ASCII 字符，不是 16 字节原始 key。

**说明文字是另一条请求**：item_list 一次只装一个 item（官方 `send.ts` 的 sendMediaItems），所以 caption 先发一条纯 text，再发文件，两条各自一个 client_id。

### 18.4 校验与那个 20 MiB

**上限是自设的，不是协议声明的。** 官方客户端 2.4.10 全仓没有任何文件大小限制（maxFileSize / too large 命中 0 处），协议规格也没写；本项目文档里唯一有明确数值的文件上限来自**企业微信** webhook 的 20 MB（`docs/15` §3.1，那是另一条通道）。取这个数是因为：宁可本地先拒，也不要在传了一半之后让服务端说不。回执与错误文案都明确写"本工具自设的保护值"——**不要把它当成 iLink 的契约**。

路径先 statSync 再 realpathSync，凭据目录按**真实路径**比对（软链接与 `~` 写法绕不过去），文件名规则独立一条。越权一律报 `path_forbidden`，不静默降级、不"只发个名字"。
### 18.5 落点（改了哪几个文件）

| 文件 | 改动 |
|---|---|
| `components/newmate/lib/wechat-file.js`（新） | 纯校验：路径解析、普通文件、大小、类型、凭据路径；不发任何东西，因此可以脱离网络测试 |
| `components/newmate/lib/wechat-ilink.js` | `uploadFile`（getuploadurl + CDN 密文 + 3 次重试）、`sendItem`（一条消息一个 item）、`fileItem`（type-4 item 形状）、`losslessIds`（uint64 id 精度）；`createIlink` 增 `getCdnBaseUrl` |
| `components/newmate/lib/wechat-channel.js` | `sendFile()`：接收者规则、先校验后读文件、caption 先发、回执与账本（stats.files / stats.fileFailed / lastFile）；stats 改为**合并**读取（旧状态文件缺 files 字段时不再返回 undefined） |
| `components/newmate/index.js` | `ctx.tools.register` 注册 `newmate_wechat_send_file`（共享注册表） |
| `components/newmate/component.js` | 名字进 `NEWMATE_RUN_TOOLS`，并进 `NEWMATE_REQUEST_TOOLS`（自动检查轮次拿不到） |
| `scripts/verify-newmate-wechat-channel.mjs` | 假 iLink 加 getuploadurl + CDN /upload（真解密回环）、上传与字段断言 14 条、错误分支 11 条、注册层 6 条 |

### 18.6 活体自测（两次，含一个被修掉的缺陷）

用活体 `~/.Newmark/newMate/wechat.json` 的 token（phase=connected、botId=af330b8418f5@im.bot）直接驱动 `lib/wechat-ilink.js` 的协议半部；**脚本只读状态文件、不写**，避免与正在跑的接收循环抢 wechat.json。

| # | 时间（本地） | 文件 | 字节 | 密文 | messageId | 结果 |
|---|---|---|---|---|---|---|
| 1 | 2026-10-27 20:46:55 | NewMate 发文件自测.txt | 370 | 384 | `7520828416397238000`（**取整后的**） | 服务端受理；同批暴露 message_id 精度缺陷 |
| 2 | 2026-10-27 20:48:11 | NewMate 发文件自测.txt | 370 | 384 | `7520828729799831816` | 服务端受理，id 精确；caption `7520828719079110280` |

- 两次的 sendmessage 响应都**没有 ret**（hasRet:false）——与 §13 的结论一致：没有 ret 不等于没发出去，也不等于送达。回执因此把 accepted 与 messageId 分开陈述，状态是 accepted_with_message_id。
- 上传都是第 **1** 次尝试成功；getuploadurl 没有返回 upload_full_url，客户端按 `{cdn}/upload?...` 自己拼（这条分支门禁里也钉住了）。
- 文件 sha256（第 2 次）：`BE23F8329291E8BD821E7822DE5EF09C1EBA269B358151859C0232CEFF9B7E0C`。
- **手机侧是否能看到这个文件，要用户确认。** `docs/15` §2.6 记录过 2026-03 的二手实测"文件只进不出"，与协议里完整的 getUploadUrl + file_item 管线互相矛盾；本轮服务端明确受理并发了 id，这是目前能拿到的最强证据，但**不等于**用户看见。

### 18.7 门禁 `verify-newmate-wechat-channel.mjs`：51 → **102 PASS**

新增覆盖（离线，假 iLink + 假 mate）：

- getuploadurl 请求体九个字段（media_type、to_user_id、rawsize、rawfilemd5、filesize 的填充公式、no_need_thumb、filekey/aeskey 形状、base_info）；
- **CDN 回环**：把收到的密文用声明里的 aeskey 解回明文，比对字节数与 MD5——证明"声明的是这份文件、传上去的也是这份文件"；
- file_item 五个字段（encrypt_query_param、aes_key 的 base64-of-hex、encrypt_type、file_name、len 字符串）、from_user_id 空串、message_state 2、沿用入站 context_token；
- caption 是**独立消息且在文件之前**、两条各一个 client_id、每条只装一个 item；
- 错误分支 11 条（含"凭据目录里的普通文件"——按目录拒绝而不是按文件名，用 USERPROFILE 指向临时 home 来测）；CDN 4xx 不重试；统计与 lastFile 落盘、状态文件不含正文与 aeskey；
- **message_id 精度**：假服务端用原始 JSON 文本回一个 19 位 id，断言客户端返回的是**字符串原文**（把修复前的行为种回去就会红）；
- 注册层 6 条：ctx.tools.register（不是 privateTools）、描述写明 20 MiB 与 messageId、execute 从会话 cwd 解析、进 NEWMATE_RUN_TOOLS、自动轮次没有、用户轮次有。
- **挂载探针**（`scripts/lib/mount-newmark-core.mjs` 真实挂载核心行，输出 `archive/20261027-204541-wechat-send-file/evidence/mount-probe.log`）：注册表 **37 个工具**、`newmate_*` 12 个，`newmate_wechat_send_file` 与 `newmate_todo_add` **在同一张表里**；直接调用它的 execute 得到两条结构化拒绝（`file_not_found`、`wechat_not_connected`）。这证明的是「插件挂载后工具真的在共享注册表里、execute 是活函数」，**不等于**运行中的 DSH 已经加载它——那需要安装并重启。

回归：verify-newmate-chat 25 / reply-and-repeat 15 / verify-newmark-core-package 54 / verify-version-discipline 12 / verify-newmate-settings 全绿（后者须在 `Newmark Agent/` 下跑，见 §18.9）。

### 18.8 未验证与边界

1. **手机侧可见性未由我确认**（需要用户看一眼微信）。
2. **未打包、未安装、未重启**：当前运行中的 DSH 仍持有 0.3.49，所以这个工具**现在还不在任何对话的工具清单里**；要让它出现必须 npm pack → 插件安装 → 重启 DSH（会结束当前会话）。
3. **服务端文件上限未知**：20 MiB 是本仓库自设的保护值，不是 iLink 声明；真要发大文件得先测一次服务端到底接多少，否则只是把失败提前到本地。
4. 图片/视频/语音三种 item（type 2/3/5）**没有实现**：本轮只做"文件"；图片按文件发也能到，但手机侧渲染成附件而不是图片。
5. 群聊不支持（官方只声明私聊）；一条入站约 10 条回复的上限没有重新标定，发文件同样消耗下行条数。
6. 一个微信号 = 一个对话：receiver 只能覆盖到"这个 bot 认识的用户 id"，没有通讯录能力。

### 18.9 备注：`verify-newmate-settings.mjs` 的 cwd 依赖

它里面写的是 `path.resolve('Newmark2DSH/packages')`，所以只在 `Newmark Agent/` 下跑才通过；在 `Newmark2DSH/` 下跑会报一个 `Newmark2DSH/Newmark2DSH/...` 的路径错误。这是**既有问题**（本轮未改它），记在这里免得下次被当成新回归。

---

## 19. 独立校验：发文件这条路的第二轮（2026-10-27 21:0x–21:4x）

§18 是作者写的。这一节是我按「不看作者的门禁，先自己造证据」做的第二轮：**重新 npm pack 官方包逐字段对照**、**对门禁做种植变异**、**用真实 token 再发一次文件**。结论：协议保真度没问题，**但校验层有两个缺陷**，都已修好并钉进门禁。

### 19.1 改动范围

只动两个文件，改动全文见归档 `archive/20261027-212500-wechat-send-file-verify/evidence/independent-edits.patch`（30 行新增 / 1 行删除）：

| 文件 | 改了什么 | 为什么 |
|---|---|---|
| `lib/wechat-file.js` | `homeDirs()` 里对拼好的目录做 `normalize`（大小写归一） | 见 19.4-A，凭据目录 12 条里有 6 条是死的 |
| `scripts/verify-newmate-wechat-channel.mjs` | 加 `aesEcbPaddedSize` 的 import、12 条长度扫描、一个 48 字节对齐文件的活路、2 条大小写用例 | 见 19.4-B 与 A 的门禁用例 |

**发送路径本身（`wechat-ilink.js` / `wechat-channel.js` / `index.js` / `component.js`）一行未改。**

### 19.2 协议保真度：与官方 2.4.10 解包逐字段对照

`npm pack @tencent-weixin/openclaw-weixin@2.4.10` → 读 `dist/src/cdn/aes-ecb.js`、`cdn-url.js`、`cdn-upload.js`、`cdn/upload.js`、`api/types.js`、`api/api.js`、`messaging/send.js`、`auth/accounts.js`。摘录见归档 `evidence/official-2.4.10-excerpts.txt`。

| 项目 | 官方 2.4.10 | 本实现 | 判定 |
|---|---|---|---|
| 密文长度（PKCS#7） | `Math.ceil((n + 1) / 16) * 16` | 同 | **全等** |
| 加密 | `aes-128-ecb`，PKCS#7 | 同 | **全等** |
| CDN 上传地址 | `{cdn}/upload?encrypted_query_param=<upload_param>&filekey=<filekey>` | 同 | **全等** |
| 上传成功判据 | HTTP 200 且响应头有 `x-encrypted-param`；4xx 立即失败，最多 3 次 | 同 | **全等** |
| CDN base | `https://novac2c.cdn.weixin.qq.com/c2c` | 同 | **全等** |
| `UploadMediaType.FILE` | `3` | `3` | **全等** |
| `MessageItemType.FILE` | `4` | `4` | **全等** |
| file_item | `{media:{encrypt_query_param, aes_key: base64(hex 字符串的 ASCII), encrypt_type:1}, file_name, len: String(明文字节数)}` | 同 | **全等** |
| 一次请求一个 item | 是（`sendMediaItems` 每个 item 一条请求） | 同 | **全等** |
| `no_need_thumb` | `true`（FILE 不要缩略图） | 同 | **全等** |
| 消息外壳 | `from_user_id: ''`、`message_type: 2`、`message_state: 2` | 同 | **全等** |

三处**差异**，都不是缺陷，但要知道：

1. 官方 `getUploadUrl` 的请求体还带 `thumb_rawsize / thumb_rawfilemd5 / thumb_filesize`，值为 undefined 时 `JSON.stringify` 会省略；本实现根本没有这三个键——**等价**。
2. 官方 `sendMessageItemWeixin` 带 `run_id: opts.runId`，没有 run 时同样是 undefined 被省略；本实现不带——**等价**。
3. 官方 `sendMessageItemWeixin` 返回的 `messageId` 其实是**客户端自己生成的 client_id**，服务端 id 另放 `serverMessageId`；本实现的 `messageId` 就是**服务端** `message_id`（另外在回执里给 `serverMessageId`）。语义更强，但两边的同名字段**来源不同**，读代码时不要按官方那套理解。

### 19.3 活体第三次（本轮）：一个 16 对齐的文件

只驱动协议半部（`uploadFile` / `sendText` / `sendItem`），**脚本只读状态文件、不写**——避免与正在跑的接收循环抢 `wechat.json`。

| 时间（本地） | 文件 | 明文 | 密文 | 上传 | messageId | hasRet |
|---|---|---|---|---|---|---|
| 21:35 | `wechat-file.js` | 8 576 B | **8 592 B** | 7 484 ms，第 1 次成功 | `7520840536736198920`（19 位，字符串） | `false` |

**8 576 正好是 16 的整数倍**，所以 8 592 只可能是「补满一整块」的结果：这一条在活体上把 padding 公式的边界钉住了（少加 1 的写法会声明 8 576）。说明文字先发一条（`7520840522739816584`），文件后发一条，两条各有 id。状态文件的 mtime 有推进是**运行中的接收循环自己在存**，不是这个脚本写的。

### 19.4 校验层的两个缺陷（本轮发现，已修）

**A. 凭据目录比对只归一化了 home，没归一化条目 ⇒ 12 条里 6 条永远匹配不上。**

`normalize()` 会 lower，而 `HOME_DIRS` 是大小写混写的常量。于是 `.ssh`/`.gnupg`/`.aws`/`.azure`/`.dsh`/`.config/gcloud`（全小写）拦得住，**`.Newmark`、`AppData/Local/Google/Chrome/User Data`、`AppData/Local/Microsoft/Edge/User Data`、`AppData/Roaming/Mozilla/Firefox/Profiles`、`AppData/*/Microsoft/Credentials` 全部失效**。本机实测（修前）：

| 探测 | 修前 | 修后 |
|---|---|---|
| `~/.Newmark/newMate/wechat.json`（**自己的 token**） | `OK`（可以发出去） | `path_forbidden` |
| `AppData/Local/Microsoft/Edge/User Data/Default/Preferences` | `OK` | `path_forbidden` |
| `C:\USERS\…\.NEWMARK\…`（大写写法） | `OK` | `path_forbidden` |
| `~/.ssh/notes.txt`（全小写条目） | `file_not_found`（路径不存在，规则本身是好的） | 同 |

判据顺序是「先按真实路径判目录、再按文件名判文件」，所以 `BLOCKED_NAMES` 只能挡住 `Cookies`/`Login Data`/`logins.json` 这类**点了名的**文件；`Local State`、`History`、profile 里的任意文件都挡不住——**这正是浏览器配置目录存在的意义**。

修法一行：`normalize(home + '/' + entry)`。门禁加两条（`~/.Newmark` 里的 token 文件、Chrome `User Data` 里的文件），把修复种回去 → **115/118，红的正是这两条**。

**原门禁为什么没抓到**：它的用例只有 `.ssh`——恰好是唯一「不需要归一化也能匹配」的形态。这与 19.4-B 是同一类错误：**用一个恰好处在敏感点之外的值去证明敏感点**。

**B. padding 公式的门禁用例只有一个长度，而那个长度恰好是两种写法相等的情形。**

用例写的是 47 字节：`ceil((47+1)/16)*16 = 48`，而 `ceil(47/16)*16 = 48`——**相等**。所以把 `+1` 去掉的变异体照样 **102 / 102 全绿**。

修法：按长度扫 `1 15 16 17 31 32 33 47 48 63 64 1000` 十二条（**整数倍时两种写法必须不同**），并真的发一个 48 字节文件、断言 `filesize = 64` 且与实际上传的密文长度一致。修后同一个变异体 → **111 / 116 红**。

### 19.5 变异清单（13 条，全部 KILLED，还原字节一致）

| # | 变异 | 修前 | 修后 |
|---|---|---|---|
| 1 | `aesEcbPaddedSize` 少加 1 | **102/102 SURVIVED** | 111/116 KILLED |
| 2 | `media_type` 3 → 1 | KILLED | KILLED |
| 3 | `item type` 4 → 2 | KILLED | KILLED |
| 4 | `aes_key` 改成 16 字节原始 key 的 base64 | KILLED | KILLED |
| 5 | `len` 改成数字 | KILLED | KILLED |
| 6 | `sendItem` 不做 uint64 无损解析 | KILLED | KILLED |
| 7 | `encrypt_type` 1 → 2 | KILLED | KILLED |
| 8 | `no_need_thumb` → false | KILLED | KILLED |
| 9 | 凭据目录判据整段关掉 | KILLED | KILLED |
| 10 | 可执行类型黑名单整段关掉 | KILLED | KILLED |
| 11 | 工具名从 `NEWMATE_RUN_TOOLS` 拿掉 | KILLED（100/102） | KILLED |
| 12 | `execute` 不再从会话 cwd 解析相对路径 | KILLED | KILLED |
| 13 | `homeDirs` 条目不做归一化（即缺陷 A 原样） | — | **115/118 KILLED** |

每次变异跑完都用 sha256 校验文件字节一致还原（5 个文件全部 `restored=true`）。证据：`evidence/mutation-suite.txt`、`mutation-run-group.txt`、`mutation-homedirs.txt`。

### 19.6 残留风险（未修，写清楚）

1. **副本不受保护**：把 `wechat.json` 复制到桌面，就能发出去——判据是目录与文件名，不是内容。真正的边界是「这台机器上任何不在黑名单里的文件都能发」，这一点应该在工具描述与用户预期里说清。
2. **软链接未在本机实测**：这台机器建符号链接报 `EPERM`，所以「软链接绕过目录判据」这条只有代码路径（`realpathSync`）支撑，没有实测证据。
3. **说明文字先于文件**：文件那一步失败时，用户会收到一条没有附件的说明，且没有针对文件的自动重试。
4. **没有发件去重**：同一个工具调用调两次就发两次——这是刻意的（与「回复」不同，回复有幂等账本），但调用方要知道。
5. **图片按文件发**会渲染成附件而不是图片（`type: 2 image_item` 未实现）；EXIF 等元数据原样带出。
6. **20 MiB 仍是自设值**，服务端真实上限未知（§18.4）。
7. **`~/.Newmark` 整目录被拒**：连 NewMate 自己写出的报告放在那里也发不出去——安全默认，但要知道。

### 19.7 门禁与回归

- `verify-newmate-wechat-channel`：**118 / 118 PASS**（作者交付时 102，本轮 +16：12 条长度扫描、2 条大小写、1 条对齐文件活路、1 条密文长度一致性）。
- 回归全绿（exit 0）：`verify-newmate-chat`、`verify-newmate-conversations`、`verify-newmate-reply-and-repeat`、`verify-newmate-report-display`、`verify-config-panel`、`verify-newmate-heartbeat`、`verify-newmark-core-package`、`verify-version-discipline`、`verify-newmate-agent-loop`、`verify-newmate-settings`、`verify-newmate-initiative`、`verify-newmate-todo-activation`。
- `verify-tool-output-boundary` 退出 2 是**环境缺 DSH 安装路径**（`PREMISE ABSENT`），与本轮无关。

### 19.8 状态

仍是**源码候选 0.3.50**：未打包、未安装、未重启。运行中的 DSH 持有 0.3.49，所以 `newmate_wechat_send_file` 现在仍不在任何对话的工具清单里；本节的活体验证走的是**协议半部**，不是那个工具本身。手机侧是否看得见那个文件，仍然要用户看一眼微信。