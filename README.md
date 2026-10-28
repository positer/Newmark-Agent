# Newmark Agent

## 2026-10-28 17:48 0.3.64 推送 git 并发布 npm（latest 已翻转）

- **主仓库** `positer/Newmark-Agent`：`087328a1`（14 文件，+302/−19）→ push `master`（`83efd901..087328a1`）。只显式暂存本次动过的路径，未并入他人的 `DESKTOP/` 改动。
- **发布仓库** `positer/newmark2dsh`：`sync-release-repo.mjs` 同步（copied 119 / changed 9 / removed 0，六个清单 0.3.64）→ 改公开 README（原来还写着「到期表示最早可激活时间」的旧说法）→ `7193473` → tag `v0.3.64` → push。
- **npm**：`publish.yml`（OIDC）run `40666442814` 09:43:16Z → **09:45:18Z success**；`latest` **09:45:42Z 由 0.3.62 翻到 0.3.64**（tag→latest 2 分 26 秒）。
- **发布字节 vs 本机字节**（发布 tarball sha256 `6DC1E99C…`，120 文件）：逐字节相同 106；仅行尾不同 12（CI 在 Linux 按 `.gitattributes eol=lf` 打包）；`package.json` 仅差结尾换行；`README.md` 只在发布包内。
- **没有重做安装/重启**：安装态与源码逐文件相等（唯一差异是 `package.json` 序列化），重装是空操作；运行态已复核为 0.3.64。

归档：`Newmark2DSH/archive/20261028-1748-npm-release-0.3.64/`。

## 2026-10-28 17:40 0.3.64：工具说明与 0.3.63 行为对齐，已安装并重启

**为什么**：0.3.63 改了投递闸门，但 `newmate_todo_add` 的描述仍是旧契约（「At due time current attention is protected …」）。**模型读到的是旧说明**。0.3.64 只改这一个字符串。

**「只改文字」是被 diff 证明的**：解包两个 tarball 逐个 sha256，119 个文件 **7 处不同** = 6 个清单的版本号 + `components/newmate/lib/mcp.js`；`component.js` / `client.js` 不在差异里（`TARBALL-DIFF-063-064.txt`）。

**安装**：`newmark2dsh-0.3.64.tgz` 1,304,666 B / sha256 `7B830CC5…`；安装态与源码 118 个可比文件 sha256 全等。
**重启**：这次走**两阶段广播屏障**（`broadcast:true, ackMode:'auto'` → 3 个运行中会话全部 registered → commit），没有打断任何会话；GUI 端口 57647 → 62684。
**重启后实测**：`current:"0.3.64"`；NewMate 200 / 251,568 B，pet/wechat 正常；`newmate_todo_add` 的描述从**运行中注册表**读回：`hasNewText=true, hasOldText=false`。

**未做**：面板文案仍无浏览器实测；npm 未发布（`latest` 仍 0.3.62）。

## 2026-10-28 17:16 0.3.63 已打包安装并重启，成对验收通过

- **打包**：`newmark2dsh-0.3.63.tgz`，1,304,570 B / 119 条目 / sha256 `77A7D592…`（用 DSH 自带 pnpm，工作目录 `packages/newmark-core`）。
- **安装**：按仓库既有做法（tarball 进 `~/.dsh/profiles/desktop` + 依赖指向 `*-source-live.tgz` + `pnpm install`），未手工替换 node_modules；**118 个可比文件与源码 sha256 全等**。
- **重启**：`heartbeat_after_restart` 登记后续跑 → 更新路由重启；端口 `62829 → 57647`；`GET /newmark-core/update` → `current:"0.3.63"`；NewMate `pet.running=true`、`wechat.connected=true`。
- **成对验收**（同一到期时刻 17:13:39.808，宿主当时确有会话覆盖该时刻）：
  - `reminder` **delivered，延迟 0.26 s**，消息入会话，微信回执 `messageId=7521137104588755592`；
  - `conversation` **pending + `deferred.code=host_busy`**，面板算出「已到期 · 等宿主有会话在运行」。
- **边界**：面板文案只在数据层验证（安装态表达式 + 实时数据），**未做浏览器实测**；「忙解除即激活」只有离线门禁覆盖（验证期间我自己一直是 running）；未做 0.3.62 的跨版本 A/B；npm 未发布。

归档：`Newmark2DSH/archive/20261028-1540-install-0.3.63/`。

## 2026-10-28 15:10 0.3.63：提醒不再等 DSH 会话，只等「陪伴开启 + NewMate 空闲」

**用户要求**：「取消消息投递的dsh无会话限制，只限制陪伴启用以及newMate空闲」。

**改前**：`deliverDueTodo()` 让 `reminder` 与 `conversation` 共用 `env.busy`（= 任意 DSH 会话 running）。14:00 那条用户提醒被另一工作区的会话压住 767.5 秒后取消（诊断见 `Newmark2DSH/archive/20261028-1447-todo-deferral-diagnosis/`）。

**改后**（`packages/newmark-core/components/newmate/component.js`）
- `reminderReady() = settings.companion===true && newmateIdle()` —— 提醒**只**看这两条。
- `newmateBusyReason()` 只看 NewMate 自己（`newmate_running` / `newmate_busy`），**不查 `agents.list()`**。
- 提醒不再看：宿主会话、桌宠就绪、阅读、阅读窗口、键鼠空闲、草稿、静默时段、暂停。**静默/暂停仍只静音气泡**，消息照常落盘（`notify()` 未改）。
- `conversation` 保留完整注意力闸，改成 `activationBlocker()` 逐条返回**首个**不满足条件。
- 两者都写 `todo.deferred={code,at,reason}`（同一原因不重复落盘）；界面显示「已到期 · 等<原因>」而不是笼统的「等待合适时机」。
- `tick()` 的到期判断不再因 `companion` 提前短路（否则 `companion_off` 永远算不出来）；`todoCancel()` 清 `deferred`。

**门禁**
- `scripts/verify-newmate-todo.mjs` **20 → 33**（新增 13 条，断言名就是需求原话）。
- 新增 `scripts/measure-newmate-todo-gate-mutations.mjs`：**7 条变异全红、源码逐字节还原**。
- 回归：activation 21 / initiative 57 / chat 25 / agent-loop 73 / reply 15 / report 5 / attachment 87 / version 12 全绿。
- **由门禁逼出的一处修正**：初版开头的 `if(!settings.companion) return` 早退让「陪伴开关不再被读取」这条变异变不红——冗余守卫替被删条件兜了底，删掉后才红。

**版本**：六个 manifest + `VERSION.md` → **0.3.63**（`sub-component change`）。**未打包、未安装、未重启**，本机仍跑 0.3.62；面板新文案未做浏览器实测。归档：`Newmark2DSH/archive/20261028-1510-reminder-no-dsh-busy/`。

## 2026-10-28 14:47 为什么「已到期 · 等待合适时机」：conversation 待办被宿主 busy 拦住，且不留原因

**用户报告**：设了定时 NewMate 激活，到点没投递，面板显示「已到期 · 等待合适时机」。

**结论（实测）**：不是丢失，是闸门在设计内拦下了，但拦下时**不写原因**。

- 面板那句的唯一含义是 `status==='pending' && activateAt<=now`（`client.js:2403`）；对比 `tasks[].deferred='target_paused'` 会落盘原因，`todos[]` 什么也不写。
- `deliverDueTodo()` 分流两种到期方式：`reminder` 直接投递（`component.js:193-199`），`conversation` 必须先过 `todoActivationReady()`（:186-187，函数在 :182，九个条件）。
- 另有对两种模式都生效的一条（:184）：NewMate 自己有 `chat` 任务 pending/running 时整体不投递。
- `env.busy`（`index.js:43`）= **任意** DSH 会话 running / inbox 有待处理 / jobs 在跑 / 桌宠 CU 占用——不区分是不是 NewMate 的、是不是用户此刻在意的事。

**这一次的具体原因**
- 待办 `4b87642b`，`mode='conversation'`，09:30:09 创建，14:00:00 到期。
- `watch.dshWindows` 显示从 13:52:06 起有会话在受监控根 `…\Files\Code` 下连续运行，**100% 覆盖**了 14:00:00→14:12:47 的 767.5 秒，闸门一次没放行（该字段只记根，不记会话 id，因此不指认具体是哪个会话）。
- 14:12:47 该待办被取消（`todoCancel` 是唯一路径，来自面板/MCP；当时没有 NewMate 任务记录）。
- 反证：四条 `reminder` 待办延迟 0.1 / 0.5 / 1.3 / 1.5 秒，其中三条投递瞬间确实有会话在跑——「等」只属于 conversation。

**证据**（`Newmark2DSH/archive/20261028-1447-todo-deferral-diagnosis/`，本轮未改源码）
- `evidence/reconstruct-1400-deferral.mjs` → 区间覆盖率 767.5/767.5 s = **100.0%**；截至取消时刻，当日 15 段活跃窗口、189.5 min / 327.5 min 跨度（**57.9%**，固定端点，不随运行时间增长）。
- `evidence/gate-is-busy-only.mjs` → 8 断言全绿（忙则延后、忙一解除下一 tick 即投递、阅读同理、reminder 不受约束）。
- `evidence/diagnose-todo-deferral.mjs` → 实时九条件表（14:49:58：ready=true / busy=false / idleMs=278953 / dueCount=0）。
- 既有门禁 `scripts/verify-newmate-todo-activation.mjs` **PASS 21**。

**建议（未实施）**：把命中的第一个假条件写进 `todo.deferred={reason,at}`；面板按 reason 显示；加「现在激活」按 reminder 立即投递。

## 2026-10-28 NewMate 收文件：页面上传 + 微信 ClawBot 入站文件（0.3.62 源码候选，未打包/未安装/未重启）

用户要求「为 NewMate 添加文件上传能力，以及通过 clawbot 接受用户从微信发来的文件」。两条入口，**一套存储、一条入站内核**：

- **入站内核只加一个参数**：`chat(text, execution, threadId, attachments)`。空文本仅在带附件时合法（手机拍一张图不说话）；用户原话仍原样落库并用作出站气泡，附件说明只进**任务提示**。
- **存储**：`<root>/newMate/uploads/<uploadId>/<sanitize 后的名字>`；容器判定落在 **realpath 后的前缀**上，`../../x` 与符号链接都越不出去。
- **页面**：新路由 `POST /newmark-newmate/upload`（body 就是字节，名字在 header，**流式** 20 MiB 上限；JSON 动作仍是 64000 字节的元数据通道）。输入框旁多一个「📎 上传文件」，用户消息里渲染附件标签。
- **微信**：ClawBot 入站媒体按官方包 `@tencent-weixin/openclaw-weixin@2.4.10` 源码实现——CDN GET `{cdn}/download?encrypted_query_param=…`（有 `full_url` 用之）+ **AES-128-ECB/PKCS#7** 解密；`media.aes_key` 两种编码（16 原始字节 / 32 位 hex 的 ASCII）都解，`image_item.aeskey`（裸 hex）优先；图片无密钥按明文保存（官方同样如此）。
- **诚实边界**：文本附件在提示里带一段有预算的片段；**非文本（图片/PDF/Office/压缩包/音频/视频）一律写「内容未读取」**，只给名字与字节数——本机不解码这些格式，模型也不许假装看过。超预算时提示用新工具 `newmate_attachment_read`（**只能读上传目录**，解析后前缀判定，2 MiB / 2000 行上限）。
- **失败不静默**：微信文件取回失败重试两次后，把「本机没能取回：<名字>；原因：<码>」**交回 NewMate** 由它如实告知用户，回执记 `mediaFailure`；语音有服务端转写就当文本，没有则单独计数（本机无 SILK 解码器）。
- **门禁**：新增 `verify-newmate-attachment` **87 / 87 PASS**（存储、chat、频道对假媒体 CDN 真发 AES 密文、真实挂载行的字节路由与读取工具、页面与行源码）；既有微信频道门禁 **118 / 118**、chat 25、file-navigation 14、client 124、package 54、version 12 全绿。**变异**：把容器判定改成恒假 → 恰好两条容器断言变红，其余 85 条仍绿。
- **还没验证**：真机微信发文件的样本没有（解密由源码 + 假 CDN 回环证明）；图片没有送进模型（当前授权模型没有已核验的图片输入能力）；未打包/未安装/未重启，所以运行中的 0.3.61 还点不到这个按钮。

- **已安装并重启（2026-10-28 12:02–12:05 实测）**：0.3.62 已装进 DSH profile（安装目录 119/119 文件与 tarball 逐字节相同），更新路由重启，端口 **55277 → 62829**。活体验收 7 项通过：工具 72→73（新增 `newmate_attachment_read`）、`wechat.media` 字段出现、99 B 文本上传后回执 sha256 与磁盘一致、注册表读回原文、越界路径被拒、真实一轮对话里 NewMate 答出文件第一行并**自己调用了**读取工具、微信通道重启后无感恢复。**真机微信发文件也已验证（12:05）**：用户手机发来 7,658,239 B 的 `.pptx`，通道取回并解密后落盘，解出的是真 PPTX（PKZIP 魔数 + 70 个 zip 条目），`mediaBytes=7,658,239 / mediaFailed=0`，回执 sha256 与磁盘一致；NewMate 在微信里如实回答「本机不解析 pptx，看不到里面版式」。

- **已发布**：0.3.62 于 2026-10-28 **12:30:38** 成为 npm `latest`（release 仓 `841966b` + tag `v0.3.62`，工作流 40630850759 success）；发布物与本机已装并验收的副本逐文件对拍**内容差异 0**。

[契约与协议出处（含未验证清单）](Newmark2DSH/docs/17-newmate-attachments.md)

## 2026-10-27 微信 ClawBot → NewMate 信道：只读调研与接入设计（未改代码）

目标是把"用户通过微信 ClawBot 给 NewMate 发信"做成"用户在页面上发信"，NewMate 答完再把**纯文本气泡版**发回微信。本轮只产出设计与证据：**未改任何源码、未打包、未安装、未重启**。

- **入站只有一个内核**：`newmate/component.js:598 chat(text, execution, threadId)`。页面（`index.js:196`）与 MCP `newmate_chat`（`mcp.js:11`）都汇到它；待办/自主/会话唤醒各自在进入前构造 `kind/origin/threadId`。
- **出站只有一个出口**：`:338 readReply` → `:356 messages[{text, plain}]` → `:358 notify`。`plain` 就是气泡/外部渠道版，0.3.43 已写入持久状态（本机实测可读）。
- **`notify()` 不是消息出口**，而是"要不要弹桌宠"：陪伴开关、静默时段、snooze、冷却四道门，桌宠没起来还会抛错。外部渠道若挂在这里，会继承全部四道门。
- **本机实测（0.3.43）**：`GET /newmark-newmate` 200 / 120 KB（含 `plain`）；`POST /newmark-newmate {action:'chat'}` 需 `x-newmark-newmate: 1`（无头 400，有头进入分发）；MCP initialize/tools/list 200（7 工具；`serverInfo.version` 仍硬编码 `0.3.14`）；宿主只监听 `127.0.0.1`。
- **推荐两步走**：先用零插件改动的独立桥验证微信侧准入（是否灰度到、扫码会不会被拦、一条入站能回几条），确认后再把桥收进插件，并补 `source`／入站幂等／授权与线程的显式决定。
- **微信侧硬边界**：官方客户端**没有入站去重、没有节流**（`dedupe`/`throttle` 在源码里 0 命中）；**工具进度消息默认开启**，一个多工具回合就能烧光约 10 条下行额度 → 渠道只发最终 `plain`；`errcode=-14` = 整账号停 1 小时且不自动重登；`sendmessage` 响应缺 `ret` 不报错，"没报错"≠"已发送"。

### 2026-10-27 14:2x 步骤 0 落地：独立双向探测 demo（`SCRIPTS/clawbot-demo`）

「扫码能不能连上、发信能不能双向收到」现在有一条可执行的判据，**不碰插件、不改发布物**：

```sh
node SCRIPTS/clawbot-demo/clawbot-demo.mjs selftest   # 离线自检：28 / 28 PASS
node SCRIPTS/clawbot-demo/clawbot-demo.mjs login      # 打印终端二维码，等手机扫码
node SCRIPTS/clawbot-demo/clawbot-demo.mjs run        # 收消息 + 自动回一条纯文本回执
```

- **判定方式**：手机收到回执 = 发送方向通；终端打印 ⬇ 行 = 接收方向通；退出时打印"双向连通 / 只收不发 / 没有收到消息"三选一的判定句。
- **本轮实测**：离线自检 28/28（登录落盘、去重、游标续传、超时不算错、`ret=-2`、`-14` 停手、请求体与头、uint64 精度、token 不外泄）；种植变异后 27/28 且唯一失败项正确，证明自检能变红；生产端点 `get_bot_qrcode` 992 ms 返回、`qrcode_img_content` 是 http(s) 链接、`get_qrcode_status` 长轮询到客户端超时→`wait`。
- **仍未验证**：真机扫码与双向收发（需要手机扫码，本轮没有绑定任何账号）；demo 目前回的是固定回执，**尚未把入站接到 NewMate**（那是步骤 0 的后半段）。
- **2026-10-27 15:24–15:26 真机实测（双向已连通）**：扫码 → `confirmed`；微信发 `test` 被收到（19 位 uint64 id 无损）；回执被服务端接受并分配 `message_id`；用户随后**把回执原文发回**，独立证明那条回执真的到了手机。两次 `sendmessage` 响应都**没有 `ret`、只有 `message_id`** —— 官方判据因此不抛错，「没报错 ≠ 已送达」从源码结论升级为实测样本。
- **跨重启已测（15:31–15:35）**：`cross-restart-test.mjs` **19/19 PASS**（新进程只读磁盘，无需重新扫码；首轮带旧游标；重启前那条被去重；用磁盘凭据直接发信成功）；活体同样成立——新进程打出「从游标 … 继续 / 已去重 2 条」，不重新扫码直接发出并送达，重启后也收到了用户回复。
- 二维码渲染用 vendored `qrcode-terminal`（Apache-2.0，未改动），因此 demo 零安装依赖。

### 2026-10-27 接入落地：`SCRIPTS/clawbot-newmate`（不改核心代码）

微信现在是 NewMate 的**同一条输入**：桥把微信文本用**页面同款请求**交给 `chat()`（运行中同线程即插入引导），
只把该任务**最终回复的 `plain`（通知气泡纯文字版）**发回微信，**永不使用 `text`**（页面渲染版）；
NewMate 一旦确认接收，该 `message_id` 就在账本里标成已读取，重启或 iLink 重放都不会再交给 NewMate。
**接收确认不发微信**——微信只收到最后那一条气泡。

- 离线自检 **22 / 22 PASS**；**种植变异**（把转发内容从 `plain` 改成 `text`）→ 20/22、exit 1，失败项正是"纯文字气泡版"。
- 未改动 `Newmark2DSH/packages/newmark-core/**`；只用既存的 `chat` 动作与 MCP `newmate_task_status`。
- 用法：`node SCRIPTS/clawbot-newmate/bridge.mjs run`（`--limit 1` 验收，`status` 看账本，`selftest` 离线）。

### 2026-10-27 0.3.49：重启前必须先报告「还有谁在跑」

heartBeat 的重启原来是「直接重启」：`heartbeat_restart {broadcast:false}` 立刻 `globalRestart()`，调用方可以在完全不知道别人回合正在进行时打断它。现在分成两步：

- 新增只读工具 **`heartbeat_activity`**：返回 `self`、`running[]`（只算宿主 `agent.status==='running'` 且**未被用户暂停**的**其他**对话）、`count`、`idleOthers`、`intent`。
- **`heartbeat_restart` 在 `force!==true` 时不重启**，返回 `{ok:false, code:'confirmation_required', activity, next:[force, broadcast], guidance}`；`force:true` 才立即重启（回执带 `forced:true`），`broadcast:true` 走两阶段屏障等每个对话登记接续。`agents` 服务不可用时返回 `activity_unavailable` 且不重启。
- 工具描述改写成两步协议（模型读的是描述，不改描述等于没改协议）。

活体（0.3.49）：`heartbeat_restart {reason:'verify probe'}` 返回 `confirmation_required` 且**进程没有重启**；`next` 里两条下一步原样返回。门禁 `verify-newmate-heartbeat` **75 PASS**。
### 2026-10-27 0.3.46：修「一条回复发三次」与「重启后收了不回」

实测暴露出两个真缺陷，都已修并给了活体证据：

- **同一条回复发了 3 次微信**：`forwardReplies()` 在 `await sendText()` **之后**才删除 `awaiting[taskId]`，而回复定时器 1 s 一次、一次发送 1 s 上下 → 两次 tick 各发一条。状态文件曾出现 `3 个 task / stats.replies=8 / sent 只有 3 个键`。修法：**先占位再等网络**（同步删除 + 落盘，失败再放回）、`sent[taskId]` 幂等、定时器单飞。离线复现（假服务端把发送拖慢到 1.3 s）：修前 `sends=2`，修后 `sends=1`；活体：`replies` 只 +1。
- **重启后「看着已连接，其实什么都不收」**：0.3.45 的 `index.js` 补丁按一段不匹配的锚点做替换，静默失败 → 通道对象建了、`wechat` 状态也暴露了，但**从没调用 `resume()`**，所以 `receiveSince`/`lastPollAt` 恒为 0。修法：按真实锚点补上 `resume()`/`stop()`；接收循环改成无限重试 + 指数退避（仅 `errcode=-14` 停手）；补 90 s 看门狗。门禁加 **4 条宿主接线断言**（模块级门禁看不见「模块对、接线漏」），总计 **43 PASS**。
- **更新无感（实测）**：0.3.46 重启后同一 `botId`、同一 `connectedAt`、`qr=null`、`cursor` 保留，`receiveSince>0` 且 `lastPollAt` 每 `20 s 前进；用户再发一条 → `inbound 3→4`、`replies 8→9`。登录信息在 ``/.Newmark/newMate/wechat.json`（插件目录之外），安装更新不会碰它。

发布：main `573d3a9` + tag `v0.3.46`，工作流 [run 40477083559](https://github.com/positer/newmark2dsh/actions/runs/40477083559) **success**；npm `latest` 于 **17:22:21** 从 0.3.45 切到 **0.3.46**（tag 推送后约 14 分钟，staged 延迟）。回拉对拍：117 vs 116 文件（多 `README.md`）、**内容差异 0**、16 个文件仅 CRLF/LF；发布物含接线修复 `wechat.resume()` 与看门狗，`dist` 带 2 个签名 + attestation。**注意 npm 现在走 staged 发布**：0.3.45 曾在 `in-process` 约 20 分钟后才出现在 registry，期间 `npm publish` 报 `409 Cannot publish over previously staged version`、`/-/stage` 列表为空。
### 2026-10-27 0.3.44 已安装、已发布（npm latest）

- **本机**：0.3.44 已打包装进 DSH profile（tarball sha256 `1AA1DEEB…`，116 文件与安装目录**逐文件零差异**）并真实重启；活体验收：`GET /newmark-newmate` 含 `wechat` 字段、设置页源码含按钮与 DSH `Modal`、`wechat-connect` 返回可显示的 PNG 二维码（1,757 B data URL）、`wechat-logout` 清空登录。
- **发布**：仓库 [positer/newmark2dsh](https://github.com/positer/newmark2dsh) main `0e9fc1c` + tag `v0.3.44`；tag 触发发布工作流 [run 40472928592](https://github.com/positer/newmark2dsh/actions/runs/40472928592) **success**，npm `latest` 0.3.43 → **0.3.44**。回拉对拍：发布物 117 文件 vs 本地 116（多 `README.md`），**内容差异 0**、16 个文件仅 CRLF/LF 不同；发布物内含 `lib/wechat-*.js` 与 `vendor/qrcode-terminal/`。
- **顺带修掉** `sync-release-repo.mjs` 的 glob 翻译缺陷：`**` 被两次 replace 互相覆盖，`vendor/**/*` 会**静默漏掉**嵌套文件（那样发布的包会缺二维码编码器）。改为单次扫描的翻译器，重跑后 13 个 vendor 文件全部到位。
### 2026-10-27 设置页入口（0.3.44，源码候选未安装）

「陪伴与工作区监控」里多一行 **微信 ClawBot**：未连接显示「发起连接」，已连接显示「重新连接」（点它会清除登录信息并重新扫码）；
二维码用 **DSH 原生弹窗**（`@deepseek-ai/dsh-client-ui-primitives` 的 `Modal`，与「更新 NewMark Core」同一个）显示，白底 260px。
通道逻辑搬进插件（`lib/wechat-channel.js` + `lib/wechat-ilink.js` + `lib/wechat-qr.js`），语义与桥一致：入站 `mate.chat()`、出站只发 `plain`、确认写账本不发微信。
门禁 `verify-newmate-wechat-channel` **30/30**；变异（`plain`→`text`）28/30 且失败项正确。**`component.js` 未改一行；未安装、未重启。**

[信道说明](SCRIPTS/clawbot-newmate/README.md) · [用法、判据与边界](SCRIPTS/clawbot-demo/README.md)

[接入设计（接口契约 / 必须一起改的语义 / 门禁清单 / 失败面 / 未验证清单）](Newmark2DSH/docs/16-wechat-clawbot-newmate-channel.md)

## 2026-10-26 Newmark2DSH 0.3.28：NewMate 真实监控 DSH 工作区（稀疏测量 + 适时一次交流）

监控根不再是手填的 `watchRoot`，而是宿主 `workspaceRegistry.list()` 里的工作区（`watchRoot` 降级为额外目录），每 5 分钟重扫，GUI 新加的工作区无需重启。稀疏性四条硬约束：**只读 `size:mtime`（从不读内容）**、深度默认 3、忽略依赖树/版本库/构建产物、目录与待处理集都有上限且**如实上报省略数**。

实测踩到一个真 bug 并修掉：真 `fs.watch` 探针显示 `src/a.txt` 的变动被归到**工作区根**，于是去 lstat 一个不存在的路径、变动被静默丢弃（第二次探针确认已按真实目录测量）。触发链沿用原设计、没有新增机制：`measure` → signals → 每分钟 `initiativeGate` → `self_activation(reason='file-change')` → 模型可回 `notify=false`（默认沉默）——**监控永不直接说话**。`GET /newmark-newmate` 与 `newmate_state` 增 `watch` 状态；解析不到工作区时写告警而不是假装在量。

门禁 `verify-newmate-workspace-watch` **26 PASS**；同轮 agent-loop 73、heartbeat 60、chat 23、short-memory-mcp 44、conversations 30、activation 57、version 12 全绿。**源码候选 0.3.28：未打包、未安装、未重启**——宿主是否在该行作用域暴露 `workspaceRegistry` 仍未活体验证。

[实现与证据](Newmark2DSH/archive/20261026-193849-newmate-workspace-watch/OPERATION.md) · [完整写回](Newmark2DSH/OVERVIEW.md)

## 2026-10-26（追加，同一 0.3.28）NewMate 工作区监控按规格重做：快照差分 + 加权阈值 + DSH 归因

启动对比一次、之后每 30 分钟一次（可配）；比较**文件数量、名称、最新修改时间**；`0.3·数量 + 0.5·名称 + 0.2·时间` 各自归一化后加权，累计达阈值（默认 0.6）触发**一次**主动响应并归零。**DSH 与用户的变动分开计**：mtime 落在「该工作区有 DSH 回合在跑」的窗口（±90 s）内按 `watchDshWeight`（默认 0.1）折算——十次 agent 写入算一次用户写入。设置页新增开关/间隔/阈值/深度/DSH 权重五项与状态行。

取代上一版的事件监视（`workspace-watch.js` 与其门禁已删除，历史归档标注被取代）：事件与差分同时计分会把同一批写入算两次。门禁 `verify-newmate-workspace-diff` **47 PASS**；真实扫描本仓库 3646 文件、采样 2048、省略目录 437，一次 1.49 s；回归 chat 23、heartbeat 60、agent-loop 73、conversations 30、initiative 57、client、config-panel、activation、version 12 全绿。源码未打包/未安装/未重启；归因是启发式（只能证明写入时刻落在窗口内，不能证明谁写的），`agents.list()` 的 cwd/status 未活体验证。

[实现与证据](Newmark2DSH/archive/20261026-195306-newmate-workspace-monitor/OPERATION.md)

## 2026-10-26 晚（已生效）0.3.28 安装、重启并活体验证；发现并修掉嵌套工作区缺陷

0.3.28 已按仓库既有方式（tarball + pnpm）装进本机 profile 并**真实重启**（新宿主 20:12，端口 54879→50256）。活体证据：启动对比执行（`watch.runs=1`）、**6 个真实工作区根**（`workspaceRegistry` 在插件行作用域可达）、6 份快照落盘、NewMate 工具组 **24 条含三个对话工具**、`dshWindows` 记录到真实 DSH 活动窗。

活体同时暴露两个缺陷：① **嵌套工作区**（`Files/Code` 与 `Files/Code/Newmark Agent` 同时注册）会让同一文件被扫两次，且子目录里的 agent 回合把父目录也标成 DSH 活动、降权用户的真实改动 —— 已在源码修掉（`dedupeRoots` + 采样取最长匹配根），门禁 47 → **50 PASS**；② 更新路由在客户端超时取消后**不复位 `state.starting`**，锁死进程内重启通道（未修，下次安装前应处理）。

**注意**：①的修复只在源码，安装态仍是修复前 0.3.28，需再装一次。广播两阶段重启在当前安装方式下结构性不可用（prepare 的是运行版本而非目标版本），实际生效走的是分离 launcher。

[重启尝试与诊断](Newmark2DSH/archive/20261026-200445-install-0.3.28-restart-attempt/OPERATION.md) · [活体验证](Newmark2DSH/archive/20261026-201340-install-0.3.28-live-verify/OPERATION.md)

### 2026-10-26 20:08 重启事故与修复（补）

这次重启暴露了我自己的临时 launcher 的四个缺陷：按镜像名杀进程、只等 6 秒、启动不带工作目录与 stdout、没有重试与就绪判据 —— 结果应用停了 4 分钟才被手动拉起。产品自带的 `core-restart.ps1` 反而是对的（等宿主打印 `dsh web: http://127.0.0.1:` 才判定成功）。

修了两处：① 仓库新增 `SCRIPTS/restart-dsh.ps1`（身份停树 → 等退出 → 带工作目录启动 → 等就绪 90 s → 重试 3 次，失败明说"请手动启动"；`-DryRun` 已通过）；② 更新路由的取消回调改到 `await` 之前登记，客户端超时不再把控制器锁死在 `starting`（源码已修、未安装）。

当前应用运行中（pid 68332，端口 50256，0.3.28，`watch.runs=1`、6 个工作区）。[事故记录](Newmark2DSH/archive/20261026-2008-restart-relaunch-failure/OPERATION.md)

### 2026-10-26 20:19 第二次重启失败与真因（补）

这次不是脚本逻辑问题：DSH 的工具子进程在 kill-on-close 的 Windows **Job 对象**里，`Start-Process` 的"分离"不脱离 Job，helper 杀死宿主树时被连带杀死，应用直到 47 秒后才被手动拉起。
修复：重启脚本改为**两段式**——前台用 WMI（`Win32_Process.Create`）创建 worker 后返回，worker 的父进程是 `WmiPrvSE.exe`、在 Job 之外，能活过自己杀死的树（实测 pid 88528，父进程 WmiPrvSE）。
当前 0.3.29 已在跑（端口 56695，`watch.runs=2`、`acc=0.354`、工作区根从 6 个收敛到 3 个——嵌套去重确实生效）。[事故记录](Newmark2DSH/archive/20261026-2019-restart-job-object-failure/OPERATION.md)

### 2026-10-26 20:32 heartBeat 已修：重启后真的接续

两个缺陷都在 heartBeat 里：① 重启准备用的是**运行版本**，而控制器比对**磁盘版本**——"装新版再重启"每次被拒；改为读取磁盘版本。② 由 heartBeat 之外完成的重启不 arm 接续，任务永远 `waiting`；改为启动时**认领**其它进程遗留的接续（>60 s、上限 8、只投一次）。
门禁 60 → **64 PASS**；0.3.30 已安装，经更新路由重启（helper 自报 `DSH host ready; new main PID 57828`），新端口 52521。**本轮这条消息就是被投递的接续**，heartBeat `tasks:0 / receipts:94`。
[实现与证据](Newmark2DSH/archive/20261026-2032-heartbeat-continuation-fix/OPERATION.md)

### 2026-10-26 20:34 接续机制已被自己证明（一条过期任务）

20:00 登记的「装 0.3.28」接续，在 0.3.30 重启时被正常投递——**接续真的工作了**；但任务已过期，所以没有回装 0.3.28，而是按当前状态对账：watch 30 分钟/0.6/0.1、**roots=3 / runs=4 / acc=0.41**、24 工具含三个对话工具；真实差分把本轮 2 个改动文件**全部归因 DSH**（user 0 / dsh 2），有效分 **0.0811**。
两个新写下的边界：文件采样上限 2048 意味着大仓库未采样区的新文件名称看不到（数量会动）；改监控间隔要等当前轮结束才生效。[对账记录](Newmark2DSH/archive/20261026-2034-stale-continuation-verify/OPERATION.md)

### 2026-10-26 20:38 接续去重：一条重启通知，只叫一次

上一次重启的 8 条投递里，同一会话收到两条**一模一样的**接续（屏障自动登记 + 更新路由各一条），对话被叫醒两轮。0.3.31 在 `enqueue` 处按 `(destination, prompt)` 去重（仅限未投递的 `waiting/armed`），第二次登记返回既有 id。
实测：0.3.31 安装 + 更新路由重启（helper 报 `new main PID 90132`，端口 53250），启动仅 **2 条**投递——本会话接续（本轮）+ 更新后任务；门禁 heartbeat **65 PASS**。[证据](Newmark2DSH/archive/20261026-2038-heartbeat-single-continuation/OPERATION.md)

### 2026-10-26 20:44 设置页整合（0.3.32，已生效）

工作区监控的四项参数改成与陪伴偏好**同一套控件**：统一高度/边框/底色/圆角、数字等宽对齐、聚焦与禁用态；标签只留名字，单位（分钟/层/倍）独立显示，每项下一行写明范围与行为（如"越高越安静""设 0 完全忽略 agent 写入"）；状态行补"下次约几点对比"；并写清"这里即时保存，插件配置里的同名项只在首次挂载时作为默认"。
门禁 config-panel 34 / client 123 通过；已安装 0.3.32 并经更新路由重启（新端口 55325）。[实现与证据](Newmark2DSH/archive/20261026-2044-settings-page-integration/OPERATION.md)

### 2026-10-26 20:58 监控并入陪伴：主动性决定阈值，时间也参与判断

设置页现在只有一张「陪伴与工作区监控」卡和一个「主动性」选择（低/中/高），阈值自动映射为 **0.85 / 0.6 / 0.4**，**不再有「每天最多 N 条」**——频率由间隔与冷却决定，不由配额决定。
阈值分数 = **文件证据 + 时间证据**：文件侧仍是数量/名称/最新修改时间（DSH 自建改动按 0.1 降权），时间侧是"已安静多久 / 主动性间隔 × 权重"（低 .15 / 中 .25 / 高 .35），两者累计到阈值才发起一次。安静本身也会积累，文件变动会加速。
每轮对话（不论用户发起还是 NewMate 主动）都会带上「工作区最近变动」这行浅层事实；主动消息被要求用具体文件事实说明，否则沉默。
门禁 diff 51 / initiative 57 / config-panel 37 / client 123 通过；0.3.34 已安装并重启（端口 56149，pace=active→阈值 0.4；旧阈值字段已从状态里清除）。[实现与证据](Newmark2DSH/archive/20261026-2058-merge-monitor-pace-time/OPERATION.md)

### 2026-10-26 21:20 设置页删减（0.3.35）

按你的划线：删掉「扫描深度」「DSH 自建改动权重」两个输入及其说明、两条状态行和页脚说明；保留陪伴开关、主动性（→阈值 0.85/0.6/0.4）、静默时段、暂停、监控开关、对比间隔。深度与权重仍是算法里的默认值（3 层 / 0.1 倍），可在插件配置里调整，只是不再占页面。[证据](Newmark2DSH/archive/20261026-2120-trim-settings-block/OPERATION.md)

###### 2026-10-27 12:00 0.3.38 已推送独立仓库并发布到 npm

- **仓库** [positer/newmark2dsh](https://github.com/positer/newmark2dsh)：main **8cdc8e5**，标签 **v0.3.38**，`sync-release-repo` 同步 99 个包内文件（11 个变更，新增 `shortcuts.js`），仓库自带 bundle 守卫通过。
- **发布**：推 tag 触发仓库工作流（trusted publishing，无 token）→ [run 40447320099](https://github.com/positer/newmark2dsh/actions/runs/40447320099) **success**，npm `latest` 从 0.3.35 切到 **0.3.38**（12:02:46），产物带 **SLSA provenance**。
- **对拍**：发布物 100 文件 vs 本地 99，唯一多出的是 `README.md`；16 个文件二进制不同但**全部只是 CRLF/LF**，真实内容差异 **0**；发布物 `shortcuts.js` 31 条、含 `ctrl+space`。

####### 2026-10-27 13:24 README 去版本化，并把 0.3.43 真正发布出去

- **README**（独立仓库）：删掉三处版本痕迹——安装命令不再钉 `@0.3.14`、Windows 验证行不再以版本号开头、末尾「当前版本与更新」改为「更新与版本」（版本历史只指向 GitHub Releases）。仓库内 `0.\d+.\d+` 匹配数 **0**。
- **推送时发现**：npm `latest` 还是 **0.3.41**，0.3.42/0.3.43 只在本机安装过、从未发布，仓库 `package.json` 也停在 0.3.41。于是同步 0.3.43 → 推 main `774a5bb` → 标签 `v0.3.43` → 可信发布。
- **结果**：`latest` 0.3.41 → **0.3.43**（13:25:49），[run 40455094828](https://github.com/positer/newmark2dsh/actions/runs/40455094828) success；对拍 101 vs 100 文件（多 `README.md`）、16 个差异全是 CRLF/LF、真实内容差异 0；**发布物里的 README 版本号也是 0 处**，两个新功能文件都在包里。

## 2026-10-27 13:17 双版本回复 + 待办重复规则（0.3.43）

- **一条回复，两种渲染**：每轮都要求 JSON 信封 `{text, plain}`——`text` 是页面渲染版（可用 Markdown），`plain` 是气泡与外部渠道（微信 clawbot）用的纯文本 ≤80 字。页面存 `text`，气泡通知发 `plain`；模型不守协议时本地降级，协议 JSON **不会**再变成消息正文。活体：一条 372 字符的渲染版 + 81 字符纯文本版，零 JSON 泄漏。
- **待办可重复**：`newmate_todo_add` 新增 `repeat`——`{every, unit:'min'|'h'|'d', weekdays:[1-7], at:'HH:MM'}` 或规则串（`every 2 d on mon,wed,fri at 09:00`）。重复待办投递后自动回到 pending 并写下一次激活；活体：8 秒后到期那条投递一次后，下一次排到 2 小时后。面板加了「重复 / 每隔 / 周几」控件，列表显示「每 1 天 · 周一、三、五 · 09:00」。
- 顺带修掉上一轮残留：重启报告不再被主动格式/能力抱怨闸门吞掉。[证据](Newmark2DSH/archive/20261027-1317-dual-reply-and-repeat/OPERATION.md)

## 2026-10-27 12:46 0.3.41 已推送独立仓库并发布到 npm

- **仓库** [positer/newmark2dsh](https://github.com/positer/newmark2dsh)：main **8e21019**（9 files, +55/−19），标签 **v0.3.41**。
- **发布**：推 tag 触发可信发布 → [run 40451512519](https://github.com/positer/newmark2dsh/actions/runs/40451512519) **success**，npm `latest` 0.3.38 → **0.3.41**（12:47:42），产物带 **SLSA provenance**。
- **对拍**：发布物 100 文件 vs 本地 99（多 `README.md`），16 个文件二进制不同但**全部只是 CRLF/LF**，真实内容差异 **0**；发布物内确认 `-WindowStyle Normal` 与 `space: ' '` 都在。

## 2026-10-27 12:43 CU 能自主改输入法吗：能，且有实测证据

- **能切换**：`computer_use({action:"app_key", key:"ctrl+space"})` → 任务栏输入指示器 **英→中**（截图），再按一次恢复 **英**。这条路径在 0.3.39 之前是坏的（SendKeys 没有 `{SPACE}` 关键字），修成字面空格后走通。
- **能绕过输入法打中文**：`app_type "你好，…"` 以 `unicode-key-events` 直接注入，IME 是中是英都不影响。
- **不能做的**：`ctrl+shift`（切换输入法/键盘）真实模式返回 `key_unsupported`；`win+space` 因本机不接受合成 Win 键而不可用；没有专门的 IME 状态动作，只有按键与文本两条腿。[证据](Newmark2DSH/archive/20261027-1243-cu-ime-control/OPERATION.md)

## 2026-10-27 12:38 重启必须带回窗口（0.3.40 + 0.3.41）

用户报「进程错误的停止了且没有自行再启动」。查下来是两段问题：辅助在旧进程尚未释放 Electron user-data 锁时就启动替换实例（`status.json` 写 `DSH exited during startup`，stderr 是缓存目录占用），以及修完后**进程回来了但没有窗口**——辅助用 `-WindowStyle Hidden` 启动应用本身，这个构建把首个窗口建成了隐藏。现在：杀树后等同路径进程全部消失（≤20s）→ 启动（`-WindowStyle Normal`）→ **必须有可见主窗口才算就绪**，失败重试 3 次并记录尝试次数。实测 12:37:48 重启：进程 34084、窗口「调试newMate唤起与微信接口」、stderr 0 B。[证据](Newmark2DSH/archive/20261027-1235-restart-window-regression/OPERATION.md)

### 2026-10-27 12:20 亲自调用 CU 验证真实/虚拟模式与快捷键（0.3.39）

真实模式（Notepad）逐条验证：输入、Ctrl+A/C/V/Z、Ctrl+Home/End/Delete、Ctrl+F/EsC 都有可见效果；虚拟模式的收据同样返回 `ok` 但文本没有插入——Windows 11 现代 Notepad 忽略 posted 键盘消息，收据里的 `action_completed:false` 才是线索。由此修掉两处「白名单里写着、实际发不出」：`ctrl+space`（SendKeys 没有 SPACE 关键字，改为字面空格）与 `ctrl+shift`（纯修饰键无 SendKeys 表达，白名单注明真实模式暂不支持）。[证据](Newmark2DSH/archive/20261027-1220-cu-live-shortcut-test/OPERATION.md)

## 2026-10-27 08:25 CU 快捷键白名单（0.3.38）

Computer Use 现在带着一份 **31 条快捷键白名单**：截图里的整套（复制/粘贴/撤销/保存、Win+↑↓、Alt+F4、Alt+Tab、Ctrl+Alt+Del、Ctrl+Shift+Esc、Win+E/Tab/R/I、Ctrl++/-、Ctrl+↑↓、Ctrl+Tab、Print Screen、Delete、Shift+Delete、Ctrl+N/W 等）**外加 Ctrl+Space 中英切换**。三个出口同一来源：工具描述里的表格、只读动作 `action:"shortcuts"` 的 JSON、以及门禁逐条用真实解析器验证。Print Screen 与缩放键补齐了 VK 映射，否则"列了却发不出"。新门禁 `verify-cu-shortcuts` 9 PASS；活体返回 31 条、含 `ctrl+space`。[证据](Newmark2DSH/archive/20261027-0825-cu-shortcut-whitelist/OPERATION.md)

## 2026-10-27 08:10 虚拟桌面预览不再纯黑（0.3.37）

桌宠的虚拟桌面预览曾整屏纯黑：`frame.png` 逐像素 **100% 黑**，而 `capture.json` 报 `captured 12, failed 0`。原因是三块置顶全屏透明浮层（CEF-OSC-WIDGET、两个 Windows.UI.Core.CoreWindow、IslandWindow）被 PrintWindow 渲染成不透明黑矩形，最后绘制盖住了一切；DSH 与任务栏其实都抓到了（lum 31 / 42）。现在对"覆盖 ≥ 屏幕 1/4 且纯黑"的窗口跳过绘制并计入 `transparent`：活体 `captured 8 / transparent 3 / failed 0`，成帧非黑比例 0.561，预览可见真实桌面。新门禁 `verify-desktop-pet-capture` 6 PASS。[证据](Newmark2DSH/archive/20261027-0810-virtual-desktop-black-fix/OPERATION.md)

### 2026-10-27 07:55 NewMate 的时间戳改为本机时间并锚到用户消息（0.3.36）

实测：用户 07:55 发消息，NewMate 回「现在 23:55」——prompt 首行给的是 UTC 的 `Z` 时间却标着「本机时区」。现在首行给两段带偏移的本机时间：`当前时间`（本次运行）与 `最后一条用户消息发送于`（该线程最近一条 user 消息），并明说不要换算。`verify-newmate-chat` 25 PASS。[证据](Newmark2DSH/archive/20261027-0755-newmate-local-time/OPERATION.md)

## 2026-10-26 21:39 npm 已发布 0.3.35（latest 已切换）

`npm publish newmark2dsh-0.3.35.tgz --tag latest` 由 **positer** 账号发布；发布后约 40 秒 `dist-tags.latest` 从 0.3.26 切到 **0.3.35**。回拉校验：从 registry `npm pack` 取回后与本地 tarball **逐文件 sha256 零差异**（98 文件），`dist.integrity` 与本地 sha512 一致（`LMq5V307…`），`dist.shasum 72370951…`。
注意：仓库里的 `publish.yml` 发布的是桌面应用 `newmark-agent`，不是本插件包；本次插件包是直接发布已验证 tarball。0.3.27–0.3.34 为本地候选，未单独发布。

## 2026-10-25 Newmark2DSH 0.3.27：NewMate 获得三个「对话级」工具（新建 / 发信 / 读取）

NewMate 现在能自己把工作落到对话里：`newmate_conversation_new` 在工作区**新建**一个真实 DSH 对话并给它第一条消息（`ctx.agents.create({sessionId, meta:{cwd, agentPreset}, setup})`，setup 里挂 preset，首条消息走 `followup` + `sessions.flush` 屏障，落盘后才 `workspaceRegistry.attachSession`）；`newmate_conversation_send` 向**已有对话**投递一条消息（复用 `newmark-task:<id>` 身份与「用户暂停的对话不唤醒」判据）；`newmate_conversation_read` **读取指定对话**的近期正文（只取 user/assistant 文本，不含思考与工具调用，最新优先 + 60 条/6000 字符上限并自报 dropped）。

三个工具是 NewMate 的**私有工具**（DSH agent catalog 不出现），身份（origin / cwd / preset / model）由运行上下文 ALS 提供，**模型不能用参数改目标**；每进程最多保留 16 个自建会话，`stop()` 只 dispose 自己建的那些；拒绝项全部具名：相对/不存在工作区、空消息、无 agents 服务、发信给当前对话自己、目标被用户暂停、目标不可 resume、未知会话。

门禁 `verify-newmate-conversations` **30 PASS**（fake services 记录调用顺序：create→setup 挂 preset→followup→flush→attach，读取只出文本、裁剪自报）；同轮复跑 agent-loop 73、heartbeat 60、chat 23、short-memory-mcp 44、activation 57、memorylab 182、version 12 全绿。**源码候选 0.3.27：未打包、未安装、未重启**——因此 `agents.create` 的真实宿主行为仍未活体验证（安装+重启会打断当前会话，留给用户决定）。

[实现与证据](Newmark2DSH/archive/20261025-153555-newmate-conversation-tools/OPERATION.md) · [完整写回](Newmark2DSH/OVERVIEW.md)

## 2026-10-25 NewMate 的 DSH 对话唤起：三个真实对话跑通，并修掉两处缺陷

`newmate_task` 把任务投回调用它的 DSH 对话（`destination`=会话 id，`agent.followup` + `sessions.flush`，消息身份 `newmark-task:<id>`，来源 `cordis-host-runner`，进 next-turn 队列，回合边界落地后另起一轮）。修复前本机 `state.json` 的 88 条任务里这条链路**一次都没跑过**；本轮用三个真实对话跑通：返回 `{"ok":true,"id":…}`、476 / 963 / 2720 ms 完成投递、目标对话各自回 `WAKE-PROBE-OK` / `WAKE-IDLE-OK` / `WAKE-ORIGIN-OK`，会话日志逐行可查。第三个探针走的是设计主动线：DSH 对话调 `newmate_chat` → NewMate run 绑定 origin → 该 run 内调 `newmate_task` → 唤起回同一个会话。

两处真缺陷：① `verify-newmate-heartbeat.mjs` 第 23 条是 19 个工具名的**快照**，0.3.25 把 `compact_context` 加进组后恒红，**并在第 23 条中断**——后面的投递与 flush 断言一直没执行；改成按族断言 + 成员必须属于组后 **22 → 60 PASS**。② 唤起路径不检查用户是否暂停了目标对话，被暂停的对话会被后台唤起跑一轮（0.3.17 已为重启通道立过同一条规则）：新增 `conversationPaused()`，暂停时任务留 `pending` 并标 `deferred:'target_paused'`，恢复 goal 后下一次 tick 自动投递，没有 goals 服务时 fail-open。

同轮复跑 chat 23、agent-loop 73、ask 20、short-memory-mcp 44、activation 57、memorylab 182 全绿；**未跑 umbrella**（CU 类门禁依赖活桌面）。源码改动**未安装、未重启**（本机仍是 0.3.26 的旧内容，4 个文件不同），版本号未提升。微信 clawbot 调研另见 `Newmark2DSH/docs/15-wechat-clawbot-research.md`。

[实现与证据](Newmark2DSH/archive/20261025-151619-newmate-wake-debug/OPERATION.md) · [完整写回](Newmark2DSH/OVERVIEW.md)

## 2026-10-21 Newmark2DSH 0.3.21 候选：NewMate 获得完整 CU 权限，并暴露实时 Agent 循环

NewMate 现在可以使用 Newmark2DSH 配套的完整 ComputerUse 工具组（`computer_use` 与只读的 `screen_capture`），但只在用户明确请求的那一轮或用户安排的待办里；自主检查（self_activation / measurement）轮次没有这两个工具。allow list 由 `newMateRunTools({automatic,origin})` 一处构造；人格 697→966 字符，写清「桌面授权只来自用户明确请求，记忆、推测、文件变化和主动联系都不构成授权」。

接管以稳定的 `newmate` 身份登记（`lib/cu-caller.js` 新增 `withComputerUseOwner` / `computerUseOwner`），不借用请求对话的 `dsh-session:`、也不落到共用的 `dsh`；用过的租约在任务结算前由运行时以同一身份对 real / virtual 各发一次 `takeover_stop`（8 s 上限），别的 owner 的租约只会被拒，不会被释放。请求对话身份仍对 `newmate_todo_add` 可见，待办 origin 语义不变。

实时循环不再只在结束时才有回执：agent-api 在事件发生时把同一份 `eventView` 交给 NewMate（在回执两条界之前），`newmate_state`、GET `/newmark-newmate` 的 `agentLoop`、MCP `newmate_task_status` 与 NewMate 页面读同一份 `loopStatus()`（phase、轮次、工具调用数、当前工具、耗时、停止原因、最近 24 个事件；页面运行中 800 ms 刷新、空闲 2000 ms）。初始化前缀在活库上 24,863 → 30,997 字符（人格 +269、CU 参数 schema +5,866）。

新门禁 `verify-newmate-agent-loop` **45 PASS**（同日追加后为 **66**），其中用真实 agent-api 循环证明实时事件与回执 `events` 逐字节相同；`verify-short-memory-mcp` 44、`verify-newmate-memory-writes` 7、`verify-newmate-heartbeat` 57、`verify-newmate-initiative` 57、`verify-memorylab-tools` 182、`verify-agent-api` 268、client 123、config-panel 31、compose 25、activation 57、package 54、version 12 全绿；`verify-tool-output-boundary` 因本机 DSH 安装路径改名而 PREMISE ABSENT（跳过，不是通过）。Umbrella 单次运行 **206 passed / 2 failed / 1 skipped**：win32 与 sweep 在该运行窗口内分别以 `foreground_window_unavailable` 与「原始增量含物理鼠标运动」红。两处都是活桌面前提——win32 随后单独复跑 **25/25 PASS**；sweep 在安静桌面下复跑 **8/8 测量项 PASS**（第 8 项 planted mutation 按设计跳过），再以 `--mutations` 单独跑该项 **PASS**（种植后 check 3 变红、还原 sha256 `6632a72d…` 核对）。因此这两条不计为代码回归，也不把 umbrella 写成全绿。0.3.21 为源码候选（**该「未安装、未重启」状态已被 2026-10-21 14:36 的本地重装与重启取代，见下方的同日追加**）。

[实现与证据](Newmark2DSH/archive/20261021-133000-newmate-cu-loop/OPERATION.md) · [完整写回](Newmark2DSH/OVERVIEW.md)

## 2026-10-21（追加⑥）Newmark2DSH 0.3.26：实时工况刷新与计时解耦（已安装）

全量轮询 2s；运行中轻量 /newmark-newmate/loop 每 200ms 刷新思考/工具；状态行本地 250ms 时钟按 startedAt 计时，秒数不再跳秒/加速。实测 /loop 返回 agentLoop/question；页面无浏览器实测。 npm 0.3.26 已发布（latest，shasum 119a3ea6...）。

## 2026-10-21（追加⑤）Newmark2DSH 0.3.25：私有工具通道 + 自主压缩（已安装）

newmate_search 与 compact_context 不再暴露给 DSH agent（进程 catalog 37，不含两者），只经私有映射进入 NewMate 运行；compact_context 由 agent-api loop 拦截，用模型给的摘要替换自身历史。实测：初始化 21 工具含两者、toolsMissing=[]；已安装重启生效；页面仍无浏览器实测。

## 2026-10-21（追加④）Newmark2DSH 0.3.24 候选：最新实时工况

页面回到暴露 agentloop 之前的对话形态（用户输入 + 落盘回复），只额外显示一条最新工况：最新思考尾部或正在使用的工具；官方搜索显示「正在进行搜索」。完整过程时间线不再渲染。门禁 71（agent-loop）、123（client）、20（ask）。源码候选 0.3.24，未安装、未重启；页面无浏览器实测。PTC 动态压缩已定位 DSH compaction 服务，尚未接入。

[实现与证据](Newmark2DSH/archive/20261021-153456-newmate-live-state/OPERATION.md)

## 2026-10-21（追加③）Newmark2DSH 0.3.23 候选：对话页对齐 Newmark 本体

只对齐**对话页表现**（不移植 heavy 内核）：新增 `newmate_ask` 选项询问——页面按本体 `.option-block` 渲染（2–6 个带说明选项 + 手填），答案作为工具结果继续同一次运行；NewMate 聊天不再设轮次上限（`agent_api_send max_steps: 0`，仍受超时/重复失败约束）；运行中的输入**只插队不排队**（进入引导缓冲、下一个模型步插入，不新增排队任务；门禁断言 steering 计数且无 pending chat 队列）。门禁：ask **20**、steer **24**、agent-api **270**、memorylab 182、activation 57、compose 25、heartbeat 57。**0.3.23 已于 2026-10-21 15:24 本地重装并重启生效**（96 文件，sha256 D0ACA55F…；npm 未发布）；页面仍无浏览器实测。

[实现与证据](Newmark2DSH/archive/20261021-150654-newmate-option-ask/OPERATION.md)

## 2026-10-21（追加②）Newmark2DSH 0.3.22 候选：Agent 循环的过程块

参考 Newmark 本体 Build 渲染：思考与工具调用按**发生顺序**排在**同一个可折叠块**里。服务端 `agent-loop.js` 把 thinking 作为时间线片段插入事件环（流式重发原位替换、片段上限 1,200 字符并保留截断标记、与工具共享 24 条/6,000 字符界）；页面 `renderProcess()` 用一个 `<details class="nm-run">`，summary「过程 · 最新动作 · N 步」，body 按顺序渲染灰色思考段与「已查看记忆/已控制电脑/已调用工具」，删除旧的 `nm-thinking`/`nm-loop` 两个块。门禁 66→**71 PASS**、4/4 planted mutation 变红还原。**2026-10-21 14:52–14:53 已本地重装 0.3.22 并经更新路由 + heartBeat 托管重启生效**（tarball sha256 `856E3510…`，95 文件一致；备份 `0.3.21-before-0.3.22-*`；npm 未发布）。重启后更新路由的 NewMate 任务跑出真实样本：`agentLoop.events` 顺序为 `agent_start,turn_start,thinking,tool_start,tool_end,…,turn_start,thinking,…`（思考段与工具按真实顺序交错）、GET `/newmark-newmate` 200 带 `agentLoop`、进程层 catalog 37 含 `newmate_search`。页面仍无浏览器实测。

[实现与证据](Newmark2DSH/archive/20261021-145500-newmate-process-timeline/OPERATION.md) · [完整写回](Newmark2DSH/OVERVIEW.md)

## 2026-10-21（追加，同一 0.3.21 候选）Agent 循环简写标签 + 思考流 + DSH 原生搜索

页面把 NewMate 的工具使用简写成浅色小字的「正在/已 查看记忆、控制电脑、调用工具」，模型推理以可折叠灰色小字实时刷新：seam 按 `reasoning-delta` 以 120 字符 / 200 ms 的步长流式发布，agent-api 的 `eventView` 只保留尾部 4,000 字符并标截断，`pushEvent` **只发给 live 观察者、不进回执**（回执的 64 条 / 16KB 界留给工具诊断）；NewMate 追踪器把思考存成替换式 `{text,at,truncated}`，不占事件环。新增 `newmate_search` 接入 DSH 原生搜索：优先 `ctx.web` 接缝，插件作用域不可达时回退 DSH 自带的 `deepseek-official` 提供者（官方端点、`DEEPSEEK_API_KEY`、默认模型不变），1–4 个 query、去重、最多 8 个来源、60 s 预算，结果带「不可信外部内容」声明；搜索与桌面工具一样只在用户请求的轮次开放，自主检查没有。

实测：本机进程层 `agent_api_send {allow:['web_search','web_fetch']}` 的回执是 `tool_names: []`、`tools_withheld: {count:2}`——这是回退路径存在的实测理由（主机的 `web_search` 在 agent 预设里，NewMate 的进程层 run 够不到）。初始化前缀 30,997 → **31,390**（+393 = 人格 +105 + 搜索 schema +287），组 19 条。门禁：新门禁 **66 PASS**；compose 25、activation 57（工具 34→35）、memorylab-tools 182（组合 32→33）、heartbeat 57（允许名加搜索）等同步更新并全绿；新增 **6 个 planted mutation 全部变红并逐字节还原**。**2026-10-21 14:36–14:39 已本地重装 0.3.21 并经更新路由 + heartBeat 托管重启生效**（本地 tarball sha256 `614F7C22…`，95 文件逐文件一致；备份在 `~/.dsh/profiles/desktop/.newmark-install-backups/0.3.20-before-0.3.21-20261021-143602`）。重启后实测：`newmate_state` 带 `agentLoop`（一次真实的更新后 NewMate 运行：3 轮 / 4 工具 / 16.0 s / 思考 4,015 字符 truncated）、GET `/newmark-newmate` 返回 `agentLoop`、进程层 catalog 37 含 `newmate_search`、`newmate_search {queries:['DeepSeek Harness']}` 返回 `ok:true` / **`provider:"ctx.web"`** / 8 个来源。**更正**：此前「本机 `ctx.web` 不可达、NewMate 实际走 provider 回退」被这次实测推翻——不可达的是 `web_search` **工具**层（`tools_withheld`），`ctx.web` **服务**在插件作用域是可达的；回退路径只作为没有该服务的宿主的备用，并由门禁用假 provider 覆盖。页面渲染仍没有浏览器实测（无 Playwright），client 断言是源契约。npm 未发布 0.3.21。

[追加证据](Newmark2DSH/archive/20261021-133000-newmate-cu-loop/evidence/addendum/) · [完整写回](Newmark2DSH/OVERVIEW.md)

## 2026-10-20 Newmark2DSH 0.3.20 候选：NewMate 初始化 = 人格 + 完整标签树 + 全部短期记忆 + 工具组 schema

NewMate 首轮上下文一次给全四项：初始化人格 prompt、完整的 MemoryLab 标签树（全部标签与每个记忆节点的名称/所属标签，不含正文）、全部短期记忆（每行带到期标记）、本轮工具组 schema（16 条：按 NewMate 自己的 allow list 从当前注册表暴露做只读投影，兼容插件提供的工具；暴露里没有的组内工具写进 toolsMissing/不会冒充可调用）。记忆正文仍按需读取。本机实测初始化前缀 14,438 → 24,626 字符。门禁 44 / 182 / 7、NewMate 回归 57/57、57/57、23/23 全绿。**未安装、未重启**，0.3.20 为源码候选（**该状态已被本段末的发布记录取代**）。

[实现与证据](Newmark2DSH/archive/20261020-230439-newmate-initialization/OPERATION.md) · [完整写回](Newmark2DSH/OVERVIEW.md)

**2026-10-20 23:45 已发布并生效**：main `76674f4`、tag `v0.3.20`、npm `latest=0.3.20`（94 文件 79 逐字节 + 15 仅换行、0 实质差异）、拉回安装 94 文件一致、更新路由重启 23:45:47、活体实测通过（tree 104/19、short 10 行、tools 16、toolsMissing=[]）。

## 2026-10-20 Newmark2DSH 0.3.19 候选：记忆工具描述写清「长期树状记忆」与「短期到期列表」的分工

MemoryLab 的 9 个工具与 shortMemory 的 4 个工具，描述开头各带一句角色句：长期记忆是持久、稳定、树状（标签父链）的知识，用于用户画像与知识图谱，不自动过期；短期记忆是扁平列表，默认七天到期、过期行保留并标记，用于跨对话的临时任务交接。两族互相点名，`memory_lab_read` 的用法说明另有一段同口径的分工。门禁 168 → 176，5 个变异全部按预期变红、逐字节还原；注册表读回 13 条描述 5558 → 8978 字符。**本轮只改源码与文档，未安装、未重启**（本机宿主仍是 0.3.18），六个 manifest 已到 0.3.19。（该状态已被本条之后的晚间追加取代：已推送、已安装、已重启并验证生效。）

[实现与证据](Newmark2DSH/archive/20261020-213034-memorylab-memory-roles/OPERATION.md) · [完整写回](Newmark2DSH/OVERVIEW.md)

**2026-10-20 晚些（按用户指令）**：发布仓分支 `codex/memorylab-roles-0.3.19` 已推送（提交 `932451f`，main 未动、未发布 npm；**此处的「未发布 npm」已被本段末 22:40 的发布记录取代**）；0.3.19 已安装进 profile 并经插件更新路由 + heartBeat 托管重启（`restart(ticket, update=true)`）生效，本对话由该接续路径回来。**2026-10-20 22:40（按用户指令「监听npm版本直至正确公开」）**：`v0.3.19` 标签已推送并触发 publish 工作流（run 39440904853 success），npm `latest` 已是 **0.3.19**；integrity 一致、93 文件（78 逐字节 + 15 仅 CRLF 规范化、实质差异 0），空目录 `npm install newmark2dsh@0.3.19` 通过。**发布仓 main 已更新推送**：`f5d9ebb..a6f7fa1`（2026-10-20 22:47:46 推送）——0.3.19 包内容与 tag `v0.3.19` 逐 blob 相同，main 的公开文档策略保留（根 CHANGELOG 仍归档、`docs/` 只留公开页、版本历史走 GitHub Releases）；远端 `git ls-remote` 读回 `a6f7fa1`，干净 worktree 上 `check-release-bundle.mjs` = `GUARD PASSES`。

## 2026-10-17 Newmark2DSH 0.3.16 候选：heartBeat 两阶段重启（广播 + 回执屏障）

`heartbeat_restart` 增可选两阶段形式：`broadcast:true` 按宿主 `agents().roots()` 枚举运行中的对话（不接受调用方传入的目标名），`ackMode:'auto'`（默认）为每个参与者登记持久接续、不花模型 token，`ackMode:'agent'` 投递持久通知并要求该会话自己回执；`heartbeat_restart_commit` 只在回执到齐且发起方自己已登记时才真正重启，否则 `aborted` 并点名缺失者。intent 持久化到 `~/.Newmark/heartBeat/state.json`（schema 3），新宿主清扫 `committing → committed`（记录本次投递）与旧进程残留 `preparing → interrupted`（通知 requester 本次没有重启）。`broadcast=false` 与 0.3.15 一致，屏障打开期间即时重启被拒绝。

详细写回见 Newmark2DSH 的 README/OVERVIEW/taste/VERSION.md 与 `Newmark2DSH/archive/20261017-heartbeat-restart/`。

## 2026-10-13 Newmark2DSH 0.3.14正式发布

0.3.14 已发布 GitHub/npm latest，并取回官方包核对全部 93 文件；Windows安装已替换为同一正式包，逐字节一致，官方ASAR与原配置/消息保留，heartBeat重启不重复投递。不可变标签 b5c8a3b46152da88bb1b16713fc93be9f575c320；只读官方云验收也通过。上一轮200/0/0完整门禁与Mac ARM六作业作为同一运行代码的验收证据；发布源只规范化Git文本换行，正式安装再次通过23项共享桌宠原生检查。

[发布证据](Newmark2DSH/archive/20261013-release-0.3.14/REPORT.md)。


## 2026-10-13 Windows安装与Mac包边对照（0.3.14候选）

0.3.14 已安装本机官方DSH，尚未发布。修复Mac屏幕四层灰度框为顺时针周长黑白渐变，桌宠按Alpha裁剪保持比例；修复Win隐藏CU先启动后开启陪伴重建桌宠的问题。200/0/0完整门禁、92文件源码/安装一致；23共享桌宠、5尺寸、20原生GPU预览、3菜单检查通过。实际宿主待办模型激活、阅读保护、MCP和heartBeat重启不重放通过，原设置/消息/其他插件保留。Mac14/15/26 ARM六云作业成功，原生52场景、生产渲染1x/2x及实际双Space通过。视觉风格与比例对齐，不宣称逐物理像素一致、官方Mac DSH整机或Neo性能实测；Win不激活桌宠实体双击/右键本轮未独立复验。

[完整证据与边界](Newmark2DSH/archive/20261013-win-mac-parity/REPORT.md)。


## 2026-10-13 macOS动态包边专项（0.3.14候选）

修正Mac桌宠矩形外框为图片Alpha轮廓波形，normal CU用四层平滑灰度边框，单调时钟3秒相位、30Hz common-mode计时器；CU决定闪边，预览展开/仅陪伴无闪边，右键菜单不中断动画，释放清理正常。ARM macOS14/15/26原生51场景与双Space均通过；实际连续像素变化、静态无闪边、轮廓邻接0脱离像素通过，生产渲染类1x/2x离屏检查通过。不是实体Retina或官方Mac DSH整机验收。0.3.14仍为未安装发布候选，包含此前toDo对话激活。

[专项证据](Newmark2DSH/archive/20261013-macos-dynamic-border/REPORT.md)。


## 2026-10-13 toDoList 适时激活 NewMate（0.3.14 候选）

新待办默认激活一轮 NewMate，结合原生MemoryLab记忆和上下文回应或处理明确委托。阅读、草稿、输入、运行任务、静默和暂停时等待；适时按现有关注策略选当前或新对话。回复通过桌宠气泡、点击进入页面，不自动弹出窗口。页面/对话工具/MCP可选择仅原文提醒，旧待办保持原语义。持久化唯一激活任务与消息回执，失败/运行中崩溃不自动重试。21激活、20提醒、23steer、12网页与12版本检查通过；完整门禁200/0/0。六manifest同步0.3.14，无新组件；本轮未安装发布。

[实现与候选包记录](Newmark2DSH/archive/20261013-todo-activation/REPORT.md)。


## 2026-10-13 0.3.13 已发布：Windows安装与Apple Silicon云验收

NewMate toDoList 已随现有五组件发布，未新增子组件。GitHub v0.3.13、npm latest=0.3.13；93个包内文件与Windows官方DSH安装逐字节一致。完整门禁200通过、零失败/跳过；实际GUI创建、到期等待陪伴开启、精确投递、第二次heartBeat重启不重放，以及实际宿主MCP创建/查询/取消通过。原39条消息、其他插件依赖和Loader配置保留，陪伴恢复原关闭状态。Apple Silicon macOS14/15/26完整和双Space六作业通过；每环境269项检查与5组真实Space场景，不包括官方Mac DSH整机安装、实体输入时序及Neo性能验收。首次npm传播门禁超时，后续官方取回及只读CI完整验证成功；同版本未重发。

[完整发布验收记录](Newmark2DSH/archive/20261013-release-0.3.13/REPORT.md) · [公共发布](https://github.com/positer/newmark2dsh/releases/tag/v0.3.13)。


## 2026-10-13 NewMate toDoList（0.3.13 候选）

NewMate 新增 toDoList 页面按钮，可手动填写激活时间和发送内容、查看状态并取消未投递项目。任意 DSH 对话、NewMate 本身及认证 MCP Agent 可通过 newmate_todo_add/list/cancel 创建与管理。到期直接投递预存内容，复用现有关注保护和自动换新对话策略，不额外调用模型；陪伴关闭时等待开启，静默/暂停/气泡冷却沿用现有规则。固定消息 ID 和持久化投递回执防止重启重复发送，历史及取消记录保留。版本为 0.3.13 源码候选，属于现有组件更新，无新增子组件。尚未安装或发布。

[实现、测试及候选包记录](Newmark2DSH/archive/20261013-newmate-todo/REPORT.md)。


## 2026-10-13 Apple Silicon 渲染至操作验收

0.3.12 源码候选的渲染至操作验证已扩展：macOS 14.8.9、15.7.9、26.6.2 ARM64 每环境通过 93 组 JS 契约、45 组原生场景、28 组 Chromium/WebKit 页面场景。修复自身输入误判、组合键、macOS 26 滚动、桌宠预览遮挡、预览帧清理及 React fallback snapshot。视觉与 AX 同时可用、分别选择，交叉核验可选；Space 共享输入，100ms 用户 idle 优先。后续仅面向 Apple Silicon，Intel 旧结果仅归档。本地 288 项检查通过。尚未验收官方 Mac DSH 整机、实体键鼠、多屏组合与 Neo 硬件性能；候选未发布或安装。

[完整报告与逐项证据](Newmark2DSH/archive/20261013-macos-render-pipeline/REPORT.md)。

补测：macOS 14/15/26 ARM64 的真实双 Space 流程全部通过。修正离屏 AX 首次绑定、异步 Space 动画和原窗口可见性恢复；离屏像素可通过显式 activate_for_observation 受保护采集，默认/桌宠预览不会自动切换。官方 DSH Mac 容器及实体设备验收仍单列。



## 2026-10-13 免费Mac云验证结果

0.3.12候选已利用公开仓库免费标准Mac CI完成两轮测试：macOS 14.8.9/15.7.9 ARM64均编译CU与桌宠，通过原生只读协议及自产AppKit窗口AXPress/原前台窗口恢复集成；normal边框创建、Space无全屏边框也通过运行检查。210项本地检查通过。鼠标恢复目前为原生返回值证据；真实跨Space、实体键鼠100ms时序、桌宠点击/DSH恢复和边框视觉、Neo硬件仍待独立验收。没有取得可长期交互的免费云Mac，当前安装与npm latest仍为0.3.11。

[报告与证据](Newmark2DSH/archive/20261013-macos-cloud-test/REPORT.md)。

## 2026-10-13 Mac桌宠展开与normal CU边框

0.3.12候选补上Mac原生共享桌宠：Space接管单击展开/收起只读目标窗口预览，双击复用open-chat事件并唤起DSH，原生菜单退出陪伴/打开设置，气泡沿用主主题；没有独立托盘。normal CU以显式mouse_mode:real保留原生输入路径，边框按每个NSScreen渲染、点击穿透、跨Space/全屏显示，并在停止/退出时清理。CU主线程不再阻塞读取stdin。预览只在展开时500ms检查，不更换Agent AX标识，最多保留2张自产临时画面。此前100ms用户优先与操作后恢复约束继续适用。Windows本机安装和公开发布仍为0.3.11；此候选未发布。

[本次记录](Newmark2DSH/archive/20261013-macos-pet-border/REPORT.md)。

## 2026-10-13 Space 用户优先输入与恢复

按用户最终选择，macOS CU 采用 Space＋AX，不接入额外账户或VM。Space租约绑定用户预先放入目标Space的现有窗口；不创建Space或使用私有Space ID。Agent输入等到物理键鼠连续空闲至少100ms、且无按键/鼠标按钮保持按下后投递，最多等待5秒，超时不投递旧动作。每个输入保存鼠标位置和原前台AX窗口，成功/失败均尝试恢复；新用户操作优先，恢复失败明确报告，已执行动作不自动重放。后台点击/文本仅使用支持的AX动作；按键/滚动可能短暂激活目标Space再恢复。仍是0.3.12源码候选，Mac编译、100ms硬件时序及焦点/鼠标恢复均未实机验收。Windows安装/公开发布维持0.3.11。

[本次记录](Newmark2DSH/archive/20261013-macos-space-input/REPORT.md)。

## 2026-10-13 macOS 无障碍辅助候选

已将 macOS CU 源码更新为无障碍 AX 优先：返回有界控件树，使用 AXPress 点击、AXSelectedText 插入选中文本、AXRaise 激活指定窗口；目标标识仅供同调用者和同窗口使用，有效期30秒。无需屏幕录制权限也可观察 AX 结构，像素采集失败时保留 AX 结果。稀疏测量结合控件标题、角色、状态、动作及几何变化，不将随机目标标识当成变化；不读取输入框值，安全字段拒绝编辑。无明确目标且控件不支持语义动作时保留 CoreGraphics 回退，已尝试失败的 AX 动作不重复投递。版本为0.3.12源码候选，尚未在Mac编译或实机验收；本机已安装/发布的0.3.11不变。

[本次记录](Newmark2DSH/archive/20261013-macos-accessibility/REPORT.md)。

## 2026-10-13 0.3.11 回复内交互与原生侧栏

0.3.11 已安装并经 heartBeat 重启。生成式 HTML 直接在回复中渲染，支持输入、按钮、展开收起、源码及复制；当前对话和只读历史复用相同实现。文件链接在 NewMate 自己的侧栏挂载 DSH 实时注册的原生组件，未委托本体对话或自写文档预览器；无法支持时通过原生文件管理器定位。NewMate 获得 MemoryLab 新建、增量更新和标签工具，以及 shortMemory_add，仍没有删除许可。259 项相关检查通过，真实模型生成的计数器及原生 Markdown 已实机验证；89 个交付文件源码、包、安装一致。原有 37 条消息均保留，增加 2 条验收消息，陪伴开关保持关闭。0.3.11 已推送 main/v0.3.11 并发布 GitHub Release，CI 成功；官方 npm latest=0.3.11，下载的90个公开文件与发布源码一致。

[本次验收记录](Newmark2DSH/archive/20261013-generative-ui-test/REPORT.md)。

## 2026-10-13 0.3.10 原生兼容与 Mac 原型

0.3.10 已本地安装，并由 heartBeat 完成重启。Agent API 统一接到 DSH 公共模型解析、请求准备和标准流回复解析，兼容能力由供应商适配层提供；同名模型按供应商隔离，未安装或点名外部供应商插件做特殊适配。NewMate 文件链接采用原生侧栏能力优先、文件管理器定位回退，实时发现未来注册类型；无边框、加粗下划线，历史仍只读。桌宠菜单修复启动主题快照缺失、预热及重复加载，原生隔离窗口测得预热后 38 ms 打开。699 项相关检查通过，包含真实 DSH Runtime/BlockAssembler 内存适配器测试和 Windows WebView 集成测试。macOS 原生 CU 与 Virtualization VM 已加入源码原型，但未经过 Mac 编译/硬件验证，guest CU 仍未接通，virtual 请求明确拒绝物理回退。未远端发布。



[本次验收记录](Newmark2DSH/archive/20261013-native-provider-darwin/REPORT.md)。


## 2026-10-12 0.3.9 主动消息内容约束

0.3.9 已本地安装并完成 heartBeat 重启。NewMate 明确区分用户提问与后台触发：主动联系要有具体可信的新内容，自然简短，最多两句、240 字符；没有可核实内容就保持安静，不主动发送能力边界、权限清单或“我不能为你做什么”的无请求说明。发送前拦截常见能力声明与长篇报告格式，不写聊天、不弹气泡、不触发换新或占消息额度；用户明确询问能力时仍如实回答。外部 agent 主动发信使用同一能力声明防线，完整正文和气泡摘要仍分离。

385 项相关检查通过。实际模型处理重启后台任务后 completed / not_actionable，未追加消息，35 条基线消息保持一致；任务物理消费为永久回执。最终源码、包、安装 84/84 文件同哈希。限频、静默、关注保护和记忆缓存保持，未新增模型审核或子组件，未远端发布。
[本次验收记录](Newmark2DSH/archive/20261012-newmate-proactive-format/REPORT.md)。


## 2026-10-12 0.3.8 重启恢复、桌宠配置与气泡投递

0.3.8 已本地安装并由 heartBeat 重启加载。修复原对话冷恢复缺少 `{{model}}`：在提示词装配前恢复该对话的供应商、模型和推理等级，保留运行中选择，禁止混用供应商或退回全局默认模型。重启辅助程序跳过已退出子进程的复用 PID，同时保留主进程身份检查。真实后台冷恢复已完成模型回复，任务物理移除并留下永久消费回执；随后再次更新重启，没有重复投递。

NewMate 取消 Windows 系统通知，仅使用桌宠气泡提醒，完整消息保存在聊天。右键菜单改为“退出伴随”“打开设置”；退出只释放陪伴的桌宠所有权，CU 可继续使用同一桌宠。配置页重构为组件卡片、模型与桌宠配置、插件更新、陪伴偏好四个区域，使用 DSH 的主题变量，独立开关和供应商模型隔离继续保留。

此次相关门禁 401 项通过；最终源码、包、安装 83/83 文件同哈希。真实重启与配置页截图已留痕，原生菜单动作经过独立窗口测试，工具限制下未完成用户桌宠的物理右键手势验收。未新增子组件，未远端发布。
[本次验收记录](Newmark2DSH/archive/20261012-heartbeat-model-context/REPORT.md)。


## 2026-10-12 0.3.7 NewMate 实时引导与关注保护

0.3.7 已本地安装：NewMate 用户输入直接加入当前运行的 steer guide，不再为每次补充另建排队轮次；界面运行中显示“引导”，补充要求在模型/工具边界生效，旧工具调用被配对为未执行结果，旧回答不会作为最终回复发出。用户打断自动 JSON 判断时复用同一持久任务转为普通回复；显式换新对话的输入会中断旧运行，用户任务优先于后台投递。

自动换新基于可观察的关注状态：正在阅读、近期输入/关注、已有草稿及用户任务保护当前对话。话题变化且至少八小时未互动，或一天以上且连续两次未回应时，在主动消息确实被允许发送前考虑换新；每天最多自动换新一次，旧对话只读保留，不清零预算、冷却或未回应退避。多窗口草稿具有所属窗口与事件序号，其他窗口和旧事件不能清除保护。用户消息上方只保留时间，删除两个“你”；NewMate 回复头像、名称、时间和格式保持不变。

实时引导/关注/换新 23/23、Agent API 268/268、客户端 123/123、低打扰激活 57/57、shortMemory/MCP 37/37、聊天 21/21、供应商隔离 18/18、版本 12/12，共 559 项通过。真实模型验证第二次输入 mode=steer，与第一次共用任务 ID，最终只回复“引导已收到”；实机截图确认用户气泡只显示时间，NewMate 标签完整。最终源码/包/安装 83/83 同哈希，25 条基线消息保留。heartBeat 重启 running，更新后任务已消费为永久回执。未新增子组件，未远端发布。



[实现与实机证据](Newmark2DSH/archive/20261012-newmate-steer-handoff/REPORT.md)。


## 2026-10-12 0.3.6 NewMate 唤起、气泡与回复预览

2026-10-12 用户实机确认：关闭 DSH 主窗口、保留后台运行后，双击桌宠可以恢复主窗口并进入 NewMate。此项验收通过；原生消息气泡点击仍待确认。下文待确认措辞为反馈前的历史记录。

0.3.6 本地更新：发送按钮保持正常右对齐；桌宠显式清除 Electron-as-Node 启动变量，通过已验证的 DSH 单实例入口唤起隐藏主窗口，并请求进入当前 NewMate。气泡跟随主设置的浅色/深色/系统外观，展示最多 80 字的独立摘要；完整正文保存在聊天页，MCP newmate_message 可传 summary。NewMate 回复约束为亲近务实的私人秘书，真实文件链接在回复内可点击，只读打开已引用的文本文件（2 MB 上限）。自包含 HTML 回复以卡片打开独立面板，支持展开、页面/源码切换和复制；iframe 采用不带同源能力的脚本沙箱及受限资源策略。未新增子组件、未远端发布。

客户端 123/123、版本 12/12、聊天 21/21、shortMemory/MCP 37/37、低打扰激活 57/57、呈现行为 8/8、原生共享桌宠 19/19，共 277 项通过；另有两条实机 HTTP 文件边界拒绝测试。实机验证 HTML 按钮计数 0→1、展开面板、文件预览及主设置浅色切换后原生 bubble_dark=false，已恢复原来的跟随系统外观。物理桌宠双击和原生气泡点击尚待用户确认，电脑控制工具拒绝对其他原生窗口的点击；不将页面测试计为这两项验收。



[实现与实机证据](Newmark2DSH/archive/20261012-newmate-bubble-preview/REPORT.md)。


最终包与安装 82/82 同哈希，23 条基线消息保持完整；heartBeat 终态 running，更新后任务已完成并真实消费为永久回执。

## 2026-10-12 0.3.5 NewMate 发送按钮对齐

已本地安装 0.3.5：移除 client.js 中按桌宠运行状态固定添加的发送按钮右外边距，陪伴开启和关闭沿用同一输入框行布局。客户端 123/123、版本约束 12/12；源码/包/安装 81/81 一致，实机截图确认陪伴开启时发送按钮位于输入框右侧。未新增子组件，未远端发布。

[修复与实机证据](Newmark2DSH/archive/20261012-newmate-send-alignment/REPORT.md)。


## 2026-10-12 0.3.4 NewMate 低打扰自主激活

已实现并本地安装 0.3.4：NewMate 不再依赖用户先开口、文件变化或外部任务才工作。开启陪伴后约 20 分钟进入自主检查；默认适中频率，每天最多 4 次自动模型判断、2 条自主消息，未回应后间隔从 4 小时逐步退避至 8/16/24 小时。夜间 23:00–08:00（北京时间）、正在输入、阅读聊天、DSH/后台任务或 CU 忙碌、锁定/安全桌面、离开设备 90 分钟时延后。读过主动消息也算回应兴趣，不要求打字。文件事件先合并，长期记忆正文的元数据变化、标签/短记忆变化与低频空闲检查共用预算；没有必要内容时不发消息。第一整天没有主动内容时允许一条不调用模型的轻量问候，后续同类兜底至少间隔三天。自主消息不抢焦点，首次系统提醒静音，持续未回应后只保留气泡/未读；外部 agent 连发保留全部内容但 30 分钟内只打扰一次。配置页新增主动开关、安静/适中/活跃频率、静默时段和暂停八小时。未新增子组件，patch +1；未远端发布。

主动激活 57/57、原生共享桌宠 16/16、客户端 123/123、聊天 21/21、陪伴/heartBeat 57/57、shortMemory/MCP 37/37、Agent API 268/268、供应商隔离 18/18、版本 12/12；最终源码/包/安装 81/81 一致，原有 19 条消息保持完整。七天无用户主动输入的模拟共 8 次模型检查、8 条消息、首次 1 条系统通知。长周期以模拟时间及确定性模型结果验证；实机验证设置、暂停/恢复和原生可用性，未把模拟结果冒称真实七天运行或实际费用。实际定时模型已复验通过：本次没有合适内容保持静默，预算只加一次，旧失败任务未重放。

[策略与验收证据](Newmark2DSH/archive/20261012-newmate-initiative/REPORT.md)。


## 2026-10-12 0.3.3 NewMate 打开链路与界面细节

实机闭环：用户已确认在其他应用前台时，双击桌宠可以正常恢复 dsh 并打开 NewMate 当前聊天（2026-10-12）。下文的待反馈措辞属于确认前记录。

0.3.3 已本地安装：桌宠打开聊天时先恢复并激活已验证的 dsh 主窗口，保留单实例启动兜底；新增双击松键判定与重复事件抑制，单击/拖动不会误打开。打开事件优先处理，恢复焦点时立即检查，缺少布局服务时保留重试；已在历史或设置页时切回当前聊天并聚焦输入框。侧栏头像降低亮度并以更克制的比例向右显示；NewMate 标题、欢迎文案、快捷按钮、历史行、输入框细节和设置页陪伴开关几何已完善。历史仍为按钮进入的只读记录，CU 仍独占闪边，NewMate 无独立托盘。未新增组件，patch +1，未远端发布。

原生点击处理 6/6、共享桌宠 15/15、客户端 123/123、聊天 21/21、陪伴/heartBeat 57/57、shortMemory/MCP 37/37、供应商隔离 18/18、版本 12/12；最终包 80/80 文件与源码和安装一致。已实机检查界面与历史/设置到聊天的导航。真实鼠标双击因无激活工具窗口不能被电脑控制工具直接定位，等待用户反馈；不把事件单测或显式 IPC 夹具声称为物理双击验证。

[本轮验收记录](Newmark2DSH/archive/20261012-newmate-polish/REPORT.md)。


## 2026-10-12 0.3.2 NewMate 页面与陪伴体验

已实现并本地安装 0.3.2：NewMate 提供常驻输入框、独立只读历史入口、新对话、设置和陪伴开关。历史不常驻，不允许编辑、重新激活、继续发送或重试历史任务；新对话关闭上一段记录，旧消息完整保留。侧栏共用桌宠图片，横向翻转朝向右侧，先放大 20% 后按反馈缩小 10%（最终为原尺寸 108%）。陪伴与 CU 共享一个桌宠，CU 单独决定闪边。NewMate 内核由 dsh Cordis 托管，原生辅助窗口只负责呈现并随宿主结束；无独立托盘，系统通知由现有 dsh 窗口承载。焦点不在 NewMate 聊天页时主动消息显示桌宠气泡，返回页面后收起。未新增子组件，patch +1，未远端发布。

专项通过：聊天 21/21、客户端 123/123、共享桌宠原生 15/15、陪伴/heartBeat 57/57、shortMemory/MCP 37/37、供应商隔离 18/18、Agent API 268/268、版本 12/12；最终源码/包/安装 80/80 字节一致。实机查看正常聊天、按钮进入历史与无输入框的只读阅读、右向图标、后台气泡和前台抑制。双击的原生事件单测与实际 IPC 导航通过；自动化工具不能直接定位无激活桌宠窗口，未声称完成真实鼠标双击。系统通知调用归属 dsh，不声称观察到 Windows 通知中心弹窗。旧总门禁的两个宿主/源码前提失败不归入本轮专项通过。

[本轮验收与证据](Newmark2DSH/archive/20261012-newmate-ui/REPORT.md)。


## 2026-10-12 0.3.1 供应商同名模型隔离

已修复并安装 0.3.1：Agent API 可用性与视觉能力以供应商和模型 ID 同时匹配，核心目录拒绝将外部供应商模型重标为自身；每次 run 固定原始供应商、模型与 reasoningEffort，后续切换不改变重试和后续轮次。记忆缓存仅复用模型无关的背景文本，不共享供应商能力或凭据。未新增组件，patch +1，未远端发布。

隔离专项 18/18、Agent API 268/268、客户端 123/123、陪伴 57/57、版本 12/12；已安装 80/80 文件与源码和 tarball 一致。真实同名 deepseek-flash 的两个供应商 profile 隔离，MCP 0.3.1 与 NewMate QA031_OK 回复通过，原准用模型已恢复。总门禁 195/197，帧循环源码断言及旧 CLI 宿主前提未通过，详见报告。[验收报告](Newmark2DSH/archive/20261012-provider-isolation/REPORT.md)。


## 2026-10-12 0.3.0 本地安装与实机验收

Windows DSH 已安装 0.3.0，80/80 包内文件与最终 tarball 和源码一致。实机验证 NewMate 侧栏/对话、DSH 与外部 MCP 调用、shortMemory 七天到期与灰显、两个独立开关、真实视觉识别，以及两次 heartBeat 全局重启：第一次自动投递后任务载荷移除，第二次不重复投递。实机修复冷启动入口缺失和 opencode-go 缺传输 sessionId，并补齐完整短记忆日期与输入框样式。准用模型恢复原 DeepSeek，桌宠倍率保持 60.1%。未发布远端。

[安装与实机证据](Newmark2DSH/archive/20261012-installed-030/REPORT.md)。下文的“源码候选/未安装”是先前阶段记录；当前状态以本节为准。旧 CLI 完整 ToolRuntime 导入门禁仍未闭环，实际宿主路径已另行验收。

## 2026-10-11 0.3.0 新组件实现（源码候选）

已接入 NewMate 陪伴内核与 heartBeat 重启投递，五子组件独立开关；Agent API 支持真实图像附件；MemoryLab 增加 shortMemory（默认七天）及“总览/详细/短期”。NewMate 在首轮推理前原生注入全部标签关系和最近十条短期记忆，并开放 DSH/MCP 共用接口；无文件删除工具，文件测量默认关闭、变动去重且低打扰。heartBeat 成功投递后移除可执行任务，保留无正文收据。

本轮为源码实现与本地候选打包，尚未发布或覆盖本地安装。[验收记录](Newmark2DSH/archive/20261011-newmate-heartbeat/REPORT.md)。[实现和接口](Newmark2DSH/docs/09-newmate-heartbeat-implementation.md) · [OpenDot 参考边界](Newmark2DSH/docs/10-opendot-reference.md)。下文的“仅设计”是先前预研记录，当前实现状态以本节与本次验收报告为准。

## 2026-10-11 Newmark2DSH newMate 陪伴内核预研

已完成 OpenAI Dots、xAI Grok Bot、Manus Cue 的公开机制调研，并设计基于 Newmark2DSH Agent API、MemoryLab 与 ComputerUse 稀疏测量的 newMate 陪伴内核。**仅设计，未实现或发布**；现有 NewMate 桌宠继续属于CU呈现层。[调研](Newmark2DSH/docs/07-newmate-companion-research.md) · [设计](Newmark2DSH/docs/08-newmate-kernel-design.md)。

## 2026-10-08 最终安装：0.2.31

NewMate 显示同步优化及 Linux X11/WSLg 支持已接入并发布。最终远端提交 c7b7165 / v0.2.31 经全新网络克隆拉回，Windows 和 WSL 分别重装同一 tarball；Windows DSH 已完全退出旧进程并重新启动，三个组件均由新宿主激活。65/65 发布文件一致，64 运行文件匹配源码；用户当前倍率 60.1% 保持不变。

0.2.31 另将窗口映射控制心跳与显示绘制分离，解决显示时钟停止时控制也停止的问题，避免 WM_TIMER 在高刷新绘制下饥饿。最终安装态：核心195/195、Windows原生专项102/102、CU边界34/34、方言45/45、隐藏路由54/54、Linux后端47/47与Qt15/15、真实模型33/33，以及配置slider门禁通过。实装桌宠约151绘制回调/秒，WSLg稳定预览约60交换回调/秒；不等同物理扫描帧率。测试映射、接管槽和辅助进程已清空。

npm索引当时仍返回404，当前明确安装远端拉回的tarball；不声称从注册表解析安装。首轮失败、后续修正、真实输入范围和完整文件树均见 [最终验收报告](Newmark2DSH/archive/20261008-release-031/REPORT.md)。



## 2026-10-08 进程迁移动画层级与纯黑桌面（0.2.29）

进程窗口推出/拉入动画读取实际呈现 HWND 的层级，真实窗口保持遮挡关系，虚拟来源跟随展开预览层并位于 NewMate 下方；动画不抢焦点、不强制收起预览。空桌面使用纯黑，移除正常状态工程提示，并修复零窗口枚举误报失败。核心 195/195、原生层级 8/8、GPU 15/15、窗口往返 17/17、空桌面逐像素 15/15。提交 45635d1 与 v0.2.29 已推送发布，经缓存对象加远端 fetch 核验后拉回打包重装，DSH 完全重启且界面显示 0.2.29；62/62 文件一致，安装后层级 8/8、空桌面 15/15、工具 25/25、CU 34/34，测试残留为零。详细状态见 Newmark2DSH/archive/20261008-transfer-visibility/REPORT.md 。用户倍率保持 45.9%。

实现位于 desktop-pet.cs/js、desktop-transfer.cs/js 和 win32.js；新增原生层级探针，GPU 门禁支持无应用空桌面。归档 before 保存修改前源码，layers/gpu/transfers 保存原生回执，empty-desktop 保留失败，empty-desktop-fixed 保存修复后的纯黑截图，core.log 为完整回归。

## 2026-10-08 真实桌面输入补测

0.2.28 已安装包补测确认：DSH 配置页真实点击/滚动正常，滑杆 65%→181.7% 后桌宠与持久化同步；推出窗口真实鼠标/键盘计数 0/0→1/1，双向往返保留 PID、启动身份与 HWND，真实源窗口恢复后仍接收键盘。测试进程已清理。用户随后手动调整并明确要求保留 **45.9%**。透明 NewMate 窗口不在 Sky 可选目标中，右键被目标校验拦截，因此桌宠拖动、菜单滑杆和点击展开/收起仍未记为真实输入通过。详见 `Newmark2DSH/archive/20261008-newmate-real-ui/REPORT.md`，其中保存 runner、原始动作回执、进程身份、输入计数、两张实机截图和清理记录。本轮仅增加验收记录，未修改产品包。

## 2026-10-08 NewMate 窗口推出/拉入（0.2.28，远端拉回重装）

已发布 `process_push` / `process_pull`，采用用户接受的交互映射保留原 PID、启动时间、HWND 和应用状态，配有 NewMate 弹性响应与 GPU 飞入飞出。全 DSH 在同一 Windows 用户下，真实/虚拟模式各一个接管槽；跨越操作同时保留两槽，身份绑定真实会话。已修复关闭竞态，导出应用保活、导入窗口恢复，并验证宿主及呈现层崩溃恢复。

最终版本 0.2.28（805d535b）已推送、从远端标签拉回打包重装，并完全重启 DSH。62 个已安装文件与远端一致，61 个运行文件与源码一致，用户大小仍为 65%。安装后：全工具 25/25、CU 34/34、真实模型 33/33、内核锁 8/8、双槽 16/16、身份 9/9、迁移 17/17、恢复 6/6、GPU 12/12。无测试映射、原生辅助进程或隐藏代理残留。npm 索引尚未同步，当前依赖指向远端拉回的 tarball。

前台真实鼠标复测尚未闭环：桌面自动化对 DSH 和呈现窗口均返回 `failed to activate captured window`；不将这一项计为通过。截图与原生消息路径验证分别有据。完整范围、失败修复和目录结构见 `Newmark2DSH/archive/20261007-cu-transfer/REPORT.md`（子项目中为 `archive/20261007-cu-transfer/REPORT.md`）。

## 2026-10-08 进程窗口映射约定

`process_push` / `process_pull` 保留原进程 PID、启动时间、状态和 HWND，通过可交互呈现窗口跨真实/隐藏桌面使用，不能宣称原生窗口线程迁移。显式选择单个顶层窗口；多窗口进程须指定 HWND，新增对话框另选。以回执中的呈现 HWND 继续操作。Windows 用户范围内真实/虚拟接管各一个，跨越时同时保留两个槽；DSH 调用身份不能由模型 owner_id 冒充。导出窗口保留其 Job Object，退出时只结束未导出的任务；拉入窗口在退出时恢复。宿主死亡和呈现层崩溃必须独立验收，不能以正常退出代替。

实现文件：`desktop-transfer.cs` 管理捕获、交互代理、Job 保活/清理、守护恢复和 GPU 动画；`desktop-transfer.js` 管理有身份校验的原生状态协议；`hidden-agent.js` 监测宿主退出；`takeover-lock.cs/js` 实现内核双槽；`lib/cu-caller.js` 绑定真实会话。`verify-desktop-transfer.mjs` 验证往返和正常结束，`verify-desktop-transfer-recovery.mjs` 验证强制结束恢复。归档 `archive/20261007-cu-transfer/` 包含 before 源码快照、evidence 门禁日志、integration-* 原生回执、recovery-* 异常恢复回执、native 编译试验、PLAN/STATUS/REPORT 工作记录；失败试验保留供复查。该段记录 0.2.27 候选阶段；最终 0.2.28 发布与重装结果见上方。

## 2026-10-08 桌面迁移与全 DSH 接管互斥（开发中，未发布）

真实/虚拟模式各一个跨 DSH 进程的 Windows 用户级接管槽已在本地实现；调用身份绑定 DSH 会话，停止一个模式保留另一个模式。该阶段最初安装 0.2.26；最终 0.2.28 的发布与验收见上方。实现背景：Win32 不支持保留现有窗口直接迁移所属线程，已用独立原生夹具复现 error 170，用户已于 2026-10-08 接受保留进程的交互映射语义，现已实现双向映射、NewMate 飞入飞出、退出保活与恢复，已执行完整回归，前台自动化限制见本轮报告。 [工作状态](Newmark2DSH/archive/20261007-cu-transfer/STATUS.md)。

## 2026-10-07 NewMate 分级配置与 GPU 动画（0.2.26，已发布并重装）

配置板块按「智能体 / 准用模型」和「桌面助手 / NewMate」分级，使用响应式卡片、说明及保存提示。桌宠复用绘制缓冲，虚拟桌面预览以 GPU 变换展开/收起并复用就绪渲染器。本机隔离动画基准：桌宠约 35→55 FPS、展开 4→56 FPS、收起 30→60 FPS；不代表源桌面采集帧率或恒定硬件刷新率。

0.2.26 已推送（ab40ba6d / v0.2.26）并发布 npm，经远端拉回、注册表精确版本重装、完整重启 DSH。57 个发布文件与远端一致、56 个运行文件与源码一致。插件全工具门禁 25/25、ComputerUse 34/34、真实模型 33/33、原生 GPU 12/12、偏好启动 5/5；范围与初次夹具失败见报告。实际配置滑杆 65→65.1→65 与桌宠同步，用户大小保留 65%。

[验收与发布记录](Newmark2DSH/archive/20261007-newmate-smooth-release/REPORT.md)。

## 2026-10-07 NewMate 配置与 DSH 主题菜单（0.2.25，本地已安装）

插件页面分为「组件」与「配置」两大板块，准用模型归入配置。配置页和 NewMate 右键菜单共用 30%–300% 连续滑杆（0.1 个百分点精度）、实时双向同步并记住最后大小。默认倍率仍为 100%，本体基准宽度从 160 缩至 120（原尺寸的 75%）；旧版保存值按版本换算以保留实际大小。

右键菜单渲染 DSH 实际 Menu DOM 与有序 CSS，支持主题与插件覆盖；按 WebView 实际 DPI 定尺寸，并在桌宠旁展开，修复 200% 缩放下菜单裁切。候选包已重新安装并完整重启 DSH；本次 0.2.25 尚未发布至 npm，公开版本仍为 0.2.24。

[验收与安装记录](Newmark2DSH/archive/20261007-newmate-dsh-menu-css/REPORT.md)。

## 2026-10-07 正式发布、拉回重装与完整重启

0.2.24 已推送至公开仓库（515482f / v0.2.24），经 GitHub OIDC 发布到 npm，再从注册表下载并以精确版本重装。46 个发布文件与发布仓一致，其中 45 个运行文件与此前实机验收版本逐字节相同。DSH 已完整退出并重启，旧主进程及宿主退出、新宿主重新加载；当前 profile 依赖为注册表 0.2.24，不再引用本地候选 tgz。 [发布记录](Newmark2DSH/archive/20261007-newmate-release-0.2.24/REPORT.md)。

## 2026-10-07 Newmark2DSH 虚拟桌面桌宠

吉祥物正式名称为 **NewMate**；桌宠窗口、右键菜单与预览提示统一使用此名称。

本机 DSH 已接入 0.2.24，并实际调用 ComputerUse 验证 NewMate 启动、运行与停止清理；[报告与动图](Newmark2DSH/archive/20261007-pet-motion/REPORT.md)保留源码、候选包和安装字节对照。

Newmark2DSH 0.2.24 将 Windows ComputerUse 虚拟模式提示改为用户提供图片的置顶可拖动桌宠：沿本体轮廓的黑白跑马灯、点击同屏全屏只读预览、展开时取消描边，Esc 或再次点击收起。桌宠出场、按压与退出有弹性伸缩；预览平滑放大/缩小，右键可调 50%–200% 大小并持久记住最后倍率。实现、使用边界与实机验收见 [插件说明](Newmark2DSH/README.md) 和 [本轮记录](Newmark2DSH/archive/20261007-pet-motion/REPORT.md)。正式发布与拉回重装已完成。

## 2026-10-05 向上游提交 DSH 静默终止 issue #1312

同日的静默终止排查已整理为公开 issue：**[anywhere-labs/dsh-desktop#1312](https://github.com/anywhere-labs/dsh-desktop/issues/1312)**（OPEN，作者 `positer`，13,989 字节正文）。

目标仓库是**按证据选出来的**，不是按名字猜的：缺陷代码属于 `deepseek-ai/deepseek-harness` 的 `@deepseek-ai/dsh-llm-deepseek` / `dsh-agent-loop`，但那个仓库 `has_issues: false`（只有 Discussions，243k star）；DSH Desktop 的产品仓库 `anywhere-labs/dsh-desktop` issues 开启、有 bug_report.yml 表单，且自带 `patches/<pkg>@<version>.patch` 机制（已有 60+ 个运行时包补丁，**尚无** `dsh-llm-deepseek` / `dsh-agent-loop` 的补丁），修复在那里可落地。正文里因此点明了"修复位置在上游核心包"。

提交前用 `gh issue list --search` 查重（`EMPTY_RESPONSE`、`reasoning 空回答`、`思考块 无输出 完成`、`静默`），并在正文里点名三条最接近但仍不同的 issue（#170 断流、#707 标题生成、#635 `reasoning_content` 回传）。正文按该仓库 issue 表单的字段逐项填写，含英文摘要、两处代码原文、量化证据、**照实标注不单调的上下文分档表**、排除第三方插件的四条证据与一个**未解释的巧合**、以及 `session.v4.jsonl.zstd` 多 zstd 帧这个复现坑。

创建后做了回读校验（`gh issue view --json`，10 项断言全过，正文与提交文件逐字节一致）。**一处未达成**：标签没打上 —— `gh issue edit --add-label` 报 `positer does not have the correct permissions to execute AddLabelsToLabelable`，即作者不是该仓库协作者，**这是权限边界而非提交失败**。本轮没有修改 DSH 安装目录或任何插件；正文与归档都不含 API key/token，路径用户名已替换为 `<user>`。

## 2026-10-05 DSH 会话静默终止定位：模型只回思考块，外壳按「已完成」收尾

本机 DSH Desktop 2.0.17 的 `deepseek-account / deepseek-flash` 轮次偶尔在没有任何回答的情况下结束，界面只留一行「已完成，用时 N 秒」。已在会话存储里定位到机制：**不是崩溃、不是中断、也不是 Newmark2DSH 插件故障**。

机制（两处代码相加）：Provider 正常返回 `finish_reason = "stop"`，但这条助手消息只有一个 `reasoning` 块，没有 `text`、没有 `tool-call`。`dsh-llm-deepseek` 的退化补全守卫写的是 `blocks.size === 0`，只含思考块的消息块数为 1，于是被当成正常回答；`dsh-agent-loop` 又因为没有工具调用而把轮次判为 `completed`。用户看到的「已完成」是这两步的产物。

实测（48 个会话 / 9,653 条助手消息，脚本与原始输出在 `archive/20261005-144403-dsh-silent-turn-stop/`）：

- 这种"只回思考块"的补全全机共 **16 次**，**全部**属于 `session-56aad17e-…`（221 轮、2,583 条助手消息、峰值上下文 679,088 token）；
- 上下文 **> 450,000 token** 的 1,480 条助手消息里有 16 条（1.1%）；**≤ 450,000 token 的 8,173 条里一条都没有**；
- 16 次全部出现在 2026-10-02 13:25 之后，即该会话上下文首次越过 45 万之后；10-05 一天就 8 次（用户截图里的"4分3秒 / 22秒 / 50秒"分别是 turn 219/220/221，逐条对应见归档）。

对两个猜想的裁定：**「Newmark2DSH 插件炸了」不成立** —— 这 16 次里插件没有任何失败记录，出问题的那条消息的 `source` 是 provider 的模型本身、流以 `finish{kind:"stop"}` 收尾，插件在所有 48 个会话里都装着而静默只出现在 1 个，同一插件版本下正常轮次与静默轮次交替出现。**「单对话轮次过多」方向对、机制错** —— 不是轮次计数，是上下文深度；但上下文深度只是**必要不充分**条件（该会话 45 万以上 1,345 条消息里只有 16 条如此，另有两个峰值 50 万的会话一条都没有）。

给出的处置：**这个会话不要再续**（新开对话即回到零风险区间）；把 `deepseek-account/deepseek-flash` 的压缩阈值从默认 `thresholdRatio = 0.8`（在 1,000,000 token 窗口上等于约 67.9 万才压缩）调低到 35 万一带（**未验证**：尚未确认 profile patch 层能否改到 preset 内部 `compaction-basic` 的 config）；治本要上游把"只有思考块"也判为 `EMPTY_RESPONSE` 从而可重试。本轮**没有**修改任何 DSH 或插件文件。

顺带查实但非本次原因：`workspace-changes` 每次改文件后跑 `git add --all`，在本仓库上 09-30 起共 7 次 30 秒超时；以及 10-05 两次 `[scope] Error: tool "subagent" is already registered in this scope`（只记录，未定位）。**同一插件的副作用还有一项实测**：提交 issue 时读回 `git status --porcelain` 得到 **4,853 条**记录，暂存区里躺着 `.tmp-*` 临时文件与 `DESKTOP/scripts/*.cjs` 等大批路径（最后一次提交是 `419428f`）—— 与该插件执行的 `git add --all` 一致，但本轮**没有**证明索引状态就是它写的，也**没有**清理它：清理不是本次任务，误清会丢别人的暂存工作。

## 2026-09-30 退役 CU-Lab 项目存储清除

`newmark-cu-lab/` 已从工作树整体删除：**53,915,960,864 bytes / 229,297 文件 / 51,418.3 MiB（50.2 GiB）**。该目录未被 git 跟踪（`git ls-files newmark-cu-lab` = 0 行，`git status` 原为 `?? newmark-cu-lab/`），内部没有嵌套仓库，也无外部构建或测试入口引用它，因此删除不触及任何 git 对象或历史，也不需要改写历史。

清除前先把 lab **源码**冻结进 `archive/20260930-001844-culab-purge/source-snapshot/`：`nculab/`、`scripts/`、`tests/`、`configs/`、`contracts/`、`policies/`、`docs/` 与 11 个根文档/配置，共 **151 个文件 / 1.25 MiB**，逐文件 SHA-256 清单在 `evidence/source-snapshot-manifest.sha256`。源侧排除规则之后的文件列表与快照列表做了双向差集，两个方向都为空。**不保留**的是数据与运行环境：`var/`（41,223.9 MiB，其中 datasets 17,348.1、open-datasets 14,407.1、runs 6,253.5、generated 2,788.6）、三个 venv（6,273.5 MiB）与 lab 内 `archive/`（3,917.8 MiB）。

数据采集侧边界：Newmark 生产代码在本轮之前就已经没有 culab 采集代码 —— App 侧的帧存储与整帧推理节流闸门（`frameStore.ts`、`CuCadenceGate`）连同整条端侧模型路线已于 2026-09-26 退役，`DESKTOP/src/core/computerUse/` 目录已不存在。本轮实测复核：`DESKTOP/src` 只剩 `tests/computerUseSparseOnlyVerify.ts` 里那条“源码不得出现 CULab/NMEP/ONNX”的反耦合断言（保留），`DESKTOP/scripts`、`TUI`、`WEB`、`android` 命中为 0。lab 自己的采集管线（`nculab/capture/`、`nculab/scenarios/`、`nculab/dataset/`）随目录离开工作树，只以源码快照形式留在本地归档。

归档区中 2026-09-21/22/26 的 culab 冷记录（约 14.7 MiB，含 6.4 MiB `.nmep` 草稿候选与 0.34 MiB 退役 legacy-source）按本轮范围未删除，它们是过去结论的证据。清理后校验：`Test-Path newmark-cu-lab` = False，`git ls-files newmark-cu-lab` = 0，C: 可用空间 143.76 GB。操作记录、清理前清单、快照哈希与清理后校验见 `archive/20260930-001844-culab-purge/`（本机归档，不进入公开仓库）。

## 2026-09-29 DSH Dev 模式（PTC 基线 + 项目协议）

本机 DSH Desktop 配置新增 agent preset `dev`（显示名 Dev，roster 顺序 2.5），由工作区内的 `@local/dsh-dev-preset` bundle 声明并已安装启用：`plugin_manager` 的 `preset-dev` 行 `enabled=true` / `fiberPhase=active`。

Dev 模式 = PTC 模式 + 项目协议约束。工具面与 `ptc` 完全一致（`run_code` 传输、plan mode、subagent/Agent Teams 委派、compaction、goal、todo、web、present 与原生 fs/shell 工具）；差异只在人设：Dev 会话在动手前必须读取项目根的 `README.md`、`OVERVIEW.md`、`taste.md` 与最新 `archive/` 记录，完成后写回三份文档并按 `archive/<YYYYMMDD-HHMMSS>-<slug>/` 归档 before/after 与结论证据，且文档与代码冲突时以代码为准、归档只增不改。

用法：新建会话时在模式选择器里选 **Dev**，或在“插件”里确认 `@local/dsh-dev-preset` 已启用。bundle 源码与逐条约束在 `_local/dsh-dev-preset/`（`_local/` 为本地目录，不随仓库发布）。

已验证：bundle YAML 解析通过（20 个 plugin 行、ptc 工具面、persona 前缀 3,237 字符）；安装后 profile `node_modules/@local/dsh-dev-preset` 与源码 SHA-256 完全一致，`package.json` 与 `cordis.patch.yml` 同时固化进本机归档。未验证：没有在 Dev 会话里跑过一轮真实提示，persona 渲染路径与 `run_code` 通路仍待首个 Dev 会话确认；本次修改的是本机 DSH 配置，不涉及 Newmark 应用代码、构建产物或发布。

桌面端归档现在在等待共享对话状态锁时让出事件循环；中断活动 Flow 与删除归档条目也走异步锁等待。归档只复制目标对话，不再为每次点击克隆整个工作区历史；长转录导出按批次让出执行机会，并保留跨进程分片中的原始消息、工作记录和可恢复清单。锁文件时间较旧但记录的进程仍存活时不会被抢占；归档可以清理已退出进程遗留的锁。

压力验证覆盖 48 个同时归档请求、跨进程分片归档、活动 Build/Flow 取消、老时间戳但 owner 仍存活的锁、死进程遗留锁恢复，以及 1,000 条约 8 MiB 的对话。完整桌面发布门禁通过。归档回归中 Flow 中断事件循环最大延迟为 25 ms，锁竞争为 11 ms，1,000 条转录导出约 196 ms、事件循环最大延迟为 53 ms。0.6.9 MSI 与便携 ZIP 已生成并通过包内 CLI、SSH/PTTY、上下文压缩和参数边界 smoke。

Windows MSI 已在本机 UAC 提升覆盖安装 0.6.7，并实测 Program Files 安装版 GUI：13/13 项通过；活动归档 4,433 ms 完成、取消 mock Provider 流、写入恢复清单、删除活动状态与 shard，且没有被迟到写入复活；idle 归档保持快速路径。安装前后 `.Newmark` 全量文件摘要一致（21,708 个文件、357,340,682 bytes）。Program Files EXE 版本为 `0.6.9.0`，安装版 `app.asar` 与候选哈希一致。Android 仅同步版本标记到 `0.6.9` / `versionCode 609`，业务代码未改。MSI 未签名，本地构建和安装没有发布到 GitHub/npm；归档使用本机 loopback mock Provider，不代表真实 Provider 验收。哈希与日志见本地归档（未纳入公开仓库）。

### Computer Use 实机修复与 0.6.9 重装验证

修复本机实测暴露的四类可靠性问题：Windows `mouse_event` 的 `dwExtraInfo` 使用正确的 `UIntPtr`；在每线程 DPI 感知上下文中设置物理像素坐标，覆盖 200% 缩放；键盘支持 `ctrl+l`、`alt+f4`、`enter` 等常见写法并安全输入 URL 标点；应用内操作先验证目标窗口已激活，避免把输入发给错误窗口。UIA 建议观察 lane 超时后采用 500 ms 至 4 s 退避并可恢复，不再冷却 60 秒。

Windows 原生隔离 GUI 回归覆盖 14 个场景：7 次受控鼠标/滚轮输入、常见快捷键与标点输入、UIA 超时恢复及 20 次快速 `app_observe`；`npm run test:computer-use-runtime`、Windows MSI/便携包门禁均通过。重建 MSI SHA-256 为 `3AB12074BE17D9324E5DD95427ECEE0373318A3382EAA527F1F904090275C415`，ZIP SHA-256 为 `3F155C42E46065CEA7A149594F68C7DD19E76943D4A4F5AFE2072632FAB2E6F3`。候选 MSI 已重装到 `C:\Program Files\Newmark Agent`：注册版本及 EXE 为 `0.6.9.0`，292 个文件及 `app.asar` 与候选完全匹配（ASAR SHA-256 `B6D9592258A2CD542350594246D585F2F5274666F7D785AB3138366D35633963`）；21,729 个既有 `.Newmark` 文件前后比对无差异。安装版 GUI 无模型黑盒检查通过。

隔离的已安装程序真模型场景使用 DeepSeek `deepseek-flash`，模型实际调用了 `computer_use.observe`，读取合成测试窗口中的视觉标签并完成稀疏变化唤醒；17/17 检查通过、Provider 请求 3 次且无错误。该场景只允许观察，鼠标及键盘交互由受控 Windows 原生 fixture 回归验证。MSI 未签名，候选只在本机验证，未发布到 GitHub/npm；包哈希、安装清单、模型响应和截图见 `archive/2026-09-29-pc-computer-use-reliability-0.6.9.md` 及其证据目录。

### CU 真实鼠标、虚拟窗口与拖动

Agent 可在 `computer_use.takeover_start` 指定 `mouse_mode: "real" | "virtual"`；省略时保持现有真实鼠标行为，模式由 CU 会话锁保存，到 `takeover_stop`、关闭开关或会话租约过期时恢复默认。真实模式沿用系统鼠标，以 50 ms 的轻度随机平滑曲线路径移动；点击和拖动共用至少 350 ms 的动作间隔。拖动先移动到起点并按住选定按键，再沿 50 ms 曲线移动至终点，最后释放按键；异常路径也会释放按键。

`drag` 的真实模式坐标是桌面像素，虚拟模式坐标相对于当前绑定应用；`app_drag` 在两种模式下都使用所选应用窗口坐标。虚拟模式通过 `app_*` 绑定应用窗口并投递按下、按住移动与释放的窗口消息，不移动系统鼠标、不调用前台激活；`app_observe` 通过隔离、限时的 `PrintWindow` worker 读取被遮挡但未最小化窗口的 presentation。模式不会静默退回真实输入。消息回执只表示已排入目标应用队列，不能证明应用完成动作。最小化窗口、非客户区、使用 Raw Input/独占输入的应用及更高完整性级别进程可能不支持。采集 worker 超时会保护 Newmark UI，但同步 `PrintWindow` 请求仍可能令目标应用在渲染响应期间变慢。

验证：`npm run test:computer-use-runtime` 通过。Windows 原生 1280×720 fixture 的 19 个场景通过，其中验证了真实桌面 `drag`、真实 `app_drag`，以及遮挡窗口上的虚拟 `app_drag` 和虚拟 `drag`；后台拖放后的测试控件确认按下、移动、释放及目标命中，前台 HWND 与实体光标保持不变。这是源码构建与隔离 fixture 的实测结果；本次没有重打包或重装 MSI。

## dev-0.6.8 Computer Use：Windows-MCP 核心交互能力原生化（开发预发行版）

本版本把 Windows-MCP 的快速截图、完整 UI Automation 观察和 `WaitFor` 等交互模式融入 Newmark ComputerUse。`observe` / `app_observe` 新增 `include_ui_tree=false` 快速截图路径；默认完整观察仍提供语义控件与 `target_id`。新增只读 `wait_for`，可在指定或最近观察的窗口内等待文本、语义目标或窗口出现，默认轮询 5 秒、上限 30 秒；首次启动 UIA helper 时，单次在途调用可能带来有界尾延迟。

实现沿用 Newmark 持久化 PowerShell 与 Windows UI Automation 通道、现有一次性视觉输入和 ComputerUse 会话授权，不增加外部 Windows-MCP 服务或 Python 运行依赖。UIA 查询限定到前台或明确选择的窗口；缺少有效句柄或目标属于 Newmark 宿主进程时跳过树采集。截图专用观察会清空旧语义目标，防止后续动作使用过期 ID。

0.6.8 的 ComputerUse 与文件写入安全门禁已发布为开发预发行版。Windows x64 MSI/便携 ZIP、Linux x64 AppImage/deb/便携 ZIP、Android APK 及 SHA-256 清单已通过 [GitHub Release](https://github.com/positer/Newmark-Agent/releases/tag/dev-0.6.8) 发布；CLI/TUI 包 `newmark-agent@0.6.8` 已单独发布到 npm。干净依赖安装后的 `test:full-release`、224 项写入观察压力断言、隔离 Electron 的 DeepSeek CU 真模型场景均通过，npm audit 为 0 项漏洞。本次没有执行 Program Files 安装/升级验收或 Android 实体设备验收；Windows 安装包未做 Authenticode 签名，Android APK 使用开发签名，不是 Google Play 发布包。

## 2026-09-28 文件变更前读取门禁（0.6.8 开发）

Newmark 的专用文件工具现在要求先用 **read** 读取精确目标。覆盖和删除必须完整读取；**edit** 必须读取包含旧文本的对应行，并要求旧文本在文件中唯一。大文件可通过起止行分段读取，只有完整行覆盖才授权整文件覆盖或删除。读取回执绑定工作区、会话、执行者与 Build run，五分钟过期，目标内容或文件身份变化后拒绝变更。新建文件先记录精确路径不存在，创建时使用排他模式；成功变更会消费回执。

此门禁覆盖 **write、edit、delete_file** 和写入本地目标的 **web_catch**。任意 Shell/终端命令、浏览器/CDP、ComputerUse、Flow、Memory Lab、技能下载及其他结构化状态变更仍由各自入口处理，本节不表示这些通道已闭合。

完整门禁运行 `npm run test:full-release`。写入压力测试覆盖 32 个并发 `ToolExecutor` 实例，并用 32 个异步门禁回调验证进程内同路径互斥；真实 CU 模型场景单独运行 `npm run test:computer-use-real-model -- --provider DeepSeek`，使用隔离 Electron 与合成视觉标记，并强制只读观察动作，不纳入无凭据的常规全量套件。

`archive/` 仅用于本机保存操作报告与证据，已由 `.gitignore` 排除，不随公开源码仓库发布。

## 2026-09-28 Auto 决策倾向与反馈历史退役

Auto 模型切换倾向现为“保守 / 均衡 / 激进”三档定性引导；每次切换仍由当前符合条件的对话模型根据任务与候选事实作出判断。资格过滤、用户明确的部署选择与硬成本约束继续生效。旧 Auto 点赞/点踩、评分持久化与历史清理入口已移除；过去遗留的本地文件不再读写或自动删除。0.6.7.0 MSI 已安装并核对：292 个文件、Program Files EXE/ASAR 哈希、注册信息和 CLI 版本均匹配，既有 `.Newmark` 文件清单无变化。本次安装后未启动 GUI；构建、针对性验证、截图与安装边界见本地归档（未纳入公开仓库）。

## 2026-09-28 PC GUI 视觉、动效与全场景验收

本轮将桌面 GUI 外壳交由 Claude Code 使用 claude-opus-5-5 自主打磨，重点是视觉协调、键盘焦点、减少动态效果偏好及渲染质感。两个 Claude 会话均自行因网关/API 错误退出（先 503 并发错误，后 403 预扣额度不足）；没有中断 Claude。保留的候选更改只在 `DESKTOP/src/ui/index.html` 的 `<style>` 区域。与本轮交接快照比较，换行符归一化后 `style` 外全文相同；renderer/preload API、IPC、HTTP/provider 协议、持久化和功能逻辑未改。

最终源码构建成功。隔离 Electron + loopback fixture 的全场景验收记录 48 个状态截图、133 项交互、91 段动效采样和 64 项检查；失败、软失败、renderer error、console error 均为 0。交错四轮 CSS A/B 的 RAF callback 均值是候选 60.08、基线 60.47 次/秒，证明不了整体帧率提升；输入绘制 p95 与 RAF 间隔 p95 有回退，侧栏开合和历史分页 p95 小幅改善。RAF callback 不是屏幕实际呈现帧率，结果不代表达到 165 Hz。完整数据、所有截图、Claude 错误、构建和性能限制见本地归档（未纳入公开仓库）。

## 2026-09-27 PC GUI 帧性能优化与本机安装

长历史恢复与分页显示不再给每条历史消息分配入场动画或持久合成层；新到消息仍保留轻量二维位移动画。0.6.7.0 unpack 在 1200 条历史、165 Hz PC 桌面下连续运行约 5 分钟，375 项检查通过、renderer/provider/runtime 错误为 0，长历史、活动完成和冷启动截图均无明显显示异常。与同负载 0.6.6.0 unpack 基线相比，renderer RAF callback cadence 从 65.31 提升到 75.58 次/秒；历史分页 p95 从 791.9 降到 663.4 ms，可信输入至绘制 p95 从 151.8 降到 51.8 ms。RAF callback 不是屏幕实际呈现帧率；本次仍未达到 165 Hz 流畅目标，也不是隔离单条 CSS 修改的多轮因果实验。该报告记录的旧 0.6.7.0 构建当时安装在 Program Files 并完成 GUI 启动验收；它已于 2026-09-28 被 Auto 倾向更新 MSI 替换。当前安装版字节见本节上方归档；本次新安装未重复启动 GUI。本地归档（未纳入公开仓库）。

## 2026-09-27 用户级 PC GUI 性能压力测试

在当前 Program Files 安装版与最新 0.6.6.0 unpack 候选上，以同一 1200 条长历史、loopback provider 和 165 Hz PC GUI 流程实测。安装版在 6 个循环后未通过历史分页节点保留检查；最新 unpack 版完成 310 秒、336/336 检查及冷重启恢复，但 RAF callback p95 为 46.3 ms、长任务 p95 为 168 ms，仍未达到流畅目标。两个 0.6.6.0 包的 `app.asar` 哈希不同；unpack 结果不代表已安装版。帧回调不等同屏幕实际呈现率。本地归档（未纳入公开仓库）。

## 2026-09-26 JEV 仅由当前对话模型的严格 JSON 决策

Auto 路由的 JEV 判断直接调用当前符合条件的对话模型及其 Provider。首次 Auto 路由优先使用符合资格的默认模型；已有有效部署时沿用该部署，否则从符合资格的候选中选取。JEV 只能在已通过路由守卫的候选中返回主部署与最多两个备选。

请求使用 Provider 原生的严格 JSON Schema，固定返回部署标识、理由码、置信度和 schema 版本；本地还会复核字段、类型、数量和边界，随后继续经过 `RouteDecisionValidator`。Provider 必须原生关闭思考。若 Provider/模型不支持关闭思考或严格 schema、输出不合约或请求超时，本次 Auto 路由失败关闭，不选择备用模型。JEV 默认硬超时为 3 秒。

GUI、TUI、CLI 只编辑启用状态和超时，不再配置独立 JEV runtime、模型标识、模型产物路径或回退选路。升级时会清除旧槽位和回退字段。当前行为、协议边界与验证记录见 本地归档（未纳入公开仓库）。

## 2026-09-26 CU 迁移为稀疏唤醒 + 远端视觉

桌面端已彻底停用 CULab/NES-T/NMEP/ONNX 端侧推理接口与依赖。`computer_use observe` 先用最多 5 Hz 的 32×18 灰度摘要等待变化或有界超时，再采集新鲜的完整截图和 UIA；截图交给当前对话配置的视觉 Provider。稀疏摘要只负责唤醒，不重构图像，也不等于严格压缩感知。完整截图仍会产生采集、传输和远端推理成本。

本轮代码、隔离 unpack 包、真实 DeepSeek 与 APInebula CU 闭环结果和限制见 本地归档（未纳入公开仓库）。`newmark-cu-lab/` 作为独立历史训练研究目录保留，不再与桌面 App 共用 schema、模型 loader 或运行时接口。（**已被 2026-09-30 的存储清除取代**：该目录已整体删除，见上方同名小节。）

## 2026-09-26 Android 模拟器高压、互联与本地对话复测

Android 15 x86_64 模拟器上的流式、队列、取消、重启恢复、远端目标绑定和 UI 压力功能门禁通过，未见崩溃或 ANR。UI 流畅度未通过：60 轮队列动画 jank 52.94% / p90 48 ms；混合高压 jank 79.25% / p90 150 ms。测试用隔离 stress/benchmark 包及 loopback fixtures，未覆盖物理手机、生产网络或真实 provider。完整环境、帧率口径、Astra 建议和限制见本地归档（未纳入公开仓库）。

## 2026-09-26 CU 稀疏变化唤醒接入

`computer_use observe` 可选使用 `sparse_wait_ms`（默认 0、最大 5000 ms）：独立 PowerShell lane 每 200 ms 至多采样一次 32×18 灰度摘要，不需要端侧视觉模型。每次等待之后都会重新获取完整截图和 UIA 树。它是低分辨率变化唤醒，不是严格压缩感知；超时不代表屏幕无变化，微小/短暂/色相变化仍可能漏过，完整桌面读取成本仍在。

0.6.6 v6 精确 unpack 候选包通过包内校验、CU 稀疏 GUI、双运行对话目标绑定，以及 120 秒 / 130 项 GUI soak。冷/热 sparse 实测分别为 4.082 秒 / 12 个样本和 486 毫秒 / 3 个样本；双流并发切换 10 次后，两条 completed run 均在关闭前落盘并通过冷启动恢复。1200 条长历史下，可信输入事件到绘制 p95 为 34.5 ms，对话切换 p95 为 1.095 s、历史分页 p95 为 1.663 s；长对话导航仍有明显等待。完整哈希、测试报告与 MSI/安装边界见 本地归档（未纳入公开仓库）。

截图语义仍由当前对话配置的视觉模型处理。本轮用隔离 loopback provider 验证真实 Electron GUI 与图像输入，没有验证外部 provider，也未接入专用远端快速模型路由；这些测试不能证明减少了端侧整帧采集或整机负载。候选 unpack 不是已安装的生产版本，MSI 没有生成或安装。

## 2026-09-26 CU 压缩感知与远端视觉可行性

理论与代码路径核查见本地归档（未纳入公开仓库）。结论：严格压缩感知要有稀疏表示、合格测量算子和接收端重构器；当前多模态模型通道只接收普通图像，本项目没有配套的远端 CS 重构服务。生产 `computer_use` 已接入可选稀疏变化唤醒；完整截图仍交给当前对话的视觉模型，未绑定专用远端快速模型。候选包和生产路径验证见上节及本地归档（未纳入公开仓库）。

## 2026-09-24 CU 权重与桌面 UI 稳定性复测

复测记录与原始证据见 本地归档（未纳入公开仓库）。复测暴露出发现层会优先选中检测/追踪门禁失败的旧 `INTEGRATION_CANDIDATE`；A2 QDQ 是 32 维描述子，而 App 当前使用 16 维 ABI。修复记录见 本地归档（未纳入公开仓库）。

加载器现要求模型声明 16 维输入/输出描述子；`INTEGRATION_CANDIDATE` 和 `ACCEPTED_FOR_RELEASE` 必须同时带 `detectorPass=true`、`trackingPass=true`。发现排序会跳过 App ABI 不兼容或晋级门禁失败的模型，并保留来源优先级。工作状态增量更新改用被动滚动监听维护的贴底标记，避免 DOM 修改前同步读取 `scrollHeight`。原 GUI 压测峰值仍为 122/224/129 ms；修改后的同口径复测尚未运行，所以不据此宣称 100 ms 门禁已通过。

Newmark 当前模型 session 固定使用 ONNX Runtime CPU：旧模型本机 p50/p95 3,218/3,304 ms，最新 A2 383/388 ms。CU-Lab RyzenAI NPU 的 32 ms p95 是另一执行 provider 的结果。当前 `computer_use` 生产工具仍未调用该模型模块，这些数字不是整机有/无权重 A/B。

**评测口径更正**：下方 2026-09-23 的识别报告调用了 App 自有 loader/provider/decoder/registry 模块，但当前 computer_use 生产工具尚未调用该模型模块。因此那组数字不是有权重与无权重的整机生产路径 A/B。

## 2026-09-23 外部复核落地：撤回三条自家结论 + 采集语义门禁

外部复核包（本地归档（未纳入公开仓库））
对本项目上一轮的批评全部成立，本轮逐条更正并落地第一轮修复。

**被推翻/更正**：① "91.9% 找到目标、30.4% 是定位上限"**撤回**——在 GT 框内取 argmax 等于用真值找信号，
而 recall@0.2=0.3369、@0.1=0.528 都高于 0.304，它从来不是上界；② parity 的 0.327 属 **interactability**，
不是 objectness（后者 0.103410）；③ 真正为 0 的是**稳定身份率**（INT8 12 / fp32 23 次 continuation），
共享身份率应为 **N/A**；④ fp32 图 25.179 MiB 是**超出** 25 MiB 首选门禁约 183 KiB。

**本轮修复（代码）**：`windows_ui.py` 的 `globalShift` 改为**实测**（并标注空间与基准），新增
`_verify_episode()` 场景语义门禁——`moveControl` 要求框真的动、`hide/show` 要求 id 真的离开/回到可见集合、
`hover` 要求 ROI 像素变化、`resize`/`page`/`overlay` 同理，否则 episode 记 `failed` 并给出原因；
`builder.py` 把 failed episode **隔离**出库并写入 `manifest.quarantine`；审计器升级为文件哈希 → RGB 哈希 →
实体框 → **控件 ROI** 四级。

**实跑结果**：12 episode 真实采集 **8 个 failed**（`moveControl_no_effect` 3、`window_move_only_no_content_motion` 2、
`hover_no_pixel_change` 2、`hide_not_observed` 1），入库只剩 4 clip / 48 帧，比例门禁如实报 false。
训练语料按目标级审计为 **432/700 clip 无目标级证据**、全局唯一帧 **3,160/8,400**；遥测里 backbone 梯度
step 1/3/5/9/17 = NaN、step 4462 = +Inf。

**交接包 v2**：本地归档（未纳入公开仓库）
（0.82 MiB / 70 文件，SHA-256 全通过），含外部复核原文、`WHAT-CHANGED-IN-V2.md` 逐条更正说明与全部新证据。
边界：采集**能力**本身未修、未重采、未重训；外部清单的任务 1/3/4/5/6 未执行。


## 2026-09-23 App 与 CU-Lab 权重解离：没有权重也能跑原本的 CU 通道

Computer Use 通道不再依赖 CU-Lab 权重，也不依赖 CU-Lab 目录存在：

- **App 自有权重点发现**（`DESKTOP/src/core/computerUse/model/artifactDiscovery.ts`）：
  `NEWMARK_CU_NMEP` → `~/.Newmark/models/cu`（用户级安装位）→ `<project>/models/cu` →
  **仅当显式设置 `NEWMARK_CU_LAB_ROOT` 时**才读 lab 的 `var/candidates`。找不到就是"没有权重"这一
  正常状态，不是异常；promoted 阶段优先于更新的未晋级候选。
- **无权重时的行为**：仍走原本的结构化（UIA）通道——UIA 观测进冻结契约、注册表仅凭几何跨帧续用身份、
  `resolveCuVisionCapability` 返回 `uia-only` 而不升级、盲坐标猜测始终禁止、disabled provider 不伪造检测。
- **门禁**：新增 `computerUseWeightlessVerify`（18 项，含"源码中不得出现 `newmark-cu-lab`"的反耦合断言），
  并入 `test:computer-use-runtime`。实测**无权重**时整链 91 项全过 + 1 项显式 SKIP；
  `node dist/tests/verify.js` 1719/1719 全过。

## 2026-09-23 真实 UI 语料缺陷：47% 的训练 episode 场景从未渲染 + 外部交接包

- **缺陷**（新工具 `newmark-cu-lab/scripts/audit_episode_motion.py`）：真实 WinForms 采集的
  `dataset-v0.1-real-ui-v2` 中 **273/700** 个 clip 的 12 帧**逐字节相同**却仍带运动/消失标签
  （`normal_translation` 76%、`stable_jitter` 96%、`disappear_reappear` 61% 命中）；留出集 24/60。
  布局类场景与合成渲染器 **0 命中** ⇒ 缺陷只在真实采集的事件类场景上。训练语料的有效唯一帧因此只有
  **3,353/8,400**；§9.2 的 `movingTargetContinuation` PASS 建立在"15 个平移 episode 里 12 个没平移"之上。
- **外部交接包**：本地归档（未纳入公开仓库）
  （0.77 MiB / 59 文件，逐文件 SHA-256 已校验通过）：双语 README（列出要外部专家回答的 4 个问题）、
  每个数字的确切复现命令、两份评测报告、训练记录含逐步 `telemetry.jsonl`、Lab+App 两侧全部评测 JSON、
  发货 artifact 元数据、数据集 manifest、一个非退化 `scroll_global` 样本 clip 与三套数据一致性审计。


## 2026-09-23 CU 模型模块识别评估：NES-T v0.1 未达成预期识别效果

把 CU-Lab 的产物装入 App 自有 loader/provider/decoder/registry 模块进行隔离评测（发货 `.nmep` INT8 → App 自己的 ONNX Runtime 会话 →
App 自己的 NES-T 解码 → App 自己的身份注册表），用带精确真值的真实 UI 帧驱动。该模块链当时没有接入当前 computer_use 生产工具。

- **识别**：PyTorch/GPU 上 recall 0.3369 @0.2；**发货 INT8 在 App 侧只有 0.2359**，而同图 fp32 是
  **0.4157**（同权重、同帧、同解码器，只换图 ⇒ 动态 INT8 让召回掉 43% 相对）。§9.1 门禁 0.95 两档都远未达到。
- **运行**：发货图在本机 ONNX Runtime CPU 上 **3,022 ms/帧（0.33 fps）**，同 run 的 fp32 图 186 ms
  （16.2× 快）。此前 Lab 的"16.34 ms/帧、满足 5–20 Hz 调度"是 PyTorch/GPU 的数字，**从未代表过发货产物**。
- **身份**：1,503 个观测里只有 12 次 `CONTINUATION`、1,367 次歧义拒绝，被检出≥2 次的真值控件
  **稳定身份率 0.0000**（也没有共享身份）——注册表在正确地"宁可 LOST 不要 WRONG-ID"，但身份连续性尚不存在。

另发现一处完整性缺口：`export --stage INTEGRATION_CANDIDATE` 会**先写完整产物、再抛错拒绝**，
而 App 的 `validateCuArtifact()` 不核对 `manifest.benchmark.detectorPass|trackingPass`，
于是被路线判定不该晋级的产物在 `13/13` ABI 校验与 `11/11` 真实推理门禁上全绿。
完整报告与全部证据见 本地归档（未纳入公开仓库）；
复现命令：`DESKTOP\scripts\verify-cu-workflow-recognition.cjs`（`--graph-override` 做 fp32 对照）与
`DESKTOP\scripts\probe-cu-graph-latency.cjs`。本轮未改动导出器、App 校验器或训练代码。


## dev-0.6.6 Computer Use 主线：CU-Lab 产出 NES-T 候选，App 侧用真实 INT8 模型跑通推理与身份追踪

### 2026-09-22 更新：真实 UI 训练集 + 高帧率/低存储纪律

按《CU-Lab 后续模型训练路线冻结指导》执行 Stage A，并按请求引入**真实 UI 控件**数据：

- **真实 UI 采集管线**（`nculab/capture/uia_playground.py` + `scenarios/windows_ui.py`）：真实 WinForms 控件窗口 + UIA 精确框真值；DPI 感知、原子文件交接、进程内快速真值与真实 UIA 树互校（worst 归一化差 0.0093）。4 套模板 / 8 类时序场景 / 每 episode 随机布局与配色。安全边界：只驱动自建窗口、不发合成输入、结束即关进程。
- **数据集**：真实 UI `dataset-v0.1-real-ui`（200 clips / 2,400 帧 / 69,366 对）与其独立留出集（60 clips / 720 帧 / 20,889 对），§6.4 八类比例全部达标；合成侧用布局抖动修复"留出集不独立"（`LAYOUT_JITTER`）。混合语料训练：`ncu-lab train --dataset a,b`。
- **高帧率 + 低存储 CU 纪律**（App）：`CuCadenceGate` 让 60 Hz 采集只产生 ~10 Hz 整帧推理（实测 601 帧→94 次调用）；`CuFrameStore` 只留最新帧 + 稀疏关键帧并强制字节上限（实测 32 MiB 内保留 32 帧、丢弃 94.7%）；全局平移判为 CONTINUATION 而不铸新身份。门禁 `computerUseHighMotionVerify` 已并入 `test:computer-use-runtime`（现有 **82/82** 通过）。
- **当前数值**：混合语料训练的静态阶段 checkpoint 在**真实 UI 留出集**上 recall **0.298 @0.2**、precision 0.320（合成抖动留出集 0.151）——真实控件域反而学得更好，但仍未达 §5.1 的 0.95 召回门禁；完整 12k 步训练仍在跑。


按《Newmark Computer Use 主线实施总指导》执行 Phase 2–11：CU-Lab 从合成精确真值出发做数据工厂 → 时序数据集 → NES-T 真实训练 → 检测/追踪评测 → INT8 量化 → `.nmep` 导出；App 侧落地 SceneVersion、TemporalEntityRegistry、ActionTransaction、视觉能力/感知路由，并用 **ONNX Runtime 真实加载该 `.nmep`**、把 `trackingHints` 送进身份注册表。

**数据（真实跑出来的规模）**：训练 suite 1,700 episodes / 20,400 帧，留出 suite 300 episodes / 3,600 帧，两者独立 seed。时序数据集 `ds-cu-train-20k-v2` = 20,400 帧 / 1,700 clips / 1,018,776 pair / 6,112,656 负样本；§6.4 的八类比例全部落在容差内（0 项越界），含 544 个硬负样本 episode（同窗口多个 Save、同图标、同列表行、scene cut、global motion）。生成从串行 ~27 分钟降到 12 进程并行 ~2 分钟。

**训练（Phase 5）**：NesT v0.1 冻结配置（768×432 输入、16D 描述子、§8.6 损失权重、AdamW 1e-4/3e-4）在 CPU 上真实训练，逐步记录 raw/weighted loss 与 backbone/temporal 梯度范数，按验证平台早停，并把执行预算（步数、分层样本数、验证间隔、设备）与冻结项分开写进 `run.json`。参数 0.99M（容量放在 stride-8 之后：stem 32/64/128 + 3 残差块）。

**本轮修掉的两个真缺陷**（都不是"调参"）：

1. **检测头塌缩**：96×54 网格上每图 1 个正例 + `pos_weight=20` 的 BCE，其最优解就是"处处 ≈0.0077"（实测真值格 0.006、全局 max 0.119），且 focal 在网格上求和后量级 ~450，被 `clip_grad_norm(5.0)` 归一化，等于把 box/type/motion 的学习率压到 1e-6。改为 CenterNet 式高斯热图 + penalty-reduced focal loss，并把 objectness 头 bias 初始化到 −4.0 之后，总损失回到 ~6.6、梯度 ~100。仅 200 步，真值格/背景对比就达到 0.157 / 0.017。
2. **数据工厂静默丢样本**：构建 pair 时"正样本不可见就跳过"实际删掉了 occlusion/disappearance 门禁的全部评测覆盖，也让 visibility 头永远没有标签。现在遮挡/消失样本保留，并用 `associationUsable=false` 明确告诉关联头"这一帧不能当匹配证据"。

**量化与产物（Phase 7/8）**：模型先导出 fp32 ONNX，再做 `onnxruntime.quantization.quantize_dynamic` INT8，并做 fp32↔int8 parity（逐输出 max/mean abs diff、association cosine），manifest 的 `quantization.mode` 使用 App 契约词表 `ptq-int8`；`artifact.budget` 用真实字节数而不是参数量估算。

**App 侧（Phase 9–11）**：`sceneState`（SceneVersion + 深拷贝读取）、`temporalEntityRegistry`（`S = w_d·S_desc + w_m·S_motion + w_g·S_geom + w_u·S_UIA + w_c·S_ctx`，歧义一律 `AMBIGUOUS_BLOCKED` + 新身份，遮挡保留、消失即 LOST）、`actionTransaction`（§19 状态机 + `EFFECT_UNCERTAIN` 禁止自动重试）、`visionCapability`/`perceptionRouter`（稳定帧 0 次模型调用、云端单飞限速、`vision-unavailable` 明确 `cannot-act`）、`grounder`/`verifier`（陈旧场景拒绝对地、歧义不猜、`NO_CHANGE` 与 `EFFECT_UNCERTAIN` 分离）、`model/*`（`.nmep` 自证 → 会话 → 解码 candidates/observations/trackHints；`onnxruntime-node` 为 optionalDependency，App 不引入任何训练依赖）。

**实测结果（留出集 `ds-cu-holdout-3k-v2`，模型 `train-20260921-230855-442cde`）**：

- 产物：`var/candidates/nes-t-v0.1-20260922-first.nmep`，安装体积 **0.99 MiB**（preferred 25 MiB / hard 100 MiB 双达标），INT8 动态量化后 fp32↔int8 的 **association 描述子余弦 0.99983**（objectness logits 最大绝对差 0.228）。
- 检测：工作点阈值 0.12 时 recall **0.1694** / precision 0.1839 / meanIoU 0.4976（真值格 0.212 vs 背景 0.0116，≈18× 对比）——**未达 §9.1 的 0.95 召回门禁**。
- 追踪：`movingTargetContinuation` 0.9503(≥0.95 PASS)、`sameSceneRepeatedControlFalseReassociation` 0.0000(<0.02 PASS)、`shortOcclusionRecovery` 1.0000(≥0.90 PASS)、`smallControlContinuation` 0.9623(≥0.85 PASS)；`sameEntityAssociation` 0.9503(<0.97)、`falseReassociation` 0.0497(≥0.01)、`scrollContinuation` 0.9231(<0.95)、`disappearanceDetection` 0.0000(<0.95) 未过。
- **因此导出器正确拒绝了 `INTEGRATION_CANDIDATE`**（`unmetForIntegrationCandidate = [detector recall gate, tracking gates]`），本轮交付的是 `CANDIDATE` 阶段产物——没有靠改门槛把候选升格。

App 门禁：`npm run test:computer-use-runtime` **77/77 全绿**（契约 16、SceneVersion 8、身份 7、动作事务 8、视觉能力 7、感知回退 13、产物校验 9、真实推理 9），其中真实推理门禁用 CU-Lab 真实渲染帧驱动 App 的 ONNX Runtime：14 个候选、全部通过冻结契约、16D 描述子范数 1.0000、hints 全部进入 Registry 且每个观测恰有一个身份归属（续用 0、歧义拒绝 14 —— 即"宁可 LOST 不要 WRONG-ID"在弱模型下的正确表现）。`node scripts/verify-cu-nmep-candidate.cjs <candidate.nmep>` 13/13 通过（App 自己重算哈希与体积，ABI PASS）。

已知边界与下一步：训练数据仍是合成精确真值（未验证真实泛化）；0.99M 参数 / 1500 CPU 步处于**欠训练**状态，§8.1 目标是 8–10M 参数 + 35/5/30 epoch，需要 CUDA fp16 才算真正跑到预算；disappearance 正样本只有 0.16%，visibility 头需要类别加权或过采样；关联头 InfoNCE 仍在 1.7 附近。Phase 12–17 未开始。完整数字与诊断过程见 本地归档（未纳入公开仓库）。


## 历史记录：dev-0.6.6 Auto 路由重构

本节保留当时的实施记录；回退模型接口、第一合格模型回退和独立决策模型编辑器已于 2026-09-26 移除。当前行为以本文顶部 JEV 说明为准。

Auto 模式不再使用「质量历史 + EWMA 偏好 + 用户评分 + 手动切模 + 工具结果 + 成本/速度/可靠性权重 + 缓存黏性」的旧打分器。模型选择使用一条决策链路：**RouteEligibilityGuard（只做硬过滤）→ 当前对话模型的 JEV 严格 JSON 决策 → RouteDecisionValidator（只接受守卫允许的部署）→ Build 内事务绑定 → Provider 调用**。

历史数据被明确切断：`~/.Newmark/routing/feedback.jsonl` 不再被加载；👍/👎 只写 `routing/ratings.jsonl` 遥测（stale/重复点击保护不变）；手动切换模型不再产生任何反馈；工具执行成功/失败只进入端点运行健康；`quality_by_task` 字段保留以兼容旧配置与降级回滚，但 Auto 既不读取也不再自动写入。端点健康、熔断与失败恢复继续保留，但它们只决定「此刻能不能用」，不再形成第二套模型选择器。

Auto 只接受当前对话模型在关闭思考模式下返回的严格 JSON，再由本地 schema、资格守卫和候选范围校验器复验。模型调用超时、失败或输出不合法时，本次路由失败关闭；不存在确定性回退模型。生产 `core/jevDecision.ts` 不含本地排序决策器，测试夹具排除于应用包。决策硬超时默认 3000 ms；路由审计记录 `decisionSource`、JEV `modelVersion`、`reasonCodes`、`latencyMs` 和模型返回的 `alternatives`，不记录 prompt 与密钥。

新增门禁：`jevDecisionVerify`（当前模型严格 JSON、校验器、关闭思考和失败关闭契约）与 `jevRoutingInvarianceVerify`（同一 JEV 输出、候选目录、用户策略与实时健康状态下，反馈文件、历史评分、手动切模、工具结果与旧 `quality_by_task` 不得改变部署）。

行为说明（有意的变化）：旧 Auto 的「质量带」来自历史质量，本身就在被移除之列，因此 Auto 的实际选择会与 0.6.5 不同（例如 speed 模式现在直接取延迟最低的合格部署，balanced/quality 按验证证据、实时可靠性与声明价格排序）；用户显式固定模型的行为完全不变，JEV 不接管固定模型路径。

### Auto 当前模型决策策略入口：GUI / TUI / CLI

Auto 的「生态位」现在有了显式的决策模型槽位，三端都能就地编辑，并且都以 Agent 为唯一权威：

- **GUI（Models & Providers 设置页）**：JEV 卡片只提供启用与超时控制，并固定展示当前合格对话模型、原生关闭思考和严格 JSON Schema。没有 runtime、JEV 模型标识、产物路径或备用模型控件。
- **TUI（Settings → [J] Auto decision policy）**：提供启用和超时控制；输出模式只读展示。决策失败时 Auto 停止，不会挑选替代模型。
- **CLI**：`Newmark.exe jev` 只读查看或编辑启用状态、超时；旧 `--runtime`、`--model-id`、`--model-path` 和 `--fallback*` 参数已移除。

**Auto 关闭即冻结**：`auto_switch` 关闭时，Agent 不调用 JEV，也不改动当前部署；GUI/TUI 锁定策略控件，CLI 写入返回退出码 2。`jev_enabled` 关闭、当前 Provider 不可调用或严格 JSON 请求失败时，路由均失败关闭。

历史界面证据仍在 本地归档（未纳入公开仓库）。当前源码门禁 `jevModelEditorVerify` 检查已移除的 runtime/model/fallback 字段与 GUI、TUI、CLI 的当前策略入口。


## dev-0.6.5 弹窗与模型配置

移动端返回项不再参与色块移动，模型菜单打开时定位当前选项，浏览器按钮采用外扩玻璃画布；供应商模型行落地后进入配置页。双端分别设置调用模型标识与显示名，并加强同名模型的供应商隔离。PC 实际窗口与 Android 模拟器触控/截图验证已执行，实体手机尚未连接。见 本地归档（未纳入公开仓库）。


## dev-0.6.5 低内存适配与流式显示

针对 8GB 电脑收紧闲置会话进程驻留预算，限制分支消息快照缓存，并阻止切换会话后的过期流式绘制。真实 DeepSeek 部署完成运行中 Next、暂停/恢复与出队回复验收。当前为源码开发版，未打包安装；8GB 实机性能仍待测。见 本地归档（未纳入公开仓库）。


## dev-0.6.4 hotfix #2 排队进入对话后的用户输入显示与连续出队

修复「通过排队进入的对话没有显示在对话区作为用户输入」与「队列没有连续进入」：后端在出队时已经把这一轮写成正式用户消息（`chatMessages` 里可见 `[user]` 与 work run 的 `primaryPrompt`），但渲染端既没有乐观气泡也没有发送回执，**从不为排队回合刷新转录**，所以对话区看不到用户输入、队列面板清空后又“什么都没有发生”。现在 `applyConversationCommandSnapshot` 比较权威 `queueItems` 的 id 集合，检测到出队即按目标去抖刷新（150ms/1200ms/3000ms，覆盖用户消息落盘与助手回复两个时刻），并且只在当前前台会话、渲染端无发送在飞时执行；运行终态（`done`/`error`/`interrupted`）也走同一条刷新。验证（已安装 exe、隔离 root + mock provider、连续两行）：账本 `seq1:SUCCEEDED seq2:SUCCEEDED`，后端与对话区都得到 `[user] DEV064_QUEUED_DISPLAY | [assistant] … | [user] DEV064_QUEUED_DISPLAY_2 | [assistant] …`，DOM 出现两个用户气泡。

本版已打包并安装：MSI SHA-256 `614BE64B…F9E4CE`、便携包 `06D403D1…BE5642`；安装器 `Success=true`、`ProductCode={ECF2B123-F441-4141-97AF-6E46694F40D7}`、`VerifiedPayloadFileCount=292`、`InstalledAsarSha256=C91A06A1…24EC82`；安装目录 `app.asar` 与打包目录一致，注册表/安装目录 exe/CLI 均为 `0.6.4`。记录与安装态截图见 本地归档（未纳入公开仓库）。

## dev-0.6.4 hotfix 受阻队列修复、排队/Guide 显示规则

修复「无法启动暂停的队列、也无法提交新队列」：某个被受理的 Build 一旦失败，`claimBuild` 只认「父 = 已提交 frontier」的排队行，于是它的整条后继链永久无法被 claim —— 恢复暂停队列看起来毫无反应，之后提交的新行也只是接在这条失败链后面。现在按队列顺序从父链推导受阻状态（失败之后才入队的行同样会显示原因），队列面板给受阻行加 `data-queue-blocked` 标记，并在队列头部提供显式的 **“修复受阻队列”** 按钮：把受阻行重新挂到最后一个已提交 Build（顺序不变，每次改挂写入 `BuildQueueRepaired` 审计事件）。修复必须是用户显式动作——0.6.3 合约要求失败前置继续阻断后继、不得静默跳过，因此恢复动作本身保持原语义。

显示规则按你的要求收紧：未进入对话的排队内容**不再画进对话区**，只在输入栈的队列面板中显示；Guide **只有被内核接受后**才出现在时间线上、并显示在接收位置（乐观/待确认、deferred、rejected 的 Guide 都不进入对话区）。

验证：新增 `queueBlockedRepairVerify`（复现用户账本形状 → 修复 → 依次 SUCCEEDED + 审计事件 + 幂等）；真实内核 + UI 端到端（mock provider）验证 `ledger: seq1:FAILED seq2:SUCCEEDED seq3:SUCCEEDED`、受阻标记与修复按钮出现、修复+恢复后队列清空；`verify.js`、`test-shared-conversation-commands.cjs`、`test-queue-start-failure.cjs`、`test-queue-acceptance-boundary.cjs`、`test-queue-continuation-identity.cjs`、`guideUiReconcileVerify`、`branchPageQueueIdentityVerify` 等门禁全部通过。

修复版已打包并**在本机完成 UAC 提升安装**：MSI SHA-256 `C174A886…E391F`、便携包 `5DA8CA31…CFC6`；安装器结果 `Success=true`、`Version=0.6.4.0`、`ProductCode={A45790C3-50B4-42F1-B58D-ED0CD2094398}`、`VerifiedPayloadFileCount=292`。独立复核：注册表 `0.6.4.0`、安装目录 exe `0.6.4.0`、安装目录 CLI `0.6.4`、安装目录 `resources/app.asar` SHA-256 `44935476…D3F7`（与打包目录一致）。已安装 exe 的隔离 root 门禁：受阻队列两行显示 `DEPENDENCY_FAILED` + 修复按钮，显式修复并恢复后账本 `seq1:FAILED seq2:SUCCEEDED seq3:SUCCEEDED`；视觉门禁分页条 `<2/2>`、队列 2 行（1 行等待所属分页）、内联排队气泡 0、Guide 仅“复制”。记录见 本地归档（未纳入公开仓库）。

## dev-0.6.4 分支分页身份、排队输入可见与 Guide 只读

PC 端修复三处对话接续表现：(1) 从 Build 开头编辑输入生成分页时，分页条现在稳定出现在被编辑的那条用户输入上——锚点解析改为 `message_id` → 渲染索引 → 锚点文本三级回退，Build 卡片式渲染（没有 `data-message-id`）也能命中；同时消息快照与 Build 列表按「分支节点」缓存，新分支页新发送的消息留在本页，不会被另一页的快照覆盖。(2) 排队输入不再隐形：队列面板不再按当前运行分支过滤、新增排队行自动展开面板，并在时间线上把属于当前分页的排队内容渲染为带「排队中」标记的用户气泡；生成分页时不再清空本地排队投影，也不再静默改写受理时捕获的 `branchPath`。(3) 时间线中的 Guide 记录只保留复制按钮，移除编辑入口（Guide 仍是当前 Build 的内联干预，不重放、不重写）。

分支身份统一为一条规则：`<conversationId>::branch:<branchNodeId>`（`DESKTOP/src/core/branchIdentity.ts`）。用户分页产生的分支与实验性「分支交流」产生的分支共用同一套逻辑：新分页必须拿到全新节点 id（`assertFreshBranchIdentity`），供应商会话序列 id 绑定 Build 所属分支（`activeWorkRunBranchId`，不再读「当前查看的分支」），压缩归档与热折叠历史按分支节点隔离，渲染端消息/Build 缓存同样按分支节点键隔离。

保留既有边界：预览分支与运行分支分离时，新分支绝不接管另一条分页的排队输入，跨分支不共享 provider 会话与折叠历史，Guide 行为不变（`test-shared-conversation-commands.cjs` 51/51 通过）。

验证：`verify.js` 1717/1717；`test-shared-conversation-commands.cjs` 51/51；`queueAttachmentIsolationVerify` 渲染器命令 57/57；`test-long-conversation-ui-ordering.cjs` 18/18；新增 `branchPageQueueIdentityVerify` 分支身份/排队可见/Guide 只读回归；真实 Electron 渲染器视觉复核脚本 `test:branch-page-queue-visual`，截图见 本地归档（未纳入公开仓库）。版本已同步为 `0.6.4`／Android `versionCode 604`（Android 行为未改动）。

本地已生成并核对：`release/Newmark-Agent-0.6.4-x64.msi`（246,759,622 bytes，SHA-256 `1BEABA08…B54E4A`）、`release/Newmark-Agent-0.6.4-win-unpacked-x64.zip`（321,900,311 bytes，SHA-256 `C807ECC6…4419D6`）。打包后 context-compress CLI stress、console wrapper boundary stress（`version=0.6.4`）与真实 loopback sshd SSH TUI 压力（4 轮重启）全部通过。

Windows MSI 已在本机完成一次 UAC 提升安装并独立复核：注册表 `0.6.4.0`、安装目录 `Newmark Agent.exe` FileVersion/ProductVersion `0.6.4.0`、安装目录 CLI `0.6.4`、`C:\Program Files\Newmark Agent\resources\app.asar` SHA-256 `92842DCB…D38804`（与打包目录字节一致）、安装器核对 292 个 payload 文件。安装前已关闭 6 个运行中的 0.6.3 实例；安装器的“用户数据未被触碰”守卫因安装窗口内仍有运行时写入 `.Newmark`（`startup.log`、`.newmark-runtime`、`.newmark-context-v2`、Electron session-data）而报 `failed`，但 MSI 退出码为 `0`、payload 无误、该目录下安装后无任何 Newmark 进程 —— 判定为并发写入误报。安装后 GUI 运行验收：以隔离 root 启动**已安装**的 exe，通过 CDP 断言 `<2/2>` 分页条、队列行 2（1 行标记等待所属分页）、排队用户气泡 1 个与 Guide 仅“复制”动作并截图，`GuiRuntimeVerified=true`（渲染器层面；真实 provider 端到端仍是独立边界）。记录见 本地归档（未纳入公开仓库）。

## dev-0.6.3 对话接续身份、分支绑定与缓存隔离

PC 与 Android 修复“底部显示的模型不等于实际发送的 provider/model”、新对话首轮长时间无反馈、排队 Next 被误接到上一个 Build、排队项落到错误分支，以及正常回复被客户端输出上限截断的问题。队列项在受理时固定 `targetRuntimeKey`、`workspaceKey`、`branchNodeId`、`branchPath` 与 `modelSelection`；Next 在上一 Build 完整结束后以新 runId 启动为同会话新用户轮次，Guide 仍内联干预当前 Build；跨会话队列项进入暂停而不是改投当前对话。受理、抢占、心跳与最终提交现在经过工作区级 `GuardedContinuationStore`：CAS/幂等回执、固定 parent、BranchGuard/fence、唯一 final、head/tail 分离、失败/取消阻断后继、分叉 lineage 校验与 append-only 事件；受理后重排被显式拒绝，必须取消后缀后以新命令重新提交。可选的 provider session 身份按分支隔离，每次模型请求记录 `branchId` 与实际 payload 的 `contextHash`。正常回复不再发送客户端 `max_tokens`/`max_output_tokens` 上限，只有明确短输出的辅助请求才传正值；移动端预算耗尽保留部分答案并标记未完成。PC 远程对话与 hosted mobile 命令共用同一 kernel/ledger；Android 本地对话仍使用独立的 `LocalQueueContract` 持久队列。验证记录见 本地归档（未纳入公开仓库）。

版本号已同步为 `0.6.3`／Android `versionCode 603`。`release:version-check`、主验证套件 `1717/1717`、共享命令/Flow handoff `51/51` 以及缓存/动态多级压缩专项全部通过。`beginExternalRun` 接管前会从工作区持久状态重载并按 clientMessageId 合并队列投影，Flow 完成后的 `waiting-b`/Goal 行不再丢失。

本地已生成并核对：`release/Newmark-Agent-0.6.3-x64.msi`（SHA-256 `E739B6…60E3`）、`release/Newmark-Agent-0.6.3-win-unpacked-x64.zip`（SHA-256 `EF9973…EA67`）、`APK/Newmark-Agent-0.6.3-release.apk`（SHA-256 `DD9559…A3260`，`com.newmark.mobile` 0.6.3/603）。完整 `test:full-release` 仍被既有 `test-subagent-settlement-receipts.cjs` 挂起阻塞；打包时 SSH TUI stress 按显式 CI 边界跳过，Linux/macOS 未在本机生成。记录见 本地归档（未纳入公开仓库）。

Windows MSI 已在本机完成一次 UAC 静默安装并独立复核：注册表 `0.6.3.0`、安装目录 CLI `0.6.3`、`resources/app.asar` SHA-256 `799E1753…A0C5D3`、安装器校验 292 个 payload 文件。安装后未自动启动 GUI，`GuiRuntimeVerified=false` 仍作为独立边界保留。

`dev-0.6.3` 已通过 tag 驱动的 GitHub Actions 完成全平台发布：[Release](https://github.com/positer/Newmark-Agent/releases/tag/dev-0.6.3) 包含 Windows MSI/便携 ZIP、Linux AppImage/deb/便携 ZIP、Android APK 六个资产；`newmark-agent@0.6.3` 已同步发布到 npm。`master` 为 `fa3174b`，tag `dev-0.6.3` 指向同一提交。

## dev-0.6.2 移动端输出预算续写

修复本地 Agent 在标题已完成后因 `max_output_tokens` 直接失败的问题：供应商明确报告预算耗尽时保留进度、提高预算并有限次续写，截断工具参数不执行；断网、取消及未知不完整状态仍分别处理。见 本地归档（未纳入公开仓库）。

## dev-0.6.2 双端推理模型标题预算

PC 与 Android 标题总结保留当前模型及思考档位，使用该档位的正常输出预算，避免短标题上限挤占模型生成正文前所需的思考空间。移动端图片文字退路继续保留。见 本地归档（未纳入公开仓库）。

## dev-0.6.2 移动端整篇回复重复修复

移动端按协议区分流式增量与完整回复快照，保留独立换行、空格和合法重复字词；Responses 的完成快照按消息片段核对，非流式聚合正文与结构化正文只取一份。见 本地归档（未纳入公开仓库）。

## dev-0.6.2 移动端运行彩边

本地与远程对话胶囊采用与 PC 一致的黑白动态运行边框：3 秒连续渐变，任务结束后消失，玻璃抬起和覆盖期间避让。后台运行的本地对话也独立显示运行状态。验证记录见 本地归档（未纳入公开仓库）。

## dev-0.6.2 免费搜索服务更新

PC 与 Android 默认搜索组更新为 Exa 官方免密钥搜索优先、You.com 官方免费搜索备用。移动端可以直接连接两项 HTTP MCP，无需配对 PC；PC 远程 MCP 复用网页工具的代理设置。旧抓取服务保留为可选配置，Bing 与 DuckDuckGo 仍承担最终退路。免费服务存在额度和网络限制；调研、双端真实搜索及打包记录见 本地归档（未纳入公开仓库）。

## dev-0.6.2 移动端带图交互与公式修复

移动端将对话保存和图片缩略图解码移出主线程，连续操作合并待保存状态，并保留标题提交的持久化与取消校验。本地、远程对话胶囊长按弹出菜单时提供系统触感反馈。Markdown 支持紧接正文的多行块公式，并使用离线原生引擎排版行内公式、上下标和分段大括号；解析失败保留可读退路，代码示例保持原文。验证范围及交付记录见 本地归档（未纳入公开仓库）。

## dev-0.6.2 图片首轮标题退路

移动端首轮带图时，标题总结失败会改用用户文字和图片数量进行纯文字分析，不发送图片数据。该重试仍失败时保存中性标题“图片内容分析”，继续正式带图请求；用户取消、对话状态失效和保存失败仍遵循原有启动门禁。见 本地归档（未纳入公开仓库）。

## dev-0.6.2 代码块复制与双端视觉复查

PC 与 Android 的 Markdown 围栏代码块均提供独立复制按钮，仅复制对应代码原文；代码卡片为左右对话时间线留出间距，PC 横向滚动代码时保留可见的复制工具栏。PC 窄窗口浏览器工具栏和上下文弹窗边界同步修正。双主题、移动端横竖屏截图、剪贴板测试及压力测试的实际结果见 本地归档（未纳入公开仓库）。

移动端 Goal 与队列操作按钮使用静态图标，取消按钮玻璃边框、按压缩放、位移、底色和涟漪，仅执行点击操作。

## dev-0.6.2 Browser-Use 视觉协作与 PDF

移动端修复 PC 合并流式片段与历史快照重叠导致的过程回复重复，按原片段 ID 合并。

PC 与 Android 的 `browser_use` 按 DOM/PDF 二进制文本 → 已配置视觉模型 → 本地 OCR 的顺序读取页面；文本足够时不调用视觉模型。`visual_mode: "vision"` 可显式请求视觉协作，`viewport: {"width": 390, "height": 844}` 可设置会话内浏览器 CSS 画幅，`pdf_page` 可选择 PDF 页码。网页 PDF 按二进制解析，扫描页先渲染后识别；不把 PDF 阅读器工具栏当作正文。检查范围和交付记录见 本地归档（未纳入公开仓库）。

## dev-0.6.2 内置浏览器本地 HTML

Android 与 PC 内置浏览器支持本地绝对路径、`file://`（兼容 `files://` 输入），本地 HTML 的相对 CSS、JavaScript 和页面链接正常加载。Android 同时接受有读取授权的 `content://` 文档地址；文件能否读取仍遵循系统权限。网页不能通过跳转或弹窗提升为本地文件访问。验证与交付记录见 本地归档（未纳入公开仓库）。

## dev-0.6.2 全界面主题与玻璃协调

两端统一状态语义色、Lucide 导航和开关反馈，Memory Lab 图谱随亮暗主题调整。PC 修复快速重开弹窗被旧退出动画误关的问题，空白浏览器画布跟随应用主题。已完成 72 个 PC 与 54 个 Android 双主题截图场景及玻璃手势回归；本地归档（未纳入公开仓库）、本地归档（未纳入公开仓库）。

## dev-0.6.2 双端视觉一致性

PC 与 Android 统一采用 Lucide 线框图标及亮暗主题的三级文字色。移动端主界面、侧栏、设置、终端和 Memory Lab 的图标语言保持一致，亮色 Material 容器使用中性配色；PC 导航、工具栏、标签和展开区的悬停反馈统一跟随当前主题。沿用既有玻璃动效与触控布局。构建、截图和交付边界见 本地归档（未纳入公开仓库）。

## dev-0.6.2 移动端图标主题跟随

移动端默认图标统一继承当前亮暗主题的前景色；状态栏与导航栏图标在主题切换和页面恢复时重新应用。首帧读取已保存的主题覆盖设置，避免先按系统主题绘制图标。版本已同步为 0.6.2／602，本轮构建与验证记录见 本地归档（未纳入公开仓库）。下方 0.6.1 安装与发行记录保留历史边界。

## 0.6.2 Windows MSI（本地构建）

Windows x64 MSI 已打包并安装到本机，主程序版本为 `0.6.2.0`。292 个安装文件与包一致，21,145 个既有用户文件未改变；实际 GUI/CLI 启动与安装后搜索通过。产物为 [Newmark-Agent-0.6.2-x64.msi](release/Newmark-Agent-0.6.2-x64.msi)，SHA-256 `F01A369A1B536CB4A9C298BFFC5FC4AA3AF1CAF6FF4E937004A0DC73D6051033`。发布检查分段执行与安装证据见 本地归档（未纳入公开仓库）。本轮未发布 GitHub/npm Release。

## 0.6.1 Windows MSI（历史记录）

此前 Windows x64 MSI 完成全量 Desktop release 回归、打包和 UAC 提权后的静默安装。当时安装版本与主程序文件版本均为 `0.6.1.0`；产物为 `release/Newmark-Agent-0.6.1-x64.msi`，SHA-256 为 `BC491848286DB2C8ED5162CF9C070E66C3358B65C8BB01BB96FBD0AE32D7CBBF`。构建、PowerShell 参数格式和历史安装证据见 本地归档（未纳入公开仓库）。

Android 0.6.1 Release APK 位于 `APK/Newmark-Agent-0.6.1-release.apk`，SHA-256 为 `286479F2E5733885850C5F75F20BCD7CD8D5E55715BD7DD6F0B4340F18F64A6A`。旧 APK、根目录历史 `release-*` 以及 archive 内历史发行安装包和解包目录已清理；非发行归档资料保留。

## dev-0.6.1 供应商限定模型身份修复与全平台发行

PC 的上下文模型、默认供应商和回退池现在统一保留供应商限定的部署身份；Android 回退同步会解析限定部署 ID，并准确绑定供应商与模型，避免不同供应商的同名模型串用。全平台发行工作流已通过，预发布提供 Windows x64 MSI／便携 ZIP、Linux x64 AppImage／deb／便携 ZIP和 Android APK。

完整双语说明、六个资产及最终 SHA-256 见 [GitHub Release dev-0.6.1](https://github.com/positer/Newmark-Agent/releases/tag/dev-0.6.1)。

## dev-0.6.0 响应观察、模型开关与玻璃开关修复

模型与供应商部署身份在会话快照、再次发送和冷加载中保持一致。未检测或响应异常的模型保持可选、可发送；模型名称后以灰色“（响应异常）”提示，真实成功响应恢复对应能力标识。图片不受历史视觉判断拦截；实际视觉拒绝后进入内置 miniOCR 与同模型文本纠错，保留原始任务与不确定性，后续图片仍尝试原模型。用户关闭模型开关才会在选择器隐藏该模型。

供应商模型行统一左右留白，信息左对齐，右侧依次为开关、编辑、删除。PC 与 Android 开关点击反转状态；长按拖动按松手档位提交，取消手势不提交。玻璃浮块从源端浮起，连续移动到目标端后再落下。PC 浮块复用现有折射渲染器，Android 视觉伸缩不改变中心锚点。

本轮不修改 OpenCode 特殊请求头。DeepSeek 首轮标题请求另修正 64-token 截断问题，保留简短标题约束并提供 2048-token 完成预算。验证、已知边界与候选交付见 本地归档（未纳入公开仓库）。

### dev-0.6.0 移动端侧栏修复

移动端供应商详情的名称与 API 接口独立显示；API 接口支持编辑并显式保存。横向协议轨道与下方竖向模型轨道隔离，竖向玻璃浮块不会进入名称、接口或跨过协议轨道。

对话胶囊支持重排后的连续长按与反向拖动；竖屏抽屉允许玻璃浮块完整绘制在侧栏边界之外。浮块保持原有扩展尺寸，向右的中心位移减半，起点和终点仍与对应色块重合。已通过 365 项 JVM 测试、30 项模拟器设备测试和 Release 构建；本轮验证与交付边界见 本地归档（未纳入公开仓库）。

Newmark Agent 将桌面、命令行与原生 Android 客户端连接到同一套会话和工作区能力，面向需要本地工具执行、多模型协作及跨设备工作连续性的开发者。

当前发行版本为 **dev-0.6.2**，Desktop 与 Android 同步为 0.6.2／602。提供 Windows x64 MSI／便携 ZIP、Linux x64 AppImage／deb／便携 ZIP 和 Android APK。[下载及完整双语发行说明](https://github.com/positer/Newmark-Agent/releases/tag/dev-0.6.2)。CLI／TUI 通过 [npm newmark-agent](https://www.npmjs.com/package/newmark-agent) 分发。Windows 未做代码签名；Android 使用开发证书供侧载。下方旧版本安装、构建记录仅作为历史记录。

### SubAgent 连续工作与通信缓存（2026-09-07）

Ultra 主代理按责任、文件范围、依赖和验收要求分工，执行子代理保持自己的任务范围，通过有用的新证据和定向 mailbox 消息协作。普通档位和 Ultra 分别保留 4／16 个执行槽；相同子代理续作沿用身份和工作历史。重复递送、同一子代理重叠执行及重启丢失已读指令的问题已修复，运行中的完整工具结果和已提交输入通过检查点保存。

同一子代理保存稳定的请求元数据和已供给工具顺序，模型、权限、协议或压缩变化会使相应快照失效；内存中的供应商兼容实例按子代理独立复用并有数量上限。真实供应商缓存读取以实际 usage 为准。可重复门禁为 `npm run test:subagent-continuity`，压力规模、真实模型观测和验收边界见本地归档（未纳入公开仓库）。

子代理可向同对话的主代理或其他子代理发送消息。`wakeup` 默认为 `false`：已停止的接收者只保存邮件，设为 `true` 才请求唤醒；运行中的接收者照常处理两种消息。发送方自行选择摘要、文本历史或工具历史及范围，未指定内容时发送最后一条可见文本历史。工具调用与结果成对传递，列表只提供摘要，静默投递不改写接收者已有上下文或静态请求缓存。

单击停止向当前对话的全部未关闭子代理发送停止控制指令并中断执行；再次强制停止覆盖同一对话的子代理和所属工具进程。停止按对话和当前运行身份隔离，其余对话继续运行。

WSL 停止要求发行版提供 Python 3 的 Linux pidfd 能力；无法确认进程归属或清理结果时会明确报错并保留隔离状态，避免误杀其他对话。可通过 `npm run test:wsl-stop-isolation` 复验真实 WSL 进程隔离。

### Build 连续响应与协议兼容（2026-09-06）

Build 的空响应、仅思考响应和短暂连接故障统一进入有界恢复；有效工具进展刷新恢复预算，已经完成的工具保留结果，当前请求已输出正文或工具调用后不自动重放。等待重试期间可以立即停止。明确失败或缺少完成依据的流不会冒充成功，也不会执行尚未完整接收的工具参数。停止或连接失败前已经显示的正文片段按未完成响应保存，重新打开会话后仍可查看。

Chat Completions、Responses 和原生协议使用匹配的请求头与接口地址，保留网关前缀、查询参数和各自鉴权。上下文窗口中的实测用量与缓存统计保持原口径。GUI 通过目标、Build 和原始流事件身份保护连续显示，旧停止回包及重叠的快照/批次不能覆盖新响应。代码原因、失败复现与验收边界见本地归档（未纳入公开仓库）。

### 上下文管理与真实计量（2026-09-06）

上下文窗口分别展示服务端实际输入/输出、对话累计缓存命中率及本地上下文分项估算。缺失计量显示未上报；只有完整覆盖的请求才能给出全会话命中率，部分数据单独列出已上报部分的加权命中率。同一请求的累计 usage 更新不会重复计费，标题、压缩等本会话辅助调用也纳入累计。历史计量与最新主请求快照随会话保存，切换会话后的晚回包保持原归属。

运行中的分项来自实际提交的消息、系统提示和工具定义，区分长期历史与当前 Build；普通输入和工具结果保留 Build 归属。供应商未提供分项 tokenizer 用量时，界面明确标注本地估算，图片编码长度不当作 token 数。空闲时展示当前保存历史的估算，并单列最近主请求的实测输入。上下文面板适配较小窗口，可滚动访问全部信息和压缩操作。本地归档（未纳入公开仓库）。

### Build 内请求与缓存效率（2026-09-06）

同一 Build 保留稳定请求前缀，并复用配置一致的供应商实例，避免重复探测已知不支持的参数。Guide 后的同模型重试保留原系统与工具序列；真实模型、认证或代理变化会使相应缓存失效。未开启诊断时不再对完整长历史重复计算指纹。服务端返回零缓存仍如实显示，不作为客户端修复失败或追加重试的理由。本地归档（未纳入公开仓库）。

### 长对话、缓存统计与实时上下文（2026-09-06）

供应商输入、输出和缓存读写计数按会话保存，切换工作区、重启或恢复归档后保持归属；旧历史中不存在的计量不反推。Responses 与 Chat 的缓存明细按真实 usage 解析，历史分页和上下文状态刷新对齐当前会话及加载代次，防止晚到的旧回包污染当前页面。

1,200 条消息的正文、身份和时间戳已通过真实持久化/冷加载检查。旧历史重复分页已修复；此前 unpack 的实际 PC/HTTP 450 条分页、过期回包隔离、上下文计数显示及重启恢复通过 21 项检查，详见本地归档（未纳入公开仓库）。Build 内保留完整初始系统提示和已发送的消息前缀，按需加载工具保留已有 schema 顺序。真实 APInebula 观测中的零缓存计数保留，按最新验收边界不强求服务端每轮命中。

### PC 弹窗 4px 反馈与 80ms 长按（2026-09-06）

模型列表、普通选择列表及会话操作列表的外框与裁剪圆角统一为 25px，与内部胶囊色块的弧线协调；选项高度、内边距及既有运动逻辑不变。新 unpack 的 16 项菜单及 4 组长按时序检查通过，最终证据见本地归档（未纳入公开仓库）。

外拉反馈按最新要求朝受力方向延展，反侧及其未受力角部固定；单轴最大 4px，斜拉按方向分配同一预算。按压内缩、文字布局、轨道和色块移动保持既有逻辑，新的方向结果记录在 `pc-directional-pull/`，旧均匀扩展截图仅为历史证据。

PC 弹窗的弹性形变上限调整为每侧 4 CSS px，长按拖动激活时间按最新要求缩短为 80ms。保留按下内缩、长按进入色块移动时恢复、受限外拉放大的既有交互；色块起终点、移动动画时长、轨道、弹窗材质与透明度保持原样。移动端不受这两项参数调整影响。构建与实际像素/时序结果记录在本地归档（未纳入公开仓库）。本次不更新已安装 MSI；下方 8px 安装说明是历史交付记录。

### 远程会话与双端队列（2026-09-06，验收进行中）

PC 与配对手机使用共同的会话命令和持久化队列。两端提交的消息、Next、Guide、模式与 Flow 操作按同一目标执行；队列项保留独立 ID、附件、请求模式、Goal 目标和时间，任一端都可编辑、删除、排序、暂停、继续或转为 Guide。客户端界面只维护后端状态的显示，不再各自消费私有队列。

本轮也修复后台会话更新后 PC 队列按钮沿用旧索引、远程新建会话不出现在 PC 列表，以及 Flow 保存期间被空闲快照误取消的问题。移动端队列编辑等待实际接收结果，失败保留草稿，切换会话隔离编辑目标。静态布局、玻璃和交互视觉规则保持既有约定。

最终 unpack 已通过 36 项快速取消 Flow 检查；与已安装 Android Release 的实际队列显示、手机编辑、继续及 Flow 运行/暂停/退出增量通过，详见本地归档（未纳入公开仓库）。候选测试中捕获的一次桌面无响应仍需定位，不能用重启恢复或当前通过的用例代替归因。下方“响应生命周期”结果属于此前已完成阶段。

### 双端响应生命周期与 PC 列表性能（2026-09-06）

桌面模型流现在按连续字节流解码 SSE，正确处理跨包换行、中文及 emoji、无空格的 `data:` 和多行事件；协议明确完成或失败时立即结束，用户停止及提前退出会释放响应体。模型 POST 使用独立 dispatcher，覆盖流式和完整 JSON 响应，解除底层隐藏的 300 秒响应头/响应体限制；连接建立、代理选择、显式请求预算和其他网络请求保持原策略。JSON 响应在正文读完后才释放取消控制，避免响应头已到而正文仍阻塞时无法停止。

Android 通过统一的可取消 HTTP 生命周期连接响应头、正文读取及重试，用户停止会关闭正在等待的网络调用，明确终止事件不再等待服务器关闭连接。双端首轮标题取消独立的 15 秒期限，并由当前运行拥有取消权；仍须成功生成并持久化标题后才能开始首次正式响应，保留冻结部署、首消息身份和既有空标题重试上限。

标题失败会显示安全的 HTTP 状态和具体故障类别，帮助区分供应商通道不可用、认证、余额与客户端网络问题。Android 活跃会话保存采用暂存后替换，失败保留旧文件并明确提示；生成的标题必须实际保存成功后才更新界面并开始正式响应。

PC 列表按实际内容变化更新 DOM。源码 Electron 对照中，500 条静态会话连续刷新 30 次的无谓 DOM 写入由 45,000 次降至 0，单次刷新均值由约 11.13 ms 降至 2.95 ms。思考内容缓存同时区分完整文本与运行状态，修复等长内容漏更新和结束后 Markdown 未恢复，并复用未变化的 Guide 与图片节点。现有主题、玻璃、8px 反馈、轨道及鼠标无泛光规则保持不变。

上述性能对照来自隔离源码测试；实际 unpack、APK 安装身份、设备流程与最终发布门禁分别记录在本地归档（未纳入公开仓库）。最终 PC 完整发布测试通过，unpack 通过九项 GUI 流程；最终 APK 通过 315 项 JVM、56 项设备测试与九项导航。按指定 `APInebula / gpt-5.6-sol` 完成的 PC 两轮 CLI、两轮 GUI 和移动端两轮真实对话均已通过，移动端进程重启后回复仍可恢复。

本轮产物为 本地归档（未纳入公开仓库） 和 本地归档（未纳入公开仓库）。下方历史 APK/MSI 不包含本轮改动，不能用旧版本号或旧安装替代新包证据。

### 灰黑暗色主题与右侧栏（2026-09-06，源码更新）

桌面与 Android 暗色界面统一采用中性灰黑画布、分层面板和清晰的灰白文字，保留功能强调色与玻璃透明度。Android 右侧栏补齐宽屏底层，避免应用暗色、系统浅色时整栏反白；分页静止显示色块，交互使用共享玻璃浮块，图标保持清晰并在落地后恢复色块。分页图标短按由整组手势统一处理。

已通过 Android 288 项单元测试、28 项硬件渲染与手势测试，以及真实 Electron 14 个状态和 121 项配色检查。本轮源码与验证记录见本地归档（未纳入公开仓库）。下方 APK/MSI 是此前交付的安装包，不包含本轮源码更新。

### 移动端触控玻璃与对话浮块（2026-09-06）

移动端泛光现在跟随真实手指位置，并始终裁剪在玻璃内部；浮块加入轻微阻尼，松手后从实际显示位置继续移动再落地。弹窗内容与玻璃共享弹性响应。对话浮块向右展开，保留完整横向扩展和原色块起终点；本地、远程对话连续慢拖后都能保持重排结果。

本次仅修改移动端，PC 界面与安装保持原状。[当前 APK](APK/Newmark-Agent-0.5.15-mobile-pointer-20260906.apk) 已通过 287 项单元测试、25 项设备渲染与手势测试及九项最终包导航检查，并复制到剪贴板。API 35 模拟器中的实际安装包与交付包 SHA-256 一致：`B12B10A02219C5517803548EABFDB129A66C941DE7089503A7FA455480D70895`。实际截图核验了右侧完整包边、触点泛光、文字位置和落点；交付及证据见本地归档（未纳入公开仓库）。

### PC 8px 方向反馈与更通透的弹窗（2026-09-06，已打包并安装）

按最新要求，PC 光学弹性上限调整为 8px：按下立即内缩，达到既有 300ms 长按阈值、色块开始移动时弹性恢复，之后受限外拉才向外放大；拖动松手直接恢复。弹窗默认底色不透明度维持约 56%，现有色块移动、轨道约束、落地和文字布局保持不变，移动端输入未改动。

当前 [MSI](release/Newmark-Agent-0.5.15-x64.msi) 已一次管理员提升、一次事务安装至 `C:\Program Files\Newmark Agent`；完整 `test:full-release` 返回 0，真实 Electron 时序、材质和滚动验证通过。294 个程序文件与包一致，20,982 个既有用户文件在安装期间保持不变，开始菜单已实际激活正确程序。版本仍为 `0.5.15`，本次 MSI SHA-256 为 `A94264A8D2703CC04BD769211F6BA3DF8F8D86209B1A0C6936625783EDE92F30`。详见本地归档（未纳入公开仓库）。10px 中间包和初版 8px 构建保留为历史记录，初版 8px 未安装。

Android 0.5.15 的上一修复包于 2026-09-05 19:49 完成发布构建检查及 APK 复制：[历史 APK](APK/Newmark-Agent-0.5.15-recovery-20260905.apk)。该次移动端源码未变，产物与当时设备验证通过的修复包逐字节一致；签名、对齐及包内容重新核验通过。详见本地归档（未纳入公开仓库）。

### PC 安装器修复后的历史构建（2026-09-05，已被上方构建取代）

包含下述绘制修复的历史 [MSI](release-0.5.15-frosted-safe-20260905/Newmark-Agent-0.5.15-x64.msi) 曾安装至 `C:\Program Files\Newmark Agent`，版本为 `0.5.15`。该次 294 个程序文件、产品身份及 20,965 个既有用户文件核验通过；3 组可能在重启后破坏程序的旧任务已清除，其余 15 组原样保留。普通用户 GUI 与真实开始菜单启动通过。该包 SHA-256 为 `10B5167E3B5C099A62FC80BC532FDA623AAC97143BE72557EF5505FB211F367C`，详见本地归档（未纳入公开仓库）。

安装器已修复 MSI 格式化破坏清理脚本、旧进程停止顺序及历史重启任务漏清问题；该次重封装仅安装助手资源变更，其余 293 个程序文件保持逐字节一致。此历史 MSI/ZIP 保存在 `release-0.5.15-frosted-safe-20260905/`；标准 `release/` 用于最新完成交付的构建。

### PC 均匀磨砂与菜单绘制修复（2026-09-05）

PC 弹窗改为均匀半透明磨砂材质，移除固定彩色照面和大面积明暗渐变；菜单选中色块在点击、长按、拖动及落地期间保持原色块样式。菜单边框与触控光直接绘制在滚动视口上，避免装饰 Canvas 和第二圈圆角边框随选项滚走。布局、文字、菜单 JavaScript 及现有位移时序保持不变。

已通过实际 Electron 暗亮主题截图、滚动像素比较和手势回归，详见本地归档（未纳入公开仓库）。最终 MSI 的界面和 ASAR 与该验证构建一致；最新安装状态以上方交付记录为准。

### 0.5.15 交互与首次安装恢复（2026-09-05，历史记录）

本次从旧 APK 的实际闪退重新排查：玻璃动画传入了折射引擎不支持的通用形状。浮块现使用真正的圆角外轮廓；模型与供应商横纵滑块在交互时四边各向外扩展 12dp，静态保持色块。点击、长按及提前松手均由实际移动/材质动画衔接，先到达目标再收缩落地；泛光限定在玻璃内部，触控半径为 66dp，文字不随玻璃变形。

PC 修复选中色块被 CSS 覆盖位置、轨道与弹窗争抢手势、宽浮块按百分比过度变形的问题；边缘响应上限为 5px。鼠标交互泛光关闭，触控光效、折射、边缘高光与帧合并绘制保留。

Windows GUI、CLI 和手动安装统一使用受监控的 MSI 原生 API 流程，避免含空格路径被 PowerShell 拆开及新 ProductCode 错用重装参数。同版本构建通过包哈希和安装后逐文件核验区分，不能仅凭版本号判断安装成功。

本轮逐项验收、构建与真实安装结果以本地归档（未纳入公开仓库）为准；本地归档（未纳入公开仓库）列出对应验证。Android 设备证据来自复现旧包闪退的 API 35 模拟器，尚无已连接真机。下面的旧版本记录保留为历史，不能用其中的安装结论代替本轮证据。

本轮交付已完成：[APK](APK/Newmark-Agent-0.5.15-recovery-20260905.apk) 已通过 281 项单测、14 项设备绘制测试及九项最终包导航检查，并复制到系统剪贴板；[MSI](release-0.5.15-recovery-20260905/Newmark-Agent-0.5.15-x64.msi) 已一次提升、一次事务覆盖安装至 Program Files，292 个文件和产品身份校验一致，20,956 个既有用户状态文件保持不变。开始菜单已实际启动正确程序，普通用户 GUI/IPC 检查通过。版本仍为 0.5.15，当前构建必须用上述文件路径及记录中的哈希识别。

### dev-0.5.14 启动恢复、双端时间线与 web_catch（上一发行版）

`dev-0.5.14` 修复 Windows 同版本 MSI 更新后重启可能同时损坏 GUI/TUI 的安装事务边界：升级前按安装目录终止全部 Newmark 可执行进程，并清理只指向该安装目录的待重命名/删除项；系统注销/重启进入 `before-quit` 后也不再触发 renderer reload 恢复循环。用户状态继续独立保存在 `.Newmark`，安装器不迁移或删除该目录。

PC 首轮标题在独立标题探测成功并持久化后，立即通过不进入 Build 历史的元数据事件刷新侧边栏，然后才允许首次正式 Agent 请求。Guide 回执缺失序号时使用当前 Build 尾序号，不再跳到顶部；Android 对旧 guides-only 快照按真实回执时间推断插入位置，不再强制置底。PC 运行中 Next 现直接写入会话内核，移动端可通过同一 `queueItems`/`queue_update` 看到、编辑和重排；PC 拖拽按指针越过行中点计算落点，并实时让相邻项避让。

Agent 运行时网络现在与 web 工具使用同一代理链路：PC 的模型/Validate/Editor/GitHub/Anthropic 请求和 `web_search`/`web_fetch`/`web_catch` 都通过 `proxy.enabled/url/auth` 或 `HTTPS_PROXY/HTTP_PROXY` 环境变量走 `undici.ProxyAgent`；未显式配置时环境变量回退（已修复 Agent 误传 `enabled=false` 导致屏蔽环境代理的问题），显式禁用配置优先，本机回环保持直连；Android 接受 `TRANSPORT_VPN` 网络，即使系统尚未标记 `VALIDATED` 也允许代理/VPN 线路，并禁用旧回调快照导致的等待。移动端后台同时升级为 API 29+ 的 `WIFI_MODE_FULL_LOW_LATENCY`（旧版本保留 `FULL_HIGH_PERF`），保持长连接低时延。

新增高级 `web_catch`：PC 与移动端本地 Build/Goal 可将公开 HTTP(S) 下载、整页或 CSS selector 组件资源保存到指定工作区文件。该工具默认拒绝覆盖，限制 100 MiB，拒绝本机/私网及不安全重定向；Plan/Chat 不可用。PC 基础 prompt 仅提示能力存在，完整 schema 必须经 `tool_provision` 暴露；移动端不使用 `tool_provision`，在本地 Build/Goal 直接暴露完整 schema。工具活动标签已区分：`web_search` 显示“搜索了网页”，`web_fetch`/`web_catch` 显示“抓取了网页”，PC 与移动端均生效。

`image_display` 的公开图片现在按调用顺序同时呈现在两端：Build 工具页保留原有行内/折叠证据，PC GUI、PC TUI 与移动端最终 Agent 回复还会在正文之前按 `sequence → timestamp → id` 顺序具体展示每张图片；图片仅复制自同一已校验的 `displayImage` 事件，不重复写入模型历史。

源码门禁已完成：最终 `npm run test:full-release`、Desktop build 与主验证 `1708/1708`、工具 provisioning `80/80 schema + 80/80 reachability`、TUI/GUI launcher `28/28`、带图队列/Guide 聚焦回归、Android `71 suites / 270/270` JVM 及 release APK assembly 全部通过。真实公网 `https://example.com/` 组件抓取生成 `<h1>Example Domain</h1>`，同时验证默认拒绝覆盖及 Plan 执行拒绝。Android release APK 为 `android/app/build/outputs/apk/release/app-release.apk`（66,771,458 bytes，SHA-256 `CBD98838B95344F0C6262165928DFFA6B19C57574B74F2B0B2D5AE245B981470`，当前使用 Android Debug 签名）。免安装 unpack 已构建并完成 packaged SSH/TUI、CLI、上下文压缩、console-wrapper、asar/图标和 ZIP 冒烟；同时生成但未安装 0.5.14 MSI。仍未执行真实 Windows 重启后的安装态 GUI/TUI 黑盒复验，因此不把源码诊断替代为安装态结论。

全平台 `dev-0.5.14` 六个资产已生成于 `release-0.5.14-full-platform/`：

| 资产 | 大小（bytes） | SHA-256 |
| --- | ---: | --- |
| `Newmark-Agent-0.5.14-x64.msi` | 246,488,754 | `9576F6D5902CBFEC1ADFAF0B322ACFDDB4F6BD1B3610DCCC2A2A748EC95C8969` |
| `Newmark-Agent-0.5.14-win-unpacked-x64.zip` | 321,603,037 | `68541B0A44F2788CCC06C232721080DDAC7534A4197DB508229AEB7BB72EAEF1` |
| `Newmark-Agent-0.5.14-x86_64.AppImage` | 217,240,535 | `02818508563A229DDC57F2F64541D6538DB1B0C0688807BC75D34CE0BEBB685A` |
| `Newmark-Agent-0.5.14-amd64.deb` | 166,895,176 | `D478F4E3D4F8B036B0D438997E5229F3F737C34987D70FCBCBA69EDB58F6DA80` |
| `Newmark-Agent-0.5.14-linux-unpacked-x64.zip` | 212,960,786 | `B1035B594CF7B843355D7034FE811DEBA6DFED267A5DC993F71404E39DE055CC` |
| `Newmark-Agent-0.5.14-android.apk` | 66,771,458 | `B609B36B382E7753A98789A8B415C5478142975AAE6E5F6C160F65A630A628F9` |

### dev-0.5.13 双端累计改动 r5 APK + Windows MSI（上一发行版）

PC 与 Android 当前 `0.5.13` 累计源码已完成一致性核验。桌面端 typecheck、build 和完整 `test:full-release` 通过，其中主验证 1702/1702、thinking tier 压力 68/68、压缩压力 34/34、模型恢复压力、TUI、真实 loopback SSH、WSL TUI、CLI 与 GUI/TUI/CLI 三端压力均通过；无供应商标题门禁错误同时保留 `No LLM configured` 可操作诊断。`pdf_read` 的 1–120 秒预算现在覆盖异步文件读取、pdf.js 全文解析和扫描页浏览器观察，任一阶段超时都返回可恢复工具回执并允许同一 Agent 继续给出正式响应。Android 首轮标题探测与正式首轮共享冻结的 provider/model/intelligence/native reasoning 映射；新增 `image_inspect` 可把安全工作区或已授权文件 URI 的有效 PNG/JPEG 一次性送入当前冻结视觉模型，图片字节不写入工具文本或持久历史。Android Responses 聚焦 32/32、69 suites / 267/267 JVM、Vital Lint、R8、资源收缩及隔离 clean Release assembly 通过。当前 Android 交付包为 `APK/Newmark-Agent-0.5.13-dual-platform-final-r5-release.apk`，大小 52,794,422 bytes，SHA-256 `C87DFA53B309D4FE1790FCB5F1EB2084F67BE6E44FC27D76D5E8E4E84A30A14B`。

Windows 当前交付包为 `release-0.5.13-r5-title-retry-msi-20260902-3/Newmark-Agent-0.5.13-x64.msi`，大小 249,629,109 bytes，SHA-256 `AD9427B36178473BAF461C63119D14B5DF1B27EC510205205DD991845ECEE462`；配套 `win-unpacked` zip 为 326,302,457 bytes，SHA-256 `91644890407C4C7A1F8BC8F84FEAB5D55F3B71D66517EDA7F744D71A0D97C803`。PC 首次标题探测已加入 0s→1s→2s→4s→8s 的 5 级自动退避重试，空响应或模型原样重复用户输入都会自动重试，不再要求手动再次发送。MSI 已通过打包后 CLI、上下文压缩与 console wrapper 压力，并在 UAC 提升下安装成功；已安装 `app.asar` 和关键 EXE 与 `win-unpacked` 哈希一致，注册表版本 `0.5.13.0`。

移动端 Markdown/LaTeX 渲染已内置 Noto Sans Math 与 Noto Sans Mono CJK SC 两套离线字体：数学符号、箭头、CJK、代码框线均不再依赖设备字库；Markdown 代码块改为在父级约束内 `softWrap=true` 自动换行，不再用横向滚动占满无限宽度。代码高亮 token 也已修复：原占位符把索引写成数字，会被数字高亮正则二次命中并残留 PUA/方框；现改为私用区字符索引，字符串/数字/关键字高亮不再破坏原文。语法高亮改为主题语义色板：暗色保持原有观感，亮色下绿色字符串改为 `#1B7F3B`，关键字/注释/数字/类型/tag 也换成浅底可读色。当前候选 `APK/Newmark-Agent-0.5.13-mobile-md-font-r8-release.apk`，66,686,998 bytes，SHA-256 `05A26E0EE66541F656E39412384A689B06AAA2A4ABA363043516C2B862D6A1FE`；r7 保留为亮色高亮修复前回滚候选，r6 是更早的高亮 token 修复前候选，r5 仍未包含字体适配。

全平台 `dev-0.5.13` 发行名为 `dev-0.5.13`，Release 标题统一为 `Newmark Agent dev-0.5.13`，六个资产：

- Windows MSI：`E540A110453BC2F5647FFA9839C47BA85588E7281B3070EEEAA93AFC1AB40C67`
- Windows ZIP：`CA6C20CF521FA3AD02BABE40C6F50557B72750F241FED641F8B7036D0853EE9C`
- Linux AppImage：`165C0A2244FCADF482B09B207493705BB05725397C570A90AE34DA1C62EBCA67`
- Linux Deb：`829B25C520EE6FB7BF33A47E8DECB95D36386EA0FBCB8579BDCCBEFA69C153A1`
- Linux ZIP：`1622B63C6ABC5320D2353850B852288F73455346407221955627A555845D94E1`
- Android APK：`05A26E0EE66541F656E39412384A689B06AAA2A4ABA363043516C2B862D6A1FE`

远端核验已完成：`verify-github-release-assets.cjs` 下载六个发行资产并用远端 SHA-256 与本地逐一比对，六项大小和哈希全部一致；Windows ZIP/MSI、WSL AppImage/deb/ZIP 打包态 smoke 以及 packaged dev-0.0.8/dev-0.0.9 feature smoke 全部通过。Tag/Release 审计脚本检查本地 60 个、远端 59 个正式 Tag，远端名称均符合 `dev-<major>.<minor>.<patch>`，Release 标题均符合 `Newmark Agent dev-<version>`；本地额外保留的历史未发布 `dev-0.5.5` 未推送到远端，本次发布不包含该 Tag。

APK 已核对包名 `com.newmark.mobile`、版本 `0.5.13` / `513`、compileSdk 36、minSdk 24、targetSdk 36、可启动 `MainActivity`、四 ABI、`specialUse` 前台服务、`stopWithTask=false`、4-byte/16 KiB 对齐与 APK Signature Scheme v2。逐 Zip entry 字节扫描未发现开发者 profile/workspace、其他用户目录、Bearer/API Key 或私钥材料；裸数字 `12252` 只命中 6 个 vendor 文件，4 个来自 PDFBox CMap、2 个来自 BouncyCastle SIKE 常量，4 ABI 的 ML Kit 库只含第三方通用 `/home/build` 标记，均不是开发机路径。安装者运行时仍可显示其本机实际 `user/.Newmark` 位置。该包使用工程既有 Android Debug 证书，适合开发预览/侧载，不是 Google Play 生产签名。API 35 `emulator-5554` 冷启动恢复在线后执行 `adb install -r` 成功；显式重启 `MainActivity` 后 2 秒与 7 秒均为 topResumed，PID 3173 保持不变，目标进程 FATAL/ANR 为 0。该冒烟不替代设置玻璃逐帧、真实供应商、配对 PC stdio bridge及真机锁屏/切网/划走/长时后台验收。

### dev-0.5.13 移动端设置返回按钮玻璃画布修复

移动端设置主页及全部子页共用的 36dp 顶栏返回按钮已改用 `GlassButtonCanvas`。按钮的布局、命中区、图标、主题色与逐页返回逻辑保持不变，仅将折射边缘、高光、阴影和按压浮起绘制到四周 8dp 的透明光学子层，避免玻璃反馈被按钮自身 RenderNode 画布截断。

回归测试同时约束共享设置顶栏必须使用外扩画布、不得退回直接在 36dp 节点调用 `glassButtonSurface`。修复已进入上述当前 r5 APK，但仍不声明设置返回按钮的真机逐帧视觉验收。

### dev-0.5.13 双端内置 Search MCP 搜索池

PC 与 Android 的 `web_search` 已接入独立的 search-only MCP 兼容层。桌面端每次调用都重新读取安装者本地 `user/.Newmark/search-mcp.json`，按优先级完整探测本轮所有启用节点，再选择最高优先级成功结果；旧健康结果不会形成熔断或跳过。固定容灾顺序为 Search MCP 池 → Bing HTTP → DuckDuckGo HTTP。

Wuxing Search MCP 已随 Desktop 内置，但它依赖可访问的 SearXNG；默认探测环境没有该前置服务，因此不会伪装成健康节点或默认启用。当前唯一通过真实 initialize → tools/list → tools/call 并默认启用的是 `@ignidor/web-search-mcp`。双端只允许带字符串查询字段且不含命令、文件、脚本、请求体等危险参数的公开网络搜索工具；MCP 输出限制为 60,000 字符。每轮健康状态原子刷新到安装者本地健康文件，仅用于观测，永不作为下一轮跳过依据。

Android 可直接连接用户配置的 Streamable HTTP/SSE Search MCP；stdio 节点通过已配对 PC 的 Bearer 认证 MCP-only bridge 执行。该 bridge 不会提前执行 PC 的 Bing/DuckDuckGo HTTP 退路，因此全局顺序保持为所有桌面/移动 MCP 完整轮询后才进入 Android Bing，最后 DuckDuckGo。公开清单不返回 stdio command、args、cwd、密钥值或开发机路径。

### dev-0.5.13 移动端供应商协议切换与 OpenAI Responses

移动端“模型与供应商”现在把请求协议作为供应商自身的显式配置：新建供应商、模糊注入和既有供应商详情都可在 OpenAI Chat、OpenAI Responses、Anthropic 与 GitHub Models 之间切换。选择 Responses 后，本地 Agent 直接请求 Responses 端点；官方 API 根地址会补成标准 `/v1/responses`，已填写 `/v1`、`/v1/chat/completions`、完整 `/v1/responses` 或兼容网关自定义前缀时则保留其路径语义。Responses 流继续解析思考摘要、正文、拒绝文本、函数调用和参数增量；流式 `response.completed` 的内嵌状态和非流式 JSON 都只接受明确 `status=completed`，`failed`、`incomplete`、`cancelled`、`queued`、`in_progress`、未知或缺失状态均作为失败，并保留 `incomplete_details.reason` 供受控诊断。

协议字段随 `ProviderConfig` 持久化；旧的 `responses`、`openai-compatible`、`claude`、`github` 等别名在读取、保存、设备目录合并和 Agent `settings_update` 全量替换边界统一迁移为规范值，其他供应商字段、模型列表和本地 API Key 保持不变。

### dev-0.5.13 移动后台断流复查

真机仍出现 `Software caused connection abort` 后，代码与既有测试复查确认：后台前台服务、Wake/Wi-Fi lock 和服务级运行 Job 已进入 APK，但本地模型 SSE 的恢复只允许发生在“尚未收到 thought/text”的阶段。推理模型一旦先输出任何思考或正文，随后后台网络切换导致 SocketException，当前状态机会为避免重复正文/工具副作用而直接终止，并把原始异常显示给用户。因此当前后台强化只解决生命周期所有权，没有闭合部分流式输出后的可恢复续接。

次级缺口包括：网络恢复只检查 `NET_CAPABILITY_INTERNET`，没有等待 `VALIDATED`，可能在路由尚未真正可用时过早重试；`START_STICKY` 重启服务时没有持久运行检查点，进程被 OEM 杀死后无法恢复原 Agent；现有后台测试主要是源码结构断言与前台 MockWebServer，没有真实锁屏/网络切换覆盖。当前无 ADB 设备，尚不能取得发生故障手机的 logcat、系统电池策略与已安装 APK 指纹，因此本轮只声明代码根因与验证缺口，不声明设备侧诱因已经唯一确定。

### dev-0.5.13 移动后台强化 APK

后台强化版 Android Release APK 已重新打包至 `APK/Newmark-Agent-0.5.13-background-agent-service-release.apk`，大小 52,761,654 bytes，SHA-256 `AD2BE3FD29F7A38CB7F7FC9E2A44744B34BDE25A8906D78C36868283FE3FB04C`。包名为 `com.newmark.mobile`，版本为 `0.5.13` / `513`；最终 Manifest 已核对 `specialUse` 前台服务、Wi-Fi 状态权限、长期 AI Agent 网络会话 subtype 与 `stopWithTask=false`。230/230 项 JVM 测试、Vital Lint、R8、资源收缩和隔离 Release assembly 通过，APK Signature Scheme v2 验证通过。

该 APK 使用工程既有 Android Debug 证书，只适合开发预览/侧载，不等同于商店生产签名。当前 ADB 无连接设备，因此尚未声明真机锁屏、划走任务、网络切换或 30 分钟后台长运行验收；Google Play 分发前仍需申报 `specialUse` 前台服务用途。

### dev-0.5.13 PC 中断后 Agent 回复恢复候选

PC 对话在 Build 被中断后，会把该运行最后一条非空公开 `response` 恢复为 Build 块外独立的“Agent回复”；同一正文不会再在展开 Build 中重复。未产生公开回复的中断仍只显示 Build，不伪造 Agent 内容。实时中断、切换对话和重启后的历史恢复使用同一规则。

源码门禁为 Desktop typecheck、build、聚焦 UI 回归及 1685/1685 主验证全部通过。修复候选位于 `release-0.5.13-pc-agent-response-fix/`：MSI 为 243,911,093 bytes / SHA-256 `5A6A38326D5A1180160C8B8A0434F0C6721D04B241DB2DB9A403BBB55227F03F`，ZIP 为 317,510,279 bytes / SHA-256 `D20196BACCDCFB1BCDD613EB3D0ED538F08DDEEA0B4D07E86B7C566C7A1AC622`，`app.asar` 为 196,528,014 bytes / SHA-256 `73ED089782AA5774974D54FC7BBD2054370912E4835295B8A6E307A38F141427`。发行包内已直接核对三处关键恢复逻辑；MSI 未签名。

本机覆盖安装尚未完成：2026-09-01 两次 UAC 启动均由系统返回“操作已被用户取消”，Windows Installer 未创建安装日志，Program Files 中仍是此前的 0.5.13 构建。安装尝试前后用户 `.Newmark` 的 20,873 个文件、335,810,138 bytes 及全量聚合 SHA-256 `195FF9B3709A10D310C0CD2E2C9B3FD369A5D8456D4E3F957A204B23DBE73282` 完全一致；旧版客户端已重新启动且 5 个已采样进程均响应。

### dev-0.5.13 运行时稳定性、工作区图片视觉与发行隐私

Agent 现在可通过扩展后的 `image_inspect` 将活动工作区内经过校验的 PNG/JPEG 作为一次性视觉观察交给当前已验证视觉模型；图片限制为 10 MiB、40MP，图片字节不会进入公开工具文本或持久历史。

`pdf_read` 的扫描页浏览器观察新增默认 30 秒、可配置 1–120 秒的工具级超时。超时只返回可恢复回执，不再中止整轮 Agent 响应。PC 长运行期间的局部状态快照若未携带 `chatMessages`，不再把当前可读对话重绘为空，修复对话区暂时消失后又恢复的问题。

发行应用可在运行时展示安装者本机的实际 `user/.Newmark` 配置位置，但发行源码、TUI 演示数据和辅助脚本不得包含开发者电脑用户名或绝对路径。

### dev-0.5.13 PC Build 展开按压暗色修复

PC 对话中的 Build 展开/折叠标题在暗色模式按住时继续保持透明时间线，不再回退到 Chromium 原生白色按钮背景。修复不改变展开状态、内容布局、折叠箭头、键盘按钮语义或既有无动效规则。

验证已覆盖 Desktop 编译、1676 项主断言、PC 玻璃聚焦契约与真实 Electron 暗色按住态；按住帧计算背景为完全透明，并保存视觉证据到 本地归档（未纳入公开仓库）。本轮未构建或发布安装包。

### dev-0.5.12 全平台预发布

2026-08-31 已发布 [dev-0.5.12](https://github.com/positer/Newmark-Agent/releases/tag/dev-0.5.12)。Windows MSI/ZIP、Linux AppImage/deb/ZIP 与 Android APK 共六个资产均通过版本和打包态门禁，并从 GitHub Release 回下载逐项复核 SHA-256。Windows 资产未做 Authenticode 签名；Android APK 使用工程既有 Android Debug 证书并通过 v2 签名验证，因此本版本保持 prerelease。

| 资产 | 大小（bytes） | SHA-256 |
| --- | ---: | --- |
| `Newmark-Agent-0.5.12-x64.msi` | 226,408,528 | `9DE63C48F2A0C8697F19914DA3D57E675293F5701D107A68ED22414FCA6AC3A7` |
| `Newmark-Agent-0.5.12-win-unpacked-x64.zip` | 292,565,363 | `C58044D6E31DD4D5AA16E9957778BB015E5BD66DB3BDA5E1D1C6B0F53757CFED` |
| `Newmark-Agent-0.5.12-x86_64.AppImage` | 176,667,824 | `76079D996F06C90336E32CEFD2D12E527E4293F0AFBFB0565941BD8C18D3F9EA` |
| `Newmark-Agent-0.5.12-amd64.deb` | 136,046,472 | `ABCFDD787C2DE341E8426C0AA848CDEC4D8585F89BDD9D8476BDA95081BF7E7F` |
| `Newmark-Agent-0.5.12-linux-unpacked-x64.zip` | 172,791,270 | `6241FC007ED19B07366086179F357271214E79E7EFD74D28A66D2D83346B3845` |
| `Newmark-Agent-0.5.12-android.apk` | 52,761,506 | `65241093432AFD18B167B9A7C48FB059E568BF7763B1624D5267D2329082C000` |

### dev-0.5.12 队列用户输入可见性修复

排队后自动执行的真实用户输入不再继承 Agent 内部续接的隐藏标记；消费队列时保留普通用户可见语义，同时继续隐藏无 client id 的内部自动续接指令。

### dev-0.5.12 压缩后连续图片输入

内部上下文压缩后，近期窗口内连续提交的多张用户图片全部保留，避免视觉模型只收到最后一张图片。

Newmark Agent 是面向本地工作区的多端 AI Agent。它把对话、Build/Plan/Goal/Flow、文件与终端、浏览器、Memory Lab、自动化和多 Agent 协作整合在同一套本地状态模型中，并提供 Windows/Linux 桌面端、终端界面、CLI 与 Android 客户端。

当前开发版本：`dev-0.5.15`。本版修复移动端本地 Agent 退出/重建后的对话追踪与恢复，统一双端液态弹窗材质和弹窗内选项直接色块交互，并把模型/供应商浮块边带增厚、左侧栏浮块右移、提交图标改为主题语义色。桌面端与 Android 从根目录 `VERSION` 读取并校验同一个版本。

dev-0.5.11 同时优化 PC 冷启动。历史生命周期 marker 不再由 `Agent` 构造函数同步逐个读取，而是在轻量启动页显示后按批异步清理；正常退出直接删除当前 marker，避免运行目录随启动次数线性增长。历史日志基线为 Agent 8.122s、主界面 14.974s；在 1000 个旧 marker 压力下，当前实测轻量启动页 721ms、主页面导航 2567ms、输入可用 2772ms，Windows 进程无响应采样为 0，目录最终仅保留当前进程 1 个 marker。

本轮 Android Release APK 位于 `android/app/build/outputs/apk/release/app-release.apk`，大小 52,750,472 bytes，SHA-256 `9E10F3FB8E20EB138FE7E16C699BC5767534865FD065BE27B9115673453D2EBC`。JVM、Vital Lint、R8 与 Release assembly 通过；本轮未安装到真实设备，因此不声明真机视觉验收。

dev-0.5.11 保持输入栏与 Memory Lab 按钮的原布局尺寸、命中区和锚点不变，只扩展内部光学子层。Agent 运行且输入框非空时，移动端不再复用空闲渐变发送键，而是使用 PC `running-action` 同款深色/浅色玻璃、旋转 marquee 边框与 Send 图标；输入为空时仍显示 Square/OctagonX 停止态。

移动端“模型与供应商”在 dev-0.5.11 同时补齐常规手动创建路径。供应商列表提供“新建供应商”，可填写名称、OpenAI/Anthropic/GitHub Models 协议、API 接口与可选 API Key；保存后直接进入供应商详情。详情内提供独立“新建模型”页面，可配置模型标识、显示名、上下文长度、描述、视觉与思考能力。手动创建、模糊注入和远程拉取共用既有 PC 兼容 `ProviderConfig`/`ModelConfig` 与 `ProviderStore`，没有分叉配置格式。

模型与供应商子页的纵向交互现在只保留胶囊浮块，不再绘制无功能的独立轨道或预留左侧空白。点击导航项必须完整播放浮起与并行移动，待落下完成后才进入新页；新建供应商和模糊注入中的横向协议浮块与纵向浮块共享互斥协调器，任一方向占用期间另一方向不能起飞。纵向移动遇到协议横轨时会在边界前落下并从另一侧重新浮起，不允许穿越横向浮块。

dev-0.5.10 的 PC 固定玻璃按钮已改为唯一浮块绘制：按住期间源按钮仅保留布局与命中框，原文字、图标、实体/渐变色块、边框、阴影及前后伪元素全部停止绘制；完整浮起和落下结束、源按钮恢复后才派发原点击。该事务在取消、失焦、页面卸载和超时路径都执行幂等清理，避免浮窗重建后按钮永久消失。

本机已生成并安装 `Newmark-Agent-0.5.10-x64.msi`；安装版注册表、CLI、GUI 和 `app.asar` 边界均通过验证。Android Release APK 已通过 JVM、Vital Lint、R8 和签名验证；当前 APK 使用工程既有 Android Debug 证书，不属于商店正式签名。

### dev-0.5.9 移动端工具 help 与 settings_update 修复

`settings_update` 现在使用原生结构化参数：只切换模型时传 `active`，修改供应商时传完整 `providers` 数组；不再要求模型猜测二次 JSON 转义。所有移动端本地工具均声明闭合对象 schema、字段类型、必填/可选关系、权限前置条件、副作用与返回语义。普通 Build、Plan、全文件/应用授权以及 Root、Shizuku、ADB 高权限工具通过同一完整性契约检查。旧版 `json` 字符串包装仍由执行器兼容，六档 intelligence 也与设置执行器保持一致。

写入工具进一步改为局部优先：`settings_update` 支持单个 provider/model upsert/delete 和 active 字段 patch，未提供字段保持不变；`memory_lab_update` 支持按 component 修改单个元数据字段、追加正文或唯一片段替换；内部与共享存储文本工具支持 overwrite/append/replace 以及 SHA-256 并发保护。旧 providers 全量替换和全文写入仍兼容，但不再是推荐调用。任务工具原本就是单项增删改，日历/闹钟为单次系统 Intent，reindex 的全量工作仅在设备内部完成，审计后无需改变。

移动端 Memory Lab 的界面“重建索引”按钮与本地 Agent `memory_lab_reindex` 现共用同一存储层规范化器，并与 PC 对齐中英同义词/近义词合并：根据 `preferredLanguage` 选择主标签、把其余名称保留为 aliases，并同步改写组件 tags/tagPaths。PC 写入工具审计同时将 `memory_lab_update`、`flow_save` 与 `linked_plan` 改为局部优先；Automation、Task、Goal 和普通文件编辑原本已是字段/条目/片段级更新，无需重复改造。

移动端交互材质也完成收口：包括设置页在内的全应用同时关闭 Foundation indication 与 Material3 ripple。右边栏和 Memory Lab 不再出现会压灰浅色玻璃表面的圆形/矩形灰色涟漪；Memory Lab 的新增、重建、关系模式、清除和重置按钮统一为 Newmark 玻璃操作胶囊，按压只显示向外浮起的折射边缘。移动端不再提供自定义调色或调色板配置；仅保留产品内置的固定深色/浅色语义主题色，并以 `ThemeColors` 命名避免误解为用户可编辑配色。

移动端“排队对话”面板采用独立的无边框操作语言：暂停/继续、展开/折叠、立即 Guide、编辑与删除按钮静止时均无描边和底块，按压只显示短促的同色晕染、轻微上浮与放大。面板标题同步显示运行/暂停状态点与待处理数量，队列行增加更稳定的留白和弱层次底色，同时保留长按拖动排序与全局无 MD3 涟漪边界。

移动端所有玻璃浮块的边缘厚度统一增加 1dp：主交互浮块折射/色散边带由 6dp 调整为 7dp，独立弹窗类由 4dp 调整为 5dp，开关按压浮块由 8dp 调整为 9dp；轻量玻璃按钮的 Kyant 高光包边也同步增加 1dp。RGB 色散与折射共享同一 `refractionHeight`，避免包边、高光、色散和折射出现宽度错层。

移动端归档对话现在在胶囊退场后使用 LazyColumn placement animation 平滑补位，下方对话不再瞬移。玻璃点击生命周期也统一为强制完整播放：浮起与移动可以并行，但只有浮块达到完整大小且移动完成后才开始落下；普通 +、远程设备、Memory Lab 与左栏新建本地对话等玻璃按钮即使快速点按，也会完整播放 105ms 浮起与 165ms 回落，连续点击按次排队。输入区不再裁剪 + 按钮的外扩玻璃边缘。

玻璃按钮的画布截断已在 vendored Kyant 底层统一修复：边缘型按钮玻璃关闭内部“按按钮形状裁剪整个离屏层”的策略，高光离屏画布按实际描边宽度与模糊半径动态外扩，不再固定为按钮等大的方形画布。该修复覆盖 Chat、Memory Lab、左右侧栏、设置与终端共 33 处 `glassButtonSurface` 调用；完整玻璃面板仍保持 shape 裁剪，不会泄漏背景内容。

紧凑玻璃控件使用独立的透明光学子层，不再依赖按钮等大的 RenderNode。共享 `GlassButtonCanvas` 的父布局尺寸始终等于原按钮尺寸，8dp 外沿只通过 `requiredSize` 子层溢出绘制，用于容纳 7dp 折射/色散边带、模糊高光、阴影与浮起；绝不改变输入框厚度、padding、按钮间距、锚点或点击范围。左栏新建本地对话、对话顶栏远程设备/新对话，以及输入框的模式与文件/模型/发送或停止按钮已接入。

PC 与移动端共同新增与 Build/Plan/Goal/Flow 并列的 Chat 模式，移动端本地对话可直接选择。Chat 是严格的联网取证模式：模型工具面只包含 `web_search` 与 `web_fetch`，执行边界也会拒绝旧上下文或隐藏调用中的文件、终端、浏览器控制、设置、Memory Lab、任务、应用和系统权限，因此没有任何写入通道。Agent 被要求先联网搜索、必要时抓取权威原文，证据充分后尽快总结回答并附可用来源，不延展成长任务。移动端排队面板同时去掉“排队对话”标题，只保留“n 条待处理”状态字段。

### dev-0.5.9 全平台预发布

2026-08-27 已完成 `dev-0.5.9` 本地发布候选构建与独立验收。Windows MSI/ZIP、Linux AppImage/deb/ZIP 和 Android APK 共六个资产均通过打包态 smoke；Linux 三包在 WSL/Linux 中实际启动 GUI 并验证 Bash/sh 会话。Android APK 通过 v2 签名验证，使用工程现有 Android Debug 证书；Windows 资产未做 Authenticode 签名，因此本版本作为 prerelease 发布。macOS DMG 仍需 macOS 构建主机，不属于当前六资产矩阵。

| 资产 | SHA-256 |
| --- | --- |
| `Newmark-Agent-0.5.9-x64.msi` | `41635EA64A0B1F72FE5775CFE8F2A67AACB854B14A5997FC725C2072FAA5B9CF` |
| `Newmark-Agent-0.5.9-win-unpacked-x64.zip` | `F5267709EA4EC44D5057C19F06DA04F84CE3C2B89D34A3B2CF77FBF677F30D12` |
| `Newmark-Agent-0.5.9-x86_64.AppImage` | `BA6FD827E627B961A077A3F9474CC885B8056A872A2DE32807CF070E1C4C47AB` |
| `Newmark-Agent-0.5.9-amd64.deb` | `350B61D352136B37857A9CFF6442BAB2CF0EEC37B1773217AD4E92B72535AB57` |
| `Newmark-Agent-0.5.9-linux-unpacked-x64.zip` | `BD6E6CB7959AC2A0A991D8D55FF485ECFF77B8746FFE9E1D32B14BDEFB2D4BA6` |
| `Newmark-Agent-0.5.9-android.apk` | `2BA403506ACC39B58DAFFE1AECBE53715C58302AD4B643B3AB7C448E7F8FADB3` |

当前 Android `dev-0.5.7` 已统一移动端液态选择器：点击播放完整的源选项浮起、移动、落下动画，连续点击会让唯一浮块从当前帧改道到最后目标再落下；拖动必须先静止按住 300ms，之前超过触摸阈值的移动不消费并交还列表/侧栏滚动。会话、左右侧栏工具/分页和 Memory Lab 分页共用这一规则；本地/远程对话的点按飞行与长按排序共用唯一玻璃浮层，胶囊四边固定外扩 6dp，飞行、跟手与落下全程按实时速度产生沿运动方向拉伸、垂直方向收缩的液态形变，折射随外形同步。拖动期间列表实时空出落点，未位移松手才打开操作菜单。PC 与移动端二态开关统一为“点击直接反转、确认水平拖动后才按松手位置吸附”，纵向滚动不触发开关。Release APK 仍以 `android/app/build/outputs/apk/release/app-release.apk` 为本地验证产物。

## 主要能力

- Electron GUI、`Newmark --TUI` 与 `Newmark --cli` 共用工作区、对话和运行时契约。
- Build、Plan、Goal 与 Flow 支持长任务、队列、暂停/恢复、上下文压缩和可追溯 WorkRun。
- 文件、终端、编辑器、浏览器、Computer Use、Git/GitHub、SSH、MCP、技能、自动化与 Memory Lab 均受策略边界约束。
- 模型按供应商部署隔离；同名模型不会共享凭据、验证状态或路由证据。
- Android 支持本地对话、Agent 可调用的工作区终端、本地工具、Memory Lab、系统日程读取/创建与系统分享接收，也支持配对桌面端后的远端对话、文件上传和工作区操作。
- Android 设置中的“读取所有文件”和“读取应用列表”是 Agent 工具面的硬开关。关闭文件开关时只暴露内部 `files/newmark/workspace` 安全目录；开启后跳转 Android 系统授权页，应用内开关与系统授权同时有效才开放最新文件/共享存储工具。应用列表同样要求应用内开关与系统“使用情况访问”授权同时有效。两项都不依赖 Root/Shizuku。移动端冷启动默认恢复上次本地对话，远程对话仅在用户主动选择设备后进入。
- Android 本地 Agent 在兼容服务拒绝 Chat Completions 的“工具 + 推理强度”组合时，会自动切换到 Responses API；若模型明确不支持 `temperature`，会移除该参数重试并继续流式呈现思考、正文与工具调用。
- 新安装不预置供应商或密钥；用户自行添加供应商，升级不会清除已有配置。

## 下载与安装

从 [GitHub Releases](https://github.com/positer/Newmark-Agent/releases) 下载与系统对应的构建：

| 平台 | 发布资产 |
| --- | --- |
| Windows | `Newmark-Agent-<version>-x64.msi`、`Newmark-Agent-<version>-win-unpacked-x64.zip` |
| Linux | `Newmark-Agent-<version>-x86_64.AppImage`、`Newmark-Agent-<version>-amd64.deb`、`Newmark-Agent-<version>-linux-unpacked-x64.zip` |
| Android | `Newmark-Agent-<version>-android.apk` |

Windows MSI 为整机安装包；便携 ZIP 解压后即可运行。Linux 可选择 AppImage、Debian/Ubuntu 安装包或解压版。Android APK 需要允许当前文件来源安装未知应用。当前发布属于未签名或开发签名的预发布构建，请从项目 Release 页面下载并核对发布资产。

## 远端触及与 Tailscale

远端触及功能需要桌面端和 Android 端协同使用 [Tailscale](https://tailscale.com/) 虚拟组网。两台设备应加入同一个 tailnet，桌面端开启 Remote Touch 后，再使用配对二维码或 Tailscale 地址连接。

建议配置：

1. 在电脑与 Android 设备安装并登录 Tailscale，确认双方处于同一虚拟网络。
2. 在桌面端开启 Remote Touch，或使用 `Newmark.exe remote on`。
3. 使用 `Newmark.exe pair` 显示配对二维码，并由 Android 客户端完成配对。
4. 确保系统防火墙允许 Newmark 使用 TCP `47890`；不要把该端口直接映射到公网。

普通局域网在路由可达时也可连接，但跨网络、移动网络和异地设备应使用 Tailscale。配对令牌与供应商密钥属于私密数据，不应进入截图、日志或仓库。

## 使用

启动桌面 GUI 后，可在设置中添加供应商、模型与工作区。终端入口：

```text
Newmark --TUI
Newmark --cli --help
```

常用 CLI：

```text
Newmark.exe validate-models --selected provider/model
Newmark.exe memory-lab --help
Newmark.exe pair
Newmark.exe remote status
```

用户配置、凭据、对话、缓存和归档默认位于：

```text
~/.Newmark/
```

仓库中的 `DESKTOP/config.example.json` 仅用于展示配置结构。不要提交真实 `config.json`、API Key、配对令牌或生成的用户数据。

## 开发

桌面端需要 Node.js 24 与 npm：

```powershell
cd DESKTOP
npm ci
npm run build
npm run test:full-release
```

Android 需要 JDK 17 与 Android SDK：

```powershell
android\gradlew.bat -p android testDebugUnitTest lintVitalRelease assembleRelease
```

修改版本时使用唯一版本同步命令：

```powershell
cd DESKTOP
npm run release:version-set -- 0.5.2
npm run release:version-check
```

默认完整发布打包：

```powershell
cd DESKTOP
npm run release
```

该命令执行桌面端完整门禁、Android 单测与 Release lint，并在根目录 `release/` 生成 Windows MSI/ZIP、Linux AppImage/deb/ZIP 和 Android APK。推送 `dev-X.Y.Z` 标签时，GitHub Actions 会独立构建三端并把同版本的六个资产发布为 prerelease。

### dev-0.5.8 全平台预发布

2026-08-27 已发布 [`dev-0.5.8`](https://github.com/positer/Newmark-Agent/releases/tag/dev-0.5.8) prerelease。完整发布流水线、本地独立资产 smoke、GitHub 三平台构建和远端回下载验证全部通过；远端六资产的名称、字节数与 SHA-256 均和本地验收候选一致。Windows MSI/ZIP、Linux AppImage/deb/ZIP 完成打包态启动验证，Android APK 通过 v2 签名校验。当前 Windows 包未做 Authenticode 签名，Android APK 使用工程现有 Android Debug 证书，均属于预发布测试构建。本机没有 macOS 原生签名/打包环境，`dist:mac` 需要在 macOS 主机另行生成 DMG。

同日 Windows x64 MSI 已通过 UAC fresh install 验证：安装版 CLI 返回 `0.5.8`，安装目录 `app.asar` 与发布包字节及 SHA-256 完全一致，既有用户配置保持不变，安装版 GUI 启动并保持响应。

| 资产 | SHA-256 |
| --- | --- |
| `Newmark-Agent-0.5.8-x64.msi` | `669E808882DADF7790FA4D929E3A42C5717566073A6ECB1EDE7002005BF031E0` |
| `Newmark-Agent-0.5.8-win-unpacked-x64.zip` | `6D037DAB8664D4A75FA2FEE73322A1D9835F9F4DB340ED0BB4858836EFDED555` |
| `Newmark-Agent-0.5.8-x86_64.AppImage` | `FCF25AB45D8C4F6F5FD876C14654E48C4C9653AE7FB864F1EAB52AA24BE18F5F` |
| `Newmark-Agent-0.5.8-amd64.deb` | `C75FE9834F7CD2EF69B024C93BF14B366EB98AFDA2F958BC870A4C9029020EEA` |
| `Newmark-Agent-0.5.8-linux-unpacked-x64.zip` | `27236779B69E299C43652A5F5448A33C9B1AF8F05920E09EAFB2CD15DCE2CF8B` |
| `Newmark-Agent-0.5.8-android.apk` | `F514C919411DD2D84214B54024D7CF6D9EB25692E35F7D5465FF8FC08188325F` |

## 架构

### dev-0.5.7 corrective release

PC interaction glass uses one 6px geometry token for both the outer edge and dispersion band. Its command runs synchronously on pointer release while backdrop capture and the 120ms shrink/fade landing remain non-blocking; transcript block, tool, and review disclosures do not create floating glass. Light-theme settings/modal carriers are brighter without changing the already-correct PC sidebar.

PC light-theme sub-windows opened from the left tool rail (Plugins, Memory Lab, Automation, Flow, workspace dialogs, and Settings) now share the same bright carrier surface. While a mouse press remains active, selector glass listens at window capture scope and continuously projects the pointer onto its horizontal or vertical track even outside the source control; native conversation drag glass is likewise updated from document-level drag events outside the conversation list.

PC click-driven selection glass now reserves the complete visual lifecycle: 360ms for lift/track movement and 180ms for the shrink landing. The logical command still commits immediately on release, while an actual pointer drag removes the click pacing class and retains the faster direct-follow response.

PC conversation and selector glass now applies RGB dispersion across the complete fixed 6px refractive edge instead of cancelling the effect on the capsule center axes. Scrollable selector popups restrict tracking to their visible option track and clamp the float inside the visible popup bounds. On release, the float freezes its final geometry before dispatching the command, so a command that closes the popup cannot erase the landing target or leave a stuck float flying toward the viewport origin.

PC conversation capsules now make the floating glass the sole edge owner: static borders and marquee borders are hidden while covered. Conversation and selector clicks share one serialized visual transaction; repeated clicks redirect the existing float, and page changes, selector commands, and popup teardown wait until the final 360ms movement plus 180ms landing completes. Popup tracking excludes only items fully outside the viewport, so partially visible rows remain reachable.

Android interaction glass now uses fixed `6dp` outer bounds on every side and no longer simulates edge thickness with proportional scaling. Moving glass on desktop and Android deforms from live velocity: it stretches slightly along travel, contracts across travel, and carries the refractive rendering through the same transform. Remote-conversation hold cleanup is stable across non-active rows, refresh and cancellation, popup/dialog shells share a 22dp radius, and light-theme sidebar surfaces are brighter without changing popup brightness.

Android local and remote conversation capsules now suppress both their static outline and running-state marquee outline whenever the shared floating glass covers that capsule. The collapsed and expanded left-sidebar utility selectors and the right-sidebar tab selector apply the same edge-ownership rule: only the item currently covered by the moving glass hides its static border. Conversation reordering stores one stable group destination slot throughout drag preview and release; the release commit no longer recalculates from animation-sensitive bounds, so the persisted order lands in the exact slot opened by avoidance.

Android live activity notifications now use the native Android 16 `ProgressStyle` promoted-ongoing path for Fluid Cloud/Live Update presentation, with separate remote/local running-Agent lines and exactly three alternating progress segments. Older Android versions retain the existing custom two-line ongoing notification and its existing marquee resources.

With model fallback disabled, fixed and Auto routing may retry only the exact same deployment; exhaustion fails instead of selecting an equivalent, fallback, or alternate model identity. Automated release gates pass for desktop and Android. Physical Android-device interaction checks and packaged-desktop visual acceptance remain manual release checks.

Release APK: `android/app/build/outputs/apk/release/app-release.apk` (SHA-256 `C209F32F46D03EC2A1E52164AE580D17F9434263B0FFBB93ED33A72B07F1A2EE`).

### dev-0.5.6 glass interaction

PC and Android controls retain their original static color/surface. Pressing or dragging lifts one Kyant-style glass interaction layer; releasing commits the landing option and restores its color capsule. PC selection glass uses the original per-interaction pipeline: capture the current window, create one independent WebGL2 renderer, upload the captured data URL, and render Kyant's complete rounded-rectangle SDF/lens surface without a center-hole mask or cached stale texture. The original refraction geometry is unchanged; only chromatic sampling is reduced from seven wavelengths to three live backdrop reads at red, green, and blue offsets. Android uses the same RGB-only reduction in the vendored Kyant dispersion shader while retaining its existing Compose backdrop topology and graphics-layer drag translation. The Glass intensity setting continues to drive carrier frost separately from moving-float refraction/dispersion.

Mobile model-list gestures now arbitrate intent before drawing: a tap plays the complete old-selection lift/move/land sequence, a fast vertical move remains list scrolling, and only a stationary 300 ms hold owns glass dragging. Repeated taps redirect the one rendered float from its current position and only the final target commits; tapping the selected item performs the same-position lift and landing. PC/mobile conversation reorder suppresses static selected/drop capsules during the gesture and uses surrounding-row avoidance for the release preview. Android's ongoing live notification shows separate remote/local running-Agent counts on two lines with a moving black-white-black-white gradient bar.

Conversation reordering now keeps one visible carried capsule on both clients. Android preview and commit share the same stable group-slot calculation, and immediately rebases the active conversation's glass origin after a reorder. PC uses a clone of the actual held row as the native drag image, commits the current avoided DOM order even when released in a list gap, and invalidates any pre-reorder glass flight before the next click.

Release APK: `android/app/build/outputs/apk/release/app-release.apk` (SHA-256 `B3198A17B8E9DA8CAE142FC69856C236F88C5FF92B80CA44C1419746BB09B12D`). Current Windows MSI: `release/Newmark-Agent-0.5.6-x64.msi` (SHA-256 `F7ACE76FC3A78BD1B856BB0BE17D2C315DF6E1B0E94451B6A6D2495C3F2888A3`); UAC fresh installation and packaged/installed ASAR equality are verified.

```text
Windows / Linux GUI     TUI / CLI          Android
          \                |                /
           \               |               /
            Conversation- and workspace-bound runtime
                           |
       Agent / Provider / Tool / Context orchestration
                           |
       Local state, Memory Lab, archives and workspaces
```

桌面端远程服务只在用户明确开启后监听；移动端远端操作继续使用桌面端的工作区、对话和运行时身份，不把前台选择当作写入目标。完整内部结构、文件树和历史验收记录见 `OVERVIEW.md` 与 本地归档（未纳入公开仓库），README 仅保留产品使用与发布说明。

## 安全与隐私

- 凭据保存在用户本地配置中，并在诊断和验证输出中脱敏。
- 高风险工具受参数校验、能力供应和授权边界保护。
- 浏览器、运行时事件、草稿、队列和归档按工作区与对话目标隔离。
- 不建议将 Remote Touch 端口直接暴露到公网；异地连接使用 Tailscale 虚拟组网。

## 许可

Copyright © 2025 Newmark AI. All rights reserved. 具体许可边界见 [LICENSE](LICENSE)。

## 2026-08-25 dev-0.5.7 流体云协议与对话玻璃落地校正

Android 16 实时活动恢复为历史实机可工作的
`NotificationCompat.Builder + setRequestPromotedOngoing(true)` 协议。API 36 主路径不再挂载
自定义 `RemoteViews` 或平台 `ProgressStyle`；远程/本地 Agent 计数分别放在标题和正文，旧系统
的两行通知及自定义跑马灯保持不变。

移动端本地与远程对话胶囊的点按、长按拖动统一增加 180ms 落地回缩，动画完成后才移除
玻璃层。光学包边仍固定为 6dp；胶囊半圆端帽使用固定 12dp 横向捕获外扩，补偿左右可见
折射区，不随组件宽度等比放大。记录见
本地归档（未纳入公开仓库）。

后续实测校正将对话落地改为“先锁定唯一目标色块，再让玻璃在其上收缩”，落地使用更明显的
240ms、1.00→0.68 回缩，消除父状态延迟造成的新旧色块闪动。移动端本地/远程对话胶囊、
左栏底部三按钮和右栏分页选中态均取消静态边框；运行中对话也不再额外绘制胶囊跑马边框，
选中状态只由色块底表达。

最终互斥时序进一步统一为：选中色块从交互首帧立即让位，玻璃在原位置用 100ms 从
0.68/透明浮起为完整浮块，随后移动或长按跟手，再用 240ms 收缩落下；玻璃彻底移除后才在
目标位置恢复色块。对话胶囊只保留长按排序的轨迹差异，浮起、互斥与落地效果与输入菜单、
左栏三按钮、右栏分页和 Memory Lab 分页一致，色块与玻璃不会同时存在。

移动选择动画现已补成真正的 `色块 -> 浮块 -> 色块` 可逆材质闭环。唯一动画层在进度 0
就是选中色块，浮起时连续淡出填色并增强折射；落地前先吸附目标中心，再同步收回外扩边界、
退去折射并显回同一层色块。最后一帧与目标静态色块同形同色后才交接，因此不再是玻璃缩没
后色块突然出现。对话胶囊按实际目标宽高计算横纵回缩比例。记录见
本地归档（未纳入公开仓库）。

PC List 类弹窗（模型列表、Newmark Select、对话操作列表）不再叠加旧版固定外泛光/阴影底，
只保留当前承载玻璃的实时磨砂与折射边缘。PC 对话长按拖动也从自由二维跟手改为单一纵向
轨道：横坐标固定在对话胶囊列，纵坐标限制在同一置顶分组的首尾槽位之间。Android 本地与
远程对话同步夹取可见浮块位移，排序目标与浮块位置使用相同的首尾边界。记录见
本地归档（未纳入公开仓库）。

实机截图复核发现 List 虽已取消容器 `box-shadow`，仍继承通用玻璃伪元素绘制的整面固定明暗
渐变与内阴影，形成底部灰黑带。模型列表、Newmark Select 与对话操作菜单现同步关闭这两层
固有绘制，仅保留 carrier 本底模糊和轮廓边线。

跨端对话拖动的落地分层已校正：收缩只属于玻璃光学外壳，携带的标题、图标和状态内容保持
原尺寸。PC 对话拖动浮块为内容层增加反向缩放补偿，并在进入落地前停止速度拉伸；Android
本地/远程对话内容行仅在实际跟手阶段应用速度形变，归轨和玻璃回落阶段恢复 1:1。浮起阶段
的现有液态形变保持不变。记录见 本地归档（未纳入公开仓库）。

实机复核后，Android 对话玻璃进一步取消对整个 backdrop 采样层的 `scaleX/scaleY` 落地缩放。
本地与远程浮层改为围绕目标色块中心，动态收回左右 12dp、上下 6dp 的固定外扩尺寸与坐标；
折射外壳连续落成色块，但下层标题、图标和状态始终保持 1:1，也消除了胶囊落地时的左偏。
对话拖动轨道同时扩展到同置顶分组的首项前与末项后完整插入槽，移动端速度按夹取后的实际
位移计算且仅唯一玻璃外壳形变。记录见 本地归档（未纳入公开仓库）。

同一落地分层现已同步到移动端左栏三按钮和右栏子分页：折叠左栏的 40dp 外壳收回到居中的
36dp 色块，展开左栏从整行外壳收回四周 4dp，右栏分页从 44×40dp 外壳收回到 32×28dp
按钮色块。三者均通过动态尺寸与中心偏移收边，不再缩放 backdrop 采样层，因此图标、文字
保持原尺寸。记录见 本地归档（未纳入公开仓库）。

当前 Windows MSI：`release/Newmark-Agent-0.5.7-x64.msi`，SHA-256
`F90E44A6BA82A30FD56EC5A97403E4FF6337F341164C4F52BA090F96FC3FD777`。本机已通过 UAC
升级安装至 `C:\Program Files\Newmark Agent`，已安装版本 `0.5.7.0`，安装后的 `app.asar`
与打包产物哈希完全一致。

PC 对话区的审查摘要现按逻辑 Build 运行执行 upsert：增量 diff 快照更新既有卡片，后端正式
runId 到达时接管本地 provisional runId，状态缓存与 DOM 均不会追加第二张审查卡。对话区
同时在全部滚动内容和透明玻璃之下增加随明暗主题变化的实色主题本底，稳定正文对比度而不
覆盖轨道、玻璃折射或用户自定义背景色。回归记录见
本地归档（未纳入公开仓库）。

包含该修复的 Windows MSI 已重新构建并完成本机 UAC 升级安装：
`release/Newmark-Agent-0.5.7-x64.msi`，SHA-256
`F8DF62267671B263349F1EEB21017704501F07FE7A7CABDC4D0DC0166A07A3BF`。安装目录为
`C:\Program Files\Newmark Agent`，安装后 `app.asar` 与候选产物哈希一致。性能与安装记录见
本地归档（未纳入公开仓库）。

后续实测定位到 Build 行内审查徽标仍存在独立的展开重复问题：徽标生成类为
`.conversation-work-change-badge`，增量更新误查成 `.conversation-work-run-change-badge`，导致
每次展开/收起都追加一份。选择器已统一，连续 8 次展开/收起仍恒为一个徽标；Build 标题也
加入无玻璃、无按压缩放的展开控件排除规则。记录见
本地归档（未纳入公开仓库）。

包含该最终展开修复的 MSI 已再次构建并 UAC 安装：
`release/Newmark-Agent-0.5.7-x64.msi`，SHA-256
`36A1893143FB4DC46C25073FDC431F1CF6409948CD9DD698F666FEAEAA8DB357`。安装版
`app.asar` SHA-256 为 `4BA2C12C6C2EDB83A5CF3B3F4F11A8546C738233333B38DEF9441CB544CC9B3E`，
与 release 候选一致。记录见 本地归档（未纳入公开仓库）。

移动端浮动选择器的实测几何再次校正：本地/远程对话胶囊的测量矩形统一转换到玻璃宿主
坐标系，修复远程列表 8dp 内边距造成的左偏；右栏子分页直接记录每个 32×28dp 色块的实际
边界，玻璃落地终点不再依赖槽宽硬编码。Memory Lab 总览/详细切换删除整体 scale 落地，
改为只收回玻璃外壳的固定 6dp 外扩，采样内容始终保持 1:1。记录见
本地归档（未纳入公开仓库）。

包含上述修复的 Android Release APK 已完成 R8、Vital lint、资源优化与签名构建：
`android/app/build/outputs/apk/release/app-release.apk`，大小 45,954,544 bytes，SHA-256
`7761F5F841D75C3A32013FE248F26BFBA49C2541ECF87DE4BC8A57211D5022F5`。

移动端预测性返回随后修正顶层页面的 commit 交接：竖/横屏命令行及竖屏 Memory Lab 总览在
松手后保留当前手势变换，由外层退出动画直接接管，不再闪回原位；Memory Lab 详细页返回
总览仍在同一 surface 内从松手进度平滑复原。左侧栏本地/远程对话玻璃的移动态增加随材质
浮起进度生效的 2dp 右向视觉中心校正，色块态进度为零，因此不改变准确的浮起起点和落地
终点。记录见 本地归档（未纳入公开仓库）。

包含该修复的最新 Android Release APK 已完成 R8、Vital lint、资源优化与签名构建：
`android/app/build/outputs/apk/release/app-release.apk`，大小 45,954,544 bytes，SHA-256
`F4A379867B05B667D4106F4F5986D46751A6D7639E73F71A970CFEB208F3E3E4`。

移动端右边栏随后与 PC `#right` 的 carrier 语义同步：聊天底层继续按展开进度做 backdrop blur，
右栏自身不再作为全高折射透镜采样聊天画面，消除拖到一半时左边缘出现的宽条镜像。亮色
右栏改用 98% 的明亮 `bgTertiary` 本底，不再被 0.74 透明度稀释；外形为仅左上/左下 18dp
圆角、右侧贴屏直角，并只绘制左侧分隔线。记录见
本地归档（未纳入公开仓库）。

包含该右栏修复的 Android Release APK 已重新构建：
`android/app/build/outputs/apk/release/app-release.apk`，大小 45,954,544 bytes，SHA-256
`E1051DE9D6C02DB624626891874206D9A1E386F84EA9C7F2B4F7728738D224D5`。

按后续实测要求，移动端右栏已取消左侧圆角，恢复四角直角贴边；明亮本底、仅左侧分隔线和
禁止全高折射倒影的修复保持不变。最新 APK SHA-256 为
`A00D40A01E8EFB9DD218B4466A75744552756EA4C22DDC4FF63FD6908FE58795`。

移动端“移动端权限”页新增“后台联网”系统状态开关。开关读取
`ConnectivityManager.restrictBackgroundStatus`，点击时打开本应用专属的后台数据/不受限流量
设置页，系统不提供该入口时回退应用详情页；从系统页返回后重新读取真实状态。应用不会伪造
或静默修改该系统特殊权限。记录见 本地归档（未纳入公开仓库）。

包含后台联网入口的 Android Release APK 已完成 R8、Vital lint、资源优化与签名构建，大小
45,970,928 bytes，SHA-256 `79A5577EEF1B0A92F2489B0BDCAA2933422DFA6474EBED03900CDED91ECDEB1D`。

后台联网入口的开关语义随后调整为单向请求：开启时才调起系统后台联网页面；关闭仅关闭
Newmark 权限页中的开关，不撤销也不修改任何系统联网策略。系统真实限制状态继续由下方说明
独立展示。最新 APK SHA-256 为 `A9DDA1C834B5A46393AF8AD580AD444D3BAC061C30CAE6F0CBDD502E0DC6BB1F`。

PC 与移动端所有选择型玻璃浮块现统一采用并行状态机：玻璃从当前色块起点浮起的同时立即向
目标运动，抵达目标色块后马上收缩落地，不再串行等待完整浮起，也不再为原地点击补齐虚假的
220/360ms 行程。长按与对话排序拖动在按住期间维持完整浮起，松手归轨到最终色块后才落地；
页面切换、弹窗命令和对话切换仍等落地完成后提交。覆盖菜单、左右栏、设置/插件/MemoryLab
分页、工作区/模式选择、移动端侧栏三按钮、输入复合菜单及 PC/移动端对话点击与拖动。记录见
本地归档（未纳入公开仓库）。

包含上述并行运动状态机的 Android Release APK 已完成 Vital lint、R8、资源优化与签名构建：
`android/app/build/outputs/apk/release/app-release.apk`，大小 45,970,928 bytes，SHA-256
`298E11F7A27000A7770956AB99AAEF1C3046E2BC5E3F1BA0DEDD44A0CABB8532`。当前工作区最新 Electron
dev 也已使用独立临时用户数据目录启动，避免与已安装版配置和单实例锁冲突。记录见
本地归档（未纳入公开仓库）。

包含全平台玻璃并行运动改造的 Windows MSI 已重新构建并完成本机 UAC 升级安装：
`release/Newmark-Agent-0.5.7-x64.msi`，大小 226,383,951 bytes，SHA-256
`3D6683B81E4FF3C90E51E26D2995808C3FBAFDA3A4D6E6EB06F122F145C2CF4A`。MSI 管理映像的
22 项结构断言与 12 项安全断言全部通过；安装返回 3010（成功、建议重启），安装目录
`C:\Program Files\Newmark Agent` 的 `app.asar` 与 release 候选 SHA-256 同为
`E6F3F777E803DF9804054E7D86712B9B8605A768C78E7B74EDD744AAAEF0C233`，安装版 GUI 已成功启动。
记录见 本地归档（未纳入公开仓库）。

dev-0.5.8 补齐移动端对话操作反馈：更多按钮与长按打开的菜单分别从真实触发锚点弹出，并在
关闭时反向收回；归档操作会在菜单退出后让对话胶囊淡出并轻微收缩，动画结束才从本地或远端
列表提交删除，避免菜单和对话突然消失。对应 Release APK 大小 45,970,952 bytes，SHA-256
`2FDF58EB6366FD49007DEABCDBB3269F8319415EC7B0FED3EAA8DD281E292A0C`。

移动端 `alarm_manage` 已接入 Android 默认时钟应用：创建闹钟会打开系统时钟确认界面，查看
闹钟会进入默认时钟的闹钟列表。Newmark 不再用自身通知模拟系统闹钟，也不再声明 Android
公共协议无法保证的跨时钟应用 ID 查询与删除能力。
包含该修复的 Release APK 大小 45,970,920 bytes，SHA-256
`FBD59BD5A93F3B9DE11097C36B75A0D406F5A79E16096E57088ADB73EBBC88CA`。

本地 Agent 的恢复层还对齐 PC 的瞬态传输错误边界：思考已开始但正文尚未到达时，EOF、连接重置、
流关闭、超时和 broken pipe 会继续进入连续恢复，不会因一次短暂连接抖动直接终止 Build。

该状态已完成 Android 本机压力门禁：151 项 JVM 测试全部通过，独立 stress variant 构建成功，
正式 Release 的 Vital lint、R8、资源优化和签名打包通过。当前未连接 ADB 设备，因此实机
SSE/UI 循环未执行，也未计为通过。

移动端本地 Agent 已取消写死的 6 轮工具调用限制：连续工具工作会运行到模型完成、用户停止或
真实错误。上下文结构同步 PC 的请求级最新用户焦点、Guide 顺序、历史证据边界与压缩续接；
每个工具子轮都重新检查 70% 自动压缩和 90% 安全压缩，避免长工具链因上下文只在首轮检查而
溢出。请求级 bootstrap 不写入对话历史。
该 bootstrap 同时移除了消息数量、工具数量、模式、ID 等动态字段，使连续工具子轮的 system
前缀保持字节稳定；新工具结果只追加在上下文尾部，从而提高支持 prompt caching 的 provider
缓存命中率，只有真正发生上下文压缩时才改变 durable 前缀。
该状态 Release APK 已通过 154 项单测、Vital lint、R8、资源优化与签名构建，SHA-256
`768AA0C216FB004FE17CD2C32BDB035C12D6443FE29BEBB5E3B6DB165B046887`。

移动端文件发现现合并 MediaStore 与用户已授权的系统 DocumentProvider，能识别云端仅在线、
系统优化释放及重复文件占位记录，保留稳定 document ID/canonical identity，并在读取 content URI
时由原 provider 恢复真实内容。文件读取新增 PDF、Word、PowerPoint、CSV/TSV 与 Excel；PDF
按文字层、页面视觉模型、设备 miniOCR、LLM 完整视觉综合顺序降级，并返回实际命中的解析阶段。
该状态 Release APK 已通过 156 项测试、Vital lint、R8、资源优化与签名，大小 52,684,932
bytes，SHA-256 `C845EC677B3A878D512D740E7A93213490E8137757241040D65FA0ECD04EB3C8`。

dev-0.5.8 统一升级了移动端既有玻璃浮块的飞行状态机。对话胶囊、侧栏工具选择器、右栏分页、
记忆实验室分页和输入复合菜单均可在浮起过程中向目标运动，并在尚未完全抵达时开始收缩落地；
首帧仍严格从起点色块浮起，结束时严格收缩为目标色块。长按和拖动期间保持完全浮起，只有松手
才进入落地；重定向复用当前浮块，不生成第二个浮层。普通表面未被转换为玻璃。

移动端现从应用主题根部关闭 Compose/Material3 的所有点击 indication，不再显示 Android 默认的
灰色涟漪。点击、长按、拖动、无障碍语义以及 Newmark 自有的玻璃/状态动画保持原有行为。

移动端 Memory Lab 已补齐 PC 同构工具链：读取、查询、新增/更新、重构、删除与重建索引均支持
完整 metadata、tagPaths、版本号、expectedUpdatedAt 并发保护、旧版本归档、policy.jsonl 审计和
rebuild receipt。总览继续采用 PC 标签/组件关系云，并保留移动端单指拖动、双指缩放与 48dp 命中优化；
详情页新增组件元数据、标签路径、别名、核心 Markdown 及新增/编辑/删除入口。
# dev-0.5.8 terminal responsiveness

PC 内置终端现对高频 PTY 输出实施主进程背压合并与渲染端逐帧追加，避免 Windows 将 Electron 判定为未响应；终端历史仍保持 256 KiB 有界缓存，普通终端和 Agent takeover 路径一致。
# Mobile local Agent response stability (2026-08-26)

移动端本地 Agent 的所有 provider 调用统一经过空响应恢复层：只有 provider 明确返回失效空响应才进入重试；持续等待、静默连接、EOF、超时或流关闭本身不视为空响应。明确失效后的等待序列为 200ms、800ms、2s、10s、60s，对应 5 次重试，第 5 次仍失效才终止；任意思考、正文、工具调用或其他有效流式活动都作为正常结果并立即清零计数。

本轮稳定性修复同时兼容 chat SSE 的完整 `choices[0].message` 帧与增量 `delta` 帧，避免健康连接被解析层误判为空响应；显式失效重试间隔固定为 200ms、800ms、2s、10s、60s。

## dev-0.5.8 模型菜单玻璃拖动调度

移动端模型选择二级菜单现将拖动位移与速度直接留在 Compose `graphicsLayer`/RenderNode 更新路径，
动画 Job、当前目标行和菜单几何不再作为高频可观察状态反复触发整表重组；同一目标行内的指针事件
不会重复取消和重建 spring。玻璃材质、形变公式、240ms 飞行、长按浮起和落地状态机保持不变。
本地 Agent 的流式增量仍完整按序接收，但主线程公开快照改为 16ms 窗口批量提交，避免高速 token
流与 UI 帧回调争抢主线程。171 项 JVM 测试、Vital lint、R8 与 Release 构建通过；当前无 ADB
设备，未把模拟器/实机帧率计为已验证。

## dev-0.5.8 移动端连续思考节点

移动端本地 Agent 现在将同一连续思考阶段内的多个 provider 子轮接续到一个 Build 思考节点。仅思考
响应会继续当前节点，不再反复生成“进行了思考”；开始工具调用、生成正文、收到 Guide、发生错误或
Build 结束时才关闭该节点。流式 reasoning delta 与最终 reasoningContent 会按子轮对账，既不丢失也
不重复。1000 个连续 thought-only 子轮压力回归保持 1 个 thought shell，完整 174 项 JVM 测试、
Vital Lint、R8 与 Release APK 构建通过；真实移动端 UI 长压仍需连接设备后补测。

## dev-0.5.8 移动端思考响应续接稳定性

移动端本地 Agent 不再把 reasoning-only 子轮结束后的下一次请求原样重放。当前 Build 会维护一份
最多 12,000 字符的临时思考进度检查点，并仅在下一次 Chat Completions 请求尾部以 assistant
`reasoning_content` 原生字段携带；普通 `content` 保持为空，不再伪造成内部提示词。它不写入聊天正文、
`messages`、`modelContext`、压缩摘要或磁盘历史。任一 Guide、工具调用、
正文、错误或终态都会清空检查点，因此最新真实用户指令仍保持权威。

流式 reasoning 已经显示后，较短或不兼容的最终 reasoning 字段不再覆盖它；内容在同一思考节点内
只会保持或增长，不会出现长思考突然截断后从头重来的可见回退。1000 个连续子轮回归同时约束单节点、
请求变化、检查点有界和非持久化。完整 178 项 JVM 测试、Vital Lint、R8 与 Release 构建通过。

后续协议校正进一步保留 provider 的 `finish_reason`：只有模型明确返回 `length`、`max_tokens` 或
`max_output_tokens` 才允许携带上述检查点进入下一子轮。普通 `stop`、工具状态、异常 EOF 或连接关闭
都不会由客户端解释为“继续思考”，软件端也没有思考空闲计时器。当前供应商的当前模型配置直接提供
`thinking_tier_map`，避免不同供应商的同名模型串用原生档位。183 项 JVM 测试、Vital Lint、R8 与
Release APK 构建通过；分发 APK SHA-256 为
`ED15D28A643B9C200E239C4D5D6B07C159C54BCBEE7D218C480BAB1DFBA9381E`。

## dev-0.5.8 PC/移动端工具上下文接续修复

长对话中“明知参数错误却重复执行同一调用”并非最新记忆无法写入，而是部分 OpenAI 兼容网关把
`function.arguments` 作为累计快照重复发送，客户端却按普通增量无条件拼接。合法参数因此变成两个
相邻 JSON 对象，工具只看到旧值或空对象，模型收到误导性的参数缺失结果后继续重复调用。

PC 与 Android 现统一兼容标准增量、累计快照和完整重复快照；Chat Completions、Responses 及
GitHub Models 兼容流均按 tool index 隔离并行调用。Android 工具执行器执行前使用严格单对象解析，
不会再接受带尾随对象的参数。每轮 assistant tool call 与同 call id 的工具结果仍只追加到上下文尾部，
稳定 system/bootstrap、工具 schema 和既有消息前缀保持不变，prompt cache 命中结构未被破坏。

回归覆盖累计/重复/标准增量、交错并行调用、无 `output_item.done` 的 Responses 兼容流、严格参数拒绝、
下一轮工具结果接续及 45 个 PC 工具子轮缓存压力。Android 187 项 JVM 测试、Vital Lint、R8 与
Release 构建通过。APK：`APK/Newmark-Agent-0.5.8-context-continuity.apk`，SHA-256
`F514C919411DD2D84214B54024D7CF6D9EB25692E35F7D5465FF8FC08188325F`。
### dev-0.5.10 Windows 设置页玻璃稳定性

Windows Electron 的玻璃浮块现在为每次交互使用独立的可见合成画布，避免从大浮块切换到设置分页等小浮块时继承旧 GPU 图层边界并出现整块白色覆盖。折射外观、浮起移动落下逻辑和设置页展示保持不变。
### dev-0.5.10 移动端液态细节

移动端玻璃浮块的速度拉伸与边界拉力形变已小幅增强，同时保持原 4dp 阻尼位移上限。对话区“回到底部”按钮现使用独立透明光学外扩画布，浮起时的玻璃边缘、阴影和放大不再被 40dp 按钮节点截断，按钮布局和点击范围保持不变。

### dev-0.5.11 移动端模型与供应商胶囊设置

“模型与供应商”及其供应商详情、新建供应商、新建模型、模糊注入五个子设置页统一为 44dp 单行胶囊；文本字段、开关、模型条目和操作入口不再混用卡片或多行表单。设置页纵向选择器复用左侧栏三个按钮同款的纵向胶囊玻璃浮块：色块起点/终点保持静态，浮块在点击或长按拖动时独立起飞、沿轨移动并发生液态形变，释放后回到目标色块；同时保留列表快速滚动。新建供应商与模糊注入的协议选择改为横向胶囊玻璃滑块，继续沿用语义色、无 ripple 和既有保存逻辑。

输入型胶囊现从纵向玻璃浮块的可选目标、手势起点与初始高亮三层排除，文字输入、选字和长按不再被父级浮块接管。模型与供应商首页的点击飞行改为真实 `Animatable` 位移；位移与 100ms 浮起/240ms 落下材质生命周期并行执行，二者均完整结束后才进入目标页面，不再以赋值加延时制造中段瞬移。

创建/取消双按钮行也已退出整行纵向浮块：每个按钮使用自身尺寸、略厚包边的独立玻璃，点击完整浮起落下后才执行，按住拖动保留 4dp 边界阻尼与液态形变。首页命中按胶囊实际区间计算，不再向下一项偏移；快速长按松手会从当前动画帧连续吸附和落地。设备拉取弹窗居中展示在线/离线状态，离线保存设备不可触发拉取且请求具有 8 秒超时。命令行发送图标改用主题前景色，亮色模式保持可见。

PC 启动优化版 dev-0.5.11 Windows x64 MSI 已构建到独立目录 `release-0.5.11-startup-msi/`，避免清理既有 release 资产。启动响应门禁保持进程全程可响应，MSI 行政解包、CLI/TUI、上下文压缩与功能冒烟通过。旧 0.5.10 已卸载并通过 UAC 全新安装 0.5.11；注册表、CLI 和 `app.asar` 一致性验证通过，`.Newmark` 关键用户状态哈希不变。安装版实测轻量启动页 603ms、Agent 1959ms、主界面 4288ms，113 个进程响应样本中无无响应记录。

### dev-0.5.11 全平台本地 Release 资产

`release-0.5.11-full-platform/` 已从当前源码生成 Windows x64 MSI 与解包 ZIP、Linux x64 AppImage、deb 与解包 ZIP，以及 Android APK。Windows 两种资产分别通过行政解包/独立解压黑盒冒烟；Linux 三种资产均在 Ubuntu 24.04 WSL 下完成真实 xvfb GUI、Bash/sh 终端隔离与版本检查；Android 通过 218 项 JVM 测试、Vital Lint、R8、v2 签名及版本检查。

这是本地候选资产集合，并未上传到 GitHub 或应用商店。Windows MSI 未做 Authenticode 签名，Android APK 使用工程 Debug 证书；macOS DMG 必须在 macOS 主机原生构建，因此不包含在本次 Windows 主机产物中。

### dev-0.5.11 移动端图片展示与回到底部玻璃

移动端本地 Agent 新增 PC 同名 `image_display` 工具，可将安全工作区内不超过 10 MiB 的 PNG/JPEG 作为持久视觉证据展示在当前 Build 中；远程 PC 工作事件继续复用同一图片投影。用户发送的本地或远程历史图片统一显示在对应用户文字上方，支持点击展开，并保持 PNG/JPEG、来源与数据大小校验。

“回到底部”按钮不再由静态内容边框和浮起玻璃分层叠画：静止边框与浮起/落下的折射边缘现在由同一个外扩光学层接管，按钮尺寸、命中范围和 8dp 光学外扩保持不变。新移动端 APK 位于 `release-0.5.11-mobile-images-glass/`。
### dev-0.5.11 移动端布局与全平台发布

用户输入图片现在右对齐，Agent 展示/查看图片左对齐，并分别与对应正文保持同一文字边界。对话区会持续测量输入上方的 Goal/Flow/Queue 浮层，把变化后的高度实时纳入滚动内容底部避让；Markdown/LaTeX 阅读预览复用同一左右安全边界，窄屏不会被时间线或编辑器边缘裁切。

本轮最新 Android APK 已重新绑定到 `release-0.5.11-full-platform/`，并与 Windows x64 MSI/ZIP、Linux AppImage/deb/ZIP 一起发布为 GitHub [`dev-0.5.11` prerelease](https://github.com/positer/Newmark-Agent/releases/tag/dev-0.5.11)。GitHub 回下载逐字节核对六项 SHA-256 均通过。macOS DMG 仍需 macOS 主机，Windows MSI 未签名，Android 使用工程 Debug v2 证书。

## 2026-08-30 内核响应中断排查

确认用户配置 `agent.process_timeout_ms=0`、`terminal.interrupt_timeout_ms=0`，稳定 API 的流式读取不会因空闲等待被误判超时；`providerTimeoutRecoveryVerify`、`agentRuntimeV2Verify`、`runtimeIsolationVerify`、`streamUnlimitedTimeoutStressVerify` 与桌面构建均通过。修复运行中上下文快照仅在 status/tool_result/usage/message_end 等语义边界刷新，避免高频文本/思考增量触发 IPC 竞争。Abort 入口增加诊断原因标记（如 `user_stop`、`process_timeout_*`），便于区分用户停止、超时和外部运行时故障。
## 2026-08-30 PC Build Block 纯时间线修复

修正回归：Build Block 展开区域曾被通用材质规则绘制成粗糙的白色圆角底板。现在 Build Block 外层、标题、正文及伪元素均明确禁止背景、backdrop-filter、边框、圆角、阴影与滤镜，仅保留原有时间线内容。`pcGlassMigrationVerify` 新增并通过该门禁。
## 2026-08-30 内置浏览器弹出页刷新

PC 内置 Browser 将 `target=_blank`/`window.open` 页面拦截并导航到当前嵌入标签，保留地址栏与 Reload。移动端 WebView 开启多窗口回调，将弹出页安全导回同一 `BrowserSessionState`，因此移动端弹出页面同样可使用刷新。PC 构建与 UI/浏览器回归通过；移动端新增会话刷新断言。
### dev-0.5.12 PC 图片交互边界

PC 用户上传图片与 Agent 展示图片的点击组件均按图片自然尺寸收敛，不再强制胶囊形命中区域；用户附件右对齐，Agent/Build 图片左对齐，与各自正文一致。图片查看仍通过玻璃子窗口打开。
### dev-0.5.12 自动续接循环与缓存命中复核

Conversation Kernel 为自动 Guide/Goal/隐藏续接记录最近一次 Agent 文本指纹；provider 在没有新用户输入或工具进展时重复返回完全相同内容，会停止剩余自动续接并写入运行状态，避免“自说自话”轮回。真实用户 follow-up 不参与该保护。缓存压力测试确认 cacheRead token、命中率及跨请求稳定前缀均保持正确。
## dev-0.5.13 移动交互稳定性

移动端输入编辑现在持续保留光标选择与输入法组合状态，向前移动光标、选字或调整选择区时不再触发键盘瞬时关闭重连。队列操作区也拆分了手势所有权：只有左侧把手响应长按拖动，Guide、编辑和删除保持独立、即时的短点击路径。

Agent 运行中且输入框非空时，普通点按发送仍将内容加入 Next；长按发送键 300ms 后向上拉动会抽出一个同尺寸上箭头玻璃浮块，松手将当前文本直接作为 Guide 注入运行，不改动已有队列。

本地 Guide 适用于所有正在执行的 Agent 模式（Build、Plan、Chat），不再被隐藏的 Build-only 判断忽略。若运行已经越过接收边界，输入内容会保留供用户再次提交。

## dev-0.5.13 Windows x64 MSI 打包与本机安装

PC 修复版已从当前 `0.5.13` 源码完成 clean build、桌面主验证、运行时隔离/生命周期/诊断验证，以及 Windows 打包态 CLI、上下文压缩、控制台参数边界和真实 SSH/TUI 压力测试。Windows x64 资产位于 `release/`：MSI 为 `Newmark-Agent-0.5.13-x64.msi`，解包 ZIP 为 `Newmark-Agent-0.5.13-win-unpacked-x64.zip`。

MSI 已通过 UAC 安装到本机。卸载注册表为 `0.5.13.0`，安装版三种 CLI 均返回 `0.5.13`，安装后的 `app.asar` 与打包候选逐字节哈希一致，GUI 主窗口及 Electron 子进程均保持响应。安装前后用户 `.Newmark` 的 20,871 个文件、总字节数和聚合 SHA-256 完全一致。本地 MSI 未做 Authenticode 签名，当前资产未上传远端 Release。

## dev-0.5.13 移动端后台 Agent 连接服务

Android 前台服务不再只是运行数量通知：本地 Agent 主协程、远程 SSE 与重连均迁入服务级 `SupervisorJob`，不再由 Activity/Compose 的 `viewModelScope` 决定存活。服务在已配对期间维持用户可见的后台连接租约，持有 CPU/Wi-Fi 网络锁并监听默认网络变化；界面退出后由服务接管认证 SSE 保活，重新打开界面时交还正式事件流并从桌面持久状态补齐。

断网恢复时会清理失效连接池并立即重连。远程 Agent 活跃期间不再受原 5 分钟重连上限限制；本地模型请求只有在尚未产生任何正文或思考时才允许等待网络恢复后重试，已经产生模型活动的请求不会盲目重发，避免重复正文或工具副作用。Android 使用 `specialUse` 前台服务类型，未来若上架 Google Play 需申报对应长期 Agent 连接用途。

## dev-0.5.13 PC 中断回复边界修复

PC Build 在被停止或强制停止后，只要模型已经产生过公开回复，最后一条公开回复会继续作为 Build 块外的独立 Agent 回复显示；展开 Build 时不会重复同一段正文。尚未产生任何公开模型回复就被中断的运行不会伪造回复。实时终结、切换对话、重启后的历史恢复使用同一选择与去重规则。

## 首次输入智能对话命名与移动断线续接

PC 与 Android 本地新对话在首条真实用户输入落库后，必须先完成一次独立、无工具的标题探测；标题成功生成并落库后才允许首次正式 Agent 请求开始。按 2026-09-06 的生命周期修复，标题使用正常 provider 读取策略和父运行取消，不再另设 15 秒期限。该请求复用首轮发送时冻结的 provider/model/intelligence，概括用户意图而非截取原文，同时作为该部署的首轮可用性检查；探测失败或被取消不会启动正式响应，用户在原对话再次发送时仍使用同一条首消息重试门禁。Android 远程对话继续由 PC 单点命名。

标题身份和“首次正式响应是否已启动”均随对话持久化；重启、第二次发送或工作区切换不会把后续文本误当作标题来源。双端首轮使用发送时冻结的 provider/model/intelligence 配置，标题结果只在目标会话、首消息身份与自动默认标题仍匹配时落库，手动命名始终优先；标题请求的消息、错误和输出不进入聊天、Build、Guide/Next 或正式请求缓存前缀。

移动端后台网络恢复现在要求系统默认网络同时具备 INTERNET 与 VALIDATED。provider 在流式正文或思考途中断开时，会保留已公开进度、等待验证网络恢复并最多安全续接三次，续接提示禁止复述；反复失败显示受控恢复提示，不再直接暴露 `Software caused connection abort`。工具调用仍以既有持久化结果边界为准，断线恢复不会重放已经提交的工具副作用。

## dev-0.5.13 双端标题一致性与 r2 APK（历史候选，已被 r3 替代）

双端首次标题探测现在严格复用首轮正式响应的冻结部署身份。PC 在标题门禁前完成不可用模型与 fallback 解析，再把同一 provider、model、intelligence 及原生 reasoning effort 交给标题探测和正式响应；Android 同步冻结 `ApiConfig`、`ModelConfig` 与 intelligence。标题探测不再硬编码 `low`，因此它确实承担首轮正式模型可用性检测，而不会验证另一档配置。

该轮工作树的桌面 typecheck、build 与 `1696/1696` 主验证通过；Android `263/263` JVM 测试、Release Vital Lint、R8、资源收缩和隔离 Release 构建通过。r2 历史侧载包为 `APK/Newmark-Agent-0.5.13-dual-platform-final-r2-release.apk`，大小 52,794,422 bytes，SHA-256 `6A3B048E987F4BBE94C1F22EFCFD3E2B85DF96B58BEF813FE01C72A581243183`。旧 `8BDCF457C7003C8ECF710F006F87109D8A11E722C784CFD63F6A2F087EB7A820` 候选当时已被 r2 替代；r2 随后因 Android Responses 流把缺失内嵌 `response.status` 的 `response.completed` 误判为成功而被 r3 替代。

r2 当时包含 Search MCP 池、`browser_use.visible`、OpenAI Responses 协议、后台网络恢复、Guide/输入法交互和设置返回按钮玻璃画布修复。其 v2 签名、4-byte/16 KiB 对齐、Manifest/版本、隐私扫描和 API 35 模拟器冒烟记录继续保留为历史/回滚证据，但 r2 不再代表当前源码或当前交付。

## dev-0.5.13 Android Responses 严格完成态与 r3 APK（历史候选，已被 r4/r5 替代）

Android Responses 流现在只有在 `response.completed` 同时携带大小写不敏感的明确 `response.status=completed` 时才成功。事件名本身以及缺失、空白、未知或非完成状态均返回受控失败；成功 SSE 测试夹具也显式携带该状态，避免宽松 fixture 再次掩盖协议缺口。

Responses 聚焦测试 30/30、Android 68 suites / 264/264 且 0 failures/errors/skips；`lintVitalRelease` 用时 3 分 50 秒成功，隔离 clean `assembleRelease` 50 tasks（48 executed、2 up-to-date）用时 5 分 05 秒成功。历史侧载包为 `APK/Newmark-Agent-0.5.13-dual-platform-final-r3-release.apk`，52,794,422 bytes，SHA-256 `B702EB35EC4E9DB42FD8598865D46EF75F7B707CE6C3C611307CBD573A5B8847`；版本 `0.5.13/513`，使用 v2 Android Debug 签名，并通过 4-byte/16 KiB 对齐。后续终审发现根级 `status=completed` 仍可绕过内嵌状态契约，r3 因而被 r4 替代；r4 又因双端完整性终审发现 PDF 整体超时、Android 标题原生 reasoning 透传和移动图片视觉缺口而被 r5 替代。

API 35 `emulator-5554` 安装成功。初次启动进入系统权限页，处理后 `MainActivity` 前台；独立复核一度被电池优化系统页覆盖，返回并显式启动后 2 秒、7 秒及最终查询均恢复 `MainActivity` topResumed。PID 11040 持续存活，FATAL/ANR 为 0。首次普通解压因重复 APK entry 失败后，发行扫描改为逐 Zip entry 读取字节，重复 entry 也全部检查且不创建临时目录；未发现开发者 profile/workspace、非允许用户目录、凭据或私钥。裸数字 `12252` 仅命中 6 个 vendor 文件，4 ABI ML Kit 库中的 `/home/build` 是第三方通用构建标记。用户本轮仅要求 APK，因此未打包 MSI；真机后台切网/长时运行、真实 provider、配对 PC bridge 与逐帧视觉仍未验证。

## dev-0.5.13 双端终审修复与 r5 APK

r4 将 Responses SSE 的成功条件收紧为只接受内嵌 `response.status=completed`，拒绝根级状态替代，并在缺失内嵌状态时优先保留供应商 `error.message`、`incomplete_details.reason` 或消息；Responses 聚焦 32/32。最终双端终审随后补齐三项发布阻断：Desktop `pdf_read` 使用一个累计 deadline 覆盖异步文件读取、pdf.js 全文解析和扫描页视觉观察，超时回执记录阶段并允许同一 Agent 继续响应；Android 标题探测与正式首轮共享冻结的 native reasoning 映射；Android `image_inspect` 校验 PNG/JPEG、10 MiB、4000 万像素与工作区/授权 URI 边界后，把图片仅作为一次性视觉子请求输入。

门禁为 Desktop typecheck、build、1702/1702 主验证与完整 `test:full-release`；Android Responses 32/32、69 suites / 267/267、`lintVitalRelease` 3 分 01 秒，以及隔离 clean `assembleRelease` 50 tasks（47 executed、3 up-to-date）3 分 49 秒。当前侧载包 `APK/Newmark-Agent-0.5.13-dual-platform-final-r5-release.apk` 为 52,794,422 bytes，SHA-256 `C87DFA53B309D4FE1790FCB5F1EB2084F67BE6E44FC27D76D5E8E4E84A30A14B`；源包与交付副本一致，版本 `0.5.13/513`，v2 Android Debug 签名、4-byte/16 KiB 对齐及逐 Zip entry 隐私扫描通过。Desktop 后续仅完善了无供应商诊断文本与标题门禁压力夹具，不改变 APK 的 Android 源码快照。

API 35 `emulator-5554` 在 ADB 重启后通过冷启动恢复在线，`adb install -r` 成功。显式启动 `MainActivity` 后 2 秒和 7 秒均为 topResumed，PID 3173 持续存在，目标进程 FATAL/ANR 为 0。该验证只证明模拟器安装和短时前台运行；真机 OEM 后台、切网/锁屏/划走、真实 provider、配对 PC bridge 与逐帧玻璃反馈仍需独立验收。本轮按用户要求只打包 APK，没有生成 MSI。

### 20260905-141515 移动端长按释放动画修复

修复移动端玻璃浮块在长按拖动松手后先在原地收缩、再让静态色块闪现的问题。Provider 横向协议轨道现在先把释放帧同步到 Animatable、清除 dragging 渲染优先级，再移动到释放浮块中心对应的选项，完成移动后才进入 landing 收缩；Memory Lab 分页和右侧栏分页只有在确实发生拖动时才同步拖动坐标，普通长按释放继续使用当前动画帧。玻璃光学画布保持内部裁剪与均匀外扩。

验证：Android :app:testDebugUnitTest 通过（275/275）；:app:assembleRelease 通过。APK：
elease-0.5.15/Newmark-Agent-0.5.15-android.apk，66,768,134 bytes，SHA-256 ECED37CDC80E1DAB5541F3744225A43A250572E30DEA2F197FF8E3A1408D0A09。

### 20260905-143414 PC GUI 液态玻璃绘制稳定性与视觉复核

本轮全面复核 PC 液态玻璃链路：CSS 弹窗承载玻璃、WebGL2 SDF 折射浮块、独立 2D 展示画布、弹窗交互光源与 pointermove 调度。修复浮块展示画布在 WebGL 折射后使用整幅 fillRect 绘制泛光导致透明画布外出现方形光晕的风险：现在折射与泛光统一使用圆角路径裁剪。修复弹窗光源在高频 pointermove 中同步写 CSS 的抖动风险：位置与透明度先进入待处理状态，每帧合并一次，再更新 CSS 与 2D 光学画布。

Electron 实测：localhost:47890 GUI 可启动，模型菜单可打开，弹窗折射边缘/高光/阴影/色块层级正常。验证：
pm run typecheck、
pm run build、
ode dist/tests/pcGlassMigrationVerify.js、
pm run test:liquid-renderer-calls、
pm run test:liquid-renderer-electron 全部通过。渲染器测量保持单 WebGL context、2 次 shader 编译、1 次 program link、200 次 draws；Electron 冒烟 p95 pointer-up 到命令完成约 510ms，未发现绘制错误。

### 20260905-144650 PC 长按玻璃浮块与文字稳定性修复

桌面端模型/供应商设置菜单现在在长按 300ms 后，先从当前选中项完整飞行到长按目标项，再进入沿轨道拖动；飞行完成后拖动基准保持在目标位置，避免首个 pointermove 跳回原项。长按浮块使用独立玻璃态，包含厚边缘、内部折射高光、阴影与受圆角裁剪约束的泛光；松手先完成到最终选项的位移动画，再提交并收缩回静态色块。菜单选项的 	ransform、独立 scale 与 ilter 均被锁定，文字和图标不会发生变形。

验证：Desktop typecheck/build、pcGlassMigrationVerify、renderer calls、Electron renderer smoke 全部通过。

### 20260905-145603 移动端暗色竖屏左边栏亮边修复

定位到亮边来自竖屏 ModalDrawerSheet 的全高矩形 liquidGlassModifier：默认 Kyant 外沿高光被绘制在整个左抽屉边界，暗色背景下表现为神秘亮框。新增 dgeHighlight 参数，竖屏抽屉关闭整面外沿高光，保留磨砂、折射和内部控件玻璃交互；默认值保持开启以兼容普通弹窗与交互浮块。

验证：Android :app:testDebugUnitTest 全部通过。

## dev-0.6.5 release runtime gate
Release APK installed on emulator and MSI built. MSI elevation was canceled, so installed-0.6.5 runtime queue/Goal/Flow measurements remain pending; see 本地归档（未纳入公开仓库）.


## dev-0.6.5 cross-platform release artifacts
Windows MSI, Windows portable ZIP, Linux AppImage/deb/portable ZIP, and Android release APK were rebuilt and hash-verified. See 本地归档（未纳入公开仓库）.

## 2026-09-26 PC GUI frame-pressure validation

At the active 2560×1600, 165 Hz PC display, the installed 0.6.6.0 GUI and the packaged v6 unpack candidate both passed their long-history functional and cold-restart checks, but both showed renderer stalls under a 3000-message interactive soak. Renderer RAF p95 intervals were 40.5 ms and 40.4 ms. RAF intervals longer than 9.091 ms accounted for 43.39% and 31.23%; these callback intervals are not actual dropped-present counts. The v6 result is from the unpacked app, not an installed build. Its MSI payload was hash-matched to the unpacked candidate, but Windows canceled elevation; the installed 0.6.6.0 hashes were confirmed unchanged. 本地归档（未纳入公开仓库）.

## 2026-09-27 Build cancellation and sparse Computer Use verification

The desktop build now runs through a phase-logged supervisor with bounded step timeouts and process-tree termination. A live Ctrl+C during `npm run build` stopped the active TypeScript process tree, left no `build-driver` or `tsc` descendants, and a follow-up build succeeded. The packaged Windows x64 0.6.6.0 candidate passed its unpacked CLI, SSH/TUI, context-compression, MSI, and ZIP smoke checks; it was not installed.

The 165 Hz unpacked GUI A/B improved renderer RAF callback cadence from 66.02/s to 76.98/s, while history-page p95 and the longest callback interval regressed. These callback measurements are not compositor presentation FPS, and the GUI remains visibly short of a smooth 165 Hz target. DeepSeek reached sparse-change wakeup and full-image upload, but neither real-provider run completed the semantic task; Windows Firewall prompts obscured the synthetic target. 本地归档（未纳入公开仓库）.


## 2026-10-06 Newmark2DSH rDev transport 排查

本轮只修复插件源码的错误诊断：Agent API 的即时拒绝、流异常和已收到工具调用后的流异常现在保留底层 cause，便于辨认连接失败原因。三条回归修复前失败，修复后 Agent API 268/268、插件总门禁 195/195、预设门禁 23/23 通过。

今天成功解码的会话记录含 339 次 TRANSPORT 失败尝试（rDev 166、Dev 138、原生 cordis 35）、322 条重试和 17 次失败收尾；这是失败事件计数，不能当作总请求失败率。标题生成也失败，现有证据不支持 rDev 特有配置归因。DSH 在序列化错误时丢弃 cause 已由安装版实际类验证；一个压缩帧解码失败，统计可能不完整。根因仍待新鲜、保留 cause 的记录确认。

安装版仍为 0.2.19，工作树原有未发布的 0.2.20 重试候选被保留；本轮没有发布、安装覆盖或重启，也未修改生产记忆库。详细证据见 `Newmark2DSH/archive/20261006-232444-transport-audit/REPORT.md`。

## 2026-10-06 电脑控制 transport 复测

通过原生电脑控制在 DSH Desktop 2.0.17 / newmark2dsh 0.2.19 实测：开始时插件实际关闭；空白会话短文本测试 19 秒成功。临时启用插件后，正确加载的 rDev 空白会话同一提示 18 秒成功，两轮均无可见重试或工具调用。测试后恢复插件关闭状态。未复现当前断流，不能据两次成功排除间歇故障；关闭插件时保留的 rdev 标识不等于加载了该预设。

页面另观察到 Agent API 显示“已启用 / not loaded”，尚未确认是否真实挂载故障，也未证明与 TRANSPORT 有关。操作及边界见 `Newmark2DSH/archive/20261006-235200-computer-use-transport/REPORT.md`；该目录的 before/after 保存六份文档快照。两条测试会话保留供复核；没有重启、安装或部署源码。

## 2026-10-07 Newmark2DSH 当前本地安装与 debug

当前本地安装并启用0.2.22，保留MemoryLab、ComputerUse、Agent API与Dev/rDev。完整核心195/195、客户端119/119、Agent API268/268通过，42安装文件与源码逐项哈希一致。电脑控制实测的rDev原生工具、Agent API真实模型和原先失败的61%上下文长会话均成功，运行计数归零、无租约残留。修复错误链丢失、Agent API挂载标志及热启用状态说明不一致。

新鲜证据捕获deepseek-official一次TLS建连前socket断开，DSH自动重试后成功；未证明rDev或本机代理是根因。独立本机DSH诊断补丁已保留错误链，更新DSH可能覆盖。增量监控曾启用，现已按用户要求删除，改为一次性完整验收；插件验收通过不等于外部间歇网络故障永久消失。本地候选未发布，生产记忆未测试写入。详情和回退证据见 `Newmark2DSH/archive/20261007-101037-installed-debug/REPORT.md`。


## 2026-10-07 一次性全工具与长上下文 heavy 验收

按用户要求删除持续监控，一次性验收已结束。安装0.2.22全部15插件工具连续1416调用零失败；42测试文件与实际安装哈希一致。旧长会话第30轮62工具调用正常completed，跨上下文压缩继续完成5项真实模型任务，独立计算全正确、计数及租约归零。1070条安装版重试/取消函数用例通过。5次连接故障由宿主自动恢复，没有人工停止或重发。历史native会话没有run_code，JS验收由独立CLI补齐，不冒称会话内执行。详情见 Newmark2DSH/archive/20261007-oneshot-heavy/REPORT.md。


## 2026-10-07 新发重试耗尽与限定连接修复

新发TLS连接失败耗尽5次重试已复现。为本机DSH Desktop 2.0.17的官方Messages精确origin https://api.deepseek.com安装可回退直连覆盖，使用同版本Undici fetch/dispatcher，保留TLS校验、取消、其他路由和全部插件能力；插件源码/安装仍0.2.22，未发布。初版dispatcher跨运行时兼容错误已由实机发现并修正。原失败长会话第10轮11工具调用正常completed、重试0，五项真实模型结果独立计算全正确，计数归零。限定origin20无凭据请求、非目标origin和取消用例通过。代理随后也曾恢复，不能称为永久代理故障或证明rDev因果。详见 Newmark2DSH/archive/20261007-1410-transport-exhausted/REPORT.md；持续监控保持删除。


## 2026-10-07 连接补丁后功能无损伤复核

连接补丁后的功能无损伤复核通过：安装0.2.22全部42文件与连接修复前逐项哈希一致且匹配源码；核心195/195、客户端119/119、Agent API268/268、Dev/rDev23/23和实际安装market兼容通过。全15插件工具连续1416调用零失败、零漏测，100模型夹具运行后activeRuns/retainedMessages为0，CU租约free。宿主adapter只改import与Messages fetch函数，鉴权/图像工具序列化/SSE/取消/重试代码逐字未改，其他origin参数与response原样传递。详情 Newmark2DSH/archive/20261007-function-integrity/REPORT.md；实际模型结果以此前1410归档为证。本轮未动生产记忆/源码、未重启或发布、不持续监控。

## 2026-10-08 NewMate 显示同步优化（源码候选）

桌宠、虚拟预览及窗口映射解除固定 30/60 FPS 绘制限制，Windows 按所在显示器垂直消隐调度，Linux 使用 GPU 绘制、独立采集和显示刷新率调度。本机 Windows 原生绘制回调约 57→150 FPS；WSLg 稳态预览约 52→60 FPS。297 项回归通过；这些是渲染回调测量，不等于物理扫描输出。尚未发布、重装或重启生产 DSH。详细数据与限制见 `Newmark2DSH/archive/20261008-animation-vsync/REPORT.md`（子项目内去掉 `Newmark2DSH/` 前缀）。

### 2026-10-11 用户补充后的最终设计范围

newMate以授权本地文件事件、元数据和必要差分作稀疏测量，默认消极主动响应：无变化不后台思考，无关变化不读正文，有意义才调用Agent API，有必要才唤起DSH本体对话。定制陪伴以MemoryLab确认为权威来源；自主链硬禁止删除文件及间接删除。CU读屏只作可选任务辅助。宿主真实会话创建/消息投递/导航契约待核实，不以API临时run或桌宠气泡冒充。设计、工具与文件结构均未实现。

## 2026-10-13 macOS 隔离与 Neo 最低档评估

用户暂停 Space 实现并要求评估，最低部署基线为 MacBook Neo A18 Pro／8GB。Space 不提供独立输入，另用户虚拟显示会话具有原生操作分离的官方依据，但本项目同机接入未验收；VM 系统边界更强，资源开销以测前预算记录。此次仅写评估，不改CU源码、版本、安装或发布。详见[比较与容量预算](Newmark2DSH/docs/12-macos-spaces-vm-assessment.md)。


## Newmark2DSH 插件介绍

[完整产品首页](Newmark2DSH/README.md) 介绍 MemoryLab、ComputerUse、Agent API、NewMate、heartBeat 以及 Dev/rDev 预设的当前功能、安装、使用场景和平台范围。首页格式已纳入 [子项目维护约定](Newmark2DSH/taste.md)。
