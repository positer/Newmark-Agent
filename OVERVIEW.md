# Newmark Agent Overview

## 2026-10-30 0.3.73 汇报出口：`newmate_wechat_send_text`

- **用户要求**：「有事汇报时积极发信 clawbot 让用户了解」。此前主动消息不出微信，只到页面/桌宠。
- **改动**：`lib/wechat-channel.js` 新增 `sendText()`（≤800 字、换行压单段、先判接收者；重复 10 分钟内拒、一小时 ≤6 条、未连接/暂停/无接收者各自具名，拒绝结果写 `stats.reportFailed`，成功写 `reports[]` 与 `stats.reports`）；`components/newmate/index.js` 注册私有工具 `newmate_wechat_send_text`；`component.js` 的 `NEWMATE_RUN_TOOLS` +1 且**不进** `NEWMATE_REQUEST_TOOLS`；`lib/persona.js` 增加汇报边界（报什么、怎么写、没有事就不要发）。
- **状态设计**：`emptyState()` 增加 `reports: []` 与 `stats.reports/reportFailed`；`read()` 的合并保留 `reports`，旧状态文件（无该键）不会报错。
- **门禁**：`verify-newmate-wechat-channel` 121 → **134**（自带 sendmessage-only 假服务器，不依赖前面关闭的 fixture）；变异禁用重复判定 → 133/134 RED。回归 chat 25 / agent-loop 73 / memorylab-tools 182 / conversations 48 / heartbeat 75。
- **安装与实测**：0.3.73（1,312,526 B / sha256 `B9911A43…`）rename 互换装好，119/119 全等；重新挂载后工具组含该工具，真实发送回执 `messageId 7521960525169980936 / chars 56 / remainingThisHour 5`，账本 `stats.reports=1` 一致。

## 2026-10-30 0.3.72 输入提示贴回发送按钮（一行 CSS，三条门禁）

- **现场**：用户截图，`Enter 发送 · Shift + Enter 换行` 漂在输入框正中。根因 `.nm-composer-row` 的 `justify-content:space-between` 把剩余空间在三个子元素间平分。
- **改动**：`packages/newmark-core/client.js` 里 `.nm-composer-hint` 加 `margin-left:auto;margin-right:2px` + `min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right`。无行为改动。
- **门禁**：`verify-newmark-core-client` 124 → **127**；`margin-left:auto` 种回后 124 RED、还原后 127 绿。
- **安装**：0.3.72（1,310,141 B / 119 条目 / sha256 `B14CA703…`）用 rename 互换装好，119/119 与源码全等；备份 `0.3.71-before-0.3.72-20261030-224249`。刷新页面即生效（client half 按安装字节提供），未重启。
- **自伤与修复**：整份重写 `client.js` 时被截断成 51,200 B，用安装目录同版本副本恢复（sha256 `7F939AE4…` 全等）；规则进 `taste.md`。

## 2026-10-30 0.3.71 NewMate 的对话发现：新增只读清单工具，冷读换成宿主真正声明的 `sessionQuery`

- **触发（用户原话）**：「newMate反馈其缺乏获取对话 id 的能力，为其添加，但注意不要越界添加」。现场（19:32 微信通道）：NewMate 说「没有列举会话的工具，重启后又无会话持久化，旧 id 一律 unknown_conversation」。
- **两处事实**：① `lib/conversations.js` 只有 new/send/read，没有发现入口；② 冷读分支调 `sessionPersistence.inspect`/`load`，而**活宿主**的 `sessionPersistence` 只声明 `create/open/flush/stat/list`（cordis Service 探针实测），两个方法都不存在 → 非 live 对话的每次读取都 `unknown_conversation`。旧门禁 30 条全绿是因为 fixture 自造了这两个方法。
- **改动的文件**
  - `components/newmate/lib/conversations.js`：`CONVERSATION_TOOLS` 由 3 变 4（`newmate_conversation_list` 在最前）；新增 `MAX_LIST_SESSIONS=50 / DEFAULT_LIST_SESSIONS=20 / MAX_TITLE_CHARS=120`；新增 `sessionQuery()` 惰性取用、`titlesOf()`（页内一次批量折叠）、`list()`（语料/活会话两源，具名拒绝，`total/returned/truncated`，`self` 标记）；`read()` 冷路径改为 `sessionQuery.readSession` + `readTitle`，legacy `inspect/load` 分支保留在 else。
  - `components/newmate/component.js`：`NEWMATE_RUN_TOOLS` +1 名（仍需 `NEWMATE_REQUEST_TOOLS` 之外，因此自主检查轮也有它 —— 只读发现不该被闸住）。
  - `components/newmate/index.js`：`createConversationBridge` 的 services 里增加 `sessionQuery:()=>ctx.get?.('sessionQuery')`。
  - `components/newmate/lib/persona.js`：第 23 段改为「先 `newmate_conversation_list` 看清单…标题缺失就是 null，不要自己编造对话或 id」。
  - `scripts/verify-newmate-conversations.mjs`：重写为 48 条，fixture 换上真实契约（`listSessions/readSession/readTitleSnapshots/readTitle`）+ 计数器证明 list 不打开正文。
  - `scripts/verify-newmark-core.mjs`：heartBeat 工具计数 5 → 6 并补 `heartbeat_activity`（0.3.49 起就陈旧，与本次改动无关）。
  - 六个 manifest → 0.3.71；`VERSION.md` 新增一行。
- **契约锚点（这份改动的证据来自运行中的宿主，不是文档）**：`sessionPersistence.methods = create/open/flush/stat/list`；`sessionQuery.listSessions(): Promise<SessionRecord[]>`（`SessionRecord{header,live,persisted}`）、`readSession(id): Promise<SessionLogSnapshot>`（`{session,inheritedEventCount,events}`）、`readTitle(id)`、`readTitleSnapshots(ids)`（`SessionTitleObservation{ session, title?: SessionTitleSnapshot{title,...} }`）。
- **边界**：只读；分页有界；两个来源都不可用时 `agents_unavailable`，列举抛错时 `list_unavailable`；不加全文检索、不删对话、不写、不遍历 `~/.dsh/sessions`、不跨 profile。
- **门禁**：`verify-newmate-conversations` **48 PASS**；4 条种植变异全 RED 且源码逐字节还原（sha256 `ef18ba683fa8314a…`）；chat 25 / agent-loop 73 / memorylab-tools 182 / version 12 / heartbeat 75 / package 54 全绿。
- **状态**：**0.3.71 已打包 → 已安装 → 已重启 → 已活体验收（2026-10-30 22:10–22:20）**。安装目录 `~/.dsh/profiles/desktop/node_modules/newmark2dsh`（119/119 与源码 sha256 全等），备份 `0.3.70-before-0.3.71-20261030-220317`；重启回执 `phase:committed`（intentId `623de934…`），GUI 端口 62061 → 55255。
- **活体结果**：NewMate 真实调用 `newmate_conversation_list{limit:10}` → `total:324 / returned:10 / truncated:true / source:corpus`（与磁盘 324 个会话目录一致），并正确标出 `self:true` 为本对话、3 条 subagent 行；`newmate_conversation_read{sessionId:session-86562a46…,limit:3}` → `from:persisted`、`title:强化五部分大纲细化`、`total:44`、丢弃 41 条如实上报 —— 这条在修复前是 `unknown_conversation`。
- **两个必须记住的坑**：① 替换正在运行的 bundle 目录会触发 HMR 重载，提权通道挂起时目录为空约 6 分钟、Newmark 工具整块消失（`/newmark-core/update` 404），已用解包目录补齐并 119/119 校验；② 重启后第一轮 NewMate `failed`（`no model has been authorised for this bundle yet`，errors.jsonl 自 2026-10-29 起有同类），原因就是 profile `cordis.patch.yml` 缺 `newmark-core` 行，补 `modelProvider/model` 后热生效。
- **取代关系**：本条取代 2026-10-25 条目中「`newmate_conversation_read` …否则 `sessionPersistence.load`」的说法；旧句已在原处标注。

## 2026-10-29 0.3.70 CU 复查：未读状态被画成「已禁用」，NewMate 页被内容撑宽后裁切

- **方法**：ComputerUse 打开真实 GUI（插件页 / NewMate 设置页）逐页截图，不再只读源码。
- **缺陷 A**：插件页第一帧五个已挂载组件显示「已禁用 · not loaded」，几秒后才变「已启用」。根因：`ConfigComponents` 在路由回答前回退页面快照，本页 `payload` 为空 → 每行 `false`。修：`on()` 返回 `true/false/null`，`null` → 读取中… + `.nmc-dot-pending` + 按钮禁用。
- **缺陷 B**：NewMate 页比窗格宽，第二列与 `N` 被裁。根因：`.nmc-page` 是 auto 尺寸子元素，被网格固有宽度撑爆；旧设置页的滚动壳在重构中丢了。修：`.nmc-page{width:100%;min-width:0}` + 新增 `.nmc-mount{height:100%;overflow-y:auto;padding:24px}`。
- **验证**：探针 —— 插件页 `page=pane`、NewMate `page=pane−48`、905/975/1100/1280 四宽两页全 2 列、`docScroll=clientWidth`（无横向溢出）；真实 GUI —— NewMate 页第二列完整。
- **门禁**：`verify-config-panel` 57 → **58**；`verify-config-format` 18；`verify-version-discipline` 12。
- **安装/重启**：0.3.70 tarball 1,308,012 B / 119 条目 / sha256 `F5F27C98…`；备份 `0.3.69-before-0.3.70-20261029-194615`；119/119 与源码全等；`count:0` → `force:true`；端口 59241；`current:"0.3.70"`。
- **归档**：`Newmark2DSH/archive/20261029-195000-config-sync-and-clip/`（before/after client.js + 三张 CU 截图 + REPORT）。
- **推送与发布**：源仓库 `56ff0f99`（`ls-remote` 复核）；发布仓库 119 copied / 53 changed / 0 removed，tag `v0.3.70`=`6741b41`、`main`=`dd461c0`（rebase 到 `origin/main`，树相同）；npm 工作流 `40872002909` Publish 11 s 成功、`latest` 于 **`12:42:46Z`** 翻到 0.3.70（`fileCount 120`、`unpackedSize 3,743,046`、`shasum 6862bf40…`），Verify 于 `12:42:52Z` 确认，run `success`。
- **两个过程性坑**：本地发布仓库 `main` 落后 15 个提交（先 fetch 再 sync）；`npm publish` 返回 0 到注册表可见相隔 25 分钟（npm 日志写明「正在处理」）——「已发布未可见」≠「失败」。

## 2026-10-29 0.3.69 两页排版不一致：列数由容器宽度决定（auto-fit），改为固定两列

- **报障**：用户对比截图——NewMate 设置页组件区 3 列、插件配置页 2 列，「以插件配置为标准」排查 NewMate 入口。
- **测量**（浏览器探针，Edge + playwright，见归档 `evidence/probe-config-layout.mjs`）：两页**同宽逐像素相同**（@975 card=481 / rowH=118 / state.top=204）；差异只来自容器宽度（插件座位 ≈905 CSS px、NewMate 面板 ≈1040）与 `.nmc-list` 的 `auto-fit`：975→2 列、1100→3 列。
- **改动**（`packages/newmark-core/client.js`，CSS 两条）：`.nmc-list` → `repeat(2,minmax(0,1fr))`（`≤640px` 断 1 列）；`.nmc-row-state` 的 `align-self:center` → `start`（原先比同排按钮低 26 px）。`.nmc-grid` 不动（单卡区恒占满整行）。
- **读数**：修复后 905/975/1100/1280 四宽 × 两页，列数全 2；状态标签与按钮 top 差 0–1 px。
- **门禁**：`verify-config-panel` 55 → **57**（两条新断言钉住列数与对齐）；`verify-config-format` 18（新增 `NEWMARK_CONFIG_HTML=<dir>` 把两页写成可打开的独立文档）；`verify-version-discipline` 12。
- **安装/重启**：`newmark2dsh-0.3.69.tgz` 1,307,429 B / 119 条目 / sha256 `F29DB6EE…`；备份 `0.3.68-before-0.3.69-20261029-193152`；119/119 与源码 sha256 全等；`broadcast` 屏障（`count:1`，两方 auto ack）；端口 → **58868**；`current:"0.3.69"`、六组件 `mounted`、`/newmark-newmate` 200 / 272,006 B。
- **未验证**：真实 GUI 页面外观（探针跑的是本仓库序列化文档，同 CSS 同树但不经过 DSH 外壳的容器）。
- **重启后复盘（19:37:40 +08，端口 58868）**：`current:"0.3.69"`、`compose=true` 且五组件全 `mounted`、模型 `dsh-opencode-go/deepseek-v4.1-flash`、`/newmark-newmate` 200 / 271,997 B；门禁 57 / 18 / 12 全绿。逐条读数见包 `OVERVIEW.md` 与归档 `REPORT.md` §6e。

## 2026-10-29 0.3.68 配置页重构：一条目录两个挂载点，格式化的可复用组件，原生 DSH 令牌

- **要求**：「将 newMate 的配置页面与插件配置页面的内容相互锁定定向，然后整体重构配置页面，采用格式化的可复用格式，并原生使用 dsh 的 css」。
- **代码**（唯一的产品文件是 `Newmark2DSH/packages/newmark-core/client.js`，净 +881 −691）：
  - 新的格式块取代 `CONFIG_CSS` + 600 行 `NewmarkConfigPanel`：`CONFIG_CSS`（单代，全部 `nmc-` 选择器）、`PLUGIN_ROWS_CSS`（唯一非命名空间规则，只由插件挂载渲染）、十个部件 `ConfigPage/ConfigSection/ConfigCard/ConfigRow/ConfigField/ConfigNote/ConfigSwitch/ConfigSelect/ConfigNumber/ConfigButton`。
  - `CONFIG_COMPONENTS`（六个组件的一处声明）、`CONFIG_SECTION_ORDER` + `CONFIG_SECTIONS`（五节的目录）、`CONFIG_MOUNTS`（plugin / newmate 两个挂载点，唯一差异是 `suppressRows`）、`ConfigSurface`（目录 → 页面）。
  - 数据：`useCoreSurface()`（组件/模型/桌宠大小/更新，两个挂载点共用）与 `useCompanionSurface()`（陪伴设置，读写 `/newmark-newmate`）；NewMate 挂载点用页面自己的实时 `state` 作陪伴面，不再二次读同一条路由。
  - 方向：`openNewMateSeat`（apply 内定义）→ `layout.selectPanel('newmate')` + `newmark-newmate-open-chat{settings:true}`；插件页眉由此多一个「NewMate 设置」按钮。
  - 删：`NEWMATE_SLIDER_CSS` 里三条 `nmc-config-*` 残留与不存在的 `--dsw-alias-border-secondary`；聊天表里 27 条孤儿 `.nm-settings-*` 规则；`wechatStatusLine`（升级为工厂作用域的 `wechatPhaseText`，两页共用）。
- **门禁**：`scripts/verify-config-panel.mjs` 37 → 55；**新增** `scripts/verify-config-format.mjs`（18 条，VM + 最小 React/浏览器 + stub ctx，真跑 `apply` 并渲染两个挂载点）；`verify-newmark-core-client.mjs` 124（并修 `expand` 的 children 合并）；`verify-newmark-core.mjs` 的 same-origin 通道断言改为按路径比较 + 命名唯一查询；`verify-version-discipline` 12。
- **独立跑绿的子门禁**：package / memorylab-tools / agent-api / newmate-chat / newmate-initiative / newmate-conversations / newmate-workspace-diff / newmate-attachment / failure-log / newmark-core-client / config-panel / config-format / version-discipline（13 份）。
- **既有红（本轮未碰其判据）**：`verify-newmark-core-activation` 4 条（工具数与注入计数）、`verify-preset-patch` 2 条（活动 profile 的 preset-dev 行）——两者读的都是 host 半边与 profile，本轮 `git diff` 不含那些文件。`verify-newmark-core` 的 25 条红里 21 条是包装层判词（子门禁打 `SUMMARY`、包装层找 `PASS`），与本轮无关。
- **安装与重启（同轮完成）**：`npm pack` → `newmark2dsh-0.3.68.tgz` 1,307,128 B / 119 条目 / sha256 `18811520E293…`；备份 `.newmark-install-backups/0.3.67-before-0.3.68-20261029-184339`；依赖改指 `newmark2dsh-0.3.68-source-live.tgz`，`pnpm install` 2.2 s / `Packages: +1`；**安装态 119/119 与源码 sha256 全等**。重启走 `broadcast` 屏障（另一对话在跑，2 个参与方 `ack:registered`、`ackSource:auto`、`missing:[]`）。
- **重启后活体**（端口 60367 → 62781）：`current:"0.3.68"`（`latest:"0.3.67"`，npm 未发）；`compose:true` 且五个组件全 `mounted:true`；准用模型 `dsh-opencode-go / deepseek-v4.1-flash`（`selectedListed:true`）；`GET /newmark-newmate` 200 / 271,580 B。
- **重启后复核（18:52:30 +08，端口 62781）**：`current:"0.3.68"`；`/newmark-newmate` 200 / 271,572 B（`ok=true`、35 线程 / 188 消息 / 26 待办 / 微信已连接、settings 11 键齐全）；`/newmark-core/components` 200 / 8,219 B、`compose=true`、五个组件全 `mounted=true`、模型 `dsh-opencode-go/deepseek-v4.1-flash`（`selectedListed:true`、`editable:true`）；`verify-config-format` 18 PASS。逐条读数见包 `OVERVIEW.md` 与归档 `REPORT.md` §6c。
- **没做**：没有 `npm publish`；没有在浏览器里打开配置页（`GET /` 从 PowerShell 401，客户端 artifact 不可猜 URL），所以页面外观只有「安装态文件与门禁跑过的源码逐字节相同」这条传递证据，按未验证记。
- **归档**：`Newmark2DSH/archive/20261029-174242-config-page-lock/`（含 `evidence/install-*`、`live-*.json`）。

## 2026-10-29 14:52 只读调研：登录式（Gmail/QQ）与 POP3/IMAP 协议式邮件的读取与发送接口

- **要求**：「只读调研 git 以及其他已有开源实现：主流登录式邮件（gmail、qq）与 pop3/imap 协议式邮件读取与发送接口」。
- **产出**：`docs/research/mail-transport-interfaces.md`（308 行）。仓库此前没有 `docs/research/` 目录，本轮新建；该目录放「调研报告」，与 `docs/` 根下的实现契约文档分开。
- **git 这一半的结论**：`git log --all -i --grep=mail` 只命中两条与邮件无关的提交（DSH 的 mailbox/会话隔离）；无历史分支可捡。仓库里**没有**邮件实现。
- **本机唯一的现成实现**：`~/.dsh/skills/imap-smtp-email`（author NetEase、MIT、`imap@0.8.19` + `imap-simple` + `mailparser` + `nodemailer`）。命令面 `check/fetch/download/search/mark-read/mark-unread/list-mailboxes/list-accounts`（IMAP）与 `send/test/list-accounts`（SMTP）；已带 RFC 2971 `ID`（网易必需）与附件写盘白名单；短板是底层 node-imap 2023 年停更、无 OAuth、无增量游标、无推送。
- **实测底座（未认证、只读）**：7 个 IMAP/POP3 端点与 3 个 SMTP 端点的问候 + `CAPABILITY`/`EHLO`，能力串逐字存档。要点：`imap.gmail.com:993` 有 `IDLE`/`ID`/`X-GM-EXT-1`/`AUTH=XOAUTH2` 但**无 MOVE**；`imap.qq.com:993` 有 `IDLE`/`MOVE`/`UIDPLUS`/`ID`；`imap.163.com:993`（Coremail）**无 IDLE**、`APPENDLIMIT=71680000`；`smtp.qq.com:465` `SIZE 73400320` + `SMTPUTF8`；`outlook.office365.com:993` **`LOGINDISABLED`**。`smtp.gmail.com:587/465` 两次都没收到 greeting（同机 993/995 正常），记为未测到、不猜原因。
- **文档事实（附 URL 与抓取时间）**：Gmail 已不支持「账号密码」，只剩 OAuth2 或 16 位应用专用密码（需 2 步验证）；自助 OAuth 项目 testing 状态 **refresh token 7 天过期、测试用户上限 100**；单日 500 收件人/500 封；`gmail.send` 是 **sensitive**、`gmail.readonly`/`gmail.modify`/`mail.google.com/` 是 **restricted**。QQ：第三方客户端**必须** 16 位授权码（默认关闭、短信密保），未见公众 OAuth API。网易：LOGIN 后**必须先发 RFC 2971 ID**，否则 `SELECT ... Unsafe Login`（官方帮助 + nanobot #1123 + hermes-agent `3fd4ccbd` + 本机 skill 四处独立证据）。
- **环境事实（不是邮件问题）**：pwsh 的 `SslStream` 对这些服务器一律失败（`安全包中没有可用的凭证`），换 Node OpenSSL 成功；本机 TCP 443 直连 gmail/oauth2/googleapis/qq **5 s 内未握手**，而 993/995/465/587 全通，环境里 `HTTP_PROXY=127.0.0.1:7890` → 走 Gmail REST/Graph 的程序必须支持代理。
- **开源盘点（取数 2026-10-29）**：nodemailer 17,696★ / 周下载 29,465,944；mailparser 1,673★ / 6,421,683；imapflow 578★ / 3,275,501（最新 2.9.1）；node-imap 2,222★ / 531,470（最近提交 2023-11-10、194 open issue）；himalaya 7,553★（Rust CLI）；email-oauth2-proxy 1,494★；MailKit 6,865★；imap_tools 848★。MCP 侧：Wh1isper/mcp-email-server 372★、codefuturist/email-mcp 142★；Google 官方 Workspace MCP 服务器（preview，含 Gmail，动作到「建草稿」为止）。
- **建议（写进报告 §7，尚未落地成代码）**：IMAP 用 imapflow、SMTP 用 nodemailer；Gmail 优先 REST + OAuth，失败再退回应用专用密码；网易走轮询而非 IDLE；12 条必须写进代码的坑逐条带出处。
- **文件树**：新增 `docs/research/mail-transport-interfaces.md` 与 `archive/20261029-144039-mail-transport-research/`（REPORT + evidence 4 份 + probes 5 份 + 清单）。**无源码改动、无依赖变更、无版本变更、README 未改**（它对外的能力描述没有变化）。
- **归档**：`archive/20261029-144039-mail-transport-research/`。

## 2026-10-29 11:31 0.3.67：定时待办的激活回答经 ClawBot 投递

- 代码：`components/newmate/lib/wechat-channel.js`（`forwardReminders` → `forwardScheduled`，两种到期方式都转发；水位 `<=` → `<`；日志措辞）、`components/newmate/index.js`（通道契约注释）、`components/newmate/lib/wechat-channel.js` 头部注释。
- 门禁：`verify-newmate-wechat-channel` 117 → **121**；改回旧过滤器时新增 4 条全红（实测 `sends=0`）。版本纪律 12 PASS。
- 活体：`conversation` 激活 **+1,427 ms**、回答 99 字符、微信 `messageId 7521413036687844744`；`reminder` 投递 **+7,495 ms**、`messageId 7521413041557356808`；`replies` 33 → 35。
- 旧待办 `78b46752`（07:30 监考）在准用模型后由 0.3.66 的重试自动补做成功（11:17，246 字符），并随这次重启补发到微信（`7521412651621339016`）——**不需要重建**。
- 版本 0.3.67：tarball 1,306,551 B / 119 条目 / sha256 `37A9F06A…`；安装态 118/119 与源码 sha256 全等；发布仓库 `79845c7` + tag `v0.3.67`（首次 push tag 报 Internal Server Error，重试成功，`ls-remote` 确认 `38499eac…`）。


**推送与 npm（复核，2026-10-29 12:07 +08）**：两个仓库远端与本地 HEAD 相同——`positer/Newmark-Agent` `master` = `6e731825`，`positer/newmark2dsh` `main` = `79845c7`（tag `v0.3.67` 指向它）。npm `dist-tags` → `{"latest":"0.3.67"}`，`time["0.3.67"]=03:36:34.194Z`，`fileCount 120` / `unpackedSize 3,732,419`；工作流 run `40812687259`（push `v0.3.67`，sha `79845c7`）**success**，`03:32:11Z → 03:36:45Z`。tag push → 注册表出现 **4 分 23 秒**，首次采样到 `latest` 翻转 `03:37:04Z`。从注册表下载的 tarball sha256 `5A9FD935…` 与本地回拉对拍那份同一个文件。发布后再采样 5 次（`04:05:16`–`04:07:26`）`latest` 均为 0.3.67，无回翻。注册表版本序列：0.3.61 / 0.3.62 / 0.3.64 / 0.3.66 / 0.3.67（0.3.63、0.3.65 从未发布，符合记录）。
**发布（0.3.67，同日）**：发布仓库 `79845c7` + tag `v0.3.67`（`11:31:39 +08`）→ npm `latest` 在 `03:37:04Z` 翻到 0.3.67（tag→latest 约 **5 分 25 秒**；首次推 tag 被 GitHub `Internal Server Error` 拒绝，重试成功）。回拉对拍：tarball 1,314,473 B / sha256 `5A9FD935…`，120 文件里 **107 逐字节相同 / 12 仅行尾 / 1 公开 README**。源仓库提交 `3f132c26`。
- 失误记录：重启用了 `force:true` 而当时有 1 个其他对话在运行；应先 `broadcast`。

## 2026-10-29 10:2x 0.3.66：审计逼出的四处「投递到了却没激活」

独立只读审计（新起一个 teammate，读源码 + 真跑三份门禁 + 自建探针）的结论分两半：**闸门解耦 PASS**，**端到端语义 FAIL**。四条失败路径与修法见 `README.md` 同日条目；本条记实现落点。

- `component.js`：`unsolicited` 排除 `delegated`；`tick()` 的候选改为「chat → 其余」并跳过 paused 目标（不再 `return`）；`deliverDueTodo()` 到期项逐个判定 + `queue_full` 不再静默；catch 里新增 `nothingAttempted` 分支（exit 3 → `pending` + `retryAfter` + `model_unavailable`）；`DEFERRAL` 增 `queue_full`/`model_unavailable`；新增 `NOTHING_ATTEMPTED` 正则与 `NOTHING_ATTEMPTED_RETRY_MS=5min`。
- 0.3.65 的 `deliveryBlocker()`/`deliveryReady()` 保持不变——审计确认这部分是对的，本轮只补它下游的消费路径。
- `verify-newmate-todo-activation.mjs` 20→31；`measure-newmate-todo-gate-mutations.mjs` 7→11 条变异，并改为**同时**跑两份门禁（`red` 判定覆盖 activation 的端到端行为）。
- 版本：0.3.65 → 0.3.66（中间态不发布）；打包/安装数字见 README 同日条目与归档 `evidence/`。


**重启后活体验收（0.3.66）**：`current:"0.3.66"`、NewMate 200/175,157 B、`pet.running=true`；活注册表描述 `hasNewText=true/hasOldText=false`；同一到期时刻成对验收——`reminder` 延迟 **1.783 s** 投递，`conversation` **到期后 1.223 s 发起激活**（`activatedAt=02:05:36.480`），随后两次尝试都止于 `model_not_selected`，状态为 `pending` + `deferred={code:model_unavailable}` 并在 5 分钟后自动重试（**不是** `failed`）。面板实时行求值：对话行「已到期 · 模型尚未就绪」、提醒行「已投递」。



**准用模型之后的完整链路验收（11:12 +08）**：`agent_api_state` → `model.ok=true`（`dsh-opencode-go / deepseek-v4.1-flash`）。同一到期时刻放两条，**本会话全程 running（宿主必然 busy）**：`conversation` **到期后 739 ms 发起激活**、那一轮跑 8,262 ms、回答 206 字符落盘、无 `deferred`/`error`/`suppressed`；`reminder` **delivered，延迟 9,809 ms**——正好是激活整轮跑完之后 **0.81 s**，即它等的是 NewMate 自己那一轮（`newmate_busy`），不是宿主。至此「投递 → 激活 → 落盘」三段都在活体上跑通。
**发布（同日）**：发布仓库提交 `805fce9` + tag `v0.3.66`（`10:12:29 +08`）→ `latest` 在 `02:15:57Z` 从 0.3.64 翻到 **0.3.66**（tag→latest **3 分 28 秒**，采样见归档 `evidence/npm-latest.jsonl`）。回拉对拍：发布 tarball 1,313,594 B / sha256 `E3A0E3FF…`，120 个文件里 **107 逐字节相同、12 仅行尾不同**（CI 在 Linux 打包 LF）、1 个只在发布包内（公开 README）——**逐条差异都有成因**。
**环境事实（不是本轮引入）**：profile `cordis.patch.yml` 在 09:47:42 被整体替换成 `[]`（备份 `.bak-1793238461030` 仍带 `modelProvider: dsh-opencode-go` / `model: deepseek-v4.1-flash`），因此当前 bundle 没有准用模型，`agent_api_state` 报 `model_not_selected`。本轮未写该文件。
**教训（也写进 taste.md）**：闸门对了只等于「放行」对了；用户说的「投递」在 NewMate 里是「策划 → 运行 → 落盘 → 气泡」四段，任何一段读宿主事实、或被别的任务的格式规则判死，用户看到的都还是「没来」。

## 2026-10-29 09:0x 0.3.65：到期投递与 DSH 会话彻底解耦（两种模式共用一道闸）

**要求**：用户指出 0.3.63 的修法错向——「上个版本要求没有活动对话，我让你修的是不要求 dsh 的会话全空闲，结果你给我修成了需要 dsh 有活动会话」；并给出规则原话：「代办的带 newMate 激活的投递应该和 dsh 本体的会话没有任何关系，只需要投递给 newMate 并激活 newMate 的对话即可」。

**改动（`components/newmate/component.js`，净 −19 行）**
- 删 `activationBlocker()`（九条注意力梯）与 `todoActivationReady()`、`reminderReady()`，改为 `deliveryBlocker()`（陪伴开关 → `newmateBusyReason()`）与 `deliveryReady()`；`deliverDueTodo()` 在按 mode 分支**之前**只调一次，`conversation` 分支不再自己复查；`tick()` 挑 `todo_activation` 任务改用 `deliveryReady()`。
- `DEFERRAL` 由 10 码缩到 3 码（`companion_off` / `newmate_running` / `newmate_busy`）；导出由 `activationBlocker/newmateIdle/reminderReady` 改为 `deliveryBlocker/deliveryReady/newmateIdle`。
- `env.busy`（DSH 会话/队列/job/CU）与桌宠就绪、静默、暂停、阅读、键鼠、草稿**全部**退出 `todos` 投递路径。它们仍在 `environment()` 里，但消费方只剩 `initiativeGate`（主动陪伴）与 `rotateForMessage`、`lateGate`（主动消息），那是「不请自来的打扰」，与本条规则不是一回事。
- `client.js`：`'已到期 · 等'+reason` → `'已到期 · '+reason`（状态不是等待目标）；`nm-todo-hint` 由「激活对话会等待阅读、草稿、输入及静默结束…」改为「两种到期方式都只等「陪伴开启 + NewMate 自己空闲」，与 DSH 工作区会话无关…静默时段只静音气泡，不推迟到账」。
- `lib/mcp.js`：`newmate_todo_add` 的描述改为「BOTH modes wait for exactly two things … DSH host sessions, quiet hours, snooze, the desktop, reading, typing and drafts never hold an item」。

**为什么这是「回到用户要的那条」，而不是又一次扩大**：两个模式在结构上做的是同一件事——把一条到期内容交给 NewMate；差别只在 end-of-line（落一条原文 / 跑一轮模型）。旧代码把「跑一轮」当成「要占用用户的注意力」，于是拿宿主会话与键鼠状态当代理；而打扰的裁决点本来就在 `notify()`（静默/暂停只静音气泡）。用户 07:30 的监考激活被挡到 08:49，正是这条代理的成本。

**证据**
- 运行态取证（`archive/20261029-085759-newmate-todo-gate-no-dsh/evidence/live-state-before.json`）：待办 `78b46752` `mode=conversation`，`activateAt=2026-10-28T23:30:00.000Z`，`deferred={code:host_busy, at:2026-10-29T00:00:01.131Z}`；同机 `quietStart=23/quietEnd=8`。08:00:01 这个写入时刻说明：静默解除后的第一 tick 把码从（静默）改成 `host_busy`，之后一直没变。
- 门禁：`verify-newmate-todo` PASS 34（新增 4 条断言覆盖「宿主/阅读/键鼠/桌宠都不拦激活」「激活落到 NewMate 并跑一轮」「NewMate 自己的回合仍拦，码为 `newmate_busy`」）；`verify-newmate-todo-activation` PASS 20；变异门禁 7 条全红、源码逐字节还原。
- 回归：initiative 57、chat 25、agent-loop 73、reply-and-repeat 15、report-display 5、attachment 87、settings PASS、version-discipline 12 全绿。`verify-newmate-todo-web` 需要 `NEWMARK_WEB_DEPS`/`NEWMARK_EVIDENCE_DIR` 未提供，本轮未跑；`verify-newmate-menu` 需要 webview2 vendor 目录的独立装配，本轮未跑。

**边界**：`verify-newmate-presentation` 红，且已实测在 HEAD 代码下同样红（chat prompt 1003 字符，不含人格三段），属既有失败，本轮未修。面板文案只在数据层验证到表达式改动（见归档），浏览器渲染实测在重启后补。
## 2026-10-28 17:48 0.3.64 已推送 git 并发布到 npm（latest 已翻转）

**要求**：「打包安装并重启验证，推送git，监控npm latest」。

**打包/安装/重启**：复核而不是重做——安装态与源码 118 个可比文件 sha256 全等，唯一「不同」的 `package.json` 差异只是序列化（canonical JSON 相等），重装是空操作。运行态实测 `current:"0.3.64"`、`GET /newmark-newmate` 200 / 251,560 B、工具描述为新文案。

**推送 git（两个仓库）**
- 主仓库 `positer/Newmark-Agent` `master`：`087328a1`（14 文件、+302/−19），显式路径暂存，未并入他人的 `DESKTOP/` 改动；`83efd901..087328a1` push 成功。
- 发布仓库 `positer/newmark2dsh` `main`：`sync-release-repo.mjs` 同步（copied 119 / changed 9 / removed 0，六个清单 0.3.64）→ 改公开 README → `7193473` → tag `v0.3.64`（`76f038c5…`）→ push 成功。
- 公开 README 第 104 行原是**改动前**的全局描述（「到期表示最早可激活时间，不保证精确到秒送达」），已换成两模式对照表 + 「提醒不等宿主」「静默只静音气泡」。

**npm**：tag 推送触发 `publish.yml`（OIDC），run `40666442814` 09:43:16Z → **09:45:18Z success**；轮询 `latest` 于 **09:45:42Z 从 0.3.62 翻到 0.3.64**（tag→latest = 2 分 26 秒；历史上 0.3.61/0.3.62 约 20 分钟，本轮只记录这个观测）。

**发布字节 vs 本机字节**（`evidence/COMPARE.json`，发布 tarball sha256 `6DC1E99C…`，120 文件）：raw 全等 106；**12 个仅行尾不同**（发布侧 LF，本机 Windows 侧 CRLF——`.gitattributes` 的 `eol=lf` 让 CI 按 LF pack）；`package.json` 仅多一个结尾换行（canonical 相等）；`README.md` 只在发布包里（发布仓库根自带的公开 README）。

**边界**：本轮没有从干净状态重走 uninstall→install→restart；`computeruse/.runtime/` 三个文件仍是进场前的 modified（未提交）；其他 dist-tag（`next` 等）未查；macOS/Linux 未验；面板浏览器实测仍缺。

## 2026-10-28 17:40 0.3.64：工具说明与 0.3.63 行为对齐，已安装并重启

**为什么有 0.3.64**：0.3.63 验收时读 `newmate_todo_add` 的描述，发现它仍是旧契约（「At due time current attention is protected … companion off postpones delivery」）。**模型看到的是旧说明，行为却是新规则**——同一个改动没做完。0.3.64 只改这一句。

**两 tarball 逐文件证据**（`TARBALL-DIFF-063-064.txt`，解包后 119 个文件逐个 sha256）：**differing=7** = 6 个清单的 `version` 字段 + `components/newmate/lib/mcp.js`。`component.js` 与 `client.js` **不在差异里**，所以「行为逐字节相同」是测出来的。

**安装**：`newmark2dsh-0.3.64.tgz` 1,304,666 B / sha256 `7B830CC5…`；装进 `~/.dsh/profiles/desktop`（同一套 tarball + 依赖指向 + `pnpm install`），`0.3.63 → 0.3.64` EXIT=0；安装态与源码 **118 个可比文件 sha256 全等**。

**重启**：这次走**两阶段广播屏障**而非更新路由——`heartbeat_restart {broadcast:true, ackMode:'auto'}` 让三个运行中会话全部 `registered`（auto 覆盖，不花模型调用），`heartbeat_restart_commit` → `committed`。GUI 端口 `57647 → 62684`。

**重启后实测**：安装态 `package.json` = 0.3.64；`GET /newmark-core/update` → `current:"0.3.64"`；`GET /newmark-newmate` 200 / 251,568 B，`pet.running=true`、`statusAgeMs=131`、`wechat.connected=true`、`pending todos=0`；**工具描述读回**（`agent_api_catalog detail=full`，取自运行中的注册表）：`hasNewText=true / hasOldText=false`。

**边界**：面板「已到期 · 等<原因>」仍未做浏览器实测；npm 未发布（`latest` 仍 0.3.62）；0.3.64 只改说明文字，未新增行为断言。

## 2026-10-28 17:16 0.3.63 已打包、已安装、已重启，并完成成对行为验收

**做了什么**：`pnpm pack` → `newmark2dsh-0.3.63.tgz`（1,304,570 B / 119 条目 / sha256 `77A7D592…`）→ 按仓库既有做法装进 `~/.dsh/profiles/desktop`（tarball 进 profile + 依赖指向 `*-source-live.tgz` + `pnpm install`）→ 登记 `heartbeat_after_restart` → 更新路由重启。

**安装核对**：安装目录 vs `packages/newmark-core` 共 118 个可比文件，**sha256 全部相同，0 处不一致**；源码侧多出的 11 项都是不进包的一次性/运行期文件（`.runtime/payload/*.cs|ps1`、`__pycache__`、`archive/`、old tarball），与 `files` 白名单吻合。

**重启后实测**：GUI 端口 `62829 → 57647`；`GET /newmark-core/update` → `current:"0.3.63"`（`latest:"0.3.62"`，npm 未发布，预期不同）；`GET /newmark-newmate` 200 / 249,266 B，`pet.running=true`、`statusAgeMs=268`、`wechat.connected=true`。

**成对行为验收（同一到期时刻 17:13:39.808）**

| id | mode | 结果 |
|---|---|---|
| `debaf575` | `reminder` | **delivered，延迟 0.26 s**；消息入会话；微信回执 `messageId=7521137104588755592` |
| `50ae8bdf` | `conversation` | **pending + `deferred.code=host_busy`**；面板文案算出「已到期 · 等宿主有会话在运行」 |

到期瞬间宿主确实忙：`watch.dshWindows` 记录 `17:10:26→17:14:56` 有会话覆盖该时刻。**这正是 0.3.62 会拦住提醒的条件，现在它只拦对话激活。**

**未做/边界**：面板文案只在**数据层**验证（用安装态 `client.js` 原表达式对实时行求值），**未做浏览器实测**；对照组因我自己这一轮一直 running 而始终 `host_busy`，「忙解除即激活」只有离线门禁覆盖；「0.3.62 会拦」是上一轮实测归因 + 本轮源码核对的推论，**未做跨版本 A/B**；验证结束后该对照组已取消且 `deferred` 被清空。npm 未发布（`latest` 仍 0.3.62）。

**归档**：`archive/20261028-1540-install-0.3.63/`（tarball、前后 profile 配置、两次实时采样、`ACCEPTANCE.json`、`panel-probe.json`、`MANIFEST.sha256.txt`）。

## 2026-10-28 15:10 0.3.63：提醒投递只受「陪伴启用 + NewMate 空闲」约束

**要求（用户原话）**：「取消消息投递的dsh无会话限制，只限制陪伴启用以及newMate空闲」。

**改前**（`archive/20261028-1447-todo-deferral-diagnosis/` 已确诊）：`deliverDueTodo()` 让 `reminder` 与 `conversation` 共用 `env.busy`，而 `env.busy` = 任意 DSH 会话 running；14:00 的用户提醒被另一工作区的会话压了 767.5 秒，且 `todos[]` 不记录原因。

**改后**：`components/newmate/component.js`
- 新增 `newmateBusyReason()`（`newmate_running` / `newmate_busy` / null，**只看 NewMate 自己**）、`newmateIdle()`、`reminderReady() = companion && newmateIdle()`。
- 新增 `activationBlocker()`：对话激活的完整注意力闸，改为**逐条返回首个**不满足条件；`todoActivationReady() = activationBlocker()===null`（行为等价、可解释）。
- 新增 `DEFERRAL` 码表与 `defer(item,code)`：只在 code 变化时写 `todo.deferred={code,at,reason}`（tick 1.5 s，不重复落盘）。
- `deliverDueTodo()` 分流：`conversation` = newmate 忙 → 注意力闸；`reminder` = 仅 `reminderReady()`。两分支各自 `defer` 原因。
- `tick()` 的到期判断不再因 `companion` 提前短路（否则 `companion_off` 永远算不出来）。
- `todoCancel()` 清掉 `deferred`；导出 `activationBlocker/newmateIdle/reminderReady` 供门禁直接断言。

**提醒不再看的条件**：宿主会话在跑、桌宠就绪、页面阅读、本进程阅读窗口、键鼠空闲、草稿、静默时段、暂停。**静默/暂停仍只静音气泡**（`notify()` 未改），消息与回照常落盘——「到了」与「打扰了」分开记。

**仍保留的**：陪伴关闭 → 两种模式都不投递并记 `companion_off`；NewMate 自己的 `chat` 队列 pending/running → 两种模式都让路（这就是「NewMate 空闲」）；对话激活保留 `host_busy` 等全部条件。

**界面**：`client.js` 那句改为 `t.deferred?.reason ? '已到期 · 等'+reason : '已到期 · 等待合适时机'`；升级前的旧 pending 记录无 `deferred`，继续显示旧文案直到下一次 tick 写入。

**门禁**：`verify-newmate-todo` **20 → 33**；新增 `scripts/measure-newmate-todo-gate-mutations.mjs` **7 条变异全红、源码逐字节还原**；`verify-newmate-todo-activation` 21、`verify-newmate-initiative` 57、`verify-newmate-chat` 25、`verify-newmate-agent-loop` 73、`verify-newmate-reply-and-repeat` 15、`verify-newmate-report-display` 5、`verify-newmate-attachment` 87、`verify-version-discipline` 12 全绿。

**一处由门禁逼出来的设计修正**：初版在 `deliverDueTodo()` 开头留了 `if(!settings.companion) return` 早退，「陪伴开关不再被提醒读取」这条变异因此**变不红**——冗余守卫替被删条件兜了底。删掉早退、让两分支各自给原因后变异才红。（已写进 `taste.md`。）

**版本**：六个 manifest + `VERSION.md` → **0.3.63**（`sub-component change`）。**未打包、未安装、未重启**，本机仍是 0.3.62。

## 2026-10-28 14:47 诊断：定时待办到期不投递，面板显示「已到期 · 等待合适时机」

**用户报告**：设定时 NewMate 激活，到点没投递，面板写着「已到期 · 等待合适时机」。

**结论（实测，非推测）**：闸门按设计工作，但**把原因丢掉了**。本次那条 `4b87642b` 是 `mode='conversation'`，到期时刻（14:00:00）到被手动取消（14:12:47）之间，`watch.dshWindows` 显示受监控根 `…\Files\Code` 下**始终有会话在运行，100% 覆盖**这 767.5 秒，于是 `env.busy` 恒真，`todoActivationReady()` 从未放行。该字段只记根不记会话 id，所以本记录**不指认**是哪一个会话。

**代码事实**
- 面板字串唯一含义 = `status==='pending' && activateAt<=now`（`client.js:2403`），不携带原因；对比 `tasks[]` 会写 `deferred:'target_paused'`，`todos[]` 什么都不写。
- `deliverDueTodo()` 对两模式分流：`reminder` 直接投递（:193-199），`conversation` 先过 `todoActivationReady()`（:186-187）。
- `todoActivationReady()`（:182）九个条件：companion / 非静默 / 非 snooze / `env.ready` / `!env.busy` / `!env.readerFocused` / `readingUntil<=now` / `idleMs>=60s` / 无草稿。
- 另有对两模式都生效的一条（:184）：NewMate 自己有 `chat` 任务 pending/running 时整体 return。
- `env.busy`（`index.js:43`）= 任意 DSH 会话 running 或 inbox 有货 或 jobs 在跑 或 桌宠 CU 占用；不区分是哪个会话。

**反证（同样来自 state.json）**：四条 `mode='reminder'` 已投递记录的延迟为 0.1 / 0.5 / 1.3 / 1.5 秒，其中三条投递瞬间 `dshWindows` 显示有会话在跑——证明「等」只属于 `conversation`。

**产物**（`archive/20261028-1447-todo-deferral-diagnosis/`，本轮**未改任何源码**）
- `evidence/reconstruct-1400-deferral.mjs` → 区间覆盖率 767.5/767.5 s = **100.0%**；截至取消时刻当日 15 段活跃窗口、189.5 / 327.5 分钟（**57.9%**，固定端点）。
- `evidence/gate-is-busy-only.mjs` → 8 断言全绿，离线证明「忙即延后、忙一解除下一 tick 就投递」，且 `reminder` 不受此约束。
- `evidence/diagnose-todo-deferral.mjs` → 实时九条件表（14:49:58：`ready=true, busy=false, idleMs=278953, dueCount=0`）。
- 既有门禁 `scripts/verify-newmate-todo-activation.mjs` **PASS 21** 未受影响。

**边界**：`dshWindows` 是区间级证据，无法反查 14:00 那一刻具体是哪个会话的哪个 turn；`readingUntil` 在内存，不可回放。取消来自面板/MCP 的人工动作（`component.js:591 todoCancel` 是唯一取消路径，当日 14:12 前后无 NewMate 任务记录）。

**建议（未实施，待确认）**：把被拦下的第一个假条件写进 `todo.deferred={reason,at}`；面板那句按 reason 显示；加「现在激活」按 `reminder` 立刻投递。三条都不改闸门语义。

## 2026-10-28 11:5x NewMate 收文件：页面上传与微信入站媒体（0.3.62 源码候选，未安装未重启）

**用户要求**：「为 newmark2dsh 的 newMate 添加文件上传能力，以及通过 clawbot 接受用户从微信发来的文件」。

**起点（实测）**：已安装并运行的是 **0.3.61**（宿主 PID 19632，端口 55277，01:44:45 装、01:45:13 启动）；`GET /newmark-newmate` 200 / 233 069 B，`wechat.connected=true`，`stats={inbound:19,acked:19,skipped:1,replies:24,sendFailed:1,files:1,fileFailed:0}`；`.Newmark/newMate/` 里没有 `uploads/`，入站媒体计数为 0 —— 也就是说**用户发来的图片/文件此前被 `queue()` 的 `message_type!==1` / 纯文本判定直接跳过**。

**改动**
- **新增** `packages/newmark-core/components/newmate/lib/upload-store.js`：`uploadsRoot`、`sanitizeUploadName`、`mediaKind`、`inspectUpload`、`saveUpload`、`pruneUploads`、`resolveUploadPath`（realpath 前缀判定）、`readUploadContent`（按行 + 字节双上限）、`textExcerpt`、`normalizeAttachments`、`attachmentBlock`。常量：20 MiB / 8 个 / 4000 字 / 2 MiB / 2000 行 / 保留 200 个目录。
- **改** `components/newmate/component.js`：`withAttachments()`（预算 = 15000 − 原话 − 240×附件数，装不下先丢片段再拒绝）；`chat(text, execution, threadId, attachments)`；任务记录带 `attachments`；用户消息保留原话并另存附件；新增 `saveAttachment()` / `readAttachment()`；`NEWMATE_RUN_TOOLS` 加 `newmate_attachment_read`（**不进** `NEWMATE_REQUEST_TOOLS`）。
- **改** `components/newmate/index.js`：新路由 `POST /newmark-newmate/upload`（流式 20 MiB，超过 413 且不落盘；`x-newmark-newmate` 头与 `sec-fetch-site` 与既有动作同规）；注册 `newmate_attachment_read`（`ctx.tools.register`，共享注册表）；`case 'chat'` 透传 `input.attachments`。
- **改** `components/newmate/lib/wechat-ilink.js`：`decryptAesEcb`、`parseAesKey`（16 原始字节 / 32 位 hex ASCII 两种编码）、`cdnDownloadUrl`、`downloadMedia`（GET 流式、Content-Length 与实读双判上限、失败码分开）。
- **改** `components/newmate/lib/wechat-channel.js`：`describeMedia`（官方优先级 image > video > file > voice）、`imageFileName`（字节魔数嗅探扩展名）、`deliverOne`（先取回再 `chat()`）、`queue()/drain()` 重写、`stats.media/mediaBytes/mediaFailed/voiceUnsupported`、`status().media`、回执 `attachment{name,bytes,kind,sha256}` 与 `mediaFailure`。
- **改** `client.js`：输入框旁「📎 上传文件」（隐藏 `input[type=file]`，`POST /newmark-newmate/upload`）+ 待发附件标签（可移除）+ 用户消息里的附件标签 + `.nm-attach*` 样式；`send()` 提交 `attachments` 后清空。
- **文档**：新增 `docs/17-newmate-attachments.md`（契约、协议出处、错误码、门禁、未验证清单）。
- **门禁**：新增 `scripts/verify-newmate-attachment.mjs`（87 断言），并登记进`verify-newmark-core.mjs`；六个 manifest 与 `VERSION.md` → **0.3.62**（`sub-component change`，patch +1）。

**实测（本机，可复现）**
- `verify-newmate-attachment` **87 / 87 PASS**；变异（`resolveUploadPath` 容器判定改恒假）→ **2 / 87 FAIL**，失败的正是两条容器断言，恢复后 87 / 87。
- `verify-newmate-wechat-channel` **118 / 118**、`verify-newmate-chat` 25、`verify-newmate-file-navigation` 14、`verify-newmark-core-client` 124、`verify-newmark-core-package` 54、`verify-version-discipline` 12 全绿。
- 真实挂载（`mount-newmark-core.mjs`）里 `newmate_attachment_read` 在共享注册表、`/newmark-newmate/upload` 在路由表；用真实字节驱动该路由 → 200 + 回执 sha256 与落盘一致；用 `state.json` 路径调读取工具 → `file_not_in_upload_store`。

**边界**：未打包/未安装/未重启（运行中是 0.3.61）；真机微信发文件未测；图片未送进模型（授权模型无已核验图片输入能力）；无 PDF/Office 解析与 OCR；`verify-tool-output-boundary` 本轮 **PREMISE ABSENT（exit 2）**——它要的 DSH 安装路径（`DSH_APP_ROOT` 下的 `dsh-util-values`）在这台机器上找不到，不是代码失败，故新工具的「lossless JSON 边界」本轮只有挂载层证据。

**umbrella 最终读数（12:0x 复跑）**：`verify-newmark-core` **206 passed / 4 failed / 2 skipped（212）**，其中 `ok 204 - NewMate attachment gate passes`；剩下 4 条与本轮无关且改动前同样如此（heartbeat 五工具计数早已落后、两个门禁只打印 `SUMMARY` 没有判定词、win32 的 `whole_desktop_capture_is_its_own_scope`）。本轮因新功能而改变的计数已按实测修正：工具 39、路由 13、`newmate_` 13、页面 `fetch` 通道 8（HEAD 实测分别是 38 / 12 / 12 / 7，三处硬编码数字早就落后，已一并改正并逐条写明依据）。

**已安装并重启（12:02–12:05）**：`newmark2dsh-0.3.62-source-live.tgz`（sha256 `D60A0E0E…`）装进 DSH profile，安装目录 **119/119 文件与 tarball 逐字节相同**，经更新路由重启（**55277 → 62829**）。活体验收：工具数 **72 → 73**（新增 `newmate_attachment_read`）、`wechat.media` 字段出现、99 B 文本经 `POST /newmark-newmate/upload` 落盘且 sha256 一致、注册表读回原文、越界路径被拒、NewMate 在真实一轮里答出文件第一行并**自己调用**了读取工具。**真机微信发文件已验证（12:05）**：手机发来 7,658,239 B 的 pptx → 解密落盘为真 PPTX（PKZIP + 70 条目）、`mediaBytes=7,658,239/mediaFailed=0`、回执 sha256 与磁盘一致；NewMate 在微信里如实说「本机不解析 pptx」。用户随后**确认手机上收到了那条回复**，所以「入站文件 → 回答 → 回复回到手机」整圈闭环成立（进程侧 `replies 24→25` + `sent` 新键，用户侧复述确认）。

**已发布（12:30:38）**：源码仓 `9c7f6e33`、release 仓 `841966b` + 注解 tag `v0.3.62` 均推送；工作流 run **40630850759** success；`dist-tags.latest` 从 0.3.61 切到 **0.3.62**（tag 后 19m54s）。发布物与本机已装并验收过的那一份逐文件对拍：120 文件 / 106 字节相同 / 13 仅换行 / **内容差异 0**；registry tarball sha256 `29A2D252…`，sha512 与 `dist.integrity` 一致。

归档：`archive/` 下本轮目录（before/after + OPERATION.md + evidence）。

## 2026-10-28 09:0x 0.3.61 已发布为 npm latest（含 goal 硬恢复与隐藏桌面滚轮修复）

- **release 仓**：main `5352ea7..47d0975`，注解 tag `v0.3.61` → `ebac70a`，本地 == 远端；`sync-release-repo` 报 `copied 118, changed 13, removed 0`，stage 版本 0.3.61。
- **workflow**：run 40610924863 **success（20m36s）**；`Publish` 步早于可见性就完成，之后一直在工作流自己的 `Verify official latest without fallback` 里等——staged 发布的常态。
- **npm**：`dist-tags.latest` 在 **09:07:13** 切到 **0.3.61**（距 tag 推送 20 分钟）。
- **发布包 vs 已安装副本**：119 文件（118 + release 仓 README）、105 字节相同、13 仅 EOL 差异、**内容差异 0**、安装目录无多余文件；发布包里 `components/heartbeat/component.js` 带 `bootPid`，即本轮 goal 硬恢复的代码确实在 `latest` 里。
- **源码仓**：`HEAD == origin/master == 30a594fe`，本轮无待推提交。

归档：`archive/20261028-014600-release-0.3.61/`（refs、20 分钟采样、发布包比对）。
## 2026-10-28 01:5x 硬性 goal 恢复终于成立（0.3.61 装盘重启，实测对话真的续了 round）

**用户的两条批评都成立**：① 之前那份接续文案仍是旧的（持久队列里保留入队时的文本）；② 前几次重启的「恢复」没有一次是组件真正完成的。0.3.54→0.3.61 之间被实测推翻的判断有五个：装新版第一次重启无快照（0.3.54）、已消费快照被当证据（0.3.56）、空注册表被当成没有目标（0.3.57）、`observed armed` 被当终态导致看守提前关闭（0.3.59）、回执跨进程继承污染判断（0.3.60）。

**最终实现**：重启前 `captureGoalSnapshot()` 记录每个 live 对话的最小字段（无 objective）→ 新进程 boot 起 **180 秒窗口**，按 `bootPid` 隔离记录、等 agent 真的载入、每 tick 检查候选（有快照用快照，没有就扫全部 live），读到 `active+disarmed` 立即 `resume` 并读回校验，`observed armed` **不算结束**；窗口到期或全部落定才写 `settled`。另在 boot 时把队列里两条**历史接续文案**改写为当前文案（`RETIRED_CONTINUATION_TEXTS`，调用方自己的 prompt 不动）。

**最终实测（0.3.61，01:45–01:49）**：回执 `bootPid=19632`、窗口 01:45:29–01:48:29、`expected=2 loaded=2`、**`resumed: c3a22d88 {active,disarmed} → {active,armed} verified=true @01:45:29`**、`observed x88`、`closed=window_elapsed`；同一时间窗里目标对话 **`goal rounds` 1 次（01:47:43）**、`update_goal` 0 次、`goal_restore` 0 次、`get_goal` 显示 `active+armed`、已回到课程视频任务。

**门禁** `verify-heartbeat-goal-autorestore` **27/27**（快照/扫描/就绪/窗口/翻转/旧回执/跨 boot 隔离逐条），`verify-goal-restore` 23/23、barrier 103/103 + 变异 34/34。

归档：`archive/20261028-013000-heartbeat-goal-autorestore/`（含五次失败的回执与最终成功回执）。
## 2026-10-28 01:2x 活体验收：0.3.54 装盘重启后，组件自己把 goal 重新 arm 了

**指令**：「装 0.3.54 → 重启一次 → 重启后直接读」。

- **安装**：0.3.54（备份 0.3.53 到 `.newmark-install-backups/0.3.53-before-0.3.54-20261028-011611`）。
- **重启 #1**（进程里仍是 0.3.53）：`goalSnapshot=<null>`、`goalRestore=<null>`——**预料之中**，快照由「重启前那个进程」写，而它还没有 capture 代码。这条也再次印证了「改重启前行为 → 必须在已装新版的进程里再重启一次」。
- **重启 #2**（进程里是 0.3.54）：`heartbeat_activity.goal_restore` 直接读出回执——
  `resumed[0] = { sessionId: c3a22d88…, goalId: goal-50a3f973…, before: {active, disarmed, round 8}, after: {active, **armed**, round 8}, verified: true }`，`attempts: 1`，`skipped: [{ 本会话, not_active_before_restart }]`。
- **目标对话自己的读回**（重启后 `get_goal`）：`{ phase:"active", roundsStarted:8, maxGoalRounds:200 }`，`activation:"armed"`。
- **调用面**：重启后 `update_goal` 派发 **0** 次（此前每次重启必撞一次拒绝），`goal_restore` **0** 次（不需要模型动手）。
- **尚未观察到新的 `<goal_round>`**：arming 已完成，round 由 `dsh-goal-round-driver` 在 agent 空闲时 admit；采样时它还在接续轮里工作。这是驱动器的正常时序。
- **结论**：重启前快照 + 重启后组件直接 `resume` 的两段式在真机成立，恢复过程没有任何模型轮次参与。

归档：`archive/20261028-013000-heartbeat-goal-autorestore/`（含回执原文与两段会话证据）。
## 2026-10-28 01:3x 重启后由组件硬性恢复 goal（0.3.54 源码候选，未安装）

**指令**：「采用这个方式：强制在heartBeat重启前读取所有非归档活动对话的goal状态和对话运行状态，然后在heartBeat重启后硬性直接恢复，而不是通过prompt提示工具调用」+「先仔细调研dsh的代码方面如何实现…暂不安装重启」+「在heartBeat工具层面主动提示使用恢复工具而非原生set goal工具」。

- **先读宿主实现**（解包 `app.asar`）：goal 的 **phase 持久、activation 进程级**——`dsh-goal` 每个新进程从 `disarmed` 起，session-start 边沿再发一次 `disarmed`；`dsh-goal-round-driver` 只在 `phase==='active' && activation==='armed'` 时续跑。`resume(agent, ref)` 的可恢复集合是 active/paused/**blocked**，要求 agent 是 registry 里的同一实例、ref 精确匹配、轮次未耗尽。宿主工具 `update_goal` 的 resume 仍要直接人类轮次。
- **实现**：`captureGoalSnapshot()` 在两条重启路径（`restart()` 与屏障 `commitBarrier`）真正拉起 helper 之前，记录每个 live 对话的 `sessionId / running / goalId / phase / activation / revision / rounds`（**不含 objective**）→ `state.goalSnapshot`；新进程第一个 tick 由 `restoreGoalSnapshot()` 按 sessionId 找回 live agent，**只对重启前是 active 的目标** `resume()` 并读回校验 → `state.goalRestore` 回执（resumed/skipped + 逐条原因）。
- **边界（刻意）**：paused 是用户的暂停、blocked 是人的结论——即使服务把 blocked 列为可 resume 也一律不动；complete 不复活；轮次耗尽 / agent 未载入 / 目标被改过 / resume 抛错都具名跳过；服务不可用最多等 30 tick（约 60 s）后写 `gaveUp:'services_unavailable'`。
- **工具与提示词**：新增 `goal_restore`（参数为空且 sealed，只恢复当前对话的 paused 或 active+disarmed，不改写、不解除阻断、不跨对话）；续跑提示词与**全部 heartBeat 工具描述**改成「目标由组件自动恢复，只有失败时才用 goal_restore，不要用原生 create_goal/update_goal」。
- **门禁**：`verify-heartbeat-goal-autorestore` **16/16**（7 条快照；重启后只 resume 那 1 条 active；paused/blocked/complete 不动；轮次耗尽与 agent 未载入各具名；幂等；服务不可用给放弃回执）、`verify-goal-restore` **23/23**、barrier **103/103**、变异 **34/34**、memorylab 分区修正后 **182/182**。
- **状态**：按你的要求**只改代码、未安装、未重启**；运行中的 DSH 仍是 0.3.53。

归档：`archive/20261028-013000-heartbeat-goal-autorestore/`。
## 2026-10-28 00:4x–01:0x 活体验收：goal 接续修好了；隐藏桌面滚轮改成「发给光标下的窗口」（0.3.53）

**指令**：「正好有一个正在使用虚拟桌面且在 goal running 的对话，安装最新插件、重启并校验 goal 能否正确接续」→ 随后「虚拟桌面似乎没办法提交/触发滚轮滚动指令」→ 再一条：截图显示 `更新目标 · Error: this goal operation requires a direct human turn on a top-level agent`「仍然无法」。

### 1. goal 接续：已修，已活体验收

- 目标对话：`c3a22d88-be78-4ed9-9c09-cbd22ce7717d`（在 Edge 里刷 mooc 课程视频，隐藏/虚拟桌面）。
- 第一次重启（装 0.3.52 后）**没能证明修复**：投递给它的接续仍是旧文案，因为接续由**重启前那个进程**（0.3.50）生成并入队。它在 00:45:51 又调了一次 `update_goal{action:"resume"}` 并被拒——用户截图那条错误就是这一次。
- 第二次重启（进程里已是 0.3.52 代码）后：同一对话收到的接续是**新文案**（`NEW_PROMPT=true / OLD_PROMPT=false`），重启后 `update_goal` 派发 **0** 次，紧接着 `takeover_start` + `process_pull` 把隐藏桌面和 Edge 窗口重新拉起来继续任务。
- 结论：提示词缺陷真的修掉了；**发布顺序的坑**记进 VERSION——续跑文本由重启前的进程决定，所以「改提示词→装盘→重启」只在**下一次**重启生效。

### 2. 隐藏桌面滚轮：原因不是 delta，是目标窗口

- 现场：那 46 次 `app_scroll` 回执全是 `posted=true`（`delivery: hidden-desktop-agent`），页面一格没动。
- 根因：`WM_LBUTTONDOWN` 带客户区坐标、框架会命中测试转发给子窗口；`WM_MOUSEWHEEL` 带屏幕坐标、系统只交给光标下的窗口——隐藏桌面不是输入桌面，没有光标也没有前台窗口，发到框架的滚轮落到 `DefWindowProc`，Chromium 什么也不做。
- 修法：agent 侧加 `WindowFromPoint`（作用域＝调用线程所在桌面）+ `ClassNameOf`；`scroll` 用 `ClientCenterOnScreen` 算屏幕点 → `WindowAtScreenPoint` 解出该点窗口 → 仅当 `IsChild(target, under)` 是后代才发到它 → 失效时显式回落框架，回执分开报 `wheel_target`/`wheel_target_class`/`wheel_target_is_child`/`posted`/`frame_fallback_posted`。
- 新门禁 `verify-cu-hidden-wheel` **10/10**（形状）；门禁自己打印「页面是否真的滚动只有活体隐藏桌面能证明」。**页面动不动仍待活体确认**：目标对话已用 0.3.53 的 agent 重新 `takeover_start`，它下一次滚动的回执会带 `wheel_target_class`。

### 3. 状态

0.3.53 已安装、已重启；源码候选（未发布，npm latest 仍 0.3.50）。

归档：`archive/20261027-010000-goal-continuation-live/`。
## 2026-10-27 23:5x–00:3x 两处组件修复（0.3.52 源码候选）：goal 接续不再越权 + CU 截图可选 png

**指令**：「heartBeat的goal接续行为被工具拒绝…检查修复这个goal接续工具缺陷，对heartBeat的重启接续写白名单」（另一 Agent 反馈）与「优化CU截图可选格式，由调用的Agent可指定」；随后「完成所有组件修复后再push」。

### 1. goal 接续：那条指令**必然**被拒，因为权限不在这一轮

- **现场**：重启后的自动续跑轮里按续跑提示词调用 `update_goal{action:"resume"}` → `this goal operation requires a direct human turn on a top-level agent`。
- **根因（解包 `app.asar` 读宿主源码）**：`@deepseek-ai/dsh-tool-goal/lib/index.js` 的 `requireDirectHuman()` 要求本轮 open turn 里有 `user/message` 且 `source.kind==="user"`、且 agent 是 runtime root；`edit/pause/resume` 与 `create_goal` 都走它，`complete/blocked` 走 `completionAuthority()`（额外接受「本目标自己的那一轮」）。重启接续既不是 user 消息也不是 goal round，所以**四个写操作全部必被拒**。
- **修复**：续跑提示词改成「只 `get_goal` 读、这一轮不写目标」，把重新武装交回人类那句；白名单做成数据 `CONTINUATION_GOAL_POLICY`（`allowed`/`refused`/`authority`/`resume_hint`），提示词由它拼，门禁断言两者一致。**没有**绕过守卫直接调 `ctx.goals.resume()`——那正是宿主拦住的事。
- **门禁**：`verify-heartbeat-restart-barrier` case 15 重写（读得到、写不了、交回人类），**103/103 PASS**；变异 **34/34**，其中 M33 已改锚到新文案且仍 RED。

### 2. CU 截图：`format: bmp|png`，由调用方指定，默认旧行为

- 新增 `lib/image-format.js`（BMP→PNG，node zlib；24/32 位、上下朝向、四字节行对齐；其它布局按名字拒绝）。`observe` 与 `screen_capture` 新增 `format`；隐藏车道只有 `format:"png"` 时转一次，回执给 `image_format{requested,served,conversion_ms}`，失败保留 BMP 并给 `error_code`。
- **新门禁** `verify-computeruse-image-format` **31/31 PASS**：BMP 夹具（32 位正立／24 位倒立）、PNG 解回像素逐字节比对、编码器与解码器互逆、四种拒绝码、文件与接线断言。

### 3. 同批修掉三个陈旧门禁（0.3.49/0.3.50 之后没人跑过）

| 门禁 | 陈旧点 | 现在 |
|---|---|---|
| `verify-memorylab-tools` | 工具总数写死 33（0.3.49/0.3.50 各加一个工具后是 35） | 命名空间分区求和，181/1 → **182/182** |
| `verify-heartbeat-restart-barrier` | 「五个工具」（0.3.49 加了 `heartbeat_activity`）；「legacy 立即重启」的顺序断言（0.3.49 改成先确认后 force） | 六个工具 + 顺序断言，**103/103** |
| `measure-heartbeat-restart-barrier-mutations` | M4 锚点是 0.3.30 之前的 `prepare(version)`；M33 锚点是旧提示词 | 两个锚点都更新，**34/34** |

### 4. 未验证 / 环境限制（如实记录）

- **CU 格式没有活体验证**：本机 takeover lease 被占用，`verify-computeruse-win32` 有 5 条 `takeover_lease_occupied` 失败（first takeover_start 拿不到租约），与本次改动无关，但因此没能在隐藏桌面上真跑一次 `format:"png"`。
- `verify-computeruse-hidden-route` **4 条失败是改动前就有的**：用 `git stash` 把我的三个 CU 文件暂存后复跑，基线同样 4 条红（两条规则 + 三条「plant 没打到文件」的变异行），文件已原样弹回。
- `verify-computeruse-output-boundary` 退出 2 是环境缺 `DSH Desktop\resources\app\node_modules\@deepseek-ai\cordis`，与本轮无关。
- **面板与页面仍无浏览器实测**；本轮也没有打包安装。

### 5. 状态

0.3.52 **源码候选**：未打包、未安装、未重启、未发布（npm latest 仍是 0.3.50）。

归档：`archive/20261027-235900-batch-goal-and-cu-format/`。
## 2026-10-27 23:5x 短期记忆列表：最新在最上（0.3.51 源码候选）

**指令**：「将memoryLab的短期记忆呈现列表顺序反过来…改为最上为最新」。

- **改法**：`client.js` 的 `ShortMemoryView` 新增 `shortNewestFirst()`——按 `createdAt` 倒序、同时间戳按 `seq` 倒序兜底，**显式排序而不是 reverse**；副标题补「最新在最上」。
- **没有动接口顺序**：`GET /newmark-memorylab/short-memory` 仍按 `seq` 升序（活体 30 行，`#1` = 10-12 的旧记录在最前），因为 `lib/memory-context.js` 把这批行当**时间史**注入 NewMate 的初始化上下文，反了会改模型输入语义。呈现层归呈现层。
- **门禁**：`verify-newmark-core-client` 123 → **124 PASS**。夹具原来两条 `createdAt` 相同（那种数据下「排序」与「不排序」只差一个 tiebreak，测不出意图），改成两个不同日期；新增 `ok 22 - the short memory list presents the newest entry first`；过期灰显断言移到 `rows[1]`。变异（去掉排序）→ **122/124**，红的正是这两条，还原 sha256 一致。
- **顺带修掉一个陈旧门禁**：`verify-memorylab-tools` 把组合后的工具总数写死 `33`，而 0.3.49 的 `heartbeat_activity` 与 0.3.50 的 `newmate_wechat_send_file` 之后实际是 **35** —— 跑它必红。改成命名空间分区（memory_lab 9 / agent_api 4 / shortMemory 4 / heartbeat 6 / newmate 12，总数由分区求和），**181/1 → 182/182**。
- **一次 flake**：客户端门禁首跑 `ABORT: the live store changed during the run`（exit 2）——运行中的 0.3.50 在快照期间写了 live 存储；重试即 PASS。记下来免得下次误判成回归。
- **版本**：0.3.51（六个 manifest + `VERSION.md`）。**源码候选，未打包未安装未重启**，所以现在打开面板看到的仍是旧顺序。

归档：`archive/20261027-235900-short-memory-newest-first/`（两份门禁补丁、改动 diff、变异跑、活体接口顺序、MANIFEST）。
## 2026-10-27 23:5x 0.3.50 发布：npm latest 已切到 0.3.50

**指令**：「确认收到，推送git，监控npm latest」。

- **先查再动**：源码仓 `HEAD` == `origin/master` == `85f4e1a7`，**没有待推的提交**（剩下的 `M` 全是既有排除项）；release 仓还在 `f659ddb`（0.3.49）。所以「推送 git」的可做部分是**发布链路**。
- **发布前门禁**：`verify-newmark-core-package` PASS、`verify-version-discipline` PASS、`verify-newmate-wechat-channel` **118/118 PASS**。
- **同步与推送**：`sync-release-repo.mjs` → `copied 117, changed 11, removed 0`，stage 版本 0.3.50（五个组件同版本，`wechat-file.js` 就位）；release 仓 commit `5352ea7`（11 文件 / +485 / −17）→ `f659ddb..5352ea7 main -> main`；注解 tag `v0.3.50` → `b022185` → 推送成功（本地 == 远端）。
- **工作流**：tag 触发 `publish.yml` run **40532122861**，18m44s 后 **✓ success**；期间 `Publish` 步很早就 ✓，之后一直停在 `Verify official latest without fallback` 循环——**staged 发布的预期形态**（publish 已受理，registry 可见性滞后）。
- **监控结果**：每 ~45 s 采样，23:44→23:51 全部 `latest=0.3.49 / 0.3.50=E404`，**23:52:16 翻转**为 `latest=0.3.50` 且 `0.3.50` 可解析——距 tag 推送 **19 分钟**，与 0.3.45/0.3.49 的历史延迟同量级。
- **发布包与已安装版本的对照**（`npm pack newmark2dsh@0.3.50` 解包逐文件比）：118 文件 = 117 包内文件 + release 仓 `README.md`；**101 字节相同、16 个仅 EOL 差异（归一化后内容相同）、内容差异 0**；安装目录多出的 12 个 `components/computeruse/.runtime/**` 是运行时生成，不属于发布包。`wechat-file.js` 在包里，`index.js` 里能搜到 `newmate_wechat_send_file`。
- **状态**：0.3.50 已安装、已重启、已活体验证、**已发布为 npm latest**；四件事首次同时成立。

归档：`archive/20261027-233000-release-0.3.50/`（release refs、workflow run JSON、npm 采样、发布包对照、MANIFEST）。

## 2026-10-27 23:2x 0.3.50 安装并重启（发文件工具真正上线）

**指令**：「安装并重启」。

- **装盘**：`npm pack` → `newmark2dsh-0.3.50.tgz`（1 271 576 B，117 条目，含 `components/newmate/lib/wechat-file.js`），按既有命名落为 `newmark2dsh-0.3.50-source-042252fa.tgz`；profile 依赖从 0.3.49 的 tgz 改指它，**用 DSH 自带 pnpm 安装**（`npm install` 直接 `EUNSUPPORTEDPROTOCOL: link:`——这个 profile 用的是 pnpm 的 `link:` 协议）。备份在 `.newmark-install-backups/0.3.49-before-0.3.50-20261027-230727`（128 文件，0.3.49）。
- **安装核对**：磁盘版本 0.3.50；tarball 与安装目录 **117/117 sha256 相同**（0 差异/0 缺失/0 多余）；`wechat-file.js` 8 576 B、sha `16d756f2…`（与我独立校验、并活体发出去的那份字节一致）。
- **重启**：走**更新路由** `POST /newmark-core/update`（`prepare(0.3.50)` → ticket `fb1ed454-…` → `restart`），不走挂载中的 `heartbeat_restart`。旧端口 54629 消失，新 GUI 端口 **63021**；本会话由更新的 `wokenByUpdate` 接续自动唤醒（接续消息到了）。
- **「跑起来了」的判据（不看磁盘版本号）**：① `agent_api_catalog` → **71 工具**，`newmate_*` **12 个**，含 `newmate_wechat_send_file`（0.3.49 代码里没有这个名字）；② `wechat.json` 的 `stats` 出现 `files`/`fileFailed`（0.3.49 的 `emptyState` 没有）；③ 通道无感恢复（`phase=connected`、`receiveSince=23:25:09`、`lastPollAt` 推进）；④ 门禁 118/118。
- **进程内第一次真实调用**：`newmate_wechat_send_file` 发 `archive/20261027-231500-install-0.3.50/OPERATION.md`（2454 B → 密文 2464），caption `7520868469861372424`、文件 `7520868484994385288`，`receipt.state=accepted_with_message_id`；随后 `stats.files=1`、`lastFile={name:OPERATION.md, bytes:2454, messageId:7520868484994385288, caption:true}`——**这条路径第一次可对账**（之前三次活体都绕过 channel，账本里没有记录）。
- **两个工具坑**（已写进 `taste.md`）：这个 profile 的 `link:` 依赖让 `npm install` 报 `EUNSUPPORTEDPROTOCOL`，必须用 DSH 自带 pnpm；`Invoke-WebRequest` 打本机路由会 5 s 超时，改用 `curl.exe`。
- **状态**：0.3.50 **已安装、已重启、已活体验证**；仍**未发布**到 npm（latest 仍是 0.3.49），发布需 sync-release-repo → tag `v0.3.50` → `publish.yml`。

归档：`archive/20261027-231500-install-0.3.50/`（安装核对、重启后探针、进程内首次调用回执、MANIFEST）。

## 2026-10-27 21:5x 推送 0.3.50 源码 + npm latest 监控

**指令**：「推送git，监控npm latest」。

- **推送**：`f23b8add` → **`d4136646`**（`HEAD` == `origin/master` == `d4136646c5123a5860e9529815a8f9d95acef41b`），一个提交 **18 文件 / +997 / −24**：新增 `lib/wechat-file.js`，改 `wechat-ilink.js`/`wechat-channel.js`/`index.js`/`component.js`，门禁 `verify-newmate-wechat-channel.mjs`（51 → 118 PASS），`VERSION.md` 0.3.50 行（含同日追加），`docs/16` §18/§19，`Newmark2DSH/README.md` 的工具清单与「发文件到微信」一段，六处 `package.json` 版本号，`OVERVIEW.md`/`taste.md`。
- **npm latest 没变，这是对的**：连采 7 次（21:55–22:01，50 s 一次）`latest` 一直是 **0.3.49**，`npm view newmark2dsh@0.3.50` 一直 `absent`。原因不是延迟：**本轮只推源码，没有打包、没有同步 release 仓、没有打 tag**——release 仓仍在 `f659ddb`（0.3.49），远端 tag 到 `v0.3.49` 为止。要发 0.3.50 需要 `scripts/sync-release-repo.mjs` → 提交 → 打注解 tag `v0.3.50` → 推 tag 让 `publish.yml` 跑，**这一步要用户决定**（且 0.3.50 还没打包安装重启）。
- **排除项（与上一轮同一套口径）**：`Newmark2DSH/evidence/` 的浏览器抓取件（超长路径会让 `git add` 整体失败）、`computeruse/.runtime/hidden-agent-ledger.jsonl`（运行时账本）、`DESKTOP/` 的 33 个改动与 19 个未跟踪脚本、根 `VERSION`（0.6.8→0.6.9，属 DESKTOP）、`.gitignore`（culab 忽略项）、`.tmp-*`、`release-dev066/`、`release-auto-tendency-20260928/`、`_tmp-codex-log-probe.txt`、`%SystemDrive%/`、`android/`、`install-task.xml`。
- **一个容易踩的事实**：根 `.gitignore` 的 `archive/` 规则**也匹配 `Newmark2DSH/archive/`**，所以作者那轮写的 `Newmark2DSH/archive/20261027-204541-wechat-send-file/`（两次活体回执 + mount-probe）**不在版本库里**；`docs/16` §18.7 引用它是「本地归档」，别人克隆仓库看不到那些证据。
- **写回**：`OVERVIEW.md` 本节；归档 `archive/20261027-215500-push-0.3.50/`（提交 stat/name-status、refs、7 次 npm 采样、OPERATION.md、MANIFEST）。

## 2026-10-27 21:1x 独立校验「发文件到微信」（用户自写实现的复核）

**指令**：「检查并校验clawbot发文件途径的实现，我自己做的」。

- **范围**：`newmate_wechat_send_file`（0.3.50 源码候选，用户自写）：`lib/wechat-file.js`（新，纯校验）、`lib/wechat-ilink.js` 的 `uploadFile/sendItem/fileItem/losslessIds`、`lib/wechat-channel.js` 的 `sendFile()`、`index.js` 用 `ctx.tools.register` 注册、`component.js` 把名字加进 `NEWMATE_RUN_TOOLS`/`NEWMATE_REQUEST_TOOLS`。
- **三项独立证据**（不是复述作者的门禁）：① `npm pack @tencent-weixin/openclaw-weixin@2.4.10` 解包后逐字段对照，11 项全等（padding 公式 `ceil((n+1)/16)*16`、CDN `/upload?encrypted_query_param=&filekey=`、成功判据 200+`x-encrypted-param`、4xx 不重试/最多 3 次、`media_type=3`、`item type=4`、`aes_key=base64(hex 字符串 ASCII)`、`len` 字符串、一次一个 item、`no_need_thumb:true`、消息外壳），三处差异（thumb_*、run_id、`messageId` 其实是 client_id）均已核对为无损；② 13 条种植变异全部 KILLED 且还原字节一致；③ 用真实 token 第三次活体发文件：8576 B → 密文 **8592**（8576 是 16 的整数倍，只可能是多补一整块），`messageId=7520840536736198920`（19 位字符串），caption `7520840522739816584`。
- **修掉两个缺陷（都在校验层，发送路径一行未改）**：
  1. `homeDirs()` 只归一化了 home、没归一化条目 ⇒ `HOME_DIRS` 12 条里 6 条永远匹配不上。**本机实测 `~/.Newmark/newMate/wechat.json`（自己的 token）与 Edge `User Data` 都判成「可以发」**；改为 `normalize(home + '/' + entry)`，并加 2 条门禁用例（修前 `.ssh` 是全小写，恰好是唯一不需要归一化就匹配的形态，所以原门禁全绿）。种回修复 → 115/118 红。
  2. padding 用例只有一个 **47 字节**长度，而 47 恰好使 `ceil((47+1)/16)*16 == ceil(47/16)*16` ⇒ 去掉 `+1` 的变异体 **102/102 照样全绿**。补 12 条长度扫描（含 16/32/48/64 整数倍）+ 真发一个 48 字节对齐文件断言 `filesize=64`；同一变异体现在 111/116 红。
- **门禁**：`verify-newmate-wechat-channel` 102 → **118 PASS**；回归 12 个门禁全绿（chat / conversations / reply-and-repeat / report-display / config-panel / heartbeat / core-package / version-discipline / agent-loop / settings / initiative / todo-activation）。`verify-tool-output-boundary` 退出 2 是环境缺 DSH 安装路径，与本轮无关。
- **残留风险（未修，已写进 docs/16 §19.6）**：token 文件的**副本**发得出去（判据是目录与文件名，不是内容）；软链接在本机建不出来所以未实测；caption 先发、文件失败会留一条无附件的说明；没有发件去重；图片按文件发会渲染成附件且 EXIF 原样带出；20 MiB 仍是自设值；`~/.Newmark` 整目录被拒（连自己写的报告也发不出去）。
- **改动范围**：`lib/wechat-file.js` 一处 + `scripts/verify-newmate-wechat-channel.mjs` 三处，共 30 行新增 / 1 行删除（`evidence/independent-edits.patch`）。
- **状态**：仍为源码候选 0.3.50，未打包、未安装、未重启；运行中的 DSH 是 0.3.49，`newmate_wechat_send_file` 现在**不在任何对话的工具清单里**，所以活体验证走的是协议半部。

归档：`archive/20261027-212500-wechat-send-file-verify/`。

## 2026-10-27 18:1x 源码仓库推送 + npm latest 监控 + 提醒投递活体验收

**指令**：「推送git并监控npm latest」（本轮第二次）。

- **源码仓库已推送**：`master` `7c458e85…` → `7c36faff`（本地 `HEAD` == `origin/master` == `7c36faffacbc5bb226b6e659e63363002be208850`）。一个提交，**99 文件 / +13 899 / −115**，覆盖 0.3.27→0.3.49：微信 ClawBot 信道（研究 → demo → 桥 → 插件内 `lib/wechat-*.js` + vendored `qrcode-terminal`）、NewMate 三个对话级工具与快照差分监控、heartBeat 两阶段重启与 `heartbeat_activity`、`docs/00–16`、15 个门禁脚本、`SCRIPTS/restart-dsh.ps1`。
- **入不了的目录（如实记录）**：`Newmark2DSH/evidence/cu-hidden-agent/…` 是**捕获的浏览器 profile 抓取件**，其中有路径超过 Windows 的 260 字符上限，`git add` 直接 `Filename too long` 失败。本轮用 pathspec 排除（`':(exclude)Newmark2DSH/evidence'`）绕过，**没有**删证据、**没有**改 `.gitignore`；该目录仍是工作区里的未跟踪内容，后续要么进 `archive/` 要么进忽略表，属于遗留项。同样未纳入本次提交的还有：`.tmp-*`、`_tmp-codex-log-probe.txt`、`%SystemDrive%/`、`android/`、`release-dev066/`、`release-auto-tendency-20260928/`、根 `.gitignore`/`VERSION` 的既有改动，以及 33 个与本次工作无关的 `DESKTOP/` 改动。
- **npm latest 监控**：`npm view newmark2dsh dist-tags` 连采 4 次（18:13:44 / 18:14:08 / 18:14:32 / 18:14:56）都是 `latest=0.3.49`；`versions` 列表末尾 confirm `0.3.49` 是已发布的最新一版（`0.3.47`/`0.3.48` 本该缺席——它们只装过本机，从未打过 tag）。发布路径已闭环：release 仓 `f659ddb` == `origin/main`，`v0.3.49` 注解 tag（`f0c1d68`）已推送，publish run `40484407264` 成功，发布 tarball 与本地实现 `contentDiff 0`（117 vs 116 文件，多一个 README）。
- **同时补的活体验收**：`~/.Newmark/newMate/wechat.json` 实测 `phase=connected`、`lastPollAt` 每秒推进（接收循环活着）、`sent` 里 7 条真实回复各唯一 taskId；4 条 `todo:*` 全是 0.3.47 时期的 `skipped:'no_peer'`，时间都早于 `reminderWatermark=1793094572588`。为此新建 `mode=reminder` 待办 `6bb2e6c1-4c7d-441e-9e5e-a16de4b9d74f`（18:17:10 到期）验证「提醒→微信」这条路径，结果见本节下方追加。
- **发现的新事实**：`newmate_todo_add` 的 `activateAt` 只收**带时区的 ISO 时间**，传 epoch 毫秒被拒（`激活时间须为带时区的 ISO 时间`）；`newmate_todo_list` 返回的 `status` 是 `pending`/`delivered`/`completed`/`cancelled`，与 `wechat.json` 的 `skipped:no_peer` 是**两套独立账本**，排查时要同时看。
- **写回**：`Newmark2DSH/docs/16` 新增 §17（0.3.45–0.3.48 三个活体缺陷的根因/修复/证据）；本节；`taste.md` 追加三条规矩（提交前用 pathspec 排除抓取件证据目录、`String.replace` 之后必须 grep 回符号、发布后按 ~20 s 采样 `dist-tags` 判定 latest）。

- **追加 18:18（活体）**：提醒路径**实测通过**。待办 `6bb2e6c1…` 18:17:11 本地投递（`delivered`/`deliveries:1`），18:17:16 微信侧出现 `{messageId: 7520790708907987000, chars: 52, reminder: true}`。关键是 `lastPeer` 至今为 `null`——证明 0.3.48 的 peer 回退到 `state.ilinkUserId` 是这条路径**唯一**的支点；`reminderWatermark=1793094572588` 早于该条，水印没有吞掉它。两套账本（todo 状态 / `wechat.json: sent`）对得上，且只发一次。

归档：`archive/20261027-182500-git-push-and-npm-monitor/`。

## 2026-10-27 微信 ClawBot → NewMate 信道（只读调研 + 接入设计）

**指令**：「我想将微信clawbot接入newMate，用户通过clawbot向newMate发信=用户向newMate发信，newMate完成回复后通过clawbot发送纯文字的气泡版本」。

- **结论**：入站不需要新内核，出站不需要新协议。0.3.43 的"一条用户消息"只有内核 `components/newmate/component.js:598 chat(text, execution, threadId)`（页面 `index.js:196` 与 MCP `mcp.js:11` 都汇到它），"一条回复"只有出口 `:338 readReply → :356 messages[{text,plain}] → :358 notify`，`plain` 就是气泡/外部渠道版且已持久化。微信侧缺的是**传输层**与**渠道身份三件事**：`messages[].source`（来源可辨识）、`chat()` 的入站幂等 id、授权与线程的显式决定。
- **推荐路径**：两步。步骤 0 用零插件改动的独立桥（入站 `POST /newmark-newmate action=chat`、出站 MCP `newmate_task_status` 取 `plain`）先验证微信侧准入；步骤 1 确认可用后再把桥收进插件并补三件事 + 门禁 `verify-newmate-wechat-channel`。
- **实测（本机 0.3.43，13:44–13:49）**：`GET /` 401；`GET /newmark-newmate` 200 / 120,525 B（102 条消息、含 `plain`）；`GET /newmark-newmate/loop` 200；`POST /newmark-newmate` 无头 400 `请求来源无效`、有头 + 未知 action 400 `未知操作`（已进入插件分发）；MCP initialize 200 且 `serverInfo.version='0.3.14'`（`mcp.js:17` 硬编码默认值，与安装版本不符）；`tools/list` 7 工具、`newmate_chat` 仅 `prompt`；端口仅 `127.0.0.1`。
- **微信侧硬边界（源码复核）**：官方 `@tencent-weixin/openclaw-weixin@2.4.10` 无入站去重、无节流；`replyProgressMessages` 默认 `true` 且每个工具事件各发一条 `sendmessage`（多工具 run 会烧光约 10 条额度）；`getupdates` 请求体只有 `get_updates_buf`+`base_info`，客户端 35 s 超时按空响应续轮询；`sendmessage` 判据 `if (resp.ret && resp.ret!==0) throw`（缺 `ret` 不抛）；`-14` 只在 `getUpdates` 判，停 60 min 后 continue、不自动重登。
- **口径澄清**：`docs`/15 里"30 条/分、1000 条/时、24 小时回复窗"写在企业微信智能机器人一节（`15-wechat-clawbot-research.md:341`，属 §9.3 WeCom），**不是 iLink**；原文归属正确，但引用勿串行。
- **产出**：`Newmark2DSH/docs/16-wechat-clawbot-newmate-channel.md`（301 行：判据 / 现状实测 / 三方案对比 / 接口契约 / 必须一起改的 8 条语义 / 失败面 / 门禁清单 / 未验证清单）；两份子任务证据在归档 `evidence/`（信道追踪 435 行、iLink 规格复核 545 行、本机探针 9 条）。
- **边界**：iLink 全链路**从未真机调用**；宿主准入策略只在文档级（本机放行 ≠ 别处放行）；`newmate_chat` 经工具表调用时宿主是否传 `execution` 未活体验证。**源码零改动**（newmate 组件 18 个文件 mtime 最新 13:15:26，早于本轮 13:40 开工）。

归档：`archive/20261027-134030-clawbot-newmate-channel/`。

### 2026-10-27 14:2x 步骤 0：独立双向探测 demo 交付

**指令**：「做独立的测试demo，用于检查扫码连接与发信的双向是否可接收」。

- **新增（不碰插件、不改发布物）**：`SCRIPTS/clawbot-demo/` — `clawbot-demo.mjs`（42 KB 单文件 CLI，零运行时依赖）、`README.md`、`vendor/qrcode-terminal/`（Apache-2.0，未改动，终端二维码渲染）。
- **命令面**：`selftest`（离线，假 iLink 服务端）/ `login`（二维码 + 扫码轮询，会话落 `~/.Newmark/clawbot-demo/session.json` 0600）/ `run`（`getupdates` 长轮询 + 自动纯文本回执，`--typing` `--no-echo` `--limit`）/ `send <文本>` / `status` / `logout`。
- **判据**：手机收到回执 = 发送方向通；终端 ⬇ 行 = 接收方向通；退出打印"双向连通 / 只收不发 / 没有收到消息"三选一。
- **实测**：离线自检 **28/28 PASS**（登录落盘、二维码内容、token 不外泄、入站计数、`message_id` 去重、长轮询超时不算错、游标续传、`ret=-2` 记失败、`errcode=-14` 停手、notifystart/stop、typing、`getupdates` 体只有 `get_updates_buf`+`base_info`、首轮空游标、`sendmessage` 五字段、三个必需头、`parseLossless` 的 uint64 精度、超长拒绝）；**种植变异**（`message_type: 2`→`1`）27/28、exit 1、失败项恰为 `sendmessage: message_type=2 / state=2`；**生产端点探针**（未扫码）`get_bot_qrcode` 992 ms、`qrcode` 32 字符、`qrcode_img_content` 89 字符 http(s) 链接、首次 `get_qrcode_status` 长轮询到客户端 15 s 超时→`wait`。
- **边界**：真机扫码与双向收发**未验证**（本轮没有绑定任何账号）；demo 回的是固定格式回执，**尚未把入站接到 NewMate**（`POST /newmark-newmate {action:'chat'}` + 读 `message.plain` 是同一节的后半段）。
- **真机实测（15:24–15:26，用户扫码）**：绑定 `confirmed`（`bot_id 11401b9b2fd5@im.bot`）；收到 `test`（`message_id` 19 位 uint64，无损）；回执被服务端接受并分配 `message_id`；用户**把回执原文发回**，独立证明回执真的到了手机；两次 `sendmessage` 响应都**缺 `ret`、只有 `message_id`**（官方判据不抛错 ⇒「没报错 ≠ 已送达」升级为实测样本）。进程自报 `收到 2 / 回执 2 成功 0 失败 / 退出码 0`。
- **跨重启保持已测（15:31–15:35）**：`SCRIPTS/clawbot-demo/cross-restart-test.mjs` **19/19 PASS** —— 进程B 只 `loadSession`/`loadSeen`（等价重启）即恢复，`get_bot_qrcode` 全程仅 1 次，首轮轮询带旧游标、重启前那条被判重复、用磁盘凭据直接发信成功、token 只在 `session.json`。活体：新进程日志「从游标 ChAIAhCW3YLilzQYxY… 继续 / 已去重 2 条」→ 15:35:08 直发（`message_id=7520749831237976712`，用户收到）→ 15:35:13 收到用户回复 → 15:35:16 回执 → exit 0；游标更新为 `ChAIAxDPv6PilzQYxY…`。
- **顺带发现**：`docs/16` 的 §4.4 步骤 0 已由本 demo 覆盖传输层；NewMate 侧接入仍未动一行代码。

归档：`archive/20261027-142000-clawbot-demo/`。

### 2026-10-27 信道接入：`SCRIPTS/clawbot-newmate`（不改核心代码）

- **实现**：`bridge.mjs`（单文件：账本状态机 + 投递 + 回复转发 + CLI + 离线自检）。入站发**页面同款**请求 `POST /newmark-newmate {action:'chat', text, threadId:<activeThreadId>}` + `x-newmark-newmate: 1`，start/steer/queue 全由同一个 `chat()` 决定；出站按 `taskId` 取 `id===task.id && role==='assistant'` 的 `plain`（缺失用 NewMate 自己的 `toPlain`），**永不使用 `text`**。
- **接收确认**：`bridge.json` 账本；NewMate 回 `ok` 即写 `acked`，游标与账本**同一次原子写**（游标不会早于确认推进）；确认后重启/重放都不再投递。确认**不发微信**。
- **零核心改动**：`Newmark2DSH/packages/newmark-core/**` 未动；只用既存 `chat` 动作与 MCP `newmate_task_status`（不可用时回退 `GET /newmark-newmate`）。
- **实测**：离线自检 **22/22 PASS**；**种植变异**（`plain`→`text`）→ 20/22、exit 1，失败项正是"纯文字气泡版"；真实数据抽查 MCP 返回 `plain` 81 字 vs `text` 372 字，`bubbleText` 取到 81 字那条。端口发现：非提权 `netstat` 看不到 DSH 的 LISTEN 行但看得到其连接，故候选端口同时取本地与回环对端并并行探测（找到 57618 用 541 ms）。
- **边界**：NewMate 回 ok 后、账本落盘前被杀 → 重启会再投一次（2 次封顶）；一个微信号 = 一个对话。

归档：`archive/20261027-160500-clawbot-newmate-bridge/`。

### 2026-10-27 0.3.49 heartBeat：重启前强制报告其他运行中对话

`heartbeat_restart {broadcast:false}` 原直接重启。现在：`heartbeat_activity`（只读）→ `heartbeat_restart` 不带 force 时**只返回** `{ok:false, code:'confirmation_required', activity, next:[force,broadcast]}` 不重启 → 由 Agent 选 `force:true` 立即重启或 `broadcast:true` 等待各对话登记接续。`activity()` 只算 `agent.status==='running'` 且未被用户暂停的**其他**对话，请求方作为 `self` 单列；agents 不可用返回 `activity_unavailable` 且不重启。活体：`confirmation_required` 且进程未重启；门禁 heartbeat **75 PASS**。
### 2026-10-27 0.3.44 设置页入口：一个按钮 + DSH 原生弹窗二维码（源码候选，未安装）

- **新增**：`components/newmate/lib/wechat-channel.js`（登录状态机 + 收发 + 账本 + 重新连接的代号取代）、`lib/wechat-ilink.js`（7 端点最小客户端，与 SCRIPTS 版同协议但独立一份：已安装插件不能 import 仓库脚本）、`lib/wechat-qr.js` + `vendor/qrcode-terminal/`（把 `qrcode_img_content` 画成 PNG data URL，编码器 Apache-2.0，`files` 白名单加 `components/newmate/vendor/**`）。
- **改动**：`client.js` 设置卡新增「微信 ClawBot」一行（状态文字 + 发起连接/重新连接按钮）与 `Modal` 二维码弹窗；`index.js` GET 负载加 `wechat`、POST 加 `wechat-connect`/`wechat-logout`、挂载 4 s 后 `resume()`、释放时 `stop()`。**`component.js` 零改动。**
- **语义**：入站 `mate.chat(text, undefined, undefined)`（页面 POST 的同一个函数，运行中即插入引导）；出站只取 `id===task.id` 的 assistant 消息的 `plain`；确认写 `~/.Newmark/newMate/wechat.json` 账本且不发微信。
- **门禁**：新增 `verify-newmate-wechat-channel` **30/30**；变异（`bubbleText`→`text`）28/30 且失败项恰为纯文字气泡版；回归 chat 25 / settings / config-panel 37 / client 123 / reply-and-repeat 15 / package 54 / version-discipline 12 全绿；六个 manifest 与 `VERSION.md` 记 0.3.44。
- **状态**：**已安装、已重启、已发布**。安装：tarball sha256 `1AA1DEEB…`、116 文件与安装目录逐文件零差异、profile 依赖指向 `newmark2dsh-0.3.44-source-1aa1deeb.tgz`；重启后活体：`GET /newmark-newmate` 含 `wechat`（phase=disconnected）、MCP 7 工具、安装态 `client.js` 含「微信 ClawBot」行/发起连接/重新连接/DSH Modal；`wechat-connect` → phase=waiting_scan + 1,757 B PNG data URL（无 token），`wechat-logout` → disconnected。
- **发布**：release 仓 main `0e9fc1c` + tag `v0.3.44`（本地 HEAD == origin/main == tag 指向，bundle guard PASSES）；工作流 [run 40472928592](https://github.com/positer/newmark2dsh/actions/runs/40472928592) success；npm latest 0.3.43 → **0.3.44**；回拉对拍 117 vs 116（多 README）、**内容差异 0**、16 文件仅 EOL、发布物含 wechat 三个 lib 与 QR vendor。
- **0.3.45/0.3.46（同一天）修两个实测缺陷**：
  ① **一条回复发三次微信**：`forwardReplies()` 在 `await sendText()` 之后才删 `awaiting[taskId]`，1 s 定时器与 `1 s 发送重叠 → 同一 task 被发多次。现场 `3 task / stats.replies=8 / sent 3 键`。修：先占位再等网络 + `sent[taskId]` 幂等 + 定时器单飞；离线慢发送复现修前 `sends=2` / 修后 `sends=1`；活体 `replies` 只 +1。
  ② **重启后看着已连接却不收**：0.3.45 的 `index.js` 补丁锚点不匹配、`String.replace` 静默失败 → `resume()` 从未接线，`receiveSince/lastPollAt` 恒 0。修：按真实锚点补 `resume()`/`stop()`、接收循环无限重试 + 指数退避（仅 -14 停手）、90 s 看门狗；门禁加 4 条**宿主接线断言**（30 → **43 PASS**）。
  ③ **更新无感实测（0.3.46）**：同一 `botId`、同一 `connectedAt`、`qr=null`、cursor 保留、`receiveSince>0`、`lastPollAt` 每 `20 s 前进；用户再发一条 → `inbound 3→4`、`replies 8→9`。
  ④ **npm 现在是 staged 发布**：0.3.45 的 CI publish 先 staged、约 20 分钟后才在 registry 可见（期间 `npm publish` 报 `409 ... previously staged`，`/-/stage` 对本账号返回空列表）。**这意味着「tag 推了不等于 latest 立刻变」**，监控窗口要按 ≥20 分钟算。
- **顺带修**：`sync-release-repo.mjs` 的 `**` 翻译被链式 replace 互相覆盖（`vendor/**/*` 会漏掉嵌套文件，发布包将缺二维码编码器）→ 改成单次扫描翻译器，重跑后 13 个 vendor 文件全部同步。

## 2026-10-27 微信 ClawBot（iLink）接口调研

**指令**：「调研微信clawbot接口」。

- **结论**：微信 ClawBot 不是公众号/小程序开放平台，而是 2026-03-22 上线的**个人微信号 Bot 插件**（微信「我→设置→插件」启用）；底层 iLink 协议是 HTTPS+JSON，**7 个 Bot 端点 + 2 个扫码端点**，长轮询收发，无 Webhook、无群聊、个人专用。
- **证据**：官方 npm `@tencent-weixin/openclaw-weixin@2.4.10`（MIT，腾讯维护）源码 + 官方 `docs/protocol_zh_CN.md` + 官方新闻口径；社区实现与 GitHub issue 只作旁证并单独标注。
- **产出**：`docs/wechat-clawbot-interface.md` —— 传输与鉴权头、端点表、消息模型（type 1/2/3/4/5/11/12）、扫码状态机、媒体 CDN（AES-128-ECB+PKCS#7、`x-encrypted-param`）、硬边界、接入方案 A/B/C 取舍与推荐、未验证清单、源码行号索引。
- **关键边界（有证据）**：同一 `context_token` 连续回复约 10 条后 `ret=-2`（issue #81）；`ret=-2 errmsg=rate limited`（#142 日志）；`errcode=-14` 官方处理为**整账号暂停 1 h**（`session-guard.ts`）；`ret:0` 仍可能客户端不可见（#264）；非官方运行环境扫码可能被"此 OpenClaw 的运行环境存在风险"硬拦截（#333，官方登录函数同环境复现）；无公开开发者申请入口（#265 open 无回复）。
- **未验证**：24 h 连接有效期（仅社区 README 声明）、`bot_type` 其它取值、文本单条长度上限、`context_token` TTL、群聊是否服务端已开放。**本轮未扫码调用任何接口**，全部为源码/文档结论。
- 无源码变更、无打包、无发布；文件树仅新增一份 docs 报告。
- 归档：`archive/20261027-130246-wechat-clawbot-research/`。

## 2026-10-26 Newmark2DSH 0.3.28：NewMate 真实监控 DSH 工作区

**指令**：「newMate需要真实的检查本机dsh工作区文件夹中的文件变动，通过稀疏测量监控并适时唤起与用户主动交流」。

- 新 `Newmark2DSH/packages/newmark-core/components/newmate/lib/workspace-watch.js`：`enumerateDirectories` + `createWorkspaceWatcher`。监控根 = 宿主 `workspaceRegistry.list()` 的工作区路径（`watchRoot` 降级为额外目录），5 分钟重扫。
- 稀疏性：只读 `lstat` 的 `size:mtime`（不读内容）、深度 3、20 条忽略表、目录上限 128、待处理 256、省略数上报。
- 真 bug 修正：真 `fs.watch` 探针显示子目录变动被归到工作区根 → lstat 不存在的路径 → 变动丢失；改为按"变化所在目录"测量，并加回归断言。
- `components/newmate/index.js` 接入 watcher、`watchDepth` 配置、`watch` 状态（GET 与 `newmate_state`）；umbrella 注册；六个 manifest → 0.3.28；`VERSION.md` 增行。
- 新门禁 `verify-newmate-workspace-watch` **26 PASS**；同轮 agent-loop 73、heartbeat 60、chat 23、short-memory-mcp 44、conversations 30、activation 57、version 12 全绿。
- 归档：`Newmark2DSH/archive/20261026-193849-newmate-workspace-watch/`（before/after、真实 fs.watch 探针输出、门禁日志、OPERATION.md、MANIFEST）。

**边界**：源码候选，未打包/未安装/未重启；`workspaceRegistry` 在该行作用域是否可达未活体验证（不可达则 `watch.workspaces` 空 + 告警）；深度/目录上限会截断大仓库；Linux `fs.watch` 语义未经本机实测；"适时"由 `initiativeGate` 的节奏决定（balanced：4 小时 gap、每日 4 推理 / 2 消息）。

### 2026-10-26 追加：快照差分 + 加权阈值 + DSH 归因（取代事件监视）

- 新 `Newmark2DSH/packages/newmark-core/components/newmate/lib/workspace-diff.js`：`scanWorkspace` / `diffSnapshots` / `attributeDiff` / `scoreDiff` / `settle` / `evaluateWorkspaces`（纯函数）。
- 启动 15 s 后对比一次，之后按 `watchIntervalMinutes`（默认 30）一次；对比数量/名称/最新修改时间。
- 加权：`0.3·数量 + 0.5·名称 + 0.2·时间`（各组先归一化），累计 `acc` 达阈值（默认 0.6）触发**一次**并归零；跨工作区取最强。
- **DSH 归因**：mtime 落在 DSH 回合活动窗（±90 s）→ 按 `watchDshWeight`（默认 0.1）折算；删除按区间内是否有 DSH 活动粗判。
- 设置页新增：开关 / 间隔 / 阈值 / 深度 / DSH 权重 + 状态行；Config 四位作为首次挂载默认。
- 删除被取代的 `workspace-watch.js` 与其门禁；新门禁 `verify-newmate-workspace-diff` **47 PASS**；回归全绿。
- 归档：`Newmark2DSH/archive/20261026-195306-newmate-workspace-monitor/`。

### 2026-10-26 晚：0.3.28 已安装、已重启、已活体验证

- 安装：pnpm + `newmark2dsh-0.3.28-source-7c51b761.tgz`（98 文件，sha256 7C51B761…）；手工替换目录的方式会破坏 pnpm 布局，已弃用。
- 重启：广播被版本核验拒绝（运行版本 vs 磁盘版本分叉）；更新路由被客户端超时取消且锁死控制器；最终用分离 launcher 完成真实重启（新宿主 20:12，端口 50256）。
- 活体：`watch.runs=1`、6 个工作区根、6 份快照、24 工具含三个对话工具、`dshWindows` 记录到真实活动窗。
- 活体发现：嵌套工作区重复扫描与过度归因（已修源码，`dedupeRoots` + 最长匹配，门禁 50 PASS）；更新路由取消后不复位 `state.starting`（未修）。
- 归档：`Newmark2DSH/archive/20261026-201340-install-0.3.28-live-verify/`、`20261026-200445-install-0.3.28-restart-attempt/`。

### 2026-10-26 20:08 事故：重启后应用未起来（已定位并修）

临时 launcher 按镜像名停进程、只等 6 s、启动无工作目录/无就绪判据/无重试，20:08 停机后应用直到 20:12 才由用户手动启动。产品 helper `core-restart.ps1` 本身正确（等 `dsh web:` 就绪），问题在临时脚本。
修复：① 新 `SCRIPTS/restart-dsh.ps1`（身份停树、等退出、带工作目录启动、等就绪、重试 3 次；`-DryRun` 通过）；② 更新路由取消回调改到 `await` 之前登记，取消时 `helper.cancel()` 复位控制器（源码已修未安装）。
当前应用运行中（pid 68332，端口 50256，0.3.28，`watch.runs=1`，6 工作区）。归档 `archive/20261026-2008-restart-relaunch-failure/`。

### 2026-10-26 20:19 第二次重启失败：Job 对象连带杀死 helper（已修）

DSH 给工具子进程建 kill-on-close Job；helper 杀树时 Job 关闭，连带杀死 helper 与它拉起的应用（日志停在 launch attempt 1，应用 47 秒后由用户手动拉起）。
修复：`SCRIPTS/restart-dsh.ps1` 用 WMI 创建 worker（父进程 `WmiPrvSE.exe`，在 Job 外）再动手，实测 pid 88528 父进程为 WmiPrvSE、标记文件写入成功。
当前 0.3.29 生效：端口 56695、`watch.runs=2`、`acc=0.354`、3 个工作区根（嵌套去重生效）。归档 `archive/20261026-2019-restart-job-object-failure/`。

### 2026-10-26 20:32 heartBeat 修复并验证：重启后接续发生

1. prepare 改用**磁盘版本**（`installedVersion`），修掉"装新版再重启必被拒"；
2. 启动时**认领**其它进程遗留的 waiting 接续（>60 s、上限 8、投一次、`adopted:true`），修掉"重启后没有接续"。
门禁 60 → 64 PASS；0.3.30 已装并走更新路由重启（helper 自报 `DSH host ready; new main PID 57828`），新端口 52521；本轮消息本身就是被投递的接续，heartBeat `tasks:0/receipts:94`。
归档 `archive/20261026-2032-heartbeat-continuation-fix/`。

### 2026-10-26 20:34 过期接续对账（0.3.28 任务 → 0.3.30 现状）

20:00 的「装 0.3.28」接续在 0.3.30 重启时被正常投递（接续机制已工作），但内容过期：磁盘已是 0.3.30，未回装。
对账：watch enabled/30/0.6/0.1、roots=3、runs=4、acc=0.41；24 工具含三个对话工具；真实差分把 2 个改动文件全部归因 DSH（user 0 / dsh 2），有效分 0.0811；dshWindows 10 条。
新边界：采样上限 2048（3646 文件）→ 未采样区名称不可见；改间隔不缩短当前轮；过期接续先对账再执行。归档 `archive/20261026-2034-stale-continuation-verify/`。

### 2026-10-26 20:38 0.3.31：一条接续只发一次（实测）

屏障 auto 登记 + 更新路由 wokenByUpdate 会给同一会话登记两条同文接续（20:32 那次 8 条投递里有两条同文，连叫两轮）。修：enqueue 按 (destination,prompt) 去重（waiting/armed 内），返回 duplicate:true；不同内容仍各自成立。门禁 64→65 PASS。
实测 0.3.31：pnpm 安装、更新路由重启（helper 报 `new main PID 90132`）、端口 53250；启动仅 2 条投递（本会话接续 20:39:11 = 本轮 + 更新后任务 20:39:13）；watch runs=5 / roots=3 / acc=0.503。归档 `archive/20261026-2038-heartbeat-single-continuation/`。

### 2026-10-26 20:44 0.3.32 设置页整合（已安装重启）

监控四项改与下拉框同一套控件（统一高度/边框/底色/圆角、tabular-nums、聚焦禁用态），标签只留名字、单位独立、每项一行范围说明；状态行补"下次约 …"；明写"设置页即时保存、插件配置仅首次挂载默认"；两个开关行统一。
门禁 config-panel 34、client 123；0.3.32 已装（sha256 B59A1BC2…）、更新路由重启（pid 93792，端口 55325）；安装态 client.js 标记齐全。页面无浏览器实测。归档 `archive/20261026-2044-settings-page-integration/`。

### 2026-10-26 20:58 0.3.33/0.3.34 监控并入陪伴

一张卡、一个主动性：阈值随主动性（低 .85 / 中 .6 / 高 .4），删除阈值控件与「每天最多 N 条」，删除每日预算闸门；阈值分数 = 文件分数 + 时间分数（timeWeight .15/.25/.35，idle 饱和一天）；每轮 prompt 带「工作区最近变动」，主动轮要求具体说明。旧 watchThreshold 启动清除。
门禁 diff 51 / initiative 57 / panel 37 / client 123 等全绿；0.3.34 已安装（sha256 B3A542BE…），活体 pace=active→threshold .4、acc .072、roots 3。归档 `archive/20261026-2058-merge-monitor-pace-time/`。

### 2026-10-26 21:20 0.3.35 设置页删减

按截图删掉扫描深度/DSH 权重两个输入与其说明、两条状态行、页脚说明；保留开关、主动性、静默时段、暂停、监控开关、对比间隔，加一行"高级项保留默认值（3 层 / 0.1 倍），可在插件配置里调整"。config-panel 37 PASS、client 123 PASS；0.3.35 已装并重启（pid 92432，端口 65058）。归档 `archive/20261026-2120-trim-settings-block/`。

###### 2026-10-27 12:00 0.3.38 推送 git + 发布 npm

仓库 positer/newmark2dsh：main `8cdc8e5`、tag `v0.3.38`（sync 99 文件/11 变更，GUARD PASSES）。推 tag 触发 publish 工作流（trusted publishing + provenance）→ run 40447320099 success；npm latest 0.3.35 → **0.3.38**（12:02:46）。对拍：发布物 100 文件 vs 本地 99（多 README），16 个差异全是 CRLF/LF，真实内容差异 0。归档 `archive/20261027-1200-push-038-tag-publish/`。

####### 2026-10-27 13:24 README 去版本化 + 0.3.43 发布

README 三处去版本号（commit d9854ff，仓库内匹配数 0）。推 main 时发现 npm latest 仍 0.3.41、仓库 package.json 也停在 0.3.41：0.3.42/0.3.43 从未发布。同步 0.3.43（774a5bb）→ tag v0.3.43 → run 40455094828 success，latest 0.3.43（13:25:49）。对拍 101 vs 100（README）、16 差异全 EOL、真实差异 0；发布物 README 版本号 0 处。归档 `archive/20261027-1324-readme-dedup-and-043-publish/`。

## 2026-10-27 13:17 0.3.43 双版本回复 + 待办重复

回复协议改为 `{text, plain}`：页面用 text（可 Markdown），气泡/外部渠道用 plain（纯文本 ≤80）；协议 JSON 永不当正文，模型不守协议时本地 toPlain 降级。待办新增 repeat（every/unit/weekdays/at 或规则串），交付后用 nextActivation 回到 pending。门禁 reply-and-repeat 15 PASS、report-display 5 PASS，其余全绿。活体：372/81 字符双版、工作日规则串、8 秒重复投递后 2 小时再排。归档 `archive/20261027-1317-dual-reply-and-repeat/`。

## 2026-10-27 12:46 0.3.41 推送 git + 发布 npm

repo 8e21019 / tag v0.3.41；run 40451512519 success；latest 0.3.38 → **0.3.41**（12:47:42）；provenance 在；对拍 100 vs 99（README）、16 个差异全 EOL、真实差异 0。归档 `archive/20261027-1246-push-041-tag-publish/`。

## 2026-10-27 12:43 CU 的输入法控制（实测）

Ctrl+Space 经 CU 投递后任务栏指示器 英→中→英（截图三张）；app_type 以 unicode 事件直接注入中文，绕过 IME。边界：ctrl+shift 真实模式 key_unsupported；win+space 不可用；IME 状态按应用记忆，切的是前台应用的 IME。归档 `archive/20261027-1243-cu-ime-control/`。

## 2026-10-27 12:38 0.3.40/0.3.41 重启窗口回归

两次修复：① 等 user-data 锁释放 + 就绪按宿主判断 + 重试 3 次（0.3.40，证据：failed status + Electron 缓存占用 stderr + 父进程 explorer 说明用户手动开）；② 应用改用 `-WindowStyle Normal` 且**就绪必须有可见窗口**（0.3.41，证据：12:35 那次 running 但 EnumWindows 0 窗口、桌面截图只有壁纸）。12:37:48 实测：status running、pid 34084、窗口标题正确、stderr 0B。verify-core-restart 18/18（树外运行）。归档 `archive/20261027-1235-restart-window-regression/`。

### 2026-10-27 12:20 0.3.39 CU 真实/虚拟亲测 + Ctrl+Space 修复

真实模式逐条有可见效果；虚拟模式对 Win11 Notepad 收据 ok 但无效果（posted 消息被忽略，action_completed:false）。修复 SendKeys 的 SPACE 映射（字面空格），并在白名单注明 ctrl+shift 真实模式不支持。归档 `archive/20261027-1220-cu-live-shortcut-test/`。

## 2026-10-27 08:25 0.3.38 CU 快捷键白名单

新增 `components/computeruse/lib/shortcuts.js`：31 条（截图 30 条 + Ctrl+Space）。出口三处同源：工具描述表格、`action:"shortcuts"` JSON、门禁。补齐 printscreen/plus/minus 的 VK 映射。门禁 9 PASS；活体返回 31 条、平台 win32、含 ctrl+space。归档 `archive/20261027-0825-cu-shortcut-whitelist/`。

## 2026-10-27 08:10 0.3.37 虚拟桌面纯黑修复

诊断副本逐窗口测亮度：三块置顶全屏透明浮层 PrintWindow 返回 true 但全黑，盖住 DSH（lum 31）与任务栏（42）；"captured/failed" 是假绿。修复：≥1/4 屏幕且纯黑的窗口跳过绘制并计 `transparent`。活体 captured 8 / transparent 3 / 非黑 0.561。新门禁 verify-desktop-pet-capture 6 PASS。归档 `archive/20261027-0810-virtual-desktop-black-fix/`。

### 2026-10-27 07:55 0.3.36 NewMate 时间戳

prompt 首行改为带偏移的本机时间两段（当前时间 / 最后一条用户消息发送于），修 UTC 与「本机时区」并置导致的 8 小时错读。verify-newmate-chat 25 PASS。归档 `archive/20261027-0755-newmate-local-time/`。

## 2026-10-26 21:39 newmark2dsh 0.3.35 发布到 npm（latest 已切换）

positer 账号直接发布已验证 tarball（98 文件，sha256 DAB9F57E…）；约 40 秒后 latest 0.3.26 → **0.3.35**；从 registry 回拉 `npm pack` 与本地逐文件零差异，`dist.integrity` 与本地 sha512 一致。`publish.yml` 是桌面应用 `newmark-agent` 的工作流，不发布本插件包；0.3.27–0.3.34 未单独发布。归档 `archive/20261026-2139-publish-0.3.35/`。

## 2026-10-25 Newmark2DSH 0.3.27：NewMate 的三个对话级工具

**指令**：「为 NewMate 新增自主发起工作区新对话和向已有对话发信，以及读取指定对话的工具」。

**改动（Newmark2DSH/packages/newmark-core）**
- 新 `components/newmate/lib/conversations.js`：`createConversationBridge`，三方法 + 三定义 + `stop()`。
  - `newmate_conversation_new`：`agents.create({sessionId, meta:{cwd, agentPreset}, setup: mount})` → `deliverConversation` 投首条消息（`newmark-task:<id>` + flush）→ 落盘后 `workspaceRegistry.attachSession`；cwd 省略时继承本次运行对话的工作区，否则用最新注册工作区，都没有就拒绝（不拿 process.cwd() 猜）。
  - `newmate_conversation_send`：复用 `deliverConversation`；拒绝 `self_target` / `target_paused` / `delivery_failed`。
  - `newmate_conversation_read`：活会话 `snapshotEvents`，否则 `sessionPersistence.load`；只取 user/assistant 文本，最新优先，60 条 / 6000 字符 / 单条 800 字符上限，自报 dropped 与每条 source。（**已被 2026-10-30 0.3.71 条目取代**：宿主从未提供 `load`/`inspect`，现在走 `sessionQuery.readSession` + `readTitle`，legacy 分支保留。）
- 改 `components/newmate/component.js`（组 +3、`conversationOf(task)` 写入 ALS）、`components/newmate/index.js`（懒闭包建 bridge、并入私有映射、teardown 调 `conversations.stop()`）、`components/newmate/lib/persona.js`（授权边界）、`scripts/verify-newmark-core.mjs`（umbrella 注册）、六个 manifest（0.3.27）、`VERSION.md`（新增一行）。
- 新门禁 `scripts/verify-newmate-conversations.mjs`：**26 PASS**。

**门禁**：conversations 30、agent-loop 73、heartbeat 60、chat 23、short-memory-mcp 44、activation 57、memorylab 182、version 12，全部 exit 0（日志在归档 evidence/）。

**新增/修改文件清单**
- 新：`Newmark2DSH/packages/newmark-core/components/newmate/lib/conversations.js`
- 新：`Newmark2DSH/scripts/verify-newmate-conversations.mjs`
- 新：`Newmark2DSH/archive/20261025-153555-newmate-conversation-tools/`
- 改：上述三个组件文件、umbrella、六个 manifest、VERSION.md、两套 README/OVERVIEW/taste

**状态与边界**：**源码候选 0.3.27，未打包、未安装、未重启**（本机仍 0.3.26）。`ctx.agents.create` 的真实宿主行为、preset 在新会话是否真正生效、GUI 里新会话的呈现，均未活体验证；`read` 读原始日志尾部、不折叠 compaction；进程内上限重启归零。

## 2026-10-25 NewMate 的 DSH 对话唤起（调试 + 活体验证）与微信 clawbot 调研

**指令**：「调试 newMate 的 dsh 对话唤起功能，调研微信 clawbot 接口」。两件事互不依赖：前者改 Newmark2DSH 源码与门禁，后者只产出调研文档。

**唤起链路（先定义）**：`newmate_task` → NewMate 持久任务 `destination=<调用方 sessionId>` → tick 的 `deliverConversation()` → `agent.followup`（消息身份 `newmark-task:<id>`、来源 `cordis-host-runner`、进 next-turn 队列）+ `sessions.flush` 持久化屏障。修复前本机 88 条 NewMate 任务里这条链路 0 次执行。

**代码改动（都在 Newmark2DSH/packages/newmark-core）**
- `lib/conversation-delivery.js`：新增 `conversationPaused(goals, agent)`（fail-open 的暂停判据）。
- `components/newmate/component.js`：`goals` 注入；tick 在 `running=true` 前检查目标对话暂停，暂停则任务留 `pending` + `deferred:'target_paused'`，恢复后自动投递，完成时清标记。
- `components/newmate/index.js`：把宿主 `goals` 服务接进 NewMate。
- `scripts/verify-newmate-heartbeat.mjs`：第 23 条由"19 个工具名快照"改为"按族断言 + 成员属于组"，并新增 3 条暂停断言 → **22 → 60 PASS**。

**活体实测**：三个真实 DSH 对话各跑通一次（476 / 963 / 2720 ms 完成投递，目标会话在回合边界落地消息并另起一轮回 `WAKE-*-OK`）；第三个走 `newmate_chat` → NewMate run 绑定 origin → run 内 `newmate_task` 的设计主动线。会话日志与探针自述互为独立证据。

**同轮复跑门禁**：heartbeat 60、chat 23、agent-loop 73、ask 20、short-memory-mcp 44、activation 57、memorylab 182 全绿；未跑 umbrella（CU 活桌面前提）。

**新增文件**
- `Newmark2DSH/archive/20261025-151619-newmate-wake-debug/`：before/、after/、evidence/（三条会话时间线、门禁日志、任务记录、探针记录）、OPERATION.md、MANIFEST.sha256.txt。
- `Newmark2DSH/docs/15-wechat-clawbot-research.md`：微信 clawbot 接口调研（企业微信/公众号/微信客服/个人号 hook 的可行性、风险与本项目最小接入路径）。

**状态与边界**：源码改动**未打包、未安装、未重启**（本机安装态仍是 0.3.26 旧内容，4 个文件不同），版本号未提升；未单独测量"完全空闲无回合的对话被唤起"；未加载对话的 `agents.resume` + preset 重挂载路径本轮未测；GUI 对该消息来源的渲染无浏览器实测。

## 2026-10-21 Newmark2DSH 0.3.21 候选：NewMate 的 CU 权限与实时 Agent 循环

**用户要求**：「为 newMate 添加完整的 newmark2dsh 配套 CU 工具使用权限，并暴露实时 Agent loop 状态」。

**改动（Newmark2DSH/packages/newmark-core）**
- `components/newmate/component.js`：`NEWMATE_RUN_TOOLS` 16 → 18（+`computer_use`、`screen_capture`）；新增 `NEWMATE_CU_TOOLS` / `NEWMATE_CU_OWNER='newmate'` / `NEWMATE_CU_RELEASE_TIMEOUT_MS` / `newMateRunTools({automatic,origin})`；run 用 `withComputerUseOwner → withComputerUseCaller → withNewMateContext({...,onEvent})` 包裹；`live=createLoopStatus(now)`；finally 先 `releaseComputerUse(task.id)` 再 `live.finish(outcome)`；导出 `loopStatus()`。
- `components/newmate/lib/agent-loop.js`（新）：纯记录器，快照 `{running,phase,runId,kind,startedAt,finishedAt,elapsedMs,turns,toolCalls,currentTool,stopReason,error,events≤24/≤6000,cleanup,dropped}`，事件文本 ≤200 字符，结束保留上一轮。
- `components/newmate/lib/persona.js`：697 → 966 字符，写入 CU 授权边界、takeover_start/stop 规则与「ok:true 不等于发生」。
- `lib/cu-caller.js`：新增 owner ALS 与 `computerUseOwner`（宿主对话身份 > 显式 owner > caller 通道）；`components/computeruse/component.js` 改读它。
- `components/agent-api/component.js`：`pushEvent` 在回执两条界之前同步转发 `eventView` 给 `newMateContext()?.onEvent`（观察者异常被吞）。
- `components/newmate/index.js` / `lib/mcp.js` / `client.js`：`newmate_state`、GET `/newmark-newmate`、MCP `newmate_task_status` 三面加 `agentLoop`；页面加状态行动态文案与 `<details class="nm-loop">`（最近 8 个事件），运行中 800 ms / 空闲 2000 ms 轮询。
- 六个 manifest 0.3.21（只改版本字段，CRLF 与字节数不变）；`VERSION.md` 增 0.3.21 行；`Newmark2DSH/README.md`、`OVERVIEW.md`、`taste.md` 写回。
- 门禁：新增 `scripts/verify-newmate-agent-loop.mjs`（45 条；同日追加后 **66**）；`verify-short-memory-mcp`、`verify-newmate-memory-writes`、`verify-newmate-heartbeat`、`verify-newmate-initiative` 中旧的「无 CU」断言改写；`verify-memorylab-tools` 的初始化断言改成「暴露 + toolsMissing = allow list」（该 mount 关掉 ComputerUse）；umbrella 注册新门禁。

**实测（本机活库）**：初始化前缀 24,863 → 30,997 字符（+6,134 = 人格 +269 + CU 参数 schema 5,866；18 条 schema、104 标签、19 节点、11 条短期）；CU schema 只有 `parameters`，不含 description。门禁：新 45（追加后 66）、short-mcp 44、memory-writes 7、heartbeat 57、initiative 57、memorylab-tools 182、agent-api 268、client 123、config-panel 31、compose 25、activation 57、package 54、version 12；`verify-tool-output-boundary` PREMISE ABSENT（DSH 安装路径改名，默认 `DSH_APP_ROOT` 不存在；不是通过）。Umbrella 单次运行 **206 passed / 2 failed / 1 skipped**：win32 与 sweep 在该运行窗口内分别以 `foreground_window_unavailable` 与「原始增量含物理鼠标运动」红。两处都是活桌面前提——win32 随后单独复跑 **25/25 PASS**；sweep 在安静桌面下复跑 **8/8 测量项 PASS**（第 8 项 planted mutation 按设计跳过），再以 `--mutations` 单独跑该项 **PASS**（种植后 check 3 变红、还原 sha256 `6632a72d…` 核对）。因此这两条不计为代码回归，也不把 umbrella 写成全绿。

**状态与边界**：源码候选 0.3.21（**该「未安装」已被 2026-10-21 14:36 的本地重装与重启取代**）；CU 权限不是常开，自动轮次没有桌面工具；租约释放是运行时尽力而为（8 s 有界）；`newmate` owner 的接管只能由之后的一轮 NewMate 或进程退出释放，其他会话会收到拒绝；页面 800 ms 是轮询而非推送。

**归档**：`Newmark2DSH/archive/20261021-133000-newmate-cu-loop/`（before/after、evidence、OPERATION.md）。

## 2026-10-21（追加⑥）Newmark2DSH 0.3.26：实时工况刷新与计时解耦（已安装）

全量轮询 2s；/loop 200ms 刷新；LiveStatus 本地 250ms 按 startedAt 计时。实测版本 0.3.26、/loop 正常；页面无浏览器实测。

## 2026-10-21（追加⑤）Newmark2DSH 0.3.25：私有工具通道 + 自主压缩（已安装）

newmate_search/compact_context 从全局注册表移除，私有映射只供 NewMate 运行；compact_context 由 loop 拦截替换历史。实测 catalog 37 不含两者、初始化 21 工具含两者、toolsMissing=[]；已安装重启。页面无浏览器实测。

## 2026-10-21（追加④）Newmark2DSH 0.3.24 候选：最新实时工况

对话页回到暴露 agentloop 前的形态，只加一条最新工况（最新思考尾部/当前工具，搜索显示「正在进行搜索」）；完整过程时间线删除。门禁 agent-loop 71、client 123、ask 20。**源码候选 0.3.24，未安装未重启**；页面无浏览器实测。PTC 压缩：已定位 compaction 服务，尚未接入。归档：Newmark2DSH/archive/20261021-153456-newmate-live-state/。

## 2026-10-21（追加③）Newmark2DSH 0.3.23 候选：对话页对齐本体

**指令**：对话页完全复用 Newmark 本体设计（含选项询问）；不限对话轮次；只插队不排队。**范围**：只对齐对话页表现，不移植会话内核。**改动**：newmate_ask（2–6 选项 + 手填，阻塞等待，答案作为工具结果继续同一次运行；请求绑定）；agent_api_send `max_steps: 0` = 无轮次上限（NewMate 聊天用 0，自动检查 3）；运行中输入只插队不排队（steer 门禁新增「steering===2 且无 pending chat 队列」断言，待启动任务新输入改为追加）。**门禁**：ask 20、steer 24、agent-api 270、memorylab 182、activation 57、compose 25、heartbeat 57。**0.3.23 已于 2026-10-21 15:24 本地重装并重启生效**（96 文件，sha256 D0ACA55F…；npm 未发布）；页面无浏览器实测。**归档**：`Newmark2DSH/archive/20261021-150654-newmate-option-ask/`。

## 2026-10-21（追加②）Newmark2DSH 0.3.22 候选：Agent 循环过程块

**指令**：「agentloop显示要正确的排列对话思考和工具调用，并将思考与工具调用归纳为可折叠部分，具体参考newmark本体的对话渲染」。参考 `DESKTOP/src/ui/index.html` 的 `renderWorkThought`/`renderWorkToolGroup`。
**改动**：`components/newmate/lib/agent-loop.js`（thinking 时间线片段：原位替换、1,200 字符上限、共享 24/6,000 界、`trimBudget`）；`client.js`（`renderProcess` 单块 `<details class="nm-run">`，按 `events` 顺序渲染思考段与工具短标签，删除旧两块）；门禁 66→**71**；4/4 mutation。
**边界（2026-10-21 14:54 更新）**：**0.3.22 已于 14:52 本地重装、14:53 更新路由 + heartBeat 托管重启生效**（tarball sha256 `856E3510…`，95 文件一致；备份 `0.3.21-before-0.3.22-*`；npm 未发布）；重启后更新路由的 NewMate 任务跑出真实样本，`agentLoop.events` 为 `agent_start,turn_start,thinking,tool_start,tool_end,…,turn_start,thinking,…`（按真实顺序交错）、GET `/newmark-newmate` 200 带 `agentLoop`、进程 catalog 37 含 `newmate_search`。页面仍无浏览器实测；过程块只在运行中渲染。
**归档**：`Newmark2DSH/archive/20261021-145500-newmate-process-timeline/`。

## 2026-10-21（追加，同一 0.3.21 候选）Agent 循环简写标签 + 思考流 + DSH 原生搜索

**用户追加指令**：「newMate 的 agentloop 暴露中工具使用简写为浅色小字…思考内容以可折叠灰色小字实时刷新」；「newMate 接入 dsh 原生搜索接口调用默认官方 api」。0.3.21 未发布未安装，并入同一候选，不新增版本号。

**改动（Newmark2DSH/packages/newmark-core）**
- `components/agent-api/lib/llm-seam.js`：`collectAssistant` 的 `onPartial` 接上思考通道，`reasoning-delta` 累积后按 `THINKING_CHUNK_CHARS=120` / `THINKING_CHUNK_MS=200` 通过队列发布 `thinking` 事件；失败重试重开文本。
- `components/agent-api/lib/loop.js`：`streamAssistantResponse` 处理 `thinking` 事件并 `emit`。
- `components/agent-api/component.js`：`eventView` 增加 `thinking`（尾部 `THINKING_LIVE_LIMIT=4000` + 截断标记）；`pushEvent` 对该类型只转发观察者、不入回执。
- `components/newmate/lib/agent-loop.js`：追踪器新增替换式 `thinking:{text,at,truncated}`（不进事件环、不占 dropped）。
- `components/newmate/lib/web-search.js`（新）与 `components/newmate/index.js`：`newmate_search` 工具；接缝优先、`DeepSeekSearchProvider` 回退（官方默认端点/模型/凭据），1–4 query、最多 8 来源、60 s、不可信声明、具名拒绝。
- `components/newmate/component.js` + `lib/persona.js`：组 18→19；`NEWMATE_REQUEST_TOOLS=[...CU, newmate_search]` 扣在自主轮次；人格 966→1071 字符。
- `client.js`：`toolAction()` 三类映射 + 「正在/已」两态（浅色 11px）；`<details class="nm-thinking">` 灰色小字实时思考；原始工具名/参数不再显示。
- 门禁：新门禁 45→**66**；`probe-compose`（工具 34→35）、`verify-newmark-core-activation`（34→35）、`verify-memorylab-tools`（组合 32→33、初始化含 newmate_search）、`verify-newmate-heartbeat`（允许名加搜索）同步更新。

**实测**：前缀 30,997 → **31,390**（+393）；19 条 schema、toolsMissing=[]。宿主进程层 `agent_api_send {allow:['web_search','web_fetch']}` 回执 `tool_names: []`、`tools_withheld: 2`。门禁全绿（新 66、compose 25、activation 57、memorylab-tools 182、heartbeat 57、short-mcp 44、memory-writes 7、initiative 57、chat 23、todo 20/21/23、agent-api 268、client 123、config-panel 31、package 54、version 12）；6/6 planted mutation 变红还原。

**边界（2026-10-21 14:39 更新）**：**已本地重装 0.3.21 并经更新路由 + heartBeat 托管重启生效**（tarball sha256 `614F7C22…`，95 文件一致；备份 `0.3.20-before-0.3.21-20261021-143602`）；npm 未发布。重启后实测：`newmate_state` 带 `agentLoop`（真实运行 3 轮/4 工具/16.0 s/思考 4,015 字符 truncated）、`/newmark-newmate` 返回 `agentLoop`、进程层 catalog 37 含 `newmate_search`、搜索实测 `provider:"ctx.web"` 返回 8 来源。**更正**：旧句「`ctx.web` 在本机是 agent 预设服务，NewMate 实际走 provider 回退」错误——`web_search` 工具不在进程层，但 `ctx.web` 服务在插件作用域可达；回退只留给没有该服务的宿主，门禁用假 provider 覆盖。页面无浏览器实测（无 Playwright），client 断言为源契约；思考只在模型发 `reasoning-delta` 时出现；简写是展示层，服务端事件保留原始工具名。

**归档**：`Newmark2DSH/archive/20261021-133000-newmate-cu-loop/evidence/addendum/` 与 OPERATION.md 第 9 节。

## 2026-10-20 Newmark2DSH 0.3.20 候选：NewMate 初始化四项一次给全

**改动**：新增 `components/newmate/lib/persona.js`（`NEWMATE_PERSONA`，697 字符）；`lib/memory-context.js` 生成 `{tree, shortMemory, shortMemoryTotal, shortMemoryOmitted, tools, toolsMissing}` 并把人格放在前缀首段——`tree` 为完整标签树（全部标签 + 每个记忆节点 slug/name/tags，无正文/description/路径/bytes）；`shortMemory` 全部行（createdAt/expiresAt/expired）；`tools` 为 `NEWMATE_RUN_TOOLS`（16 条）按当前注册表暴露的只读投影，`toolsMissing` 列出暴露里没有的组内工具，插件提供的工具与包内工具一视同仁；`component.js` 的 allow list 与 schema 来源共用同一常量，user prompt 只保留时间/待办/历史/任务/协议。**实测**：活库前缀 14,438 → 24,626 字符；缓存命中；门禁 44、182、7 与 NewMate 回归 57/57、57/57、23/23 全绿。**边界**：正文不进初始化、节点上限 1000、短期内容上限 48,000 字符并写明省略；schema 读取不执行工具；未安装、未重启（宿主 0.3.19；**该状态已被本段末的发布记录取代**）。

**2026-10-20 23:45 已发布并生效**：main `76674f4`、tag `v0.3.20`、npm latest=0.3.20（94 文件 79 逐字节 + 15 仅换行、0 实质差异）、拉回安装 94 文件一致、更新路由重启 23:45:47、活体实测通过。

## 2026-10-20 Newmark2DSH 0.3.19 候选：记忆工具的描述分工（长期树状记忆 / 短期到期列表）

**改动**：`components/memorylab/component.js` 新增 `LONG_TERM_ROLE`（249 字符）并让 9 条 `memory_lab_*` 描述以它开头；`components/memorylab/lib/short-memory.js` 新增 `SHORT_TERM_ROLE`（296 字符）并让 4 条 `shortMemory_*` 描述以它开头，四段正文收进 `DESCRIPTIONS`；`components/memorylab/lib/memory-store.js` 的 `instructions()` 增加 MEMORY SPLIT 两段；`scripts/verify-memorylab-tools.mjs` 168 → 176 条断言，钉住每族描述的前缀、角色句事实、不许借用对方生命周期、单句 ≤320 字符、13 条合计 ≤10000 字符、instructions 同口径。

**证据**：注册表读回 13 条描述 5558 → 8978 字符；门禁 176/0/176；`measure-role-descriptions-mutations.mjs` 5/5 变红、逐字节还原、控制组全绿；short memory + MCP 39 条、版本纪律 12/12、打包 54/54；另做一次 6 场景措辞路由测试（deepseek-flash）6/6 选对库，但只证明文本可读，不构成部署验收。

**状态与边界**：源码候选 0.3.19，**未安装、未重启**，本机宿主仍 0.3.18（**该状态当晚已被取代：已推送、已安装、经更新路由 + heartBeat 托管重启并验证生效，见本段末**）；`dist/newmark2dsh-repo` 已同步。归位时第一次用 JSON 重写 manifest 丢了 CRLF，已按 before 快照逐字节恢复（只改版本字段，字节数与 CRLF 不变），教训写进 `Newmark2DSH/taste.md`。归档 `Newmark2DSH/archive/20261020-213034-memorylab-memory-roles/`。**同日晚些**：发布仓分支 `codex/memorylab-roles-0.3.19` 已推送（`932451f`，main 未动）；0.3.19 已安装（tgz sha256 `A140188C…`，安装态三文件同哈希），并经更新路由 `prepare(0.3.19)` + heartBeat `restart(ticket, update=true)` 重启、接续本对话。重启后已验证生效（22:32）：活体 `memory_lab_read` 的 instructions 含 MEMORY SPLIT，活体注册表 13 条描述均以角色句开头、合计 8978 字符。**2026-10-20 22:40（按用户指令「监听npm版本直至正确公开」）**：`v0.3.19` 标签已推送并触发 publish 工作流（run 39440904853 success），npm `latest` 已是 **0.3.19**；integrity 一致、93 文件（78 逐字节 + 15 仅 CRLF 规范化、实质差异 0），空目录 `npm install newmark2dsh@0.3.19` 通过。**发布仓 main 已更新推送**：`f5d9ebb..a6f7fa1`（2026-10-20 22:47:46 推送）——0.3.19 包内容与 tag `v0.3.19` 逐 blob 相同，main 的公开文档策略保留（根 CHANGELOG 仍归档、`docs/` 只留公开页、版本历史走 GitHub Releases）；远端 `git ls-remote` 读回 `a6f7fa1`，干净 worktree 上 `check-release-bundle.mjs` = `GUARD PASSES`。

## 2026-10-17 Newmark2DSH 0.3.16 候选：heartBeat 两阶段重启（广播 + 回执屏障）

`heartbeat_restart` 增可选两阶段形式：`broadcast:true` 按宿主 `agents().roots()` 枚举运行中的对话（不接受调用方传入的目标名），`ackMode:'auto'`（默认）为每个参与者登记持久接续、不花模型 token，`ackMode:'agent'` 投递持久通知并要求该会话自己回执；`heartbeat_restart_commit` 只在回执到齐且发起方自己已登记时才真正重启，否则 `aborted` 并点名缺失者。intent 持久化到 `~/.Newmark/heartBeat/state.json`（schema 3），新宿主清扫 `committing → committed`（记录本次投递）与旧进程残留 `preparing → interrupted`（通知 requester 本次没有重启）。`broadcast=false` 与 0.3.15 一致，屏障打开期间即时重启被拒绝。

详细写回见 Newmark2DSH 的 README/OVERVIEW/taste/VERSION.md 与 `Newmark2DSH/archive/20261017-heartbeat-restart/`。

## 2026-10-13 Newmark2DSH 0.3.14正式发布

0.3.14 已发布 GitHub/npm latest，并取回官方包核对全部 93 文件；Windows安装已替换为同一正式包，逐字节一致，官方ASAR与原配置/消息保留，heartBeat重启不重复投递。不可变标签 b5c8a3b46152da88bb1b16713fc93be9f575c320；只读官方云验收也通过。上一轮200/0/0完整门禁与Mac ARM六作业作为同一运行代码的验收证据；发布源只规范化Git文本换行，正式安装再次通过23项共享桌宠原生检查。

[发布证据](Newmark2DSH/archive/20261013-release-0.3.14/REPORT.md)。


## 2026-10-13 Windows安装与Mac包边对照（0.3.14候选）

0.3.14 已安装本机官方DSH，尚未发布。修复Mac屏幕四层灰度框为顺时针周长黑白渐变，桌宠按Alpha裁剪保持比例；修复Win隐藏CU先启动后开启陪伴重建桌宠的问题。200/0/0完整门禁、92文件源码/安装一致；23共享桌宠、5尺寸、20原生GPU预览、3菜单检查通过。实际宿主待办模型激活、阅读保护、MCP和heartBeat重启不重放通过，原设置/消息/其他插件保留。Mac14/15/26 ARM六云作业成功，原生52场景、生产渲染1x/2x及实际双Space通过。视觉风格与比例对齐，不宣称逐物理像素一致、官方Mac DSH整机或Neo性能实测；Win不激活桌宠实体双击/右键本轮未独立复验。

本轮构造：darwin-native.swift 统一屏幕包边的周长渐变；desktop-pet-darwin.swift 裁剪精灵、保持比例与持久化尺寸；desktop-pet.js 保留已有 CU 桌面；共享桌宠/原生菜单/云渲染脚本扩展回归。archive/20261013-win-mac-parity 下 before 与 governance 快照保存基线，mac-final/mac-spaces-final 为三系统最终云图，windows-* 为隔离原生夹具，installed-host/native-suite/restart/audit mjs 为实际宿主路径，日志/JSON/PNG/tgz为可复核记录，REPORT.md列明目录作用及证明边界。

[完整证据与边界](Newmark2DSH/archive/20261013-win-mac-parity/REPORT.md)。


## 2026-10-13 macOS动态包边专项（0.3.14候选）

修正Mac桌宠矩形外框为图片Alpha轮廓波形，normal CU用四层平滑灰度边框，单调时钟3秒相位、30Hz common-mode计时器；CU决定闪边，预览展开/仅陪伴无闪边，右键菜单不中断动画，释放清理正常。ARM macOS14/15/26原生51场景与双Space均通过；实际连续像素变化、静态无闪边、轮廓邻接0脱离像素通过，生产渲染类1x/2x离屏检查通过。不是实体Retina或官方Mac DSH整机验收。0.3.14仍为未安装发布候选，包含此前toDo对话激活。

[专项证据](Newmark2DSH/archive/20261013-macos-dynamic-border/REPORT.md)。

构造：desktop-pet-darwin.swift缓存透明掩模/波形和独立动画计时器；darwin-native.swift四层屏幕边框/common计时器；verify-darwin-render-pipeline与macos-pipeline-driver比较原生连续RGBA及轮廓邻接；verify-darwin-border-scale与macos-border-scale-probe编译原生产渲染类测1x/2x。archive/20261013-macos-dynamic-border含before、cloud/cloud-final/spaces、packed、日志/散列/REPORT与规范快照。


## 2026-10-13 toDoList 适时激活 NewMate（0.3.14 候选）

新待办默认激活一轮 NewMate，结合原生MemoryLab记忆和上下文回应或处理明确委托。阅读、草稿、输入、运行任务、静默和暂停时等待；适时按现有关注策略选当前或新对话。回复通过桌宠气泡、点击进入页面，不自动弹出窗口。页面/对话工具/MCP可选择仅原文提醒，旧待办保持原语义。持久化唯一激活任务与消息回执，失败/运行中崩溃不自动重试。21激活、20提醒、23steer、12网页与12版本检查通过；完整门禁200/0/0。六manifest同步0.3.14，无新组件；本轮未安装发布。

[实现与候选包记录](Newmark2DSH/archive/20261013-todo-activation/REPORT.md)。

文件：todo-list.js模式校验；component.js适时门禁/领取/调度/恢复；index.js与mcp.js同源模式参数；client.js到期方式及状态；verify-newmate-todo-activation.mjs激活证据。archive/20261013-todo-activation含before、governance前后、packed全包、web明暗响应式图片、日志、package-receipt和REPORT。


## 2026-10-13 0.3.13 已发布：Windows安装与Apple Silicon云验收

NewMate toDoList 已随现有五组件发布，未新增子组件。GitHub v0.3.13、npm latest=0.3.13；93个包内文件与Windows官方DSH安装逐字节一致。完整门禁200通过、零失败/跳过；实际GUI创建、到期等待陪伴开启、精确投递、第二次heartBeat重启不重放，以及实际宿主MCP创建/查询/取消通过。原39条消息、其他插件依赖和Loader配置保留，陪伴恢复原关闭状态。Apple Silicon macOS14/15/26完整和双Space六作业通过；每环境269项检查与5组真实Space场景，不包括官方Mac DSH整机安装、实体输入时序及Neo性能验收。首次npm传播门禁超时，后续官方取回及只读CI完整验证成功；同版本未重发。

[完整发布验收记录](Newmark2DSH/archive/20261013-release-0.3.13/REPORT.md) · [公共发布](https://github.com/positer/newmark2dsh/releases/tag/v0.3.13)。

本轮新增档案 archive/20261013-release-0.3.13：before/after保存私有配置和用户状态，mac-full/mac-spaces保存原生与网页云证据，publication-cloud保存官方包验证，official-desktop-sdk/test-deps为隔离验收依赖，governance-before/after保存规范前后快照；REPORT.md为入口，操作mjs、日志、json散列与实际Windows截图构成复核链。以上开发档案不上传公共包。


## 2026-10-13 NewMate toDoList（0.3.13 候选）

NewMate 新增 toDoList 页面按钮，可手动填写激活时间和发送内容、查看状态并取消未投递项目。任意 DSH 对话、NewMate 本身及认证 MCP Agent 可通过 newmate_todo_add/list/cancel 创建与管理。到期直接投递预存内容，复用现有关注保护和自动换新对话策略，不额外调用模型；陪伴关闭时等待开启，静默/暂停/气泡冷却沿用现有规则。固定消息 ID 和持久化投递回执防止重启重复发送，历史及取消记录保留。版本为 0.3.13 源码候选，属于现有组件更新，无新增子组件。尚未安装或发布。

文件构造：components/newmate/lib/todo-list.js 校验带时区的时间、有效日历日期与内容，定义稳定投递 ID；component.js 在同一 state.json 持久化 todos、到期领取/回执恢复、保护聊天并复用 thread-handoff.js；index.js 提供 todo-add/list/cancel 页面操作；lib/mcp.js 注册对话及 MCP 的同源工具；client.js 提供页面内面板、手动表单、时间/状态/内容与取消按钮，并跟随主主题的原生日期控件。scripts/verify-newmate-todo.mjs 验证调度/权限/重启，verify-newmate-todo-web.mjs 渲染实际 React 页面并连接实际 NewMate 内核。archive/20261013-newmate-todo 保存基线、日志、截图、候选包和包内执行证据。

[实现、测试及候选包记录](Newmark2DSH/archive/20261013-newmate-todo/REPORT.md)。


## 2026-10-13 Apple Silicon 渲染至操作验收

0.3.12 源码候选的渲染至操作验证已扩展：macOS 14.8.9、15.7.9、26.6.2 ARM64 每环境通过 93 组 JS 契约、45 组原生场景、28 组 Chromium/WebKit 页面场景。修复自身输入误判、组合键、macOS 26 滚动、桌宠预览遮挡、预览帧清理及 React fallback snapshot。视觉与 AX 同时可用、分别选择，交叉核验可选；Space 共享输入，100ms 用户 idle 优先。后续仅面向 Apple Silicon，Intel 旧结果仅归档。本地 288 项检查通过。尚未验收官方 Mac DSH 整机、实体键鼠、多屏组合与 Neo 硬件性能；候选未发布或安装。
文件构造：verify-darwin-render-pipeline.mjs 验证原生管线；verify-darwin-web-render.mjs 渲染真实 client.js 与 React；verify-darwin-channels.mjs 验证通道选择；verify-macos-distinct-spaces.mjs 和 macos-space-probe.swift 用公开 Mission Control AX 准备自产窗口跨桌面测试。macos-ui-fixture.swift 构造窗口，macos-pipeline-driver.swift 仅操作允许的自产 PID。归档目录保存前后源码、六份治理文档、所有场景清单、截图及失败轮次。

[完整报告与逐项证据](Newmark2DSH/archive/20261013-macos-render-pipeline/REPORT.md)。

补测：macOS 14/15/26 ARM64 的真实双 Space 流程全部通过。修正离屏 AX 首次绑定、异步 Space 动画和原窗口可见性恢复；离屏像素可通过显式 activate_for_observation 受保护采集，默认/桌宠预览不会自动切换。官方 DSH Mac 容器及实体设备验收仍单列。



## 2026-10-13 免费Mac云验证结果

0.3.12候选已利用公开仓库免费标准Mac CI完成两轮测试：macOS 14.8.9/15.7.9 ARM64均编译CU与桌宠，通过原生只读协议及自产AppKit窗口AXPress/原前台窗口恢复集成；normal边框创建、Space无全屏边框也通过运行检查。210项本地检查通过。鼠标恢复目前为原生返回值证据；真实跨Space、实体键鼠100ms时序、桌宠点击/DSH恢复和边框视觉、Neo硬件仍待独立验收。没有取得可长期交互的免费云Mac，当前安装与npm latest仍为0.3.11。

文件构造：macos-validation.yml承载两系统云端矩阵；macos-native-readonly-smoke.mjs检查只读协议；verify-darwin-native-fixture.mjs和macos-ui-fixture.swift构造仅针对自产窗口的集成。archive/20261013-macos-cloud-test保存服务筛选、提交、原生日志及结论。

[报告与证据](Newmark2DSH/archive/20261013-macos-cloud-test/REPORT.md)。

## 2026-10-13 Mac桌宠展开与normal CU边框

0.3.12候选补上Mac原生共享桌宠：Space接管单击展开/收起只读目标窗口预览，双击复用open-chat事件并唤起DSH，原生菜单退出陪伴/打开设置，气泡沿用主主题；没有独立托盘。normal CU以显式mouse_mode:real保留原生输入路径，边框按每个NSScreen渲染、点击穿透、跨Space/全屏显示，并在停止/退出时清理。CU主线程不再阻塞读取stdin。预览只在展开时500ms检查，不更换Agent AX标识，最多保留2张自产临时画面。此前100ms用户优先与操作后恢复约束继续适用。Windows本机安装和公开发布仍为0.3.11；此候选未发布。

文件构造：desktop-pet-darwin.swift承载AppKit桌宠、只读图像预览、菜单、气泡和状态文件；desktop-pet.js按平台编译并复用相同归属/事件协议。darwin.js连接Space租约与展开时观察，darwin-native.swift管理normal多屏边框与异步NDJSON/AppKit循环。verify-darwin-pet-border.mjs验证路由和源码契约；verify-darwin-native-fixture.mjs与scripts/lib/macos-ui-fixture.swift提供仅针对自产窗口的云端原生集成验收。

[本次记录](Newmark2DSH/archive/20261013-macos-pet-border/REPORT.md)。

## 2026-10-13 Space 用户优先输入与恢复

按用户最终选择，macOS CU 采用 Space＋AX，不接入额外账户或VM。Space租约绑定用户预先放入目标Space的现有窗口；不创建Space或使用私有Space ID。Agent输入等到物理键鼠连续空闲至少100ms、且无按键/鼠标按钮保持按下后投递，最多等待5秒，超时不投递旧动作。每个输入保存鼠标位置和原前台AX窗口，成功/失败均尝试恢复；新用户操作优先，恢复失败明确报告，已执行动作不自动重放。后台点击/文本仅使用支持的AX动作；按键/滚动可能短暂激活目标Space再恢复。仍是0.3.12源码候选，Mac编译、100ms硬件时序及焦点/鼠标恢复均未实机验收。Windows安装/公开发布维持0.3.11。

文件构造：darwin-space.js保存Space租约绑定与固定输入策略，darwin.js将实际调用接到该分派；darwin-native.swift新增硬件输入状态轮询、输入检查点、前台精确窗口与鼠标快照/恢复，并覆盖成功及异常。component.js扩展desktop:space参数，非Mac明确拒绝。verify-darwin-space-input.mjs验证实际JS分派与Swift源码约束；本轮archive保存基线、65项检查日志、打包清单及源文件快照。

[本次记录](Newmark2DSH/archive/20261013-macos-space-input/REPORT.md)。

## 2026-10-13 macOS 无障碍辅助候选

已将 macOS CU 源码更新为无障碍 AX 优先：返回有界控件树，使用 AXPress 点击、AXSelectedText 插入选中文本、AXRaise 激活指定窗口；目标标识仅供同调用者和同窗口使用，有效期30秒。无需屏幕录制权限也可观察 AX 结构，像素采集失败时保留 AX 结果。稀疏测量结合控件标题、角色、状态、动作及几何变化，不将随机目标标识当成变化；不读取输入框值，安全字段拒绝编辑。无明确目标且控件不支持语义动作时保留 CoreGraphics 回退，已尝试失败的 AX 动作不重复投递。版本为0.3.12源码候选，尚未在Mac编译或实机验收；本机已安装/发布的0.3.11不变。

文件构造：components/computeruse/lib/darwin-native.swift 增加 AX 访问、唯一窗口匹配、有界树遍历和语义输入；darwin.js 增加语义指纹、调用者隔离的观察缓存与AX目标校验；component.js 描述macOS无障碍调用和已有target_id参数；scripts/verify-darwin-accessibility.mjs 验证调度/测量及Swift源码契约，verify-darwin-native-build.mjs 提供Mac SDK编译门禁，本机明确SKIP。

[本次记录](Newmark2DSH/archive/20261013-macos-accessibility/REPORT.md)。

## 2026-10-13 0.3.11 回复内交互与原生侧栏

0.3.11 已安装并经 heartBeat 重启。生成式 HTML 直接在回复中渲染，支持输入、按钮、展开收起、源码及复制；当前对话和只读历史复用相同实现。文件链接在 NewMate 自己的侧栏挂载 DSH 实时注册的原生组件，未委托本体对话或自写文档预览器；无法支持时通过原生文件管理器定位。NewMate 获得 MemoryLab 新建、增量更新和标签工具，以及 shortMemory_add，仍没有删除许可。259 项相关检查通过，真实模型生成的计数器及原生 Markdown 已实机验证；89 个交付文件源码、包、安装一致。原有 37 条消息均保留，增加 2 条验收消息，陪伴开关保持关闭。0.3.11 已推送 main/v0.3.11 并发布 GitHub Release，CI 成功；官方 npm latest=0.3.11，下载的90个公开文件与发布源码一致。

本轮构造：client.js 的 NewMateInteractive 挂载每条回复的隔离 iframe；NewMateNativeDocument 绑定原生 slot 组件、store、locale 和内容契约。components/newmate/lib/file-navigation.js 在引用授权后读取有界且未变化的原文件字节，index.js 提供 file-content 操作，component.js 限定记忆写入工具。scripts/verify-newmate-generative-ui.mjs、verify-newmate-file-navigation.mjs、verify-newmate-memory-writes.mjs 分别覆盖交互隔离、原生侧栏及真实隔离库写入；本轮 archive 包含生成模型输出、截图、安装包及三方哈希审计。

[本次验收记录](Newmark2DSH/archive/20261013-generative-ui-test/REPORT.md)。

## 2026-10-13 0.3.10 原生兼容与 Mac 原型

0.3.10 已本地安装，并由 heartBeat 完成重启。Agent API 统一接到 DSH 公共模型解析、请求准备和标准流回复解析，兼容能力由供应商适配层提供；同名模型按供应商隔离，未安装或点名外部供应商插件做特殊适配。NewMate 文件链接采用原生侧栏能力优先、文件管理器定位回退，实时发现未来注册类型；无边框、加粗下划线，历史仍只读。桌宠菜单修复启动主题快照缺失、预热及重复加载，原生隔离窗口测得预热后 38 ms 打开。699 项相关检查通过，包含真实 DSH Runtime/BlockAssembler 内存适配器测试和 Windows WebView 集成测试。macOS 原生 CU 与 Virtualization VM 已加入源码原型，但未经过 Mac 编译/硬件验证，guest CU 仍未接通，virtual 请求明确拒绝物理回退。未远端发布。

本轮文件构造：components/agent-api/lib/llm-seam.js 接入原生 prepareCall 与 BlockAssembler；core-model.js/visual.js 复用原生模型元数据与供应商隔离；components/newmate/lib/file-navigation.js 校验引用并调用原生文件定位；client.js 提供实时预览注册表导航、只读历史滚动与窗口内草稿保留。components/computeruse/lib/desktop-menu-client.js 采集 DSH 菜单样式，desktop-menu.html 承载同主题文档，desktop-menu.cs 预热并复用 WebView，desktop-pet.cs 接管菜单启动时序。darwin.js 为 macOS 延迟调度/稀疏测量，darwin-native.swift 为公共 API 原生观察与输入原型，darwin-vm.swift 和 darwin-vm.entitlements.plist 为隔离 Linux VM 启动试验。scripts/verify-dsh-native-model-seam.mjs、verify-newmate-file-navigation.mjs、verify-darwin-prototype.mjs、verify-native-menu-render.mjs 分别验证真实 DSH 模型边界、文件导航、Mac 调度保护和 Windows WebView；scripts/lib/newmate-menu-render-probe.cs 是隔离原生渲染验收窗口。docs/11-native-model-and-macos.md 记录兼容原理、Mac 实现和待验收边界；本轮 archive 保存基线、官方模块摘录、测试日志、各次候选包、最终安装审计及视觉证据。

[本次验收记录](Newmark2DSH/archive/20261013-native-provider-darwin/REPORT.md)。


## 2026-10-12 0.3.9 主动消息内容约束

0.3.9 已本地安装并完成 heartBeat 重启。NewMate 明确区分用户提问与后台触发：主动联系要有具体可信的新内容，自然简短，最多两句、240 字符；没有可核实内容就保持安静，不主动发送能力边界、权限清单或“我不能为你做什么”的无请求说明。发送前拦截常见能力声明与长篇报告格式，不写聊天、不弹气泡、不触发换新或占消息额度；用户明确询问能力时仍如实回答。外部 agent 主动发信使用同一能力声明防线，完整正文和气泡摘要仍分离。

385 项相关检查通过。实际模型处理重启后台任务后 completed / not_actionable，未追加消息，35 条基线消息保持一致；任务物理消费为永久回执。最终源码、包、安装 84/84 文件同哈希。限频、静默、关注保护和记忆缓存保持，未新增模型审核或子组件，未远端发布。
本轮结构：components/newmate/lib/proactive-message.js 统一主动发信风格与内容校验；newmate/component.js 在消息写入和换新之前抑制不合适内容；newmate/lib/mcp.js 向外部 agent 声明气泡投递和主动内容边界；scripts/verify-newmate-proactive-format.mjs 为 21 项行为检查。archive/20261012-newmate-proactive-format/ 保存 before/after、最终包、测试日志和实际后台静默消费证据。

[本次验收记录](Newmark2DSH/archive/20261012-newmate-proactive-format/REPORT.md)。


## 2026-10-12 0.3.8 重启恢复、桌宠配置与气泡投递

0.3.8 已本地安装并由 heartBeat 重启加载。修复原对话冷恢复缺少 `{{model}}`：在提示词装配前恢复该对话的供应商、模型和推理等级，保留运行中选择，禁止混用供应商或退回全局默认模型。重启辅助程序跳过已退出子进程的复用 PID，同时保留主进程身份检查。真实后台冷恢复已完成模型回复，任务物理移除并留下永久消费回执；随后再次更新重启，没有重复投递。

NewMate 取消 Windows 系统通知，仅使用桌宠气泡提醒，完整消息保存在聊天。右键菜单改为“退出伴随”“打开设置”；退出只释放陪伴的桌宠所有权，CU 可继续使用同一桌宠。配置页重构为组件卡片、模型与桌宠配置、插件更新、陪伴偏好四个区域，使用 DSH 的主题变量，独立开关和供应商模型隔离继续保留。

此次相关门禁 401 项通过；最终源码、包、安装 83/83 文件同哈希。真实重启与配置页截图已留痕，原生菜单动作经过独立窗口测试，工具限制下未完成用户桌宠的物理右键手势验收。未新增子组件，未远端发布。
本轮结构：lib/conversation-delivery.js 负责冷恢复模型上下文，components/heartbeat/component.js 登记模型与消费回执，lib/core-restart.ps1 实施进程身份约束；components/newmate/{component,index}.js 固定气泡投递并处理退出伴随；computeruse/lib/{desktop-pet.js,desktop-pet.cs,desktop-menu.html,desktop-menu-client.js,desktop-menu-theme.js} 负责两项菜单及主题桥接；client.js 提供配置布局和设置导航。scripts/verify-heartbeat-model-context.mjs、verify-restart-identity.ps1、verify-newmate-menu.mjs 与 scripts/lib/newmate-menu-probe.cs 是新增门禁。archive/20261012-heartbeat-model-context/ 保留 before、after、最终包、日志、实机截图和报告。

[本次验收记录](Newmark2DSH/archive/20261012-heartbeat-model-context/REPORT.md)。


## 2026-10-12 0.3.7 NewMate 实时引导与关注保护

0.3.7 已本地安装：NewMate 用户输入直接加入当前运行的 steer guide，不再为每次补充另建排队轮次；界面运行中显示“引导”，补充要求在模型/工具边界生效，旧工具调用被配对为未执行结果，旧回答不会作为最终回复发出。用户打断自动 JSON 判断时复用同一持久任务转为普通回复；显式换新对话的输入会中断旧运行，用户任务优先于后台投递。

自动换新基于可观察的关注状态：正在阅读、近期输入/关注、已有草稿及用户任务保护当前对话。话题变化且至少八小时未互动，或一天以上且连续两次未回应时，在主动消息确实被允许发送前考虑换新；每天最多自动换新一次，旧对话只读保留，不清零预算、冷却或未回应退避。多窗口草稿具有所属窗口与事件序号，其他窗口和旧事件不能清除保护。用户消息上方只保留时间，删除两个“你”；NewMate 回复头像、名称、时间和格式保持不变。

实时引导/关注/换新 23/23、Agent API 268/268、客户端 123/123、低打扰激活 57/57、shortMemory/MCP 37/37、聊天 21/21、供应商隔离 18/18、版本 12/12，共 559 项通过。真实模型验证第二次输入 mode=steer，与第一次共用任务 ID，最终只回复“引导已收到”；实机截图确认用户气泡只显示时间，NewMate 标签完整。最终源码/包/安装 83/83 同哈希，25 条基线消息保留。heartBeat 重启 running，更新后任务已消费为永久回执。未新增子组件，未远端发布。

本轮结构：components/newmate/lib/thread-handoff.js 为无模型成本的关注保护及换新判定；newmate/component.js 管理同一运行的引导缓冲、用户优先、持久草稿和换新记录；agent-api/component.js 通过原生 AsyncLocalStorage 上下文传入 pollSteer/hasSteer，lib/loop.js 在模型及串行工具边界消费引导；newmate/index.js 提供 interaction 和 attention 路由；client.js 显示引导入口并上报草稿，同时简化用户消息元数据。scripts/verify-newmate-steer-handoff.mjs 为 23 项并发/换新行为门禁。archive/20261012-newmate-steer-handoff/{before,after,package-expanded} 分别存放基线、最终文件和 tarball 展开物；real-steer-*.json/mjs 为真实模型证据，installed-steering.jpg 为实机气泡证据。

[实现与实机证据](Newmark2DSH/archive/20261012-newmate-steer-handoff/REPORT.md)。


## 2026-10-12 0.3.6 NewMate 唤起、气泡与回复预览

2026-10-12 用户实机确认：关闭 DSH 主窗口、保留后台运行后，双击桌宠可以恢复主窗口并进入 NewMate。此项验收通过；原生消息气泡点击仍待确认。下文待确认措辞为反馈前的历史记录。

0.3.6 本地更新：发送按钮保持正常右对齐；桌宠显式清除 Electron-as-Node 启动变量，通过已验证的 DSH 单实例入口唤起隐藏主窗口，并请求进入当前 NewMate。气泡跟随主设置的浅色/深色/系统外观，展示最多 80 字的独立摘要；完整正文保存在聊天页，MCP newmate_message 可传 summary。NewMate 回复约束为亲近务实的私人秘书，真实文件链接在回复内可点击，只读打开已引用的文本文件（2 MB 上限）。自包含 HTML 回复以卡片打开独立面板，支持展开、页面/源码切换和复制；iframe 采用不带同源能力的脚本沙箱及受限资源策略。未新增子组件、未远端发布。

客户端 123/123、版本 12/12、聊天 21/21、shortMemory/MCP 37/37、低打扰激活 57/57、呈现行为 8/8、原生共享桌宠 19/19，共 277 项通过；另有两条实机 HTTP 文件边界拒绝测试。实机验证 HTML 按钮计数 0→1、展开面板、文件预览及主设置浅色切换后原生 bubble_dark=false，已恢复原来的跟随系统外观。物理桌宠双击和原生气泡点击尚待用户确认，电脑控制工具拒绝对其他原生窗口的点击；不将页面测试计为这两项验收。

本轮文件结构：components/newmate/lib/presentation.js 为纯摘要与引用解析；component.js 为秘书回复约束和独立 summary；index.js 为主题桥及有引用约束的只读文件预览；lib/mcp.js 为可选摘要入参；client.js 为内联文件链接、HTML 回复卡片和独立预览面板；computeruse/lib/desktop-pet.js/.cs 为摘要传递、原生主题与单实例唤起。scripts/verify-newmate-presentation.mjs 与 verify-shared-companion-pet.mjs 验证呈现及原生状态。archive/20261012-newmate-bubble-preview/{before,after,package-expanded} 分别保存基线、最终文件和安装包展开物；LOG/JSON 为门禁/状态/哈希，JPG 为实机证据。

[实现与实机证据](Newmark2DSH/archive/20261012-newmate-bubble-preview/REPORT.md)。


最终包与安装 82/82 同哈希，23 条基线消息保持完整；heartBeat 终态 running，更新后任务已完成并真实消费为永久回执。

## 2026-10-12 0.3.5 NewMate 发送按钮对齐

已本地安装 0.3.5：移除 client.js 中按桌宠运行状态固定添加的发送按钮右外边距，陪伴开启和关闭沿用同一输入框行布局。客户端 123/123、版本约束 12/12；源码/包/安装 81/81 一致，实机截图确认陪伴开启时发送按钮位于输入框右侧。未新增子组件，未远端发布。

[修复与实机证据](Newmark2DSH/archive/20261012-newmate-send-alignment/REPORT.md)。


## 2026-10-12 0.3.4 NewMate 低打扰自主激活

已实现并本地安装 0.3.4：NewMate 不再依赖用户先开口、文件变化或外部任务才工作。开启陪伴后约 20 分钟进入自主检查；默认适中频率，每天最多 4 次自动模型判断、2 条自主消息，未回应后间隔从 4 小时逐步退避至 8/16/24 小时。夜间 23:00–08:00（北京时间）、正在输入、阅读聊天、DSH/后台任务或 CU 忙碌、锁定/安全桌面、离开设备 90 分钟时延后。读过主动消息也算回应兴趣，不要求打字。文件事件先合并，长期记忆正文的元数据变化、标签/短记忆变化与低频空闲检查共用预算；没有必要内容时不发消息。第一整天没有主动内容时允许一条不调用模型的轻量问候，后续同类兜底至少间隔三天。自主消息不抢焦点，首次系统提醒静音，持续未回应后只保留气泡/未读；外部 agent 连发保留全部内容但 30 分钟内只打扰一次。配置页新增主动开关、安静/适中/活跃频率、静默时段和暂停八小时。未新增子组件，patch +1；未远端发布。

主动激活 57/57、原生共享桌宠 16/16、客户端 123/123、聊天 21/21、陪伴/heartBeat 57/57、shortMemory/MCP 37/37、Agent API 268/268、供应商隔离 18/18、版本 12/12；最终源码/包/安装 81/81 一致，原有 19 条消息保持完整。七天无用户主动输入的模拟共 8 次模型检查、8 条消息、首次 1 条系统通知。长周期以模拟时间及确定性模型结果验证；实机验证设置、暂停/恢复和原生可用性，未把模拟结果冒称真实七天运行或实际费用。实际定时模型已复验通过：本次没有合适内容保持静默，预算只加一次，旧失败任务未重放。

本轮结构：components/newmate/lib/initiative.js 为新增纯策略模块，定义本地日期、频率/预算、静默、退避和话题去重；component.js 接入持久预算、独立唤醒、合并信号与本地问候，index.js 从宿主 agents/jobs 和共享桌宠获取粗粒度可用性并返回策略状态；client.js 为主动陪伴配置与静音通知；computeruse/lib/desktop-pet.cs 增加只读输入空闲/当前桌面信息，desktop-pet.js 增加同一进程的短时状态缓存和静音传递。scripts/verify-newmate-initiative.mjs 包含 57 项行为测试与七天模拟；verify-newmark-core.mjs 接入该门禁。archive/20261012-newmate-initiative/before/ 为基线，after/ 为最终源码与六份治理文档，package-expanded/ 为最终 tarball；LOG/JSON 为测试、安装、模拟和策略状态，JPG/TXT 为实机配置证据，manifest.json 为哈希。

[策略与验收证据](Newmark2DSH/archive/20261012-newmate-initiative/REPORT.md)。


## 2026-10-12 0.3.3 NewMate 打开链路与界面细节

实机闭环：用户已确认在其他应用前台时，双击桌宠可以正常恢复 dsh 并打开 NewMate 当前聊天（2026-10-12）。下文的待反馈措辞属于确认前记录。

0.3.3 已本地安装：桌宠打开聊天时先恢复并激活已验证的 dsh 主窗口，保留单实例启动兜底；新增双击松键判定与重复事件抑制，单击/拖动不会误打开。打开事件优先处理，恢复焦点时立即检查，缺少布局服务时保留重试；已在历史或设置页时切回当前聊天并聚焦输入框。侧栏头像降低亮度并以更克制的比例向右显示；NewMate 标题、欢迎文案、快捷按钮、历史行、输入框细节和设置页陪伴开关几何已完善。历史仍为按钮进入的只读记录，CU 仍独占闪边，NewMate 无独立托盘。未新增组件，patch +1，未远端发布。

原生点击处理 6/6、共享桌宠 15/15、客户端 123/123、聊天 21/21、陪伴/heartBeat 57/57、shortMemory/MCP 37/37、供应商隔离 18/18、版本 12/12；最终包 80/80 文件与源码和安装一致。已实机检查界面与历史/设置到聊天的导航。真实鼠标双击因无激活工具窗口不能被电脑控制工具直接定位，等待用户反馈；不把事件单测或显式 IPC 夹具声称为物理双击验证。

本轮文件构造：client.js 负责头像、聊天细节和打开事件优先级/视图复位；components/computeruse/lib/desktop-pet.cs 负责双击识别、去重与已验证宿主窗口恢复；六份 package.json 与 newmate/lib/mcp.js 统一 0.3.3。archive/20261012-newmate-polish/before/ 保留治理/源代码基线，after/ 保留最终治理与包内源文件，package-expanded/ 保留最终 tarball 内容；NativeClickUnit.cs/.exe 与 native-click.log 是无真实鼠标注入的原生回归，navigation-fixture.mjs 和 *ipc-fixture.json 是显式标记的实机 IPC 夹具；JPG/TXT 是 UI 证据，installed-integrity.json 与 manifest.json 是安装与归档哈希。

[本轮验收记录](Newmark2DSH/archive/20261012-newmate-polish/REPORT.md)。


## 2026-10-12 0.3.2 NewMate 页面与陪伴体验

已实现并本地安装 0.3.2：NewMate 提供常驻输入框、独立只读历史入口、新对话、设置和陪伴开关。历史不常驻，不允许编辑、重新激活、继续发送或重试历史任务；新对话关闭上一段记录，旧消息完整保留。侧栏共用桌宠图片，横向翻转朝向右侧，先放大 20% 后按反馈缩小 10%（最终为原尺寸 108%）。陪伴与 CU 共享一个桌宠，CU 单独决定闪边。NewMate 内核由 dsh Cordis 托管，原生辅助窗口只负责呈现并随宿主结束；无独立托盘，系统通知由现有 dsh 窗口承载。焦点不在 NewMate 聊天页时主动消息显示桌宠气泡，返回页面后收起。未新增子组件，patch +1，未远端发布。

专项通过：聊天 21/21、客户端 123/123、共享桌宠原生 15/15、陪伴/heartBeat 57/57、shortMemory/MCP 37/37、供应商隔离 18/18、Agent API 268/268、版本 12/12；最终源码/包/安装 80/80 字节一致。实机查看正常聊天、按钮进入历史与无输入框的只读阅读、右向图标、后台气泡和前台抑制。双击的原生事件单测与实际 IPC 导航通过；自动化工具不能直接定位无激活桌宠窗口，未声称完成真实鼠标双击。系统通知调用归属 dsh，不声称观察到 Windows 通知中心弹窗。旧总门禁的两个宿主/源码前提失败不归入本轮专项通过。

本轮构造：packages/newmark-core/client.js 负责当前聊天、只读历史和宿主通知；components/newmate/component.js 负责线程持久化、当前线程写入边界与陪伴策略，index.js 负责 Cordis 生命周期和 HTTP 路由，lib/mcp.js 暴露四个 MCP 工具；components/computeruse/lib/desktop-pet.js 负责共享所有权、声明状态和一次性通知领取，desktop-pet.cs 负责前台核验、气泡与呈现。scripts/verify-newmate-chat.mjs 和 verify-shared-companion-pet.mjs 为新增行为专项；archive/20261012-newmate-ui/ 中 before/ 保存基线，after/ 保存最终源码与治理文件，host/ 为已安装官方宿主接口的只读取证，package-expanded/ 为最终包，日志/JSON/JPG/TXT 为测试、协议和实机证据，manifest.json 为哈希清单。

[本轮验收与证据](Newmark2DSH/archive/20261012-newmate-ui/REPORT.md)。


## 2026-10-12 0.3.1 供应商同名模型隔离

已修复并安装 0.3.1：Agent API 可用性与视觉能力以供应商和模型 ID 同时匹配，核心目录拒绝将外部供应商模型重标为自身；每次 run 固定原始供应商、模型与 reasoningEffort，后续切换不改变重试和后续轮次。记忆缓存仅复用模型无关的背景文本，不共享供应商能力或凭据。未新增组件，patch +1，未远端发布。

隔离专项 18/18、Agent API 268/268、客户端 123/123、陪伴 57/57、版本 12/12；已安装 80/80 文件与源码和 tarball 一致。真实同名 deepseek-flash 的两个供应商 profile 隔离，MCP 0.3.1 与 NewMate QA031_OK 回复通过，原准用模型已恢复。总门禁 195/197，帧循环源码断言及旧 CLI 宿主前提未通过，详见报告。[验收报告](Newmark2DSH/archive/20261012-provider-isolation/REPORT.md)。

本轮修改 core/lib/model-selection.js（目录隔离）、agent-api/lib/core-model.js（准用校验）、visual.js（图像能力）、llm-seam.js（run 选择快照）；scripts/verify-provider-isolation.mjs 验证同名、目录污染、切换及重试。archive/20261012-provider-isolation/ 保存 before 基线、日志、包展开、三方哈希、重启、真实模型身份与 MCP 回执。


## 2026-10-12 0.3.0 本地安装与实机验收

Windows DSH 已安装 0.3.0，80/80 包内文件与最终 tarball 和源码一致。实机验证 NewMate 侧栏/对话、DSH 与外部 MCP 调用、shortMemory 七天到期与灰显、两个独立开关、真实视觉识别，以及两次 heartBeat 全局重启：第一次自动投递后任务载荷移除，第二次不重复投递。实机修复冷启动入口缺失和 opencode-go 缺传输 sessionId，并补齐完整短记忆日期与输入框样式。准用模型恢复原 DeepSeek，桌宠倍率保持 60.1%。未发布远端。

[安装与实机证据](Newmark2DSH/archive/20261012-installed-030/REPORT.md)。下文的“源码候选/未安装”是先前阶段记录；当前状态以本节为准。旧 CLI 完整 ToolRuntime 导入门禁仍未闭环，实际宿主路径已另行验收。

本轮新增 archive/20261012-installed-030/：before/ 保存 profile 与六份治理基线；安装日志和 installed-integrity.json 保存三方字节一致性；PNG/TXT 保存真实窗口与可访问性；MCP JSON、两个 restart status 和 consumed JSON 保存协议与一次性投递；vision-fixture.png 及 validation JSON 保存非个人图样真值；REPORT.md 汇总边界，manifest.json 记录哈希。运行修改位于 client.js（启动状态、样式、日期）、agent-api/component.js（每 run correlation）与 lib/llm-seam.js（宿主传输参数），对应 client/companion 验证脚本补回归。

## 2026-10-11 0.3.0 新组件实现（源码候选）

已接入 NewMate 陪伴内核与 heartBeat 重启投递，五子组件独立开关；Agent API 支持真实图像附件；MemoryLab 增加 shortMemory（默认七天）及“总览/详细/短期”。NewMate 在首轮推理前原生注入全部标签关系和最近十条短期记忆，并开放 DSH/MCP 共用接口；无文件删除工具，文件测量默认关闭、变动去重且低打扰。heartBeat 成功投递后移除可执行任务，保留无正文收据。

本轮为源码实现与本地候选打包，尚未发布或覆盖本地安装。[验收记录](Newmark2DSH/archive/20261011-newmate-heartbeat/REPORT.md)。[实现和接口](Newmark2DSH/docs/09-newmate-heartbeat-implementation.md) · [OpenDot 参考边界](Newmark2DSH/docs/10-opendot-reference.md)。下文的“仅设计”是先前预研记录，当前实现状态以本节与本次验收报告为准。

新增文件树及职责：

```text
Newmark2DSH/packages/newmark-core/
  components/newmate/
    index.js               注册工具、HTTP/MCP、监听器及后台生命周期
    component.js           陪伴持久队列、源对话唤起与文件元数据测量
    package.json           子组件版本与模块入口
    lib/memory-context.js  全标签关系和短记忆原生前缀、内容指纹缓存
    lib/mcp.js             共用工具定义、MCP JSON-RPC 和 HTTP 鉴权
  components/heartbeat/
    index.js               当前对话重启工具与后台生命周期
    component.js           任务登记、重启确认、持久投递和消费收据
    package.json           子组件版本与模块入口
  components/memorylab/lib/short-memory.js  七天短记忆列表与四工具
  components/agent-api/lib/visual.js       附件入库、捕获路径约束、BMP 转 PNG
  lib/durable-state.js          原子 JSON 写入与重载读取
  lib/conversation-delivery.js  当前身份、真实 followup、去重和 flush
  lib/newmate-context.js        仅陪伴调用的原生记忆上下文
Newmark2DSH/scripts/
  verify-newmate-heartbeat.mjs  视觉、重启投递、消费和组件开关行为验证
  verify-short-memory-mcp.mjs   短期记忆、原生缓存、唤起和真实 HTTP MCP 验证
Newmark2DSH/docs/09-newmate-heartbeat-implementation.md  已实现契约、配置及验收边界
Newmark2DSH/docs/10-opendot-reference.md               提交固定的源码参考与采用范围
Newmark2DSH/archive/20261011-newmate-heartbeat/         执行前源码、参考冷数据、测试日志、候选包、报告及哈希
```

既有 index.js/core 更新流程、client.js 页面/组件开关、memorylab/index.js 短期列表路由、memorylab/component.js 工具合并、agent-api/index.js 服务注入、agent-api/component.js 视觉及记忆前缀、发布文件检查和现有测试门禁按上述契约扩展。每个新增文件的详细构造见实现文档。

## 2026-10-11 Newmark2DSH newMate 新组件预研

仅新增设计文档并维护治理索引，未改动产品代码或用户配置。`Newmark2DSH/docs/07-newmate-companion-research.md`记录对象身份、官方来源及源码边界；`08-newmate-kernel-design.md`记录模块、测量理论、API、权限、状态、记忆、未来文件结构和验收。`Newmark2DSH/archive/20261011-newmate-kernel-research/`保存before/after文档快照、五个源码哈希基线及核验、文档检查、manifest和REPORT。每个新增子文件与拟议源码子文件的构造/职责详见 [子项目索引](Newmark2DSH/OVERVIEW.md)及 [设计](Newmark2DSH/docs/08-newmate-kernel-design.md)。陪伴内核尚未注册为第四组件。

## 2026-10-08 最终安装：0.2.31

NewMate 显示同步优化及 Linux X11/WSLg 支持已接入并发布。最终远端提交 c7b7165 / v0.2.31 经全新网络克隆拉回，Windows 和 WSL 分别重装同一 tarball；Windows DSH 已完全退出旧进程并重新启动，三个组件均由新宿主激活。65/65 发布文件一致，64 运行文件匹配源码；用户当前倍率 60.1% 保持不变。

0.2.31 另将窗口映射控制心跳与显示绘制分离，解决显示时钟停止时控制也停止的问题，避免 WM_TIMER 在高刷新绘制下饥饿。最终安装态：核心195/195、Windows原生专项102/102、CU边界34/34、方言45/45、隐藏路由54/54、Linux后端47/47与Qt15/15、真实模型33/33，以及配置slider门禁通过。实装桌宠约151绘制回调/秒，WSLg稳定预览约60交换回调/秒；不等同物理扫描帧率。测试映射、接管槽和辅助进程已清空。

npm索引当时仍返回404，当前明确安装远端拉回的tarball；不声称从注册表解析安装。首轮失败、后续修正、真实输入范围和完整文件树均见 [最终验收报告](Newmark2DSH/archive/20261008-release-031/REPORT.md)。


2026-10-08：Newmark2DSH 新增 Linux X11/WSLg 原生桥、私有 Xvfb 看护与集成测试。新增文件树及职责见 [子项目 OVERVIEW](Newmark2DSH/OVERVIEW.md)，源码／安装候选 47 项与 UI/认证 12 项证据归档在 [Linux WSL REPORT](Newmark2DSH/archive/20261008-linux-wsl/REPORT.md)。本轮未发布，Windows 0.2.29 安装和用户 45.9% 偏好保持原状。

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

真实/虚拟模式各一个跨 DSH 进程的 Windows 用户级接管槽已在本地实现；调用身份绑定 DSH 会话，停止一个模式保留另一个模式。该阶段最初安装 0.2.26；最终 0.2.28 的发布与验收见上方。实现背景：Win32 不支持保留现有窗口直接迁移所属线程，已用独立原生夹具复现 error 170，用户已于 2026-10-08 接受保留进程的交互映射语义，现已实现双向映射、NewMate 飞入飞出、退出保活与恢复，已执行完整回归，前台自动化限制见本轮报告。 新增 computeruse/lib/takeover-lock.cs 管理系统互斥体，takeover-lock.js 编译/管理锁进程；lib/cu-caller.js 保留异步会话身份。scripts/verify-takeover-lock.mjs、verify-takeover-slots.mjs、verify-takeover-session.mjs 分别验证内核锁、后端双槽和宿主身份。archive/20261007-cu-transfer 中 before 是备份、evidence 是日志回执、gpu-regression 是隔离原生回归；PLAN/STATUS 记录待决事项，DesktopTransferProbe.cs 是系统限制实测。 [工作状态](Newmark2DSH/archive/20261007-cu-transfer/STATUS.md)。

## 2026-10-07 NewMate 分级配置与 GPU 动画（0.2.26，已发布并重装）

配置板块按「智能体 / 准用模型」和「桌面助手 / NewMate」分级，使用响应式卡片、说明及保存提示。桌宠复用绘制缓冲，虚拟桌面预览以 GPU 变换展开/收起并复用就绪渲染器。本机隔离动画基准：桌宠约 35→55 FPS、展开 4→56 FPS、收起 30→60 FPS；不代表源桌面采集帧率或恒定硬件刷新率。

0.2.26 已推送（ab40ba6d / v0.2.26）并发布 npm，经远端拉回、注册表精确版本重装、完整重启 DSH。57 个发布文件与远端一致、56 个运行文件与源码一致。插件全工具门禁 25/25、ComputerUse 34/34、真实模型 33/33、原生 GPU 12/12、偏好启动 5/5；范围与初次夹具失败见报告。实际配置滑杆 65→65.1→65 与桌宠同步，用户大小保留 65%。

[验收与发布记录](Newmark2DSH/archive/20261007-newmate-smooth-release/REPORT.md)。

实现结构：client.js 管理配置卡片；desktop-pet.cs 内 PetFrameClock 调度、PetSurface 复用位图、DesktopViewer 管理只读 GPU 预览与缓存；desktop-pet.js 清理临时 viewer.html。新增 scripts/verify-desktop-pet-gpu.mjs 编译生产代码并运行隐藏桌面集成，scripts/lib/desktop-pet-gpu-probe.cs 检查动画/偏好/清理。工具回归脚本支持指定已安装包并规范 pnpm 实路径。archive/20261007-newmate-smooth-release 下 before 为备份、bench 为阶段性能数据、gpu-* 为真实隐藏桌面回执、candidate 为包、release-repo/retrieved-repo 为独立发布及拉回仓、各 installed 测试目录为隔离数据、evidence 为安装与实机证据；逐目录用途见报告。

## 2026-10-07 NewMate 配置与 DSH 主题菜单（0.2.25，本地已安装）

插件页面分为「组件」与「配置」两大板块，准用模型归入配置。配置页和 NewMate 右键菜单共用 30%–300% 连续滑杆（0.1 个百分点精度）、实时双向同步并记住最后大小。默认倍率仍为 100%，本体基准宽度从 160 缩至 120（原尺寸的 75%）；旧版保存值按版本换算以保留实际大小。

右键菜单渲染 DSH 实际 Menu DOM 与有序 CSS，支持主题与插件覆盖；按 WebView 实际 DPI 定尺寸，并在桌宠旁展开，修复 200% 缩放下菜单裁切。候选包已重新安装并完整重启 DSH；本次 0.2.25 尚未发布至 npm，公开版本仍为 0.2.24。

[验收与安装记录](Newmark2DSH/archive/20261007-newmate-dsh-menu-css/REPORT.md)。

新增文件：`lib/newmate-settings.js` 管理版本化倍率读写与旧偏好换算；ComputerUse 的 `desktop-menu-theme.js` 接收经校验的同源样式快照，`desktop-menu-client.js` 捕获真实 DSH 菜单与 CSS，`desktop-menu.html` 承担滑杆交互，`desktop-menu.cs` 管理 WebView2 窗口/DPI/定位。`vendor/webview2/` 保存固定版本 SDK DLL、许可证与来源哈希。`scripts/verify-newmate-settings.mjs` 验证配置读写与迁移，`scripts/lib/desktop-pet-menu-probe.cs` 用生产原生类验证菜单。归档目录 `before/` 为修改前材料，`dependencies/` 为 SDK 来源，`candidate/` 为本地安装包，`native-probe/` 为窗口夹具与配置，`native-preferences/` 为隔离启动测试，`evidence/` 为日志、哈希与画面，`REPORT.md` 为结果和局限。

## 2026-10-07 正式发布、拉回重装与完整重启

0.2.24 已推送至公开仓库（515482f / v0.2.24），经 GitHub OIDC 发布到 npm，再从注册表下载并以精确版本重装。46 个发布文件与发布仓一致，其中 45 个运行文件与此前实机验收版本逐字节相同。DSH 已完整退出并重启，旧主进程及宿主退出、新宿主重新加载；当前 profile 依赖为注册表 0.2.24，不再引用本地候选 tgz。 [发布记录](Newmark2DSH/archive/20261007-newmate-release-0.2.24/REPORT.md)。

新增归档 `20261007-newmate-release-0.2.24/`：before/ 保存安装前配置及文档，release-repo/ 是独立发布仓，download/ 保存拉回 tarball 与解包，evidence/ 保存 CI/注册表/文件哈希/安装门禁/进程重启与 UI 证据，after/ 保存最终文档；verify-retrieved.mjs 逐文件核对，complete-docs.mjs 在安装与重启门禁通过后更新文档，REPORT.md 说明各项作用和边界。

## 2026-10-07 Newmark2DSH 桌宠候选

吉祥物正式名称为 **NewMate**；桌宠窗口、右键菜单与预览提示统一使用此名称。

正式 DSH profile 已升级至 0.2.24；45 个 shipped 文件与源码/隔离安装相同。真实 DSH 测试会话完成五次 ComputerUse 调用并释放专用租约。`20261007-pet-motion/installed-before/` 保存回退材料，`candidate/newmark2dsh-0.2.24.tgz` 是历史候选包，已由注册表依赖替代，`evidence/dsh-*` 保存运行证据。

改动范围为 `Newmark2DSH/` ComputerUse：`lib/desktop-pet.js` 管理编译、进程与用户偏好路径，`lib/desktop-pet.cs` 实现原生透明桌宠、弹性动效、右键倍率菜单及可反向缩放的只读预览，`assets/desktop-pet.png` 保存原图，`lib/win32.js` 将提示绑定到租约与模式，`component.js` 传入宿主解析的用户根目录。最后倍率位于该用户根目录的 `computer-use/desktop-pet.json`，下次首次显示前恢复。`scripts/verify-desktop-pet*.mjs` 和 `scripts/lib/desktop-pet-*` 提供实机/生命周期/像素/动效与恢复验收；四份 manifest 同步本地候选 0.2.24。完整文件职责见子项目 OVERVIEW，前后快照、包、截图与报告在 `Newmark2DSH/archive/20261007-pet-motion/`。现有其他未提交工作保留，当前正式发布与重装完成。

## 2026-10-05 提交 DSH Desktop issue #1312

- **产物**：[anywhere-labs/dsh-desktop#1312](https://github.com/anywhere-labs/dsh-desktop/issues/1312)，OPEN，`positer`，2026-10-05T07:03:43Z，正文 13,989 字节（与本地 `issue-body-as-filed.md` 逐字节一致）。
- **仓库选择依据**：`deepseek-ai/deepseek-harness`（缺陷代码所属）`has_issues: false` / `has_discussions: true`，无法提 issue；`anywhere-labs/dsh-desktop`（原 `deepseek-harness-desktop`）issues 开启、343 个 open issue、含 `bug_report.yml` 表单与 `patches/` 运行时补丁机制，且 `patches/` 中**没有** `dsh-llm-deepseek`/`dsh-agent-loop` 的补丁 —— 结论：发到桌面仓库并在正文标注修复归属上游。
- **查重**：`gh issue list -R anywhere-labs/dsh-desktop --state all --search ...`；正文点名 #170（SSE 断流，CLOSED）、#707（标题生成预算，OPEN）、#635（`reasoning_content` 回传，OPEN）三条近邻并说明差异。
- **正文结构**：严格按该仓库 issue 表单字段（查重、涉及区域、操作系统、安装方式、Desktop 版本 2.0.17、运行时 0.2.0-rc.2、Profile 类型 Custom、第三方插件 `newmark2dsh@0.2.15`、全新 Profile 对照、现象、复现、预期、频率、日志、截图），含英文摘要与两处代码原文（`blocks.size === 0`、`toolCalls.length === 0`）、48 会话 / 9,653 条助手消息 / 16 次退化的量化证据、非单调的上下文分档表、排除插件的四条证据 + 一个未解释的巧合、两个建议修复方向、以及多 zstd 帧的解码脚本。
- **回读校验**：`gh issue view 1312 --json ...` 断言 10 项（英文摘要、两处代码、量化块、分档表、插件排除段、截图对照表、用户名脱敏、无 `Users\\12252` 泄漏、边界声明段）全部通过；`state=OPEN`、`body` 13,989 字节。
- **未达成**：标签为空。`gh issue create --label ...` 退出码 0 但未生效；`gh issue edit --add-label` 报 `GraphQL: positer does not have the correct permissions to execute AddLabelsToLabelable` —— 作者非该仓库协作者，属权限边界。标题自带 `[Bug][2.0.17]` 前缀便于人工分诊。
- **写回产物**：`archive/20261005-150343-dsh-issue-filed/`（`record.md`、`operation.json`、`hashes.txt`、`docs-before/`、`docs-after/`、`issue-body-as-filed.md`）与本文件、`README.md`、`taste.md`。
- **边界**：本轮只写入了 GitHub issue #1312 与上述文档；**没有**改动 DSH 安装目录、`newmark2dsh` 插件或任何 DSH 配置；正文中承诺的"可按指示补做全新 Profile 对照"**尚未执行**；issue 是公开可编辑的，本归档只是它的本地记录而非权威副本。

## 2026-10-05 DSH 会话静默终止：只回思考块的补全被判成「已完成」

- **结论**：本机 DSH Desktop 2.0.17 的 `deepseek-account / deepseek-flash` 轮次静默收尾，不是崩溃/中断/插件故障，而是 provider 一次 `finish_reason = "stop"` 的补全只带了一个 `reasoning` 块。两处代码相加造成用户可见症状：
  - `…\resources\app\node_modules\@deepseek-ai\dsh-llm-deepseek\lib\index.js`：`if (blocks.size === 0 && reason.kind === "stop") throw new LlmError("DeepSeek Messages returned no content", "EMPTY_RESPONSE")` —— 守卫要求**零块**，只含思考块的消息块数为 1，漏过。
  - `…\@deepseek-ai\dsh-agent-loop\lib\index.js`：`const toolCalls = message.content.filter((block) => block.type === "tool-call"); if (toolCalls.length === 0) return { kind: "completed" };` —— 没有工具调用即判收尾，不检查是否有可见输出。
  - `dsh-llm/lib/index.js` 对 `EMPTY_RESPONSE` 的注释已经写明这类消息"silently ends the turn with nothing for the user or the loop to act on"，并且它被列入可重试集合；缺口只在判定条件。
- **量级与分布**（`archive/20261005-144403-dsh-silent-turn-stop/evidence/analyze-session-turns.mjs`，只读，Node ≥ 22.15）：48 个会话 / 9,653 条助手消息中"只回思考块"16 条，全部在 `session-56aad17e-5f35-4054-8000-9735c8878a5e`；这些消息的上下文为 458,073–593,523 token；上下文 ≤ 450,000 的 8,173 条助手消息中为 0。同一脚本产出的分档：0–450k 0/103 轮、450–500k 1/23、500–540k 3/23、540–580k 5/14、>580k 7/57 —— 并非干净单调，>580k 一档混入了第 146/179 轮压缩前的正常轮次，因此只能说"45 万以下零发生、45 万以上会出现"。
- **会话规模**：221 轮、2,583 条助手消息、347 条用户消息、17,458 条记录、6 次压缩、50 次工具结果剪枝；峰值上下文 679,088 token（`deepseek-flash` 目录窗口 1,000,000，`dsh-compaction-basic` 默认 `thresholdRatio = 0.8` 再被输出预留 256,000 + headroom 65,536 压到 678,464，与峰值吻合）。
- **截图对应**：10-05 14:26:46 / 14:27:14 的 turn 220（22.0 s）与 221（51.0 s）、14:22:25 的 turn 219（243.4 s = 4 分 3 秒）三次都以 `turn/end {reason:{kind:"completed"}}` 收尾且最后一条助手消息只含 `reasoning`；用户消息 seq 17416/17431/17446 与截图逐字一致（含界面时钟 14:27）。
- **对猜想的裁定**：(1) Newmark2DSH 插件不成立 —— `newmark-core/failure` 在 10-02/10-04/10-05 只有 10-02 13:15:20 一条 `computeruse/backend` 记录（早于首次静默 8 分钟、与该现象无关）；助手消息 `source = {kind:"model", provider:"deepseek-account", model:"deepseek-flash"}` 且流以 provider 的 `finish{kind:"stop"}` 结束；插件在全部 48 个会话装载而静默只在 1 个出现；10-05 同版本下 turn 213（574,185 token，875.6 s，12 步）正常、turn 214–221 连续静默。10-02 13:19:15 与 10-05 14:13:20 的插件重载与静默起点时间相邻，但 10-04 无任何插件重装（插件目录最后写入停在 10-02 15:13:41）而当天仍有 5 次静默 —— 巧合已记录，未被当作因果。(2) "轮次过多"方向对、机制错：相关变量是上下文 token 数而非轮次计数，且 45 万以上 1,345 条消息里只有 16 条退化（`fa3d5661` 峰值 501,364 / 68 条、`a11943ed` 峰值 498,077 / 65 条均为 0），上下文深度是必要不充分条件。
- **顺带查实（非本次原因）**：`workspace-changes` 的 `git add --all --ignore-errors` 在本仓库 09-30 起共 7 次 30 秒超时（09-30 ×2、10-02 ×3、10-05 ×2，10-01/10-04 为 0）；10-05 14:41:27 与 14:42:31 各一次 `[scope] Error: tool "subagent" is already registered in this scope`（未定位，`preset-dev` 的四个 subagent 条目用的是四个不同 `toolName`，表面不冲突）。 同日 15:0x 读回 `git status --porcelain` = **4,853 条**，暂存区含 `.tmp-*` 与 `DESKTOP/scripts/*.cjs` 等大批路径（HEAD 为 `419428f`）：与该插件的 `git add --all` 行为一致，但**未证明**索引由它写入，本轮**未清理**（清理不在任务范围内，且会动到他人暂存）。
- **本轮改动范围**：只读会话存储、host 日志与已安装应用源码；写入仅限 `archive/20261005-144403-dsh-silent-turn-stop/`（`record.md`、`operation.json`、`hashes.txt`、`docs-before/`、`docs-after/`、`evidence/` 两个可复跑的 `.mjs` 与四份原始输出）与本文件、`README.md`、`taste.md`。**没有修改 DSH 安装目录或 `newmark2dsh` 任何文件**；因此"把压缩阈值调低"与"上游修 `EMPTY_RESPONSE` 判定"两条建议均**未验证**。
- **踩到的坑（已写进 taste.md）**：`session.v4.jsonl.zstd` 是上万个 zstd 帧顺次拼接（本会话 10,980 帧），Node 的 `createZstdDecompress`/`zstdDecompressSync` 只解第一帧，"解压成功"只给出 1 行 session 头 —— 分析脚本必须扫 `28 B5 2F FD` 逐帧解码。

## 2026-09-30 退役 CU-Lab 项目存储清除

- `newmark-cu-lab/` 已整体删除：**53,915,960,864 bytes / 229,297 文件 / 51,418.3 MiB（50.2 GiB）**。该目录未被 git 跟踪（`git ls-files` = 0 行，原 `git status` 为 `?? newmark-cu-lab/`）且内部无嵌套仓库，删除不改写任何 git 历史；`DESKTOP`/`TUI`/`WEB`/`android`/`.github` 无构建或测试入口引用它。
- 删除方式：`robocopy <空目录> newmark-cu-lab /MIR` 后校验目录不存在（`Test-Path` = False，退出码 2 属 robocopy 成功区间），再做一次 `Remove-Item` 与断言。全程实测目录 229,297 个文件，删除耗时约 16 分钟（start 00:19，end 00:35:29）。
- 保留的源码快照：`archive/20260930-001844-culab-purge/source-snapshot/`，151 个文件 / 1,313,127 bytes（≈ 1.25 MiB），含 `nculab/`（capture、cli、dataset、evaluation、export、models、monitor、orchestrator、scenarios、server、state、storage、training）、`scripts/`、`tests/`、`configs/`、`contracts/`、`policies/`、`docs/` 与 11 个根文档/配置（`README.md`、`STATUS.md`、`OVERVIEW.md`、`taste.md`、`pyproject.toml`、`configure.txt`、`passContext.txt`、两份 signature、`quantized_info.csv`、`.gitignore`）。逐文件 SHA-256 在 `evidence/source-snapshot-manifest.sha256`；源侧与快照侧双向差集均为空（`evidence/source-snapshot-verify.txt`）。
- 未保留：`var/`（41,223.9 MiB：datasets 17,348.1、open-datasets 14,407.1、runs 6,253.5、generated 2,788.6、logs 186.4、npu-cache 173.2、candidates 62.6、probes* 3.2、reports 0.9）、`.venv` 4,452.0 + `.venv-quant` 994.5 + `.venv-npu` 827.0 MiB、lab 内 `archive/` 3,917.8 MiB、`__pycache__` 与 `.pytest_cache`。
- 数据采集代码边界（实测复核）：App 侧 `DESKTOP/src/core/computerUse/`（`frameStore.ts`、`CuCadenceGate`/`perceptionRouter.ts`、edge model provider、`.nmep` loader、artifact discovery）已于 2026-09-26 退役，目录不再存在；`DESKTOP/src` 仅剩 `tests/computerUseSparseOnlyVerify.ts` 的反耦合正则（保留，作为门禁），`DESKTOP/scripts`、`TUI`、`WEB`、`android`、`Flow`、`SCRIPTS`、`docs` 命中为 0。lab 的采集管线 `nculab/capture/`（`uia_playground.py`、`canvas_playground.py`、`lock.py`）、`nculab/scenarios/`（`windows_ui.py` 等生成器）、`nculab/dataset/` 随目录离开工作树，仅存在于源码快照。
- 文档写回：`README.md`、`OVERVIEW.md`、`taste.md` 顶部新增本节与同名的 taste 小节，并给原「`newmark-cu-lab/` 保留为隔离历史研究项目」的现状断言加注取代标记；`.gitignore` 新增 `newmark-cu-lab/`，防止重建后被误提交。带日期的历史段落（2026-09-21/22/23/24/26）不改写——它们记录当时事实。
- 冷证据边界：`archive/20260926-cu-local-model-retirement/legacy-source/`（0.34 MiB / 54 文件）、`archive/20260921-dev066-cu-nest/`（13.6 MiB，含 6.4 MiB `.nmep`）、`archive/20260922-dev066-culab-v0.1-eval/`（+zip，0.8 MiB）按本轮范围未删除，它们是过去结论的证据；因此「工作树已无 culab」不等于「归档清零」。
- 清理后校验：C: 可用空间 143.76 GB；`~/.Newmark` 下不存在 CU 模型目录，无需清理。记录、清理前清单、快照哈希、清理后校验与写回前哈希见 `archive/20260930-001844-culab-purge/`。

## dev-0.6.9 PC 对话归档响应性修复

- 版本同步脚本将 `VERSION`、`DESKTOP/package.json`、`DESKTOP/package-lock.json`、Android `versionName` 与 `versionCode` 统一为 `0.6.9` / `609`；Android 业务源码未变。
- `DESKTOP/src/core/agent.ts`：归档只分离选中对话；避免整份 workspace state 深拷贝，并把缺失分支 ID 的查询从逐消息同步读取改成每批一次。Markdown 长转录每 64 条消息让出事件循环。Flow WorkRun 结束时可以推迟同步落盘；新增异步状态锁和异步 flush，等待过程不会阻塞事件循环。归档清单写完后，在最新状态锁内删除目标对话及其 Flow suspension，再回收分片。同步状态事务现将整个持锁过程包在 `finally` 中；revision 冲突等 mutation 回调异常也会释放锁，避免后续同进程操作死锁。老锁只有在 owner 已退出（或 owner PID 缺失且文件足够旧）时才可回收。
- `DESKTOP/src/main.ts`：归档期间停止活动 Flow 时走异步 WorkRun flush，并把它纳入归档准备等待；删除目标和 Flow suspension 的落盘由 Agent 的同一状态变更完成。
- `DESKTOP/src/tests/conversationArchiveResponsivenessVerify.ts`：覆盖持锁事件循环、老时间戳的存活 owner、死 owner 锁恢复、活动 Flow 中断、归档最终删状态争锁和 1,000 条 / 约 8 MiB 转录；归档运行中 UI harness 可显式启动指定 EXE，以便直接测安装版。
- 回归：`npm run test:full-release` 最终通过（退出码 0）；一次先行全量运行发现 linked-plan revision conflict 会遗留同进程锁，修复后单测及完整发布门禁均通过。48 并发归档产生 48 个唯一名称；完整门禁的 Flow 中断 max event-loop lag 25 ms、归档锁竞争 11 ms；1,000 条转录导出约 196 ms / max lag 53 ms。真实安装版 Electron 活动/空闲归档 13/13 通过，活动 Provider mock 流取消，后续写入没有复活归档。
- Windows x64 MSI 与便携 ZIP 已在 `release/validation-0.6.9-20260929/` 生成，包内 SSH/PTTY、CLI、上下文压缩和 console 边界 smoke 通过。MSI SHA-256 `024B722C5597590939C5FC75B60348748F25CD1E70FE1E04C3FA5CECB3B328F2`；安装后注册表与 EXE 为 `0.6.9.0` / ProductCode `{EFEB73B1-4D7C-4C06-9A96-FECD83FCCDDF}`，Program Files EXE/`app.asar` 与候选哈希一致。`.Newmark` 安装前后均为 21,708 个文件、357,340,682 bytes、聚合 SHA-256 `54B837CE5A64363380A75A9A4E4215C84D82491A866F641B754C65E59C1DE357`。MSI 未签名、未发布；完整日志和 GUI 截图见本地归档（未纳入公开仓库）。
- 安装与交付边界：本机 Program Files 安装态已通过本节所列身份、用户数据完整性和归档 GUI smoke；未发布 GitHub/npm。未验证真实 Provider 归档、Android APK 构建或正式签名/发布流程。
- 后续 Computer Use 修复位于 `DESKTOP/src/tools/computerUse.ts`、`computerUsePowerShellHost.ts`、`tools/index.ts` 与 `core/agent.ts`：修正 `mouse_event` 的 `UIntPtr` 封送和高 DPI 物理坐标；规范化常见按键组合并转义标点；激活窗口后校验前台归属；UIA 建议 lane 超时使用可恢复的 500/1000/2000/4000 ms 退避。`DESKTOP/scripts/release-gui-no-model-smoke.cjs` 可通过 `NEWMARK_GUI_NO_MODEL_EXE` 直接验收指定已安装 EXE。
- Computer Use 回归：`npm run test:computer-use-runtime` 通过，Windows 原生 fixture 14 场景覆盖 7 次鼠标/滚轮事件、快捷键/URL 标点、UIA 超时恢复和 20 次快速 app 观察。DeepSeek 真模型隔离 GUI 对 Program Files 安装版完成 17/17 检查；模型仅观察合成标签，实际调用 `computer_use.observe` 并收到新鲜截图，无 Provider 错误。安装版 no-model GUI 黑盒检查也通过。
- 0.6.9 Computer Use MSI/便携 ZIP 位于 `release/validation-0.6.9-computeruse-fix-20260929/`；MSI SHA-256 `3AB12074BE17D9324E5DD95427ECEE0373318A3382EAA527F1F904090275C415`，ZIP SHA-256 `3F155C42E46065CEA7A149594F68C7DD19E76943D4A4F5AFE2072632FAB2E6F3`。第二次本机安装后 ProductCode `{07946760-788D-486D-A4DC-B31B56F2159E}`，注册表/EXE/CLI 版本 `0.6.9.0` / `0.6.9`；292/292 安装文件和 ASAR 哈希匹配，21,729 个 `.Newmark` 文件比对错误为 0。MSI 未签名、未发布；完整记录见 `archive/2026-09-29-pc-computer-use-reliability-0.6.9.md`（本机归档，不进入公开仓库）。
- 后续 CU 鼠标模式与拖动改动：`ComputerUseSessionRegistry` 将 `real`/`virtual` 绑定到 `takeover_start` 会话，host 注入会话模式，后续动作参数不能覆盖它。真实鼠标使用 50 ms native 曲线路径，点击和拖动共用至少 350 ms 间隔；新增全桌面 `drag` 与选窗 `app_drag`，真实拖动在按下后沿曲线移动并在 `finally` 释放。虚拟拖动通过选中 HWND/子控件投递 down、带按键状态的 move 和 up，不激活目标、不移动系统光标；目标 HWND 失效、路径中断时仍尝试释放。虚拟截图继续用独立 `window_capture` PowerShell worker + `PrintWindow` 读取遮挡窗口。应用需处理消息且支持 `PrintWindow`；UIPI、更高完整性级别、最小化窗口、非客户区和 Raw Input/独占输入仍是兼容边界，消息入队回执不代表应用动作已完成。
- CU 拖动实测：`npm run test:computer-use-runtime` 通过，包含清洁构建、稀疏观察 8/8、会话断言 13 项和 1280×720 Windows 原生 GUI fixture 19/19 场景。fixture 确认真实桌面 `drag`、真实 `app_drag`、遮挡后台虚拟 `app_drag` 及虚拟 `drag` 都抵达 drop target，并观察到按下、移动、释放；虚拟模式结束后前台 HWND 和实体光标坐标未变。本次验证了源码和隔离夹具，未生成或安装新 MSI/ZIP，也没有重新执行真模型调用。实现与现场操作记录见 `archive/2026-09-29-computer-use-mouse-modes.md`。

## dev-0.6.8 Computer Use：Windows-MCP 原生化

- `dev-0.6.8` 已于 2026-09-28 发布为开发预发行版，标签指向版本提交 `77ee63f697967edc5322759465b6c8323e7dbc57`。Windows x64 MSI/便携 ZIP、Linux x64 AppImage/deb/便携 ZIP、Android APK 与 SHA-256 校验清单均已在 [GitHub Release](https://github.com/positer/Newmark-Agent/releases/tag/dev-0.6.8) 发布；`newmark-agent@0.6.8` 已通过 npm Trusted Publishing/OIDC 发布并附 provenance。Windows/Linux/Android CI job 与总发布 job 均成功，六个 Release 资产 SHA-256 与正文清单逐项匹配。
- 发布验证：干净安装后 `npm run test:full-release` 退出码 0；写入观察压力测试 224 项断言（32 个并发 ToolExecutor、32 个同路径异步门禁回调）；隔离 Electron + DeepSeek CU 真模型观察闭环通过；`npm audit` 为 0 项。npm 包预演为 320 个文件且不含 archive/report。此次未执行本机 Program Files 安装/升级验收，也未做 Android 实体设备验收；Windows 包未 Authenticode 签名，APK 使用开发签名，非 Google Play 包。macOS 不属于当前发布矩阵。
- `DESKTOP/src/tools/computerUse.ts`：桌面截图支持显式跳过 UIA 树；完整观察继续生成语义对象。UIA 只从有效窗口句柄开始，不再回退到桌面根树，并跳过 Newmark 宿主进程。`wait_for` 在当前观察或指定窗口中以有界轮询匹配 UIA 文本、`target_id` 或可见窗口，并返回匹配、超时、取消或 UIA 不可用状态。观察缓存绑定窗口句柄；截图专用模式清除语义目标。
- `DESKTOP/src/tools/index.ts`：公布 `include_ui_tree`、`timeout_ms` 与 `wait_for` 参数，映射工具输入，并将只读观察参数保留在 Plan 模式工具投影中。
- `DESKTOP/src/core/toolPolicy.ts`、`DESKTOP/src/core/computerUseSession.ts`：把 `wait_for` 归入只读 ComputerUse 操作，允许 Plan 模式查询；ComputerUse 会话注册表统一保存 owner lease、enabled 状态与 `real`/`virtual` 鼠标模式，并在 stop/toggle/cancel/过期后回到 `real`。
- `DESKTOP/src/tools/computerUsePowerShellHost.ts`：继续提供持久 PowerShell/UIA worker；ComputerUse 不启动独立 Windows-MCP 服务。
- `VERSION`、Desktop package/lock 与 Android 版本标记进入 0.6.8；Android 业务代码未改，仅更新 `versionCode` / `versionName`。

## 2026-09-28 文件变更前读取门禁

- DESKTOP/src/core/fileWriteObservation.ts：读取目标、生成带作用域和有效期的观察回执、聚合已读行范围，并在变更前重新核对文件指纹。对同一规范路径加锁；并发中的第二次变更无法复用已消费或过期的回执。
- DESKTOP/src/tools/index.ts：read 支持 start_line/end_line；write、edit、delete_file 和 web_catch 经门禁执行。edit 只允许改动已读范围中出现且在目标文件唯一的 old_str；新建文件确认目标路径仍不存在并排他创建。
- DESKTOP/src/core/agentKernelRunner.ts、DESKTOP/src/core/agent.ts：把 runtime、Build run、workspace、conversation、actor 和 backend 身份传入文件门禁。
- DESKTOP/src/tests/fileWriteObservationStressVerify.ts：覆盖回执范围、单次消费、过期和目标变更、32 个并发 ToolExecutor 实例，以及 32 个异步门禁回调的进程内同路径互斥；纳入 test:desktop:built 与 test:full-release。
- DESKTOP/scripts/test-computer-use-real-model.cjs：要求明确选择已配置的线上视觉 Provider，复用隔离 GUI 流程验证真实模型发起 ComputerUse、收到新鲜图像并完成语义检查；测试进程仅允许只读桌面观察。
- 范围边界：bash/terminal_takeover、浏览器/CDP、ComputerUse、Flow、Memory Lab、技能下载等通用或结构化写入口没有纳入本轮，不能宣称全局写入闭合。
- 根目录 `本机私有归档（已从公开仓库排除）` 与 `本机私有归档（已从公开仓库排除）` 仅在本机保存冷数据，已从 Git 跟踪中移除并由 `.gitignore` 排除；README 与本概览不链接这些私有报告。

## 2026-09-28 Auto 决策倾向与反馈历史退役

- `DESKTOP/src/ui/index.html`、`DESKTOP/src/core/config.ts`、`DESKTOP/src/core/autoRouter.ts`：Auto 设置统一为保守/均衡/激进定性倾向；旧值读取时归一为均衡。
- `DESKTOP/src/core/jevDecision.ts`：把倾向作为 `objective.tendency` 交给当前对话模型，明确由模型综合任务适配、健康、验证、费用、延迟和上下文事实决策；倾向不变成固定排序或数值阈值。
- `DESKTOP/src/core/agent.ts`、`DESKTOP/src/core/conversationKernel.ts`、preload/main/server 与 utility/WSL transport：移除 Auto 路由评分、`ratings.jsonl` 写入、清理历史入口及对应专用 IPC/RPC；遗留用户数据不会被新代码读取、覆写或删除。其他聊天/provider通信接口未改。
- `npm run build`、5 组针对性验证、UI 一致性与六张打包版截图通过。MSI `release/Newmark-Agent-0.6.7-x64.msi` 已安装；Program Files 中 `0.6.7.0` EXE/ASAR 哈希、HKLM ProductCode/PackageCode、CLI `0.6.7` 和 292 个 payload 文件全部与包相符，安装前后的 `.Newmark` 清单无差异。本次安装未启动 GUI（`GuiRuntimeVerified=false`）。
- 版本身份、安装核验、哈希、截图与归档事故恢复记录见 本地归档（未纳入公开仓库）。

## 2026-09-28 PC GUI 视觉、动效与全场景验收

- `DESKTOP/src/ui/index.html`：桌面 GUI 单文件外壳；本轮候选只修改 CSS。样式交接快照与当前文件在归一化换行后，`style` 区域以外的全文完全相同，功能逻辑与通信接口未动。
- 交错四轮 CSS A/B 的 RAF callback 均值为候选 60.08、基线 60.47 次/秒。侧栏开合和历史分页 p95 小幅改善，但输入绘制与整段 RAF 间隔 p95 回退；不能宣称整体帧率提升或达到 165 Hz。测试使用隔离 Electron 与 loopback fixture，不是已安装版本或真实 provider 验证。

## 2026-09-27 用户级 PC GUI 性能压力测试

- `DESKTOP/scripts/test-user-soak-gui.cjs`：以真实 Electron GUI、preload 和 Agent/IPC 对本机 loopback provider 做隔离压力，不替换生产 handler；运行时绑定 exe 与 `app.asar` SHA-256。
- 安装版在短测内未通过历史分页原节点保留检查；新 unpack 完成 336/336 检查和 310.6 秒活动，但 RAF callback p95 46.3 ms、最高间隔 1089.1 ms、Long Task p95 168 ms，不能称为 165 Hz 流畅达标。两个包虽同为 0.6.6.0，ASAR 哈希不同；本轮没有安装新候选。
- 对测试报告和原始采样的解释遵循：RAF 是 renderer callback，不是 compositor present；稀疏 GPU 样本不能单独证明渲染瓶颈或排除瞬时合成器工作。

## 2026-09-26 CU 端侧模型接口退役

桌面生产 Computer Use 现采用稀疏灰度摘要变化唤醒，再执行新鲜全尺寸截图/UIA，并把图像交给当前对话视觉 Provider。App 源码、依赖和打包产物不再包含 CULab/NES-T/NMEP/ONNX loader、工件发现或 schema emitter。`newmark-cu-lab/` 保留为隔离的历史研究项目，使用自身冻结 schema，不读取桌面源码；其 `.nmep` 输出不属于可部署产物。（**2026-09-30 取代**：该目录已整体删除，见顶部同名小节；此处保留当时状态。）真实 Provider 和 unpack 证据见 本地归档（未纳入公开仓库）。

## 2026-09-26 JEV 只用当前模型关闭思考后的严格 JSON

Auto 路由只使用当前符合资格的对话模型完成 JEV 判断，不配置第二个 JEV 模型或额外 JEV 服务。候选先经过 `RouteEligibilityGuard`；模型返回严格类型化 JSON 后再经本地字段/边界检查与 `RouteDecisionValidator`。Provider 不支持原生关闭思考或严格 JSON Schema、输出无效、当前模型不可调用或请求超时，都使本次 Auto 路由失败关闭，不会使用本地选择器或备用模型。

| 路径 | 当前作用 |
| --- | --- |
| `DESKTOP/src/core/jevDecision.ts` | 定义 `JEV_ROUTE_DECISION_SCHEMA`、`CurrentModelJevDecisionEngine`、严格 JSON 解析、候选范围验证和超时/失败策略；生产模块不含本地模型排序器，默认失败时 fail closed。仅测试使用的确定性决策夹具位于 `DESKTOP/src/tests/fixtures/localJevDecisionEngine.ts`，应用打包规则排除整个测试目录。 |
| `DESKTOP/src/core/agent.ts` | 在已有对话模型仍合格时用它发起 JEV；首次 Auto 决策使用符合资格的默认/候选部署发起当前模型 JSON 请求，避免独立 JEV 模型槽位。 |
| `DESKTOP/src/llm/provider.ts` | 同一 Provider 的 `chatStrictJson` 发送协议原生 JSON Schema；OpenAI-compatible 模型在原生支持时设置思考 `none`，Anthropic 使用 disabled thinking 请求。拒绝/不兼容作为 JEV 失败处理。 |
| `DESKTOP/src/core/config.ts`、`DESKTOP/config.example.json` | 默认决策超时为 3000 ms；升级时移除旧 JEV runtime/model/path 和回退选路字段。 |
| `DESKTOP/src/main.ts`、`DESKTOP/src/ui/index.html`、`DESKTOP/src/cli-commands.ts`、`TUI/src/` | 只暴露当前模型策略的启用状态和超时；没有外接 JEV 模型、运行时或备用选路接口。 |
| `DESKTOP/src/tests/jevDecisionVerify.ts`、`DESKTOP/src/tests/jevRoutingInvarianceVerify.ts`、`DESKTOP/src/tests/jevModelEditorVerify.ts` | 覆盖当前模型严格 JSON、原生关闭思考、守卫复验和失败关闭；测试执行结果见 JEV 归档。 |
| 本地归档（未纳入公开仓库） | 当前决策边界、旧配置迁移和实际验证记录。 |

首次 Auto 路由从符合资格的当前/默认部署发起 JSON 决策。Schema 对所有字段使用 required 与封闭对象约束；Newmark 再逐项执行类型和边界校验。平台不接受原生关闭思考或严格输出时，不降低为提示词约束，也不回退到另一个模型。默认硬超时 3 秒。

## 2026-09-26 Android 模拟器高压、互联与本地对话复测

本轮使用 Android 15 / API 35、x86_64、1080×2400、60 Hz 的隔离 AVD；功能和持久化门禁通过，Compose UI 在压力下出现高 jank。测试基于本地 mock 和 `adb reverse`，不代表物理手机、真实网络或生产 provider。

| 路径 | 作用 |
| --- | --- |
| `android/scripts/mobile-agent-stress.ps1` | 120 条远端流事件、60 轮 UI 压力、目标状态可见性、队列写入、旧事件拒绝与 gfxinfo 采样；报告包含完整采样窗时长和窗口帧吞吐。 |
| `android/scripts/mobile-queue-animation-benchmark.ps1` | 事件流结束后以固定坐标驱动 60 轮队列展开/收起，隔离截图和 UI 树观察，记录 jank 与帧时延。 |
| `android/scripts/mobile-remote-target-switch-stress.ps1` | 在两个唯一工作区/对话间切换，核验 SSE 生命周期、目标读取与状态隔离。 |
| 本地归档（未纳入公开仓库） | 选择 Local fixture，验证流式输出、FIFO 队列、取消、持久化、强制停止和重启恢复。 |
| 本地归档（未纳入公开仓库） | 为本地运行时稳定性测试提供 loopback SSE / completion mock。 |
| 本地归档（未纳入公开仓库）、`evidence/` | 本地运行时门禁结果与逐阶段模拟器截图。 |
| 本地归档（未纳入公开仓库） | 汇总 AVD、build/test、四类运行证据、Astra 复核与生产边界。 |
| 本地归档（未纳入公开仓库）、本地归档（未纳入公开仓库）、本地归档（未纳入公开仓库） | 三类自动化运行的原始门禁与设备测量数据。 |
| 本地归档（未纳入公开仓库） | 高压 UI 检查的关键截图。 |

关键结果：混合压力 79.25% jank / p90 150 ms，单项队列动画 52.94% / p90 48 ms；两者功能门禁通过、流畅度有明显缺口。完整采样窗的 `deliveredFramesPerSecond` 包含驱动脚本输入间隔，不等于动画活动时的实际显示 FPS。具体门槛和建议见本地归档（未纳入公开仓库）。

## 2026-09-26 CU 稀疏观察接入

生产 `computer_use observe` 新增可选 `sparse_wait_ms`（0 默认、最大 5000 ms）。它通过独立的 PowerShell lane 以最多 5 Hz 对 32×18 灰度摘要做变化唤醒，无端侧神经网络；触发、超时、失败或桌面几何变化后都重新执行正常全尺寸截图 + UIA。原生产 observe 未调用 NES-T，因此这是可无模型执行等待的新路径，不是删除已有生产推理。该测量只用于唤醒，不把超时解释成无变化；native 桌面采集成本仍在，性能改善未测量。

| 路径 | 作用与状态 |
| --- | --- |
| `DESKTOP/src/tools/index.ts` | 为 `computer_use` 暴露有界 `sparse_wait_ms` 参数并传递取消信号。 |
| `DESKTOP/src/tools/computerUse.ts` | 运行可取消的 32×18 灰度变化等待；将 helper 初始化计入等待预算，分别记录完整等待墙钟与采样耗时，随后取得新鲜的完整截图与 UIA。 |
| `DESKTOP/src/tools/computerUsePowerShellHost.ts` | 提供独立 `sparse` PowerShell lane；host 初始化后发 ready 握手，启动阶段超时保留 lane，避免重复冷启动。 |
| `DESKTOP/src/core/agent.ts` | 引导 CU 对被动等待使用一次有界 sparse observe，而不是反复立即全帧观察。 |
| `DESKTOP/src/core/agentKernelRunner.ts` | 仍把完整观察图像交给当前视觉模型；本轮未改模型路由，不能保证是远端快速模型。 |
| `DESKTOP/src/tests/computerUsePerformanceVerify.ts` | 覆盖 Windows 冷启动与暖调用的稀疏采样、等待预算和 UI event-loop 性能。 |
| `DESKTOP/scripts/test-user-soak-gui.cjs` | 对精确 unpack 包运行隔离 loopback GUI：稀疏采样、队列、并发对话切换、冷重启与 UI 指标。 |
| `DESKTOP/src/tests/runtimeIsolationVerify.ts`、`DESKTOP/scripts/test-cross-process-workrun-persistence.cjs` | 保护跨 shard / 进程 WorkRun 完成状态，防止旧 `running` 快照覆盖终态。 |
| 本地归档（未纳入公开仓库） | 实现取舍、Astra 审阅、风险和未验证事项的操作记录。 |
| 本地归档（未纳入公开仓库） | 候选包哈希、CU canary、真实 provider 长上下文/队列/多对话测试、GUI soak 与安装门禁记录。 |
| 本地归档（未纳入公开仓库） | 最新精确 unpack v6 的包身份、源码回归、隔离 GUI 压力结果及 MSI 未生成/未安装边界。 |

此实现采用固定低分辨率变化测量，不是严格压缩感知重构。它允许等待阶段不依赖本地神经网络，但不能消除原生桌面采集，也未建立专属远端快速视觉模型路由。研究基线见本地归档（未纳入公开仓库）。

**候选包实测（不是已安装验收）**：精确 unpack v6 通过 CU sparse GUI 12/12、双流 A/B 目标绑定 29/29、120 秒长历史 GUI soak 130/130。冷/热 sparse 为 4.082 秒/12 个样本与 486 毫秒/3 个样本；两个并发 run 经 10 次切换和冷启动后均保持正确目标。长对话 1200 条历史连续活动 122.439 秒，provider、renderer、runtime 错误为 0；输入绘制 p95 34.5 ms，切换/分页 p95 1.095/1.663 s。所有 GUI provider 均为隔离 loopback fixture。包内 `verifyUnpackedOutput()` 与随包 SSH/TUI restart 压力通过；WiX MSI 阶段在生成文件前停止，所以无 MSI/安装验收，后续 CLI/ZIP 阶段未运行。完整证据见 本地归档（未纳入公开仓库）。

## 2026-09-26 CU 压缩感知应用边界（研究阶段）

理论、当前链路证据、Astra 专家建议和最小远端视觉原型边界见 本地归档（未纳入公开仓库）。当时为文档/架构可行性工作，没有生产代码变更；接入后的工具状态见上节。

| 路径 | 作用与本轮发现 |
| --- | --- |
| `DESKTOP/src/tools/computerUse.ts` | 生产 `observe` 并行捕获按需截图与 UIA；临时图像随工具结果供当前视觉模型读取。 |
| `DESKTOP/src/core/agentKernelRunner.ts` | 把工具截图加入当前模型输入，并在物化本轮输入后消费临时图像；当前路径不保证指定远端快速部署。 |
| `DESKTOP/src/core/computerUse/perceptionRouter.ts`、`frameStore.ts` | 描述本地 cadence、云端升级与稀疏关键帧的独立 CU 组件；尚未接入生产 `computer_use`。 |
| 本地归档（未纳入公开仓库） | CRT 压缩感知原理、CU 适配评估、Astra 方向审阅和后续原型门槛。 |

推荐先验证“事件触发观察 + 明确绑定的远端快速视觉模型”；严格 CS 需要服务端重构，并先证明真实 UI 帧差分可压缩且重建后保住微小控件/文字。详情与性能归因边界见报告。

## 2026-09-24 CU 权重稳定性与 UI 性能复测

完整复测、逐次日志和可重复 soak 脚本位于 本地归档（未纳入公开仓库）/。默认无权重发现结果为 UIA-only，原门禁 18/18 通过。复测后已修复模型装载筛选：发现阶段标出 App ABI 不兼容项，App loader 强制 16D，并拒绝检测/追踪门禁失败的晋级模型。详情见 本地归档（未纳入公开仓库）/。

代码结构与本轮判断：

| 文件/目录 | 作用与当前状态 |
| --- | --- |
| DESKTOP/src/tools/computerUse.ts | 当前 computer_use 生产工具入口；没有调用下方独立 CU 模型 provider |
| DESKTOP/src/core/computerUse/model/ | App 自有 artifact discovery、16D ABI 与 producer gate 校验、CPU ONNX session、provider；目前通过独立模块门禁和评测运行 |
| DESKTOP/src/ui/index.html | 对话工作状态增量渲染；更新路径改用滚动监听缓存的贴底状态，原性能门槛仍需同口径复测 |
| newmark-cu-lab/var/candidates/ | 本机候选权重；是否被 discovery 看见取决于显式根目录和 artifact stage |
| 本地归档（未纳入公开仓库）/、本地归档（未纳入公开仓库）/ | 原复测报告/CPU 图延迟/provider 80 帧 soak/GUI 压测日志；本轮装载修复报告与 MANIFEST |

基线无权重 GUI 两轮输入 tick 峰值为 122.4/223.9 ms；A2 CPU 推理并行一轮为 128.7 ms。三轮都超过 100 ms 压测门槛；滚动布局读取已作低风险优化，尚未复跑同一探针。A2 provider 原 80 帧无推理错误，但阶段仍为 CANDIDATE、描述子为 32D，且 detectorPass/trackingPass 为 false；现有 App loader 会拒绝它。CU-Lab RyzenAI NPU 稳定性数据不代表 Newmark 当前 CPU provider 或完整 GUI 端到端延迟。

## 2026-09-23 外部复核落地：撤回过强结论 + 采集语义门禁 + 隔离入库

用户交来外部复核包（本地归档（未纳入公开仓库），CULab_Repair_20260923）。
该复核对本项目上一轮结论的批评**全部成立**，本轮逐条接受并落地第一轮修复。

| 文件/目录 | 变更与职责 |
| --- | --- |
| `newmark-cu-lab/nculab/scenarios/windows_ui.py` | `globalShift` 从"按命令参数推算"改为**实测**（归一化 / 输入空间 / 逐帧增量 + `basis` / `cumulative` / `windowShiftDesktopPx`）；新增 `_verify_episode()` 场景语义门禁与每 episode 的 `verification` 块（`verified` / `failed` / `static-by-design` + 原因） |
| `newmark-cu-lab/nculab/dataset/builder.py` | `verification.status=failed` 的 episode **不入库**，写入 `manifest.quarantine`（原因 + 路径）；合成 suite 无 verification 段时不受影响 |
| `newmark-cu-lab/scripts/audit_episode_motion.py` | 升级为四级审计：文件哈希 → RGB 哈希 → 实体框 → **控件 ROI**；新增 `--quick` / `--limit-clips` |
| 本地归档（未纳入公开仓库） | 顶部新增**修正块**：撤回"30.4% 是定位上限"、更正 INT8 parity 口径（0.327 属 interactability）、更正 fp32 体积方向（25.179 MiB，超出首选门禁 183 KiB）、共享身份率改报 N/A、F6 数字按目标级审计更正 |
| 本地归档（未纳入公开仓库） | 交接包 v2（0.82 MiB / 70 文件，SHA-256 全通过）：新增 `reviews/`（复核原文 + 审计脚本 + `WHAT-CHANGED-IN-V2.md`）、ROI 级审计、非有限梯度证据、采集门禁摘要；fp32 profile 证据已重跑修正 |

**被推翻的三条自家结论**：① "91.9% 找到目标 / 30.4% 是回归上限"——GT 框内 argmax 等于用真值找信号，
且 recall@0.2=0.3369、@0.1=0.528 都高于 0.304，从来不是上界（改为"中心选择/编码/筛选链有缺陷、贡献不可分离"）；
② 用 parity 0.327 解释 INT8 objectness 漂移——0.327 属 interactability，objectness 是 0.103410；
③ "0 次 CONTINUATION 证明身份层失效"——实测 INT8 12 次、fp32 23 次，真正为 0 的是**稳定身份率**，
共享身份率应为 **N/A**（比较样本为 0）。

**本轮新增的硬事实**：训练语料 `real-ui-v2` 按目标级审计 **432/700 clip（61.7%）无目标级证据**、
全局唯一帧 **3,160/8,400（重复 62.4%）**；留出集 38/60；`training/telemetry.jsonl` 中 backbone 梯度
step 1/3/5/9/17 = NaN、step 4462 = +Inf。**实跑验证**：12 episode 真实采集中 **8 个被判 failed**
（`moveControl_no_effect` 3、`window_move_only_no_content_motion` 2、`hover_no_pixel_change` 2、
`hide_not_observed` 1），入库只有 4 clip / 48 帧，比例门禁如实报 false。

**根因已定位到代码行**：`_motion_script()` 的 `move` 移动的是桌面上的窗口而采集裁剪客户区；
`normal_translation` 固定移动 `btn-save`、`disappear_reappear` 固定 `ico-filter`（多数模板无此控件）；
`stable_jitter` 依赖不产生重绘的 `hover`。

边界：**采集能力本身未修**（只修了诚实性），未重采、未重训；外部清单的任务 1/3/4/5/6 未执行。


## 2026-09-23 App 与 CU-Lab 权重解离 + 外部交接包 + 真实 UI 语料缺陷

对应请求「解离 Newmark 的 App 与 culab 权重，在没有权重的情况下也能正常使用原本 CU 通道，
然后整理训练结果的数据表现为 zip 包，寻求外部帮助」。

### 一、App ⟂ 权重（已实现并门禁化）

| 文件/目录 | 变更与职责 |
| --- | --- |
| `DESKTOP/src/core/computerUse/model/artifactDiscovery.ts` | **新增**：App 自有权重点发现。显式 artifact → 用户级安装 → 仓库模型目录 →（仅设置 `NEWMARK_CU_LAB_ROOT` 时）CU-Lab 候选；对元数据进行 16D ABI 与晋级门禁预筛，兼容候选按来源优先，其次按晋级阶段与新旧排序。`selectCuModelArtifact()` 没有兼容候选时返回 `null`；最终文件完整性仍由 loader 校验。 |
| `DESKTOP/src/core/computerUse/model/artifactEligibility.ts` | **新增**：共享 App 侧快速兼容性判定；允许 App ABI 下的评估候选，晋级/发布阶段必须声明 detector 与 tracking 均通过。 |
| `DESKTOP/src/tests/computerUseEdgeModelInferenceVerify.ts` | 删除硬编码的 `../newmark-cu-lab/var/candidates`，改走 `artifactDiscovery`；无权重时打印被搜索过的路径并 SKIP（退出码 0）。 |
| `DESKTOP/src/tests/computerUseWeightlessVerify.ts` | **新增门禁（18 项）**：无权重时的发现语义（不抛异常、默认搜索表不含 lab、优先级、promoted 优先、缺失时 `CuArtifactLoadError(validate)`）；**无权重下的原始 CU 通道**（`uia-only` 不升级、禁止盲坐标、UIA 观测进契约、注册表仅凭几何跨帧续用身份、disabled provider 不伪造检测）；以及**源码级反耦合断言**：`src/`（除 `tests/`）不得出现 `newmark-cu-lab`。 |
| `DESKTOP/package.json` | `test:computer-use-runtime` 链加入 `computerUseWeightlessVerify`（现为 10 项）。 |

**实测**：无任何权重时整条 CU 运行时门禁链 **91 项全过 + 1 项显式 SKIP**；`node dist/tests/verify.js`
**1719/1719** 全过；权重在场时 `computerUseWeightlessVerify` 18/18、真实推理 11/11 仍全过。

### 二、外部交接包

本地归档（未纳入公开仓库）（0.77 MiB / 59 文件，
manifest 逐文件 SHA-256 校验通过）：README（双语，含要外部专家回答的 4 个问题）、HOW-TO-REPRODUCE
（每个数字的确切命令）、两份报告 + STATUS、训练记录（`run.json`/`stages.jsonl`/`telemetry.jsonl` 等）、
Lab 与 App 两侧全部评测 JSON、发货 artifact 的元数据（不含权重）、数据集 manifest、
一个**非退化** `scroll_global` 样本 clip（12 帧 + 精确框）与三套数据集一致性审计。

### 三、真实 UI 语料缺陷（本轮新发现，严重）

新工具 `newmark-cu-lab/scripts/audit_episode_motion.py` 逐 clip 对帧做 SHA-256，把**唯一帧数**与
`clips.jsonl` 声明的运动/事件对照：

| 数据集 | clips | frames | uniqueFrames | 重复帧率 | 静态 clip | 静态**且声明有运动** |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `dataset-v0.1-real-ui-holdout` | 60 | 720 | 275 | 61.8% | 29 | **24** |
| `dataset-v0.1-real-ui-v2`（训练） | 700 | 8,400 | 3,353 | 60.1% | 329 | **273** |
| `dataset-v0.1-tracking-v2`（合成） | 1,700 | 20,400 | 15,160 | 25.7% | 136 | **0** |

命中集中在事件类场景（`normal_translation` 76%、`stable_jitter` 96%、`disappear_reappear` 61%），
布局类（`resize_layout`/`scroll_global`/`short_occlusion`）0/280，**合成渲染器 0 命中** ⇒ 缺陷限于真实
WinForms 采集路径。后果：训练语料有效唯一帧只有 3,353/8,400；§9.2 的 `movingTargetContinuation`
"PASS"建立在 12/15 平移 episode 从未平移之上，`disappearanceDetection` 同批样本亦不可信；
而 App 侧身份层在**逐字节相同**的相邻帧之间仍产出 0 次 `CONTINUATION`，该结论因此更硬。
详见 `newmark-cu-lab/STATUS.md` §5bis-13 与 本地归档（未纳入公开仓库） F6。

边界：本轮**未**改动采集管线、未重采数据、未改动导出器与 App 校验器（上轮报告中的 INT8/门禁接线
三项修复仍待裁决）。


## 2026-09-23 CU 模型模块端到端识别评估：识别与运行双双未达标

对应请求「评估 culab 训练结果，接入 NewmarkCU 工作流评估是否达成预期识别效果」。首次把 CU-Lab 的产物装入
App 自有模型 loader/provider/decoder/registry 模块进行隔离联测（发货 `.nmep` INT8 → `onnxruntime-node` → `decodeNesTOutputs()`
→ `CuTemporalEntityRegistry`），用带精确真值的 CU-Lab 帧驱动。更正（2026-09-24）：此模块链没有接入当前 computer_use 生产工具，因此不是整机生产路径 A/B。评测结论：**没有达成预期识别效果**。

| 文件/目录 | 变更与职责 |
| --- | --- |
| `DESKTOP/scripts/verify-cu-workflow-recognition.cjs` | **新增**：App 工作流端到端识别评测。加载真实 `.nmep`、逐帧驱动生产 provider 与身份注册表，对真值框做 IoU 0.3 一对一贪心匹配，输出 recall/precision/meanIoU、尺寸分桶、稳定身份率/共享身份率、延迟 p50/p95 与 §9.1 门禁判决；`--profile` 拆分预处理/ORT/解码耗时；`--graph-override` 用于同帧 fp32↔INT8 单变量对照（只换图，manifest 与校验不动）。JSON 证据落 `var/probes/`。 |
| `DESKTOP/scripts/probe-cu-graph-latency.cjs` | **新增**：纯图延迟探针，使用与 App `inferenceSession.ts` 完全相同的 ONNX Runtime 选项，回答"慢的是图还是 App 代码"。 |
| 本地归档（未纳入公开仓库） | **新增**：完整报告 `REPORT.md` + `MANIFEST.json` + `evidence/`（App 路径 INT8/fp32 评测 JSON、Lab 检测/追踪日志、纯图延迟、两端门禁输出）。 |
| `newmark-cu-lab/STATUS.md` | 新增 §5bis-12（五条结论与待裁决动作）；§0 结论改为"识别与运行双双未达标"；D5/D7 按新事实更正（撤回"延迟已满足调度"的旧结论）。 |

**量出来的数字（全部可复现）**

| 路径 | recall(IoU 0.3) | precision | p50 延迟 |
| --- | ---: | ---: | ---: |
| Lab / PyTorch / GPU @0.2（复现既有） | 0.3369 | 0.2427 | 16.34 ms（GPU，batch1） |
| **App / 发货 INT8 / CPU（120 帧）** | **0.2359** | 0.1564 | **3,022 ms（0.33 fps）** |
| App / 同图 **fp32** 对照（同 120 帧） | **0.4157** | 0.2799 | **186 ms（5.4 fps）** |

**四条关键判读**

1. **动态 INT8 量化是纯亏**：同权重同帧同解码器，只换图 → 召回 −43% 相对、延迟 16.2×。
   体积收益真实（6.67 vs 26.4 MiB），但 25/100 MiB 两个体积门禁都不需要拿精度去换。
2. **没有门禁测过发货图的延迟**：Group D 报的 16.34 ms 是 PyTorch/GPU 的数字，与发货图在 App 侧的
   3,022 ms 相差约 185×；"5–20 Hz 调度"此前从未在发货产物上验证。
3. **身份层是安全失败但不可用**：1,503 个观测中 `CONTINUATION` 仅 12、`AMBIGUOUS_BLOCKED` 1,367，
   被检出≥2 次的真值控件**稳定身份率 0.0000**、共享身份率 0.0000（没有张冠李戴，但也没有身份连续性）。
4. **`INTEGRATION_CANDIDATE` 拒绝路径会留下产物，而且 App 会接受它**：导出器先写完整个 `.nmep`
   （manifest 已是 `INTEGRATION_CANDIDATE`）再抛错拒绝；App 的 `validateCuArtifact()` 不校验
   `manifest.benchmark.detectorPass|trackingPass`，于是这件被拒产物在 `13/13` ABI 校验与
   `11/11` 真实推理门禁上**全绿**。附带发现：`detector-eval.json` 是 last-writer-wins，
   导出候选的标定里 `threshold=0.2` 与 `measured.detectorRecall=0.0935` 来自**不同数据集**。

边界：App 侧 120 帧是**按 clip 顺序取自 `dataset-v0.1-real-ui-holdout` 的前 10 个 clip（未分层，
只含 5 类，缺 `stable_jitter` / `short_occlusion` / `scene_cut_false_association`）**，
因此纵向不可与 Lab 分层 120 帧直接互比；
本轮**未**修改导出器、App 校验器或任何训练代码——上述三条修复（停发动态 INT8、门禁接线、评测按数据集分文件）
均为待用户裁决项。


## 2026-09-22 dev-0.6.6 真实 UI 采集管线 + 高帧率/低存储 CU 运行时纪律

对应请求「优化训练集、以真实 UI 控制训练、按路线推进、确保高帧率与低存储下的正确 CU 指导」。仍是 Stage A（v0.1），未触碰 v0.2+。

| 文件/目录 | 变更与职责 |
| --- | --- |
| `newmark-cu-lab/nculab/capture/uia_playground.py` | **新增**：真实 WinForms 控件采集器。安全边界=只驱动自己创建的窗口、不发合成输入、结束即关进程。DPI 感知（`SetProcessDPIAware`）+ 窗口自报客户端矩形；每帧的 dumps 走**进程内** `RectangleToScreen`（0.36 s/帧），`capture_via_uia()` 是慢速 UIA 树审计路径（1.0 s/帧，实测 worst 归一化差 0.0093）；进程间 JSON 交接改为原子写（`.tmp` + `Move-Item -Force` 重试）。命令面：`move`/`moveControl`/`resize`/`scroll`/`hover`/`hide`/`show`/`page`/`overlay`/`dump`。 |
| `newmark-cu-lab/nculab/scenarios/windows_ui.py` | **新增**：真实 UI 时序 suite 生成器。4 套窗口模板（设置 / 列表工具栏 / 确认对话框 / 媒体控制，含 8–40 控件、含 22–26px 小控件与中文文案），§6.4 八类时序场景（含 overlay 遮挡、控件隐藏/重现、页面切换的 scene cut、三连相同按钮硬负样本），每 episode 随机布局抖动与配色；输出与合成生成器同 schema，`build_dataset` 原样可用。 |
| `newmark-cu-lab/nculab/cli/main.py` | `generate --suite windows-uia` 分派到真实采集（默认 synthetic 不变）。 |
| `DESKTOP/src/core/computerUse/frameStore.ts` | **新增**：有界帧存储——只保留最新帧 + 每 N 帧一个关键帧，按字节/帧数强制上限，中间帧立即丢弃；提供 `stats()`（保留字节、丢弃比例、关键帧数、最新帧延迟）。 |
| `DESKTOP/src/core/computerUse/perceptionRouter.ts` | 新增 `CuCadenceGate`：整帧推理的显式节流闸门（目标 Hz → 最小间隔），配合既有路由决策，保证 60 Hz 采集不会变成 60 Hz 推理。 |
| `DESKTOP/src/tests/computerUseHighMotionVerify.ts` | **新增门禁（5 项）**：60 Hz×10 s → 约 10 Hz 模型调用（601 帧→94 次）；32 MiB 预算内只留 32 帧/11 关键帧且丢弃 94.7%；全局平移判为 CONTINUATION 不铸新身份。已接入 `test:computer-use-runtime` 与 `test:desktop:built`。 |


## 2026-09-22 dev-0.6.6 CU-Lab 模型演进路线落地：NES-T v0.1 按代冻结 + GPU 训练

依据 `Newmark_CU_Lab_Frozen_Model_Roadmap_v1.0_20260921.md`（§12/§26/§28 严格按代推进）。本轮**只做 Stage A（NES-T v0.1）**，把 §29 要求的 "先让 v0.1 真正训练出来、tracking baseline 成立" 落到可执行状态；未实现 v0.2+ 的任何 head。

| 文件/目录 | 变更与职责 |
| --- | --- |
| `newmark-cu-lab/configs/nes-t-v0.1.yaml` | **新增**：v0.1 冻结配置（§5）。模型目标 8–10M/hard 15M、16D 描述子、768×432、pair/triplet + frame deltas [1,2,4,8]、§5 损失权重、AdamW 1e-4/3e-4、INT8 与 25/100 MiB 预算；`architecture` 段描述共享金字塔骨干。 |
| `newmark-cu-lab/nculab/cli/main.py` | **新增**：`GENERATION_CONFIGS` 与 `--generation`（`train --generation nes-t-v0.1`）；未实现代直接报错拒绝（"the roadmap forbids building a later generation before the previous exit gate passes"）；新增 `evaluate-detection`、`evaluate-system`、`size-check` 子命令（§23/§26/§21）。 |
| `newmark-cu-lab/nculab/models/edge_sensor/model.py` | **新增**：共享金字塔骨干（stem /4 → stages /8 /16 /32 /64 + 1×1 lateral + nearest 上采样融合 → 128 通道 /8 neck），heads 仍读 96×54 网格；`backbone_modules()/backbone_parameters()` 让优化器参数组与参数统计覆盖整条主干；`legacy_backbone` 保留旧 3-conv stem 以便历史 run 快照可复现。 |
| `newmark-cu-lab/nculab/models/edge_sensor/config.py` | **新增**：`stage_widths/stage_blocks/neck_channels/legacy_backbone` 与 `visibility_class_weights` 解析（`loss.visibility_class_weights`）。 |
| `newmark-cu-lab/nculab/training/runner.py` | 参数组按 `backbone_parameters()` 划分（主干 lr 1e-4 / 其余 3e-4）；可见性 CE 支持类别权重；修复 InfoNCE 目标张量固定在 CPU 导致 CUDA device mismatch 的缺陷。 |
| `newmark-cu-lab/nculab/evaluation/system.py` | **新增**：Group D system benchmark（§22/§23）——冷启动、batch 1/8 的每帧延迟 p50/p95、最大调用频率、cadence headroom、RSS、checkpoint 与 INT8 权重字节、artifact 上限，并显式标注 v0.1 尚无 ROI/cloud 调用。 |
| `newmark-cu-lab/nculab/export/size_check.py` | **新增**：`ncu-lab size-check`（§21）——按目录实测安装体积、逐条 entry 分解（最大几项）、manifest 声明值对比、hard/preferred 双门禁。 |
| `newmark-cu-lab/scripts/snapshot_dataset.py` | **新增**：数据集快照版本化（§14）——复制已有数据集到 `dataset-v0.1-tracking` 这类名字，写入 `snapshot{role,sourceDatasetId,generator,truthSource,labelSchema,splitHash}` 并注册到 SQLite；同名直接报错拒绝覆盖。 |
| `newmark-cu-lab/scripts/install-torch-cuda.cmd` | **新增**：安装 cu126 版 PyTorch 到实验室 venv（Stage A 的算力前提）。 |
| `README.md` / `taste.md` / 本地归档（未纳入公开仓库） | 同步记录路线对齐结论：按代冻结、参数带核对、GPU 前提、稀有类加权、每代必留 system benchmark 与 ablation。 |

### 2026-09-22 实测：三次训练迭代各自修掉的缺陷

| 迭代 | 结果 | 缺陷 |
| --- | --- | --- |
| 6k 步 / batch 8 / 顺序取样 | 验证 3.198，检测 recall≈0 | BatchNorm running stats 漂移（eval 峰值 0.396 vs batch-stat 0.560）；InfoNCE 目标张量固定在 CPU（CUDA device mismatch） |
| 4k 步 / batch 16 / 确定性 shuffle + 内置 BN 重标定 | 验证 **0.807**，BN before/after 一致 | 数据集是 episode 主序，连续样本近乎重复 → 批次内相关性强，模型"背批次" |
| 12k 步 / 60k 样本 / **多样化训练集**（进行中） | 静态阶段：独立留出集 recall 0.209@0.2（固定布局训练仅 0.0335） | 生成器布局不随 seed 变化 → 此前"留出集"不独立，指标被系统性高估 |

结论：当前 v0.1 泛化瓶颈在**数据多样性**（§9.3 第一优先），不是步数或容量；离 §5.1 的
0.95 召回门禁仍有很大差距，v0.2 未开始且被 CLI 拒绝。


## 2026-09-21 dev-0.6.6 Computer Use 主线：CU-Lab 数据/训练/量化导出 + App CU 运行时

指导文件为 `Newmark_CU_Master_Sequential_Execution_Guide_v1.0_20260921.md`（Phase 0–17）。本轮完成 Phase 2–8 的实质执行与 Phase 9–11 的 App 侧落地，执行记录见 本地归档（未纳入公开仓库）。

| 文件/目录 | 变更与职责 |
| --- | --- |
| `newmark-cu-lab/nculab/scenarios/browser_synthetic.py` | 新增模块级 `render_episode(payload)` 与 `generate_suite(..., workers=N)`：用 `ProcessPoolExecutor` 并行渲染，内容与串行路径逐一致（每 episode 种子仍为 `seed + index*13`）；20,400 帧从约 27 分钟降到约 2 分钟。 |
| `newmark-cu-lab/nculab/dataset/builder.py` | 负样本选择改为「同帧相似 → 同 clip → 有界全局池（`GLOBAL_POOL_LIMIT=20000`）」三级优先 + 按 `(frameId,entityId)` 去重，把原先随数据集增长的二次扫描降为线性；**修复**：被遮挡/消失的正样本不再被丢弃（新增 `targets.associationUsable`），visibility 头因此首次拿到遮挡/消失标签，§9.2 的 occlusion/disappearance 门禁也有了评测覆盖。 |
| `newmark-cu-lab/nculab/models/edge_sensor/config.py` | 解析并暴露执行预算与设备键：`precision`、`device`、`train_steps`、`train_samples`、`validation_every`（与 §8.1 冻结项分离）。 |
| `newmark-cu-lab/nculab/training/runner.py` | 设备解析（CUDA 可用即用，`NCU_DEVICE` 可覆盖）、AMP `GradScaler`、显式步数预算、每 `validation_every` 步的留出验证与平台早停、逐步 stdout 日志（loss/backbone grad/temporal grad/elapsed）；objectness 目标改为 CenterNet 式高斯热图，损失改为 penalty-reduced focal loss（§8.6 权重不变），`TargetBatch` 增加 `association_usable` 以跳过遮挡样本的关联监督。 |
| `newmark-cu-lab/nculab/evaluation/tracking.py` | 关联类门禁只统计 `associationUsable` 样本；遮挡/消失样本只进 visibility 门禁，避免「穿过遮挡物匹配」被当成正例。 |
| `newmark-cu-lab/nculab/export/nmep.py` | Phase 7 落地：模型先导出 fp32 ONNX（`run_dir/edge_sensor.fp32.onnx`），再用 `onnxruntime.quantization.quantize_dynamic` 量化成 `models/edge_sensor.onnx`，并做 fp32↔int8 parity（逐输出 max/mean abs diff、association cosine）；manifest 写 `quantization.mode = ptq-int8`（与 App 契约词表 `none|ptq-int8|qat-int8` 对齐），`artifact.budget` 用真实字节数而非参数量估算。 |
| `newmark-cu-lab/nculab/cli/main.py` | `generate --workers`、`train --steps`、`export --no-quantize`；训练日志行与 `db.log_event` 记录设备与步数。 |
| `newmark-cu-lab/configs/edge-sensor-nes-t-v0.1.yaml` | 新增执行预算段（`train_steps: 4000`、`train_samples: 6000`、`validation_every: 400`、`device: auto`），§8.1 的模型/损失/优化器/调度保持不变。 |
| `newmark-cu-lab/scripts/diagnose_objectness.py` | **新增诊断**：打印 objectness 分布、真值格得分与 train-mode 最大值，用于定位「检测头塌缩」。 |
| `DESKTOP/src/core/computerUse/sceneState.ts` | **新增**：SceneVersion 唯一推进点（`beginFrame`/`markDirty`）、`commit/current/entity` 全部返回深拷贝、`isStale()`、`targetableEntities()`（LOST 保留窗口）。 |
| `DESKTOP/src/core/computerUse/temporalEntityRegistry.ts` | **新增**：身份唯一真源。`S = w_d·S_desc + w_m·S_motion + w_g·S_geom + w_u·S_UIA + w_c·S_ctx` 融合评分、接受/不确定/拒绝三档阈值（§14 默认值）、贪心 1:1 分配、歧义 `AMBIGUOUS_BLOCKED` + 新身份、遮挡保留身份（`OCCLUDED`）、消失立即 `LOST`、超时老化 `LOST`，并输出 §25 遥测计数。 |
| `DESKTOP/src/core/computerUse/actionTransaction.ts` | **新增**：§19 状态机 + 确定性前置条件（sceneVersion、目标存活、CU 租约、权限、可交互度、工作区绑定、副作用未决）；`EFFECT_UNCERTAIN` 禁止自动重试，只有「执行前失败」可重试。 |
| `DESKTOP/src/core/computerUse/visionCapability.ts` | **新增**：四种能力态（uia-only / vision-assisted / vision-required / vision-unavailable）、结构化优先阶梯、`allowBlindCoordinateGuess: false` 与 `decideCuBlindCoordinateAction()`。 |
| `DESKTOP/src/core/computerUse/perceptionRouter.ts` | **新增**：逐帧感知路由；稳定结构化帧不调用模型、移动帧用本地模型、语义需求单飞升级云端并按冷却限速、`vision-unavailable` 一律 `cannot-act`。 |
| `DESKTOP/src/core/computerUse/grounder.ts`、`verifier.ts` | **新增**：陈旧场景拒绝对地、歧义返回 `ambiguous` 而不是挑最像的；验证区分 `SUCCEEDED / NO_CHANGE / EFFECT_UNCERTAIN`（只有后者要求重新观测）。 |
| `DESKTOP/src/core/computerUse/legacySenseProvider.ts` | **新增**：UIA-only 回退通路（UIA → `EdgeObservation`，无描述子），模型不可用时仍可运行链路。 |
| `DESKTOP/src/core/computerUse/model/artifactValidator.ts` | **新增**：App 侧自证 `.nmep`——自测安装体积、重算 `checksums.json`、校验 manifest（ABI/schema/阶段/16D 输出/晋级检测和追踪门禁/预算）、本体子集一致性，并报告每个拒绝原因。 |
| `DESKTOP/src/core/computerUse/model/modelArtifactLoader.ts` | **新增**：`validate → session` 两段式加载；验证失败或会话创建失败都抛 `CuArtifactLoadError`（带 stage 与 issues），绝不静默降级。 |
| `DESKTOP/src/core/computerUse/model/inferenceSession.ts` | **新增**：`onnxruntime-node` 会话封装（输入 `frame`，输出 7 个张量），并给出可用性探测 `cuInferenceAvailability()`。 |
| `DESKTOP/src/core/computerUse/model/edgeModelProvider.ts` | **新增**：provider 契约、RGB→NCHW 768×432 双线性预处理、NES-T 输出解码（sigmoid 物体度 + top-k、box 反 log、coarse type softmax、motion、visibility softmax、16D 归一化描述子），并派生 `matchConfidence`（帧内描述子可分性 × 物体度，明确标注为派生证据）。 |
| `DESKTOP/src/core/computerUse/model/stableEdgeModelProvider.ts`、`disabledEdgeModelProvider.ts` | **新增**：生产主路径与诊断路径；`health()` 报告 ABI/阶段/量化/后端/体积/阈值与推理计数。 |
| `DESKTOP/package.json` | 新增 `test:computer-use-runtime` 门禁链，把 CU 运行时门禁接入 `test:desktop:built`；`onnxruntime-node` 作为 optionalDependency（推理运行时，非训练依赖）。 |
| `DESKTOP/src/tests/computerUse*.ts` | **新增 7 个门禁**：`computerUseSceneVersionVerify`(8)、`computerUseTemporalIdentityVerify`(7)、`computerUseStaleActionVerify`(8)、`computerUseVisionCapabilityVerify`(7)、`computerUsePerceptionFallbackVerify`(13)、`computerUseEdgeModelArtifactVerify`(9)、`computerUseEdgeModelInferenceVerify`（真实 `.nmep` 推理 + hints 进 Registry）。 |


## 2026-09-21 dev-0.6.6 Auto 决策模型（JEV）三端编辑入口 + Auto 关闭冻结

| 文件/目录 | 变更与职责 |
| --- | --- |
| `DESKTOP/src/core/jevDecision.ts` | 新增运行时槽位契约：`JevRuntimeKind`（`local`/`onnx`/`native`）、`JevRuntimeDescriptor{runtime,modelId,modelPath}`、`normalizeJevRuntime/normalizeJevModelId/normalizeJevModelPath`、`createJevDecisionEngine()`（非 `local` 槽位返回 `null`，绝不静默替换）。`LocalJevDecisionEngine` 接受 `modelVersion`，把配置的决策模型标识写进每次路由审计。 |
| `DESKTOP/src/core/agent.ts` | 新增公开编辑器 API：`autoDecisionEnabled()`、`jevDecisionModelState()`（含 `autoEnabled/locked/lockReason/runtimeAvailable`）、`updateJevDecisionModel(patch)`（Auto 关闭时整笔拒绝 `auto_disabled`，非法值拒绝 `invalid_value` 且不落盘）+ 私有 `resolveJevDecisionRuntime()`。冻结语义：`evaluateAndSwitch()` 在 Auto 关闭或决策模型不可用时产出 `no_candidate` 且**保留**原 `resolvedDeployment`，不再清空后静默改用默认模型。 |
| `DESKTOP/src/core/routeDecisionValidator.ts` | 决策管线新增 `unavailablePolicy: 'fail' | 'configured_fallback'` 与 `unavailableReason`：用户关掉决策模型 / 槽位无适配器 ⇒ `fail`（不选、不改）；已部署但运行时故障 ⇒ `configured_fallback`（指南允许的确定性降级）。 |
| `DESKTOP/src/core/config.ts`、`DESKTOP/config.example.json` | 新增 `jev_runtime`、`jev_model_id`、`jev_model_path` 三个键（连同既有 `jev_enabled`/`jev_timeout_ms`/`jev_fallback_*`），构成 Auto 决策模型槽位的完整可编辑面。 |
| `DESKTOP/src/ui/index.html` | 新增 `#jev-decision-model-card`：标题/说明/锁定提示 + 8 个带 `data-jev-field` 的控件（enabled、runtime、model-id、model-path、timeout-ms、fallback-strategy、fallback-provider、fallback-model）、运行时状态行；新增 `window.setJevDecisionModel/applyJevDecisionModelState/refreshJevDecisionModel`；Auto 开关切换后自动刷新锁定态；中英双语 17 条文案。 |
| `DESKTOP/src/main.ts`、`DESKTOP/src/preload.ts`、`DESKTOP/src/server.ts` | 新增 IPC `agent:setJevDecisionModel`（返回 `{ok, reason, state}`，成功后把整槽 8 个键广播到 Electron Utility 与 WSL 运行时）；`getState` 与 `/api/state` 新增 `jevDecisionModel`。 |
| `TUI/src/settings-schema.js`、`TUI/src/state.js`、`TUI/src/render.js`、`TUI/src/i18n.js` | 新增设置分区 `[J] JEV decision model`（`settingsRows('jev')`：启用/运行时/超时预设/回退策略可循环，模型标识与产物路径为只读提示）；Auto 关闭时行值显示 `Locked (Auto off)` 并带 `LOCKED` 标记，Enter 只提示不改写；`state.settings.jev` 随权威快照刷新；中文标签补齐。 |
| `TUI/src/adapters/core-runtime-adapter.js` | `stateFields()` 暴露 `autoSwitchEnabled/autoSwitchScope/jevDecisionModel`；`applyConfig` 新增 `jevDecisionModel` 分支，直接走 `agent.updateJevDecisionModel()` 并在拒绝时返回 `{ok:false, reason}`。 |
| `DESKTOP/src/cli-commands.ts`、`DESKTOP/src/cli-discovery.ts` | 新增 `Newmark.exe jev` 命令（查看 + 编辑 + `--json`），帮助文本、值参数表与布尔参数表同步登记；Auto 关闭时编辑返回退出码 2 且不改配置。 |
| `DESKTOP/src/tests/jevModelEditorVerify.ts` | **新增门禁（24 项）**：槽位默认值、非法值不落盘、合法补丁落库、Auto 关闭时锁定与拒绝、Auto 关闭/决策模型关闭/槽位无适配器三种情况下不调用引擎且不改变已选模型；GUI/TUI 源码入口断言；真实 CLI 进程的查看/编辑/拒绝。 |
| `DESKTOP/scripts/dev-0.6.6-jev-settings-ui-monitor.cjs` | **新增视觉监控**：真实 Electron 渲染器 → Settings → Models & Providers，断言卡片与 8 个编辑位置的几何可见性、真实 DOM 编辑落库、Auto 关闭后整卡禁用 + 写入被拒、重新开启后解锁，输出 4 张截图与 `REPORT.json` 到 本地归档（未纳入公开仓库）。 |
| `DESKTOP/scripts/dev-0.6.6-jev-tui-cli-evidence.cjs` | **新增终端证据**：用生产适配器渲染 TUI 的 JEV 分区（Auto 开/关两份画面，含 `LOCKED` 状态）并抓取 CLI 的查看/编辑/拒绝输出，落盘为归档文本；已接入 `test:desktop:built`。 |

验收：`npm run dev:jev-settings-ui` 7/7 通过（截图见归档）；`npm run dev:jev-tui-cli-evidence` 7/7 通过；`node dist/tests/jevModelEditorVerify.js` 24/24 通过；`npm run test:auto-router` 与 `npm run test:desktop:built` 全绿（verify.js 1721/1721）。


## 2026-09-21 dev-0.6.6 Auto 路由重构：从自学习 AutoRouter 迁移到 JEV 确定性决策

| 文件/目录 | 变更与职责 |
| --- | --- |
| `DESKTOP/src/core/routeEligibility.ts` | **新增**：RouteEligibilityGuard，唯一权威的硬过滤实现（enabled / `unavailableReason` / provider scope / explicit subset / fallbackOnly / preview / context size / privacy / data region / required protocol parameters / hard cost ceiling）。只回答「谁能进入决策引擎」，不做任何打分，不读历史。导出 `deploymentKey`、`sameDeploymentRef`、`inAutoScope`、`inAutoSubset`、`expectedRequestCost`、`excludedOnlyForFallbackPool` 等共享原语。 |
| `DESKTOP/src/core/jevDecision.ts` | **新增**：JEV 决策契约与本地适配器。定义 `JevDecisionEngine` / `JevRouteRequest` / `JevCandidate` / `JevRouteDecision`（primary + ordered alternates + reasonCodes + modelVersion），`buildJevRouteRequest()` 把候选目录投影成「请求事实 + 显式用户配置 + 实时健康」，`LocalJevDecisionEngine` 用字典序（熔断降级 → 用户 `route_preference` → 模式目标 → 事务内上一部署平局续用 → 目录顺序）做确定性决策，`decideWithinBudget()` 提供硬超时，`resolveDeterministicFallback()` 提供 `configured_model` / `first_eligible` / `disabled` 三种确定性降级。**故意不含**：feedback、EWMA、quality_by_task、评分历史、工具结果学习。 |
| `DESKTOP/src/core/routeDecisionValidator.ts` | **新增**：`validateJevDecision()`（primary 必须在守卫集合内、alternates 去重/剔除越界、数量有界、部署身份完整）与 `buildRouteDecision()`，以及 Agent 与测试共用的唯一决策管线 `resolveAutoRouteDecision()`（guard → engine → validator → 可选事务 pin）。越界 primary 抛 `JevDecisionValidationError`，由管线转成确定性 fallback，而不是旧排序。 |
| `DESKTOP/src/core/autoRouter.ts` | **重写收缩**：只保留共享路由类型、`classifyRouteFailure()`、`classifyTaskClasses()`、`RouteExecutionController`（端点健康 + 熔断 + 事务 pin + provider-local 恢复阶梯）与审计哈希。**删除**：feedback Map、`recordFeedback()`、`clearLearnedPreferences()`、`learnedPreference()`、`qualityScore()`、`rankEligible()`、`rankCandidate()`、成本/速度/可靠性加权效用、cache affinity、switchThreshold。`RouteDecision` 升级为 `decisionSource` + `alternatives` + `jev{modelVersion,confidence?,reasonCodes,latencyMs}` + `fallbackReason` + `pinReason:'transaction'`。 |
| `DESKTOP/src/core/agent.ts` | `evaluateAndSwitch()` 改为调用 `resolveAutoRouteDecision()`；新增构造注入 `jevDecisionEngine`（默认 `LocalJevDecisionEngine`）；删除 `loadLearnedRouteFeedback()`、`recordRouteFeedbackFor()`、`recordObjectiveRouteResult()`、`recordRouteQualityObservation()` 与手动切模反馈；`rateActiveAutoRoute()` 只写 `routing/ratings.jsonl` 遥测（保留 stale/重复点击校验）；`clearLearnedModelPreferences()` 退化为删除旧 `feedback.jsonl` 与遥测；`autoRouteCandidates()` 不再填 `qualityByTask`，改为携带实时 `circuit` 与显式 `unavailableReason`（余额阻断）。 |
| `DESKTOP/src/core/agentKernelRunner.ts` | 工具客观后置条件不再进入模型偏好：`recordObjectiveRouteResult()` 调用删除，改为 `agent.recordRouteToolOutcome(objectiveResult)`（仅运行健康）。`toolResultObjectiveOutcome()` 保留为分类函数。 |
| `DESKTOP/src/core/config.ts` | 新增 `jev_enabled`（默认 true）、`jev_timeout_ms`（默认 100）、`jev_fallback_strategy`（默认 `configured_model`）、`jev_fallback_provider_id`、`jev_fallback_model_id`。`quality_by_task` schema 保留以兼容旧配置与降级回滚，运行时不再读写。 |
| `DESKTOP/src/core/performanceDiagnostics.ts` | 新增性能阶段 `jev_route_decision`，供 Auto 决策耗时观测。 |
| `DESKTOP/src/tests/jevDecisionVerify.ts` | **新增**：21 项契约门禁（primary/alternates、重复与越界剔除、空/无效 schema、跨 provider 越界、崩溃、超时、三种 fallback、输入不含历史字段）。 |
| `DESKTOP/src/tests/jevRoutingInvarianceVerify.ts` | **新增**：21 项不变量门禁（Test A–J：历史 feedback / quality_by_task / 点赞 / 手动切模 / 工具结果都不能改变 resolvedDeployment；守卫越界拒绝；超时 fallback；恢复不跨 provider；事务 pin；重复请求确定性）。 |
| `DESKTOP/src/tests/autoRouterVerify.ts` | **重写**：42 项守卫 / JEV 排序 / 健康与熔断 / 恢复阶梯 / 审计 / 「旧学习 API 已消失且源码中不存在」门禁。 |
| `DESKTOP/src/tests/autoRouteRatingVerify.ts` | **重写**：评分=遥测（不写 `quality_by_task`、不写 `feedback.jsonl`、不保存配置），并断言「踩过之后同请求重新路由结果完全相同」。 |
| `DESKTOP/src/tests/autoAgentIntegrationVerify.ts` | 增加构造注入 `FakeJevDecisionEngine` 的集成用例与「客观工具结果只进健康」断言。 |
| `DESKTOP/src/tests/modelRecoveryStressVerify.ts`、`DESKTOP/src/tests/providerIdentityVerify.ts` | 迁移到新管线（guard + JEV + validator）后继续保持 2000 轮配额路由、250 轮配置编辑、30 轮真实进程级 quota failover 与同名模型跨账号隔离全绿。 |
| `DESKTOP/src/tests/verify.ts` | Auto 用例改为断言 v2 语义（速度=最低延迟的合格部署、balanced/quality 不再有历史质量带、provider scope 仍锚定同一 provider）。 |
| `DESKTOP/scripts/release-dev010-features-smoke.cjs` | 打包态断言改查 v2 审计字段与三个新模块（`jevDecision.js` / `routeEligibility.js` / `routeDecisionValidator.js`）。 |
| `DESKTOP/src/ui/index.html` | 设置项文案由「自适应偏好 / 清空学习偏好」改为「Auto 反馈历史 / 清空 Auto 反馈历史」；👍/👎 语义改为反馈遥测，IPC 契约保持不变。 |
| `DESKTOP/config.example.json`、`DESKTOP/package.json` | 示例配置新增五个 `jev_*` 键；版本提升为 `0.6.6`；`test:auto-router`、`test:desktop:built`、(进而) `test:full-release` 纳入两个新门禁。 |

验证：`npm run test:auto-router` 全绿（autoRouterVerify 42/42、jevDecisionVerify 21/21、jevRoutingInvarianceVerify 21/21、autoAgentIntegrationVerify 33、autoRouteRatingVerify 18、providerIdentityVerify 10/10）；`npm run test:model-recovery-stress` 通过（edits=250 quotaRoutes=2000 nonQuotaGuards=500 chainedProcessFailovers=30）；`node dist/tests/verify.js` 1722/1722 通过；`npm run test:desktop:built` 全绿。

边界与保留项：`quality_by_task` 字段、旧 `feedback.jsonl` 文件与「清空反馈历史」入口都保留（不读、不写、不自动删除），以便降级回 0.6.5；本次不涉及固定模型路径、provider identity 保护、stream/副作用恢复边界、ComputerUse/会话分支逻辑。Auto 选择结果与 0.6.5 不同是设计结果：旧「质量带」本身就建立在被移除的历史质量之上。

`npm run test:full-release` 边界：desktop / intelligence-tier / TUI / mode-conversation-stress / cross-platform-env / SSH TUI stress / WSL TUI stress / CLI 全绿，**最后一段 `test:gui-tui-cli-stress` 仍失败**（`stress-cli-0 lost its provider reply`）。该夹具 `auto_switch: false`，JEV/Auto 路径不被调用；独立复现显示 CLI 子进程 stdout 正确返回 `REPLY_SURFACE_CLI_0` 且 exit=0，但工作区分片里该对话只有 user 消息、workRun 仍为 `running` —— 即终态没落盘。归因于工作区已有的未提交会话持久化改造（`agent.ts` 中 `done`/`error` 的 `saveWorkspaceConversationState(true)` 已改为 `(false)`，延迟写在短命 CLI 进程里没有机会落盘），属于并行进行中的 dev-0.6.6 存储工作，本轮未改动。


## 2026-09-17 dev-0.6.6 移动端**本地**对话归档卡顿（取证 → 修复 → 真机复测）

| 文件/目录 | 变更与职责 |
| --- | --- |
| `android/.../data/ConversationStore.kt` | `saveArchived()` 由 `archivedFile.writeText(gson.toJson(list))`（在主线程上调用的整文件同步重写）改为**流式序列化 + 暂存文件 + `fd.sync` + rename 原子替换**，并返回 `Result<Unit>`；顺带修掉「写一半被杀会把整份归档截断」「失败被静默吞掉」两个隐患。新增 `CONVERSATION_ARCHIVE_FAILURE_MESSAGE`。 |
| `android/.../vm/ChatViewModel.kt` | `archiveConversation()` 不再同步写盘；新增 `persistArchived()`：在 `LocalAgentForegroundService.launchRuntime { withContext(Dispatchers.IO) { … } }` 内写归档，并用 `archivedRevision` 做「最新状态优先」的合并（连续归档只写一次，旧快照绝不覆盖新快照），失败置 `error`。 |
| `android/.../vm/ChatViewModel.kt`（本轮追加） | ① `interruptLocalConversation(conversationId)`：把 `stop()` 的收尾抽成共用函数（取消 job、关闭 Guide 通道、移除 runtime、写入 `interrupted` 记录、排水）。② `archiveConversation()` **先立即打断**该对话正在跑的本地运行，再取最新快照归档 —— 不再把一条仍在写的工作留在列表之外。③ `persistArchived()` 由「失败即退出」改为**退避重试到成功**（500ms→1s→…上限 30s），成功清除错误位。 |
| `DESKTOP/scripts/dev-0.6.6-mobile-local-archive-soak.cjs` | 新增设备级监督门禁：`adb root` 播种 6 条活跃 + 120 条已归档（×300 条消息，含图片附件，55.4 MiB）本地对话 → 真实 UI 点「⋯ → 归档」→ 用 `dumpsys gfxinfo framestats` 的单帧耗时 + Choreographer 丢帧 + 归档文件落盘时刻判定。断言「行离开列表 / 有帧数据 / 单帧 < 250 ms / 无丢帧爆发」。 |
| `DESKTOP/scripts/dev-0.6.6-mobile-local-archive-surfaces.cjs` | 新增影响面监控：S1 启动期旧 `archived=true` 迁移、S2 连续快速归档（合并不丢写）、S3 归档"正在看"的对话、S4 冷启动持久性、S5 写入失败时旧归档字节不变、S6 **归档立即打断正在运行的本地轮次**（mock provider 流在点击后 1118 ms 被关闭、归档快照含 interrupted 记录）、S7 **写入失败自动重试到成功**（只读期间不落盘，恢复可写后自动落盘）。7 个场景 **29/29 PASS**（证据 本地归档（未纳入公开仓库））。 |
| 本地归档（未纳入公开仓库） | `REPORT.md` + 逐次运行证据（截图、UI dump、JSON 报告）。 |

实测（55.4 MiB 归档，同一台模拟器）：修复前**单帧阻塞 1386 ms**（>250 ms 帧 1 个），修复后 **171 / 178 ms**（两次复跑，>250 ms 帧 0 个），12.5 MiB 配置 185 ms；落盘时刻基本不变（说明写入只是搬到了 IO 线程）。归档文件内容核对：`archived.json` 121 条 `"archived":true`、活跃文件剩 5 条、被归档对话不再出现在活跃列表。
产物：`android/app/build/outputs/apk/release/app-release.apk`（76,134,350 bytes，SHA-256 `9FBA5145…BF2F`，已安装到模拟器）；`APK/Newmark-Agent-0.6.5-release.apk` 仍是修复前分发包，未替换。
回归：`gradlew :app:testDebugUnitTest` BUILD SUCCESSFUL；设备门禁（响应性 3 次 + 影响面 29/29）全 PASS；远端监督实测用新 APK 复跑 21/21。桌面端未改动。最新产物 SHA-256 `802AE95E…A520`（含打断+重试），`APK/Newmark-Agent-0.6.5-release.apk` 仍是旧分发包，未替换。

## 2026-09-17 dev-0.6.6 模拟器真实安装 + 监督实测（移动端归档）与后台侧修复

| 文件/目录 | 变更与职责 |
| --- | --- |
| `DESKTOP/src/core/electronUtilityRuntimePool.ts` | `snapshot()` 新增「拆解期只读」契约：目标处于 `disposing`/`restarting` 且调用方要的是默认窗口时，直接返回 `supervisorSnapshot(entry)`（缓存转录 + `runtime.running/stopRequested`），不再让 `acquire()` 抛 `... is stopping` 变成 HTTP 500；`supervisorSnapshot` 允许没有 `stopIntent`（归档强停只经过 disposing/restarting），`runId/generation` 回退到 entry 记录。请求更早历史页（`before`/非 200 窗口）仍照旧报错。 |
| `DESKTOP/src/core/wslAgentRuntimePool.ts` | 同一契约在两个后端池上对齐实现（WSL 池的 `acquire()` 有同样的 `is stopping` 抛错路径）。 |
| `DESKTOP/src/core/mobilePairing.ts`、`DESKTOP/src/server.ts` | 新增 `NEWMARK_MOBILE_PORT` 端口覆盖（默认仍是 47890）：`MOBILE_PORT` 与 server 的 `HOSTED_PORT` 共用同一来源，使第二个隔离实例可以在不占用生产端口、不打扰用户正在运行的实例的前提下托管已配对客户端。`const PORT = 47890;` 仍原样保留，既有隔离端口门禁的替换缝不变。 |
| `DESKTOP/scripts/dev-0.6.6-mobile-emulator-supervised.cjs` | 新增设备级监督脚本：临时 root 播种唯一标题的桌面对话 → 隔离端口起真实 Electron 主机（`NEWMARK_MOBILE_PORT`）→ 端口代理记录客户端全部请求 → `adb install -r` 安装 release APK → 深链配对 → 真实 UI 导航（侧栏→设备→工作区→对话）→ 发送永不结束的轮次 → 菜单点「归档」→ 逐步截图与计时 → 校验桌面归档载荷/索引/分片/无复活。 |
| `DESKTOP/scripts/dev-0.6.6-mobile-apk-string-probe.cjs` | 新增 APK 内容探针（解包后按字符串查证产物是否真的包含某段代码），用于回答「磁盘上的 APK 是否落后于源码」。 |
| 本地归档（未纳入公开仓库） | `REPORT.md` + 逐次运行的证据目录（截图、UI dump、客户端 HTTP 轨迹、桌面 stdout/stderr、JSON 报告）。 |

边界：未改移动端网络层（`MobileApiClient` 的 `readTimeout(0)` 是合约，不加上限）；未改版本号、未重新打包 MSI/APK 产物清单；设备实测在模拟器 `emulator-5554`（Android 15、`com.newmark.mobile` 0.6.5/605）上进行，用户正在运行的桌面实例（47890）全程未被触碰。实测结果：深链配对成功、永不结束的轮次由手机发出、电话端菜单点「归档」后 **5895 ms** 自行完成、载荷含该轮输入、索引与分片清干净、无复活；归档窗口内客户端每秒轮询全部 200（修复前全是 500）。回归：`verify.js` 1721/1721、`runtimePoolCapacityVerify` 27、`runtimeIsolationVerify`、`remoteTouchServerStatusVerify`、`test-hosted-command-transport` 37、`mobileWorkspaceApiVerify` 55、`test:archive-while-running` 13/13、`npm run test:desktop:built` **EXIT=0**。

## 2026-09-17 dev-0.6.6 归档契约：不加上限，改为「解放占用 + 并行归档」

| 文件/目录 | 变更与职责 |
| --- | --- |
| `DESKTOP/src/core/conversationKernel.ts` | `prepareForArchive(target, { releaseOccupancy })`：删除了上一轮加入的 `ARCHIVE_RUN_SETTLE_MS = 5000` 上限。现在先置 `preparingArchive`/`queuePaused`、取消 goal 续跑定时器、`abortActiveKernelRun('user_stop')`，随后**并行**启动调用方给的 `releaseOccupancy()`（常驻运行时强停）并 `await Promise.all([运行自身 settle, occupancyRelease])`；释放失败只记日志，不单独让归档失败。等待由**真实工作结束**终止，没有任何定时器预算。 |
| `DESKTOP/src/main.ts` | `archiveConversationForTarget`：常驻运行时强停**提前启动**（`occupancyRelease`），按持有者分流 —— 内核持有（Flow）走 `releaseOccupancy: () => occupancyRelease`；常驻运行时正在跑/正在停（`peekTargetRuntime`）时必须等这次强停完成再取快照；空闲则留在关键路径之外。内核 settle、占用释放、Flow `settlement` 三处等待合并为一次 `Promise.all`。 |
| `DESKTOP/src/core/agent.ts` | `archiveConversationAsyncUnlocked` 在克隆存储状态后，按 `Agent.CONVERSATION_SHARD_FIELDS` 从活条目读回被不可枚举访问器隐藏的载荷（分片布局下克隆会丢 `chatMessages`/`history`/`workRuns`/`tree`，导致「归档内存里没有的对话」写出空归档并删掉真转录）；`finalizeAsyncConversationArchive` 显式回收该对话的转录分片。 |
| `DESKTOP/src/tests/verify.ts` | 源码字符串门禁改为断言新契约（`occupancyRelease`、`occupancyMustSettle`、`const [mainArchiveOwner] = await Promise.all([`、`!ARCHIVE_RUN_SETTLE_MS`），并新增「内核绝不使用定时器预算」与「跨进程归档保留转录并回收分片」两条。`verify.js` 由 1718 → **1721** 条。 |
| `DESKTOP/src/tests/conversationArchiveRuntimeVerify.ts` | 「永不结束的运行不得扣住归档」改为三条更严格的断言：(a) 真实结束的运行**真的被 await**（1200 ms 的运行实测 await 1200+ ms）；(b) 只有释放占用才会结束的等待**由释放结束**（实测 0–1 ms）；(c) 不释放时归档**一直等**（2500 ms 仍在等）。另加跨进程归档用例（第二实例归档分片条目 → 载荷完整、manifest 2 条消息、分片回收）。 |
| `DESKTOP/scripts/dev-0.6.6-mobile-archive-affected-surfaces.cjs` | 新增影响面监控脚本：复用延迟取证夹具，在隔离端口起真实 `dist/server.js` 打真实 HTTP（暂停 goal / 暂停 Flow 归档、分支创建与激活、以及「真正在跑」对照组），再在进程内驱动内核归档等待。600 轮与 1500 轮两次运行均 **15/15**。 |
| `DESKTOP/scripts/verify-archive-while-running.cjs` | 新增真实 Electron + CDP 用户级门禁（npm `test:archive-while-running`）：mock provider 的 SSE 永不结束 → 轮次运行中点归档。断言行离开列表、provider 流被真正取消、载荷含该轮输入、索引无该对话、分片已回收、4 秒内无复活；再加「空闲归档仍是快路径且载荷完整」对照。**13/13 PASS**（运行中 5600 ms、空闲 262 ms）。 |
| 本地归档（未纳入公开仓库）、本地归档（未纳入公开仓库） | `REPORT.md` + `evidence/`（影响面日志、`verify.js`、完整 `test:desktop:built` 日志、用户级门禁 JSON）。同日修订了 本地归档（未纳入公开仓库） 中被取代的上限说明。 |

边界：未改 `claimBuild` 准入语义、未改移动端网络层（`readTimeout(0)` 仍是独立 UX 议题）、未重新打包/安装；版本仍 `0.6.5`。回归：`verify.js` 1721/1721、`conversationArchiveRuntimeVerify`（48 并发归档 + 跨进程归档 + 三条等待断言）、`conversationArchiveConcurrencyVerify` 19、`mobileWorkspaceApiVerify` 55、`test-hosted-command-transport` 37、`test-shared-conversation-commands` 51、`test:archive-while-running` 13/13、`npm run test:desktop:built` **EXIT=0**。

## 2026-09-16 dev-0.6.6 诊断与探针：保留在源码、绝不进包体

| 文件/目录 | 变更与职责 |
| --- | --- |
| `DESKTOP/src/core/memoryProbe.ts` | 运行期内存探针本体（env 门控 `NEWMARK_MEMORY_PROBE=1` + `NEWMARK_MEMORY_PROBE_FILE`）：每 2s 记 RSS/heapUsed/external/arrayBuffers 与宿主投递事件数/字节，RSS 超阈值自动 `writeHeapSnapshot`。**仅存在于源码**。 |
| `DESKTOP/src/core/hostRuntimeHooks.ts` | 打包用的**中性空实现**（同 `installHostRuntimeHooks()` 签名，全部 no-op）。文件名与导出名都不含探针字样，因此成品 bundle 内既无探针能力也无探针命名。 |
| `DESKTOP/src/conversation-utility-host.ts` | 改为 `installHostRuntimeHooks({ root })` 并只在 `post()` 里调用 `hostHooks.countPosted(value)`；具体实现由构建期决定。 |
| `DESKTOP/scripts/build-conversation-utility-host.cjs` | 新增 `--strip-diagnostics`（或 `NEWMARK_STRIP_DIAGNOSTICS=1`）：esbuild 插件把探针模块解析为空实现；另支持 `NEWMARK_UTILITY_HOST_OUTFILE` 供门禁构建到临时文件（不污染 `dist/`）。改用异步 `build()`（`buildSync` 不支持插件）。 |
| `DESKTOP/scripts/dist-portable.cjs` | 打包前**强制**以剥离模式重建 utility host bundle；打包后调用 `assertNoDiagnosticsInPackage()`：`app.asar` 不得含 `dist/tests` 条目、不得含探针模块，host bundle 不得含 `NEWMARK_MEMORY_PROBE`/`writeHeapSnapshot`/`host-memory.jsonl`/`installHostRuntimeHooks` 等标记。 |
| `DESKTOP/scripts/verify-package-no-diagnostics.cjs` | 独立门禁（npm `test:package-no-diagnostics`）：静态校验 `build.files` 排除项、以临时输出跑一次剥离构建并断言零标记、校验 `src/core/memoryProbe.ts` 仍在源码、若存在 `app.asar` 则校验其中无 `dist/tests` 与探针。 |
| `DESKTOP/package.json` | `build.files` 增加 `!dist/tests/**/*`（0.6.5 包体里实际含 342 个编译测试条目）与 `!dist/core/memoryProbe.*`、`!dist/core/hostRuntimeHooks.*`；新增脚本 `build:strip-diagnostics`、`test:package-no-diagnostics`。 |
| `DESKTOP/scripts/dev-0.6.6-host-memory-probe.cjs`、`dev-0.6.6-heapsnapshot-top.cjs`、`dev-0.6.6-memory-soak.cjs`、`dev-0.6.6-visual-materialization-measure.cjs`、`dev-0.6.6-live-conversation-forensics.cjs`、`dev-0.6.6-replay-live-ledger-recovery.cjs` | 诊断脚本集合，全部位于 `scripts/`（electron-builder 不收集该目录，仅 `extraResources` 收集安装脚本），因此天然不进包体。 |

验证：剥离构建后 host bundle 的 `NEWMARK_MEMORY_PROBE`/`writeHeapSnapshot`/`host-memory.jsonl`/`memoryProbe`/`heapsnapshot` 标记计数全为 0，而 dev 构建仍为 3/1/1/1（源码保留）；用**剥离版 bundle** 跑真实 Electron 门禁 `verify-background-question-hold` 通过（`passed: true`），证明剥离不改变运行行为。`test:package-no-diagnostics` 当前唯一 FAIL 是历史 0.6.5 成品 `app.asar` 里仍带 342 个 `dist/tests` 条目——该产物早于本策略，重新打包即被排除。

## 2026-09-16 dev-0.6.6 ComputerUse/BrowserControl 视觉内存阈值（按可用内存自适应）

| 文件/目录 | 变更与职责 |
| --- | --- |
| `DESKTOP/src/core/conversationVisualBudget.ts` | 新增视觉内存预算策略：按**可用内存**（`os.freemem()`）分 roomy/tight/critical/severe 四档（单图上限 2 MiB→160 KiB、单请求可视上限 48 MiB→2 MiB、上下文保留截图 ≤12→≤1 张、会话可视总量 192 MiB→8 MiB、空闲宿主 RSS 回收线 1536→384 MiB），并被**总内存**夹紧（4 GiB 机器拿不到 roomy）；宿主自身 RSS 达本档回收线 60% 时**再升一档**（V8 是在自己的堆上 abort）；最新一张截图只要不超单图上限就始终保留。附 `planVisualRetention()` / `visualDataUrlBytes()` / `shouldRecycleIdleHost()` / `describeVisualBudget()`。 |
| `DESKTOP/src/core/visualDownscale.ts` | 新增截图降采样：PNG 优先，仍超限则转 JPEG，最多 4 轮；遇到不可解码负载返回 null 由调用方走原路径。用于在内存紧张时**保住视觉能力**而不是丢弃截图。 |
| `DESKTOP/src/core/agentKernelRunner.ts` | ① `visualFallbackImageInput` 的固定 2 MiB 单图上限改为当前预算并配合降采样；② 新增 `materializeVisualImagePart()`（路径/内联统一按单图上限降采样）；③ `fromKernelMessages(messages, includeEphemeralImages, visualBudget, onVisualRelease)` 每请求按「最新优先」规划保留截图，预算外的历史截图不再物化 base64，并以 `[visual_memory_budget]` 说明告知模型可重新观察；释放量经节流工作状态行上报。 |
| `DESKTOP/src/core/electronUtilityRuntimePool.ts` | 新增 `sampleProcessMemoryBytes` / `visualBudget` 选项、`hostOverMemoryBudget()` 与 `reclaimIdleHostsOverMemory()`：空闲宿主 RSS 超过机器档位回收线时被回收（而非复用），下次从干净进程开始。 |
| `DESKTOP/src/main.ts` | 以 `app.getAppMetrics()` 的 `workingSetSize`（KB→bytes）为运行时池提供宿主 RSS 采样。 |
| `DESKTOP/src/tests/conversationVisualBudgetVerify.ts` | 新增 33 项断言（npm `test:visual-budget`，已接入 `test:desktop:built`）：档位与总内存夹紧、RSS 升级、保留计划（字节+张数、释放统计）、回收线、真实大图降采样到 96 KiB/32 KiB、不可解码拒绝、12 张历史截图只物化最新 2 张并补释放说明、零预算退化为纯文本、真实 `visualFallbackImageInput` 不超当前单图上限。 |
| 本地归档（未纳入公开仓库） | `REPORT.md`：阈值表、执行点、证据（现场 OOM 3017 MB / 本机 31.12 GiB 总 13.38 GiB 可用 / 实测单张观察图 65,665 字节）与未决说明。 |

边界：只回收**可视材料**与**空闲宿主**；不改文本、工具结果、计划、转录与模型上下文预算；被释放的只是“更早请求里已经发过”的历史截图，最新一张始终保留（必要时降采样）。回归：`verify.js` 1717/1717、`conversationVisualBudgetVerify` 33、`computerUsePerformanceVerify`、`screenCaptureIndependentVerify`、`browserUseVerify` 93、`runtimePoolCapacityVerify` 27、`runtimeIsolationVerify`、`runtimeMemoryBudgetVerify`、真实 Electron 门禁 `verify-queue-sequencing-and-drag-landing` 23/23。

## 2026-09-16 dev-0.6.6 真实对话取证与「崩溃不再卡死」的持久性加固

| 文件/目录 | 变更与职责 |
| --- | --- |
| `DESKTOP/scripts/dev-0.6.6-live-conversation-forensics.cjs` | 新增只读取证工具（npm `forensics:live-conversation`）：解析真实 `conversations/state.json` 与 `continuation-ledger.json`，输出对话/队列/work run/guard/attempt/事件与异常清单。真实对话 `conv-1789533845556-2`（history=483、finals=0）实测出「RUNNING build + guard 指向已死 PID + 租约过期 + 残留 DEPENDENCY_FAILED」。 |
| `DESKTOP/scripts/dev-0.6.6-replay-live-ledger-recovery.cjs` | 新增回放/修复工具（npm `repair:ledger-orphan`）：默认把真实账本复制到临时工作区回放孤儿回收（7/7 通过）；`--apply` 在**确认没有 Newmark Agent 进程**后，先写 `<ledger>.repair-<时间戳>.bak` 再回收孤儿 attempt（进程在跑时拒绝执行，避免被老逻辑重写覆盖）。 |
| `DESKTOP/src/core/continuation/store.ts` | ① 终态写入的归属判定改为**按 attempt 身份 + fence**，不再因租约过期拒绝活着的所有者（真实现场：34 分钟回合的 `commitFinal` 被判 `Attempt … no longer owns branch`，导致 `finals=0`）；② 新增 `recoverOrphanedAttempt()`（死所有者/长期过期/悬空 guard → attempt=EXPIRED、RUNNING build→QUEUED、释放 guard、写 `AttemptOrphanRecovered`）；③ `reanchorQueuedChainUnlocked()` 由显式修复与孤儿回收共用，并清除不再成立的 `DEPENDENCY_FAILED` 残留；④ 每次成功写入后保留 `.bak`，主账本截断/损坏时自动恢复并留 `.corrupt`。 |
| `DESKTOP/src/core/conversationKernel.ts` | ⑤ 排队回合执行期间按 `leaseRenewalMs`（20s）续租心跳；⑥ `settleLedgerScope()` 幂等结算 + `.finally` 兜底，任何退出路径都不再把 scope 留在 RUNNING；⑦ `maybeRecoverOrphanedAttempt()`（`kernel:<pid>` 判活 + 120s 宽限 + 5s 节流）在运行时创建、每次状态投影、每次入队时回收，并在队列未暂停时重新触发排水。 |
| `DESKTOP/src/ui/index.html` | ⑧ `reconcileLocalRuntimeFromSnapshot()` + 15s 看门狗：权威快照说 idle/completed/interrupted 而本地仍认为在跑时清掉幻影运行态（修复「时间戳一直在走但没有工作、输入被当 Next 排队」）；⑨ 持久化遗留的 `running` work run 只有在后端确实报告在跑时才恢复运行态，否则本地按 `interrupted` 关闭。 |
| `DESKTOP/src/tests/queueOrphanRecoveryVerify.ts` | 新增 21 项断言并接入 `test:desktop:built`：长回合跨过原租约仍能提交终态；死所有者被回收后队列继续按序执行；活着的所有者不被抢占；悬空 guard 可释放；截断账本从 `.bak` 恢复；回收写审计事件。 |
| 本地归档（未纳入公开仓库） | `REPORT.md` + `ledger-report.json`（真实账本取证）+ `live-ledger-recovery-replay.json`（真实账本回放 7/7）。核心事实链：60s 租约无心跳 → 长回合终态被拒 → `finals=0`；utility host V8 OOM（exit 4294930435，3017MB）崩溃 → attempt 永远 RUNNING → 排队进入但永不执行。 |

边界：未改 `claimBuild` 准入语义与失败前置阻断契约；未删除账本历史；未修 3GB V8 OOM 本身（内存问题另案）；版本仍 `0.6.5`，未打包、未安装。回归：`verify.js` 1717/1717、`queueOrphanRecoveryVerify` 21、`continuationStoreVerify`、`queueBlockedRepairVerify`、`queueUnifyStressVerify`、`queueDrainUserMessageVerify`、`branchPageQueueIdentityVerify`、`runtimePoolCapacityVerify`、`runtimeIsolationVerify`、`conversationArchiveRuntimeVerify`、`test-long-conversation-ui-ordering` 18/18、`test-ui-consistency`、`mode-conversation-state-stress`、`pcGlassMigrationVerify`，以及真实 Electron 门禁 `verify-queue-sequencing-and-drag-landing` 23/23、`verify-background-question-hold`、`verify-fixed-control-centering`。

## 2026-09-16 dev-0.6.6 正常排队误标“前置阻断”、对话拖动落点与轮次增长卡顿

| 文件/目录 | 变更与职责 |
| --- | --- |
| `DESKTOP/src/core/continuation/store.ts` | ① `blockedQueuedBuildIds()` 把 **RUNNING** 行纳入链行走：正在执行的那一轮状态是 RUNNING 而非 QUEUED，旧实现漏掉它，导致「父正好是这一轮」的正常排队行被推导为 `DEPENDENCY_FAILED`，且其后每一行跟着受累；现在只有父不是链上前驱、或父已 FAILED/CANCELLED 的 QUEUED 行才判受阻。② `ensureRoot()`/`ensureBranch()` 在 root/branch 已存在时直接返回，不再写整份账本。③ 新增只读投影 `queuedBlockedReasons()`（只遍历排队行，不物化 snapshot、不深拷贝 build input）。 |
| `DESKTOP/src/core/conversationKernel.ts` | ① 按 `workspace::rootId::branchId` 缓存 `GuardedContinuationStore`（读路径仍按文件指纹校验缓存，跨进程写入依然可见），队列投影不再每次重新构造并解析账本；② `queueItems()` 改用 `queuedBlockedReasons()`。 |
| `DESKTOP/src/ui/index.html` | ① 新增 `conversationRowOrderDuringDrag()`：拖动持有期间以 DOM 现序为准，只把新出现的会话行按 state 位置补进去；`renderConversations()` 用它落位，权威列表推送不再抹掉用户让出的落点。② `commitConversationDomOrder()` 在 DOM 与 state 成员不一致时以 DOM 顺序为准、缺失会话补末尾后提交，不再整表重渲染放弃拖动。③ 转录渲染的「消息是否属于已持久化 work run」判定改用 `persistedRunIdSet` 查表，去掉每消息一次 `persistedRuns.some()` 的 O(轮次²) 扫描。 |
| `DESKTOP/src/tests/continuationStoreVerify.ts` | 新增 8 条断言：正在执行的回合之后两行排队都不得带 `DEPENDENCY_FAILED` 且仍不可 claim；真实失败仍阻断整条后继链；显式修复后整条链清空且首行可 claim；既有 root/branch 的 `ensureRoot()` 零写入、新 root/branch 仍落盘。 |
| `DESKTOP/scripts/verify-queue-sequencing-and-drag-landing.cjs` | 新增真实 Electron 门禁（mock provider + CDP，npm `test:queue-sequencing-and-drag-landing`）：长回合运行中经 `queue_enqueue` 排三行 → 面板三行可见、无 `data-queue-blocked`、后端投影无 `waitingReason`；三行按提交顺序依次执行且都在长回合结束后开始；拖动越位后注入权威列表推送 → 落点保持、松手落在让位处并持久化；反证控制组还原旧行为证明推送确实会抹掉落点；640 条消息转录渲染耗时、12 个连续回合每轮耗时（356 ms → 362 ms，无轮次劣化）与零渲染器错误。24/24 PASS，evidence=本地归档（未纳入公开仓库）。 |
| `DESKTOP/scripts/dev-0.6.6-ledger-growth-measure.cjs` | 账本增长与投影成本诊断（npm `dev:ledger-growth`）：每轮 final ≈1.4KB 时，400 轮账本 2514 KiB，一次投影 35.1 ms（修复前，整文件写）→ 12.4 ms（首次读）/ 0.44 ms（稳态读）。 |
| 本地归档（未纳入公开仓库） | `REPORT.md` + `evidence/`（门禁 JSON、运行中队列截图、拖动落点截图）。 |

边界：不改 `claimBuild` 准入语义（仍只认「父 = 已提交 frontier」），失败前置继续阻断后继、必须显式修复；不删除账本历史 build/attempt/final；版本仍 `0.6.5`，未打包、未安装、未发布。回归：`verify.js` 1717/1717、`continuationStoreVerify`、`queueBlockedRepairVerify`、`queueUnifyStressVerify`、`queueDrainUserMessageVerify`、`queueAttachmentIsolationVerify` 57/57、`branchPageQueueIdentityVerify`、`test-queue-continuation-identity` 61/61、`test-queue-acceptance-boundary` 109/109、`test-queue-start-failure` 40/40、`test-shared-conversation-commands` 51/51、`test-long-conversation-ui-ordering` 18/18、`pcGlassMigrationVerify`、`conversationBranchStressVerify`、`mode-conversation-state-stress`。

## 2026-09-16 dev-0.6.6 后台对话 question 的 hold 与回显修复

| 文件/目录 | 变更与职责 |
| --- | --- |
| `DESKTOP/src/ui/index.html` | `renderChatMessagesUnsafe()` 新增 `state.renderedChatTargetKey`（记录当前占据 `#chat-area` 的对话）；`applyConversationSnapshot()` 在 `syncQueueItemsFromSnapshot()` 写完 per-target 投影之后，若该目标是当前关注对话且仍占据屏幕转录，则用同一投影源 `state.pendingOptions` 重绘一次选项块。修复「Build 以 question 结束时用户正关注其他对话，返回后问题既不 hold 也不展示」；owner 契约与作答后的乐观清空不变。 |
| `DESKTOP/scripts/verify-background-question-hold.cjs` | 新增真实 Electron 门禁（npm `test:background-question-hold`）：mock provider 按真实 runtime 顺序 `tool_provision → question`，在问题落地前切到新对话，断言「不泄漏进当前对话」「返回后恰好一个被 hold 的问题块、owner 正确」「仍可作答并继续 Build」「单份携带问题的快照必须画出选项块（确定性复现顺序缺陷）」「已作答问题不会因离开再返回而复活」。18/18 PASS。 |
| 本地归档（未纳入公开仓库） | `REPORT.md` + `evidence/`（门禁 JSON、B 中无泄漏截图、返回 A 后被 hold 的问题截图、CDP 时序轨迹） |
| 本地归档（未纳入公开仓库） | A/B 反证：临时移除重绘块后同一门禁的「单份快照」断言失败（`blocks=0`），证明门禁有判别力。 |

边界：只调整渲染器排布顺序与屏幕转录归属标记；不改后端 pendingOptions 生命周期、owner 校验与作答路径；不涉及版本号提升（仍 0.6.5），不打包、不安装、不停止进程。回归：`dev-0.6.4-option-owner-check`、`pcGlassMigrationVerify` 57 项、`test-renderer-conversation-commands` 57/57、`test-conversation-history-window` 39/39、`test-long-conversation-ui-ordering` 18/18、`test-ui-consistency`、`verify-fixed-control-centering` 24/24 全部通过。

## 2026-09-16 dev-0.6.6 左栏固定玻璃控件内容居中修复

| 文件/目录 | 变更与职责 |
| --- | --- |
| `DESKTOP/src/ui/index.html` | 在通用堆叠兜底规则 `.liquid-selection-float > :not(.liquid-selection-canvas)` 之后新增同特异度、更后来源顺序的 `.liquid-selection-float > .liquid-fixed-control-content, .liquid-selection-float > .conversation-drag-content { position: absolute; }`。修复 PC 左侧栏底部固定控件（`#left-ws-add`「+ 新建」、`.left-collapse-btn`，连同同一桥接器覆盖的 `.sec-btn`/`.right-open-btn`/`.shell-btn`/`.option-btn`/`.stack-icon-btn`/`#submit-btn`）按下时被玻璃浮块接管后内容左顶格的问题，并同时修复对话拖动浮块 `inset:9px` 丢失。仅覆盖 `position`，不动浮块几何/动画/材质与命令派发。 |
| `DESKTOP/scripts/verify-fixed-control-centering.cjs` | 新增真实 Electron 渲染器门禁（npm `test:fixed-control-centering`）：同一构建内先注入等价旧声明复现缺陷帧、再移除取修复帧，按住控件比较承载内容盒与浮块盒中心偏移；同时断言按下期间玻璃浮块可见且源按钮保持 `liquid-fixed-source-covered`、松手无残留浮块、每次按压只派发一次点击、真实折叠提交后左栏宽度 48px、渲染器零错误。 |
| 本地归档（未纳入公开仓库） | `REPORT.md` + `evidence/`（before/after 截图、左右对照图、门禁 JSON）。实测中心偏移：`#left-ws-add` −62.98px → 0，`.left-collapse-btn` −88.50px → 0。 |

边界：不涉及版本号提升（`VERSION`/`DESKTOP/package.json` 仍为 0.6.5），不打包、不安装、不停止进程；`DESKTOP/dist/ui/index.html` 由 `node scripts/build-ui-icons.cjs` 重生成且 style 块与 src 逐字节一致。既有失败 `scripts/dev-popup-direction-regression.cjs`（弹窗外部材质条纹背景模糊判定）已用 A/B 还原验证为与本次修复无关。

## 2026-09-15 弹窗及模型配置增量

`android/ui/ChatScreen.kt`（完整路径见报告）管理返回项和选中滚动；`RightSidebar.kt` 使用外扩按钮画布；`SettingsScreen.kt` 增加供应商模型编辑导航；`vm/ChatViewModel.kt` 按供应商身份重命名。`Dev065PopupModelsTest.kt` 提供触控/视觉门禁，PC `src/ui/index.html` 分离模型字段及稳定身份，`scripts/dev065-model-settings-visual.cjs` 验证实际配置路径。本地归档（未纳入公开仓库） 存放截图、报告与日志。目标是交互稳定且配置不跨供应商。


## 2026-09-15 dev-0.6.5

目标：降低低内存电脑会话驻留开销，保持历史、分支与队列身份正确。文件树增量：`DESKTOP/src/core/runtimeMemoryBudget.ts` 提供物理内存策略，由两类 RuntimePool 消费；`DESKTOP/src/ui/index.html` 限制消息快照和防止过期绘制；`DESKTOP/src/tests/runtimeMemoryBudgetVerify.ts` 覆盖预算边界；`DESKTOP/scripts/test-dev065-renderer-memory.cjs` 覆盖缓存与导航；`DESKTOP/scripts/dev-0.6.5-real-queue-deepseek.cjs` 锁定真实部署验收。本地归档（未纳入公开仓库） 保存报告、文档原始快照和门禁日志；本地归档（未纳入公开仓库） 保存真实模型证据/截图。其余目录作用保持下方记录。


## 2026-09-10 dev-0.6.4 hotfix 受阻队列修复与显示规则

| 文件/目录 | 构造与作用 |
| --- | --- |
| `DESKTOP/src/core/continuation/store.ts` | `blockedQueuedBuildIds()` 按父链推导受阻排队行（父不是链上前驱、或父已 FAILED/CANCELLED 即为受阻，受阻点之后的行同样受阻），`snapshotUnlocked()` 据此补全 `waitingReason`，使“失败之后才入队”的行也可见；`repairBlockedQueue()` 把受阻行重新挂到已提交 frontier（顺序不变，逐条写 `BuildQueueRepaired` 审计事件）。 |
| `DESKTOP/src/core/continuation/contracts.ts` | `ContinuationEvent` 新增 `BuildQueueRepaired` 事件类型。 |
| `DESKTOP/src/core/conversationKernel.ts` | 新增队列动作 `repair_blocked`（`repairBlockedQueueNow`，仅用户显式触发；修复后发布状态并调度队列）；`queueItems()` 把账本受阻原因带进投影（`waitingReason`/`blocked`）。恢复动作本身不改挂任何行，保持 0.6.3「失败前置继续阻断、不静默跳过」的合约。 |
| `DESKTOP/src/main.ts` | 队列动作白名单加入 `repair_blocked`。 |
| `DESKTOP/src/ui/index.html` | `setQueueItemsForTarget` 保留 `waitingReason`/`blocked`；受阻行标记 `data-queue-blocked`；队列头部在存在受阻行时渲染「修复受阻队列」按钮（`#queue-repair-btn` → `window.repairBlockedQueue()`）；删除内联「排队中」用户气泡（`renderPendingQueuedUserMessages` 及相关样式），排队内容只显示在队列面板；`renderPendingGuideMessages` 只渲染 accepted/applied 的 Guide（awaitingAck、deferred、rejected 不进入对话区）。 |
| `DESKTOP/src/tests/queueBlockedRepairVerify.ts` | 复现用户账本形状（失败 → DEPENDENCY_FAILED → 失败后入队同样受阻 → claim 返回 null），验证修复后顺序 SUCCEEDED、审计事件内容与数量、健康队列幂等。 |
| `DESKTOP/scripts/dev-0.6.4-queue-resume-e2e.cjs` | 真实内核 + UI 端到端门禁（mock provider）：暂停 → 入队失败行 → 恢复并失败 → 再入队两行（受阻可见 + 修复按钮出现）→ 显式修复 → 恢复 → 队列清空，账本 `seq1:FAILED seq2:SUCCEEDED seq3:SUCCEEDED`。 |
| 本地归档（未纳入公开仓库） | 根因证据（真实账本）、修复说明、门禁结果、打包哈希与「安装待一次 UAC 确认」的边界。 |

## 2026-09-10 dev-0.6.4 分支分页身份、排队可见与 Guide 只读

| 文件/目录 | 构造与作用 |
| --- | --- |
| `DESKTOP/src/core/branchIdentity.ts` | 唯一的分支身份规则：`branchConversationIdentity(conversationId, branchNodeId)` = `<conversationId>::branch:<branchNodeId>`；`branchCacheScopeKey` 为工作区级分支缓存作用域；`assertFreshBranchIdentity` 保证新分页不复用既有节点 id。 |
| `DESKTOP/src/core/agent.ts` | `branchConversation`（用户分页与 `branch_create` 工具共用的事务）在写入新节点前断言全新 id；新增 `activeWorkRunBranchId()` 与 `branchConversationIdentity()`；压缩归档作用域 `compressionArchiveScopeKey` 追加分支身份；`CompressionCacheEntry.branchNodeId` 标记折叠历史归属，`compressionCacheForBranch`/`mergedCompressionCacheForPersist` 按分支读取与合并持久化。 |
| `DESKTOP/src/core/agentKernelRunner.ts` | `providerSessionIdentity` 改为绑定 Build 所属分支（`agent.activeWorkRunBranchId()`），不再读取「当前激活/查看的分支」，兄弟分支的远端会话序列完全分割。 |
| `DESKTOP/src/ui/index.html` | 分支身份与分支级缓存键：`conversationBranchIdentity`/`rememberViewedBranchNodeId`/`viewedBranchNodeIdFor`/`branchConversationViewKey`；`conversationMessageCache`/`cacheConversationMessages` 按分支节点缓存，`workRunsForTarget` 读当前浏览分支的 Build 账本；`renderConversationBranchPagers` 锚点三级回退（message-id → 渲染索引 → 锚点文本）；`queueIndexesForTarget` 不再按分支过滤排队行并新增 `queueRequestBranchMismatch` 标记、队列面板新增行自动展开、`renderPendingQueuedUserMessages` 把本页排队输入渲染为带「排队中」徽标的用户气泡；`rebindQueueToRuntimeBranch` 不再改写受理时捕获的 `branchPath`；`renderWorkRunGuideMessage` 只保留复制动作。 |
| `DESKTOP/src/tests/branchPageQueueIdentityVerify.ts` | 新回归：分支身份唯一性与 core/UI 单一路径、分页缓存隔离、跨分页排队行可见且不被改绑、排队输入内联渲染、Guide 卡片只读复制、分页编辑不清空队列投影。 |
| `DESKTOP/scripts/dev-0.6.4-branch-page-queue-visual.cjs` | 真实 Electron 渲染器视觉复核：注入 Build 开头编辑分页 + 排队输入 + Guide 卡片，断言分页条文本、锚点、队列行、排队气泡与 Guide 动作数量，并输出截图到 本地归档（未纳入公开仓库）。 |
| `DESKTOP/scripts/test-renderer-conversation-commands.cjs`、`DESKTOP/scripts/test-long-conversation-ui-ordering.cjs`、`DESKTOP/src/tests/conversationHistoryFirstVerify.ts`、`DESKTOP/src/tests/guideUiReconcileVerify.ts`、`DESKTOP/src/tests/verify.ts` | 抽取式渲染器夹具补齐新增 helper；Guide 编辑断言改为「保留复制、移除编辑」；`test-long-conversation-ui-ordering.cjs` 命中真实 `right-status-content` 与模型选择分支后 18/18。 |
| 本地归档（未纳入公开仓库） | 本轮截图、报告与未执行边界（打包/安装/CI 发布未在本轮执行）。 |

保留边界：预览分支 ≠ 运行分支时，新分支绝不接管另一条分页的排队输入（内核执行投影仍只跟随当前激活节点）；Guide 仍是当前 Build 的内联干预；跨分支不共享 provider 会话序列与折叠历史。版本：`VERSION`/`DESKTOP/package.json`/`package-lock.json`/Android `versionName 0.6.4`+`versionCode 604`（Android 行为未改动）。`release:version-check` 通过。

本轮同时完成 Windows 打包与本地安装：`release/Newmark-Agent-0.6.4-x64.msi`（SHA-256 `1BEABA08…B54E4A`）、`release/Newmark-Agent-0.6.4-win-unpacked-x64.zip`（SHA-256 `C807ECC6…4419D6`）、打包 `app.asar` SHA-256 `92842DCB…D38804`；本机 UAC 提升安装后注册表 `0.6.4.0`、安装目录 CLI `0.6.4`、安装目录 `app.asar` 与打包字节一致、292 个 payload 文件核对通过；已安装 exe 以隔离 root 通过分页/队列/Guide 渲染器门禁并截图。记录：本地归档（未纳入公开仓库）、本地归档（未纳入公开仓库）。

## 2026-09-09 dev-0.6.3 对话接续身份、分支绑定与缓存隔离

| 文件/目录 | 构造与作用 |
| --- | --- |
| `DESKTOP/src/core/conversationKernel.ts` | 队列项新增 `targetRuntimeKey/workspaceKey/branchNodeId/branchPath/modelSelection`；`enqueueNext`/`enqueueSameSession` 受理时冻结身份；`run` 只内联抽取 Guide，Next 留给延迟调度器；`schedulePendingRuntimeContinuation` 为 Next 分配新 runId、恢复捕获分支并核验目标；`bindQueuedTurnBranch` 在分支缺失时进入暂停/重试。 |
| `DESKTOP/src/core/continuation/contracts.ts` | continuation-v1 品牌身份、`CommandReceipt`、`ExecutionScope`、`BranchGuardSnapshot`、`QueueSnapshot`、错误码与稳定请求哈希。 |
| `DESKTOP/src/core/continuation/store.ts` | `GuardedContinuationStore`：锁文件 + 原子替换的受控写入网关；`enqueueBuild` CAS/幂等/固定 parent、`claimBuild` BranchGuard/fence/lease、`heartbeat`、`commitFinal` 唯一 final/head 推进、`failBuild`、`cancelBuild`、`retryBuild`、`forkBranch`、`recoverExpiredLeases`、`snapshot`、`events`。 |
| `DESKTOP/src/tests/continuationStoreVerify.ts` | 23 项真实负面/并发测试：CAS 冲突、幂等键换目标、跨 root 拒绝、双抢占、租约过期旧 fence 拒绝、fence 单调、head/tail、final 唯一、取消阻塞、分叉锚点 lineage、重启持久、事件 cursor。 |
| `DESKTOP/src/core/agent.ts` | `ConversationContinuation` 持久化目标/分支/模型身份；`recordRequestContext` 记录 `branchId` 与 `contextHash`；标题探测对确定性 4xx 快速失败并在门禁前发布可见状态；`process` 不再让首轮看起来像无反馈冻结。 |
| `DESKTOP/src/core/agentKernelRunner.ts` | `providerSessionIdentity` 将可选远端会话身份改为 `conversationId::branch:<branchId>`；主循环不再给正常回复传客户端输出上限。 |
| `DESKTOP/src/providers/chat-completions.adapter.ts`、`responses.adapter.ts` | `maxOutputTokens <= 0` 时省略 `max_tokens`/`max_output_tokens`；Anthropic/GitHub 等必须正数的协议由 `provider.ts` 用档位预算兜底。 |
| `DESKTOP/src/ui/index.html` | `applyConversationModelSelection` + `modelSelectionRevision` 在进入对话时恢复该对话记忆的 provider-qualified 模型；发送在 `await activationBeforeSend` 之后把可见模型绑定到目标；Next 入队携带分支身份。 |
| `DESKTOP/src/main.ts`、`DESKTOP/src/server.ts` | `ConversationCommandOptions.model` 与 `hostedCommandOptions.model` 把渲染端可见模型带入发送；`queue_enqueue` 传递分支身份与模型选择。 |
| `android/.../ApiClient.kt`、`ChatViewModel.kt` | 正常回复省略输出上限；预算耗尽保留部分答案并标记 `interrupted`，不再丢弃进度。 |
| `DESKTOP/scripts/test-queue-continuation-identity.cjs` | 60 项断言：每个 Next 新开 Build、每次 process 都在目标 conversation、跨会话队列项绝不执行并保持暂停。 |
| 本地归档（未纳入公开仓库） | 本轮规范接入、验证记录与尚未实现的 SQLite GuardedStore/fence/Attempt 边界。 |
| 本地归档（未纳入公开仓库） | dev-0.6.3 本地打包资产、SHA-256、Android 包信息、门禁结果与未执行边界。 |

版本：`VERSION`、`DESKTOP/package.json`、`DESKTOP/package-lock.json` 与 Android `versionName 0.6.3`／`versionCode 603` 已同步。`release:version-check`、`verify.js`（1717/1717）、`test-shared-conversation-commands.cjs`（51/51）以及缓存/动态多级压缩专项全部通过；`beginExternalRun` 接管前通过 `reconcilePendingContinuations` 重载并合并持久队列，修复 pool→flow owner handoff。当前正在执行 `test:desktop:built` 发布门禁全链。

## 2026-09-09 dev-0.6.2 发布完成

- `dev-0.6.2` 标签绑定 `781307e`；GitHub Actions 已完成 Windows MSI/便携包、Linux AppImage/deb/便携包、Android APK 六个资产的发布，npm `newmark-agent@0.6.2` 同步发布。
- 发布页：https://github.com/positer/Newmark-Agent/releases/tag/dev-0.6.2

## 2026-09-09 移动端输出预算续写

- `android/app/src/main/java/com/newmark/mobile/data/ApiClient.kt`、`MobileResponseRecovery.kt`：区分供应商预算结束、完成及错误，保护未完成工具调用。
- `android/app/src/main/java/com/newmark/mobile/vm/ChatViewModel.kt`：最多三次提高预算的续写、请求级检查点、正文拼接与持久化。
- `android/app/src/androidTest/java/com/newmark/mobile/ui/OutputBudgetContinuationTest.kt`：真实 ViewModel 的思考截断、正文截断、成功完成与落库测试。

## 2026-09-09 双端标题推理预算

- `DESKTOP/src/core/agent.ts`：标题预算从固定 2048 改为冻结档位的 maxTokens。
- `android/app/src/main/java/com/newmark/mobile/vm/FirstInputTitleRequest.kt`：主标题取消 64-token 覆盖，图片 metadata 退路使用正常 low 档预算。
- `DESKTOP/src/tests/verify.ts`、`android/app/src/test/java/com/newmark/mobile/vm/FirstInputTitleRequestTest.kt`：标题预算、思考映射、启动门禁及 HTTP 回归。

## 2026-09-09 移动端整篇重复回复

- `android/app/src/main/java/com/newmark/mobile/data/ApiClient.kt`：协议增量与快照分离，Responses 按输出片段合并，非流式正文别名互斥。
- `android/app/src/main/java/com/newmark/mobile/vm/ChatViewModel.kt`：UI 批量发布保留空白片段，防止流式与完成态 Markdown 不一致。
- `android/app/src/test/java/com/newmark/mobile/data/ApiClientStreamTest.kt`：真实 HTTP/SSE 回归覆盖完整快照、重复字词、空白、多个输出项及聚合别名。

## 2026-09-09 移动端对话运行彩边

- `android/app/src/main/java/com/newmark/mobile/ui/components/ConversationRuntimeBorder.kt`：固定胶囊路径、旋转黑白 shader，绘制阶段读取动画，仅运行时启用。
- `ui/Sidebar.kt`、`ui/NewmarkApp.kt`、`vm/ChatViewModel.kt`（Android 主源码目录下）：本地运行 ID 集合传递与远程运行状态接入，避让浮动玻璃。
- `android/app/src/androidTest/java/com/newmark/mobile/ui/ConversationRuntimeBorderTest.kt`：双主题、本地/远程运行帧差与结束静止验证。

## 2026-09-09 免费搜索组更新

| 文件/目录 | 构造与作用 |
| --- | --- |
| `DESKTOP/src/core/searchMcpPool.ts` | Exa/You.com 官方 HTTP 默认组、搜索参数准入、注入式网络传输。 |
| `DESKTOP/src/tools/index.ts` | MCP 与普通网页请求复用配置代理。 |
| `android/app/src/main/java/com/newmark/mobile/data/MobileSearchMcp.kt` | 原生 HTTP 搜索优先，PC bridge 排后，保留完整池遍历与最终 HTTP 退路。 |
| `DESKTOP/src/tests/searchMcpPoolVerify.ts` | 默认顺序、搜索专用 schema、代理传输全流程及容灾回归。 |
| `DESKTOP/src/tests/verify.ts`, `pcGlassMigrationVerify.ts`, `startupPrewarmVerify.ts` | 发布门源码断言与当前协议写法、Windows 换行和前后台浏览器函数边界对齐；保留对应行为回归。 |
| `android/app/src/test/java/com/newmark/mobile/data/MobileSearchMcpTest.kt` | 双端同名默认服务、顺序、参数边界与原有容灾测试。 |
| `android/app/src/androidTest/java/com/newmark/mobile/data/SearchOnlyHttpMcpDeviceTest.kt` | 可显式启用的 Exa/You.com 真实联网准入，以及 HTTP/SSE 设备协议测试。 |
| 本地归档（未纳入公开仓库） | 上游调研、候选 schema、原始公开查询结果、设备与发布验证记录。 |
| 本地归档（未纳入公开仓库） | Windows 0.6.2 发布测试、MSI 打包与实际安装记录。 |

## 2026-09-09 带图导航、触感与公式

| 文件/目录 | 构造与作用 |
| --- | --- |
| `android/app/src/main/java/com/newmark/mobile/vm/ConversationPersistence.kt` | 串行后台持久化协调，标题提交等待磁盘并校验最新状态，避免恢复旧快照。 |
| `android/app/src/main/java/com/newmark/mobile/vm/ChatViewModel.kt` | 合并连续保存请求，交给 IO 执行，标题使用可挂起保存屏障。 |
| `android/app/src/main/java/com/newmark/mobile/data/ConversationStore.kt` | 原子文件替换保留，JSON 流式读写以减少带图历史的中间内存分配。 |
| `android/app/src/main/java/com/newmark/mobile/ui/AttachmentPreview.kt` | 后台读取图片尺寸并采样解码，限制预览边长；原始附件不变。 |
| `android/app/src/main/java/com/newmark/mobile/ui/ChatScreen.kt`, `Sidebar.kt` | 四处图片预览接入后台解码；本地及远程胶囊弹菜单时触发系统长按触感。 |
| `android/app/src/main/java/com/newmark/mobile/ui/components/DisplayMathLines.kt`, `Markdown.kt` | 分离紧接正文的块公式，保护代码，修复行内命令匹配与分段公式文本退路。 |
| `android/app/src/main/java/com/newmark/mobile/ui/components/NativeMath.kt` | RaTeX 0.1.14 离线 Canvas 公式排版；后台解析、字体加载、尺寸限制与可读退路。 |
| `android/app/src/main/assets/licenses/` | 随 APK 打包数学引擎和 KaTeX 字体的许可证。 |
| `android/app/src/test/java/com/newmark/mobile/vm/ConversationPersistenceTest.kt` | 保存挂起期间新建、删除、取消、失败的竞态验证。 |
| `android/app/src/test/java/com/newmark/mobile/ui/DisplayMathRegressionTest.kt` | 截图同类 cases、多行公式、代码保护与流式未闭合公式回归。 |
| `android/app/src/androidTest/java/com/newmark/mobile/ui/ImageNavigationAndMathTest.kt` | 实际带图 ViewModel 发送、退出重入、键盘关闭循环与双主题公式截图。 |
| 本地归档（未纳入公开仓库） | 构建、测试、实际截图和性能边界记录。 |

## 2026-09-09 图片首轮标题退路

| 文件/目录 | 构造与作用 |
| --- | --- |
| `android/app/src/main/java/com/newmark/mobile/vm/FirstInputTitleRequest.kt` | 图片首轮标题失败后执行纯文字元数据分析；仍失败时通过既有持久化门禁保存中性标题。 |
| `android/app/src/main/java/com/newmark/mobile/vm/ChatViewModel.kt` | 将首条用户消息图片数量传入标题流程，正式带图请求保留原始图片及冻结配置。 |
| `android/app/src/test/java/com/newmark/mobile/vm/FirstInputTitleRequestTest.kt` | HTTP 夹具验证文字退路、请求载荷、服务不可用兜底、保存失败与取消。 |
| `android/app/src/test/java/com/newmark/mobile/vm/FirstInputTitleAndNetworkRecoveryContractTest.kt` | 既有首轮门禁契约增加图片文字退路例外。 |
| `android/app/src/test/java/com/newmark/mobile/vm/MobileEmptyResponseRetryContractTest.kt` | 标题请求计数允许图片专属文字退路，正式轮次请求契约保持不变。 |
| `android/app/src/test/java/com/newmark/mobile/ui/QueuePanelVisualContractTest.kt` | 按既有视觉证据校正队列按钮契约，要求无边界及按压反馈。 |
| 本地归档（未纳入公开仓库） | 本次请求回归、构建日志与交付记录。 |

## 2026-09-08 代码块与全量视觉压力复查

| 文件/目录 | 构造与作用 |
| --- | --- |
| `DESKTOP/src/ui/index.html` | Markdown 独立复制工具栏、双时间线间距、浏览器工具栏收缩、上下文弹窗随聊天列定位。 |
| `android/app/src/main/java/com/newmark/mobile/ui/components/Markdown.kt` | 每个围栏代码块独立写入系统剪贴板，主题化语言标题和复制反馈。 |
| `android/app/src/main/java/com/newmark/mobile/ui/ChatScreen.kt` | 正文代码卡片为相对侧时间线预留边距；Goal/队列按钮无玻璃框和按压反馈，只保留点击。 |
| `android/app/src/androidTest/java/com/newmark/mobile/ui/MarkdownCodeRenderingTest.kt` | 双主题、双角色、多代码块的真实剪贴板、几何断言和 PixelCopy 截图。 |
| `android/app/src/androidTest/java/com/newmark/mobile/ui/FullVisualAuditTest.kt` | 27 个界面状态、双主题、短屏滚动与窗口归属检查；plainActions 模式比较 Goal/队列按钮静止与按住时的真实像素。 |
| `DESKTOP/scripts/full-visual-audit.cjs`, `render-visual-gallery.cjs` | 参数化画幅和界面筛选，代码复制与边界断言，原始截图图册。 |
| `DESKTOP/scripts/release-ui-incremental-render-stress.cjs`, `ui-stress-electron-bootstrap.cjs` | 当前开发构建及打包构建的增量节点、滚动与输入延迟压力检查，保存阶段耗时。 |
| `android/scripts/mobile-agent-stress.ps1` | 独立 stress 包的远端事件、队列、菜单与侧栏压力检查，通过 UI 进入远端对话并留存截图。 |
| `DESKTOP/scripts/mobile-mock-server.cjs` | 隔离 SSE/API 夹具，按真实 PC 的统一 send 入口处理运行中 Next 入队。 |
| 本地归档（未纳入公开仓库） | 本轮报告、双端截图、图册、构建日志、成功与失败测试证据；无效诊断截图不计入验收。 |

## 2026-09-08 Browser-Use 视觉、画幅与 PDF

| 文件/目录 | 构造与作用 |
| --- | --- |
| `DESKTOP/src/core/browserUse.ts` | 画幅、视觉模式与 PDF 页码协议校验，观察代际和视觉回执边界。 |
| `DESKTOP/src/core/browserUsePageAdapter.ts` | DOM 优先观察；PDF 的 observe/extract 走二进制；截图前后检查页面代际。 |
| `DESKTOP/src/core/browserPdf.ts` | PDF.js 二进制文本提取、指定页渲染、页数和识别范围元数据。 |
| `DESKTOP/src/core/electronBrowserUseHost.ts` | 真实 CSS 画幅、适配宿主的显示缩放、截图和输入映射、会话 Cookie 与 PDF 下载 MIME 路由。 |
| `DESKTOP/src/core/agent.ts`, `agentKernelRunner.ts`, `DESKTOP/src/tools/index.ts` | 只读视觉模型协作调用、限时与取消、失败后 OCR、一次性图片不写入工具历史。 |
| `android/app/src/main/java/com/newmark/mobile/ui/BrowserRecognition.kt` | PDFBox 二进制解析、PdfRenderer 页渲染、视觉优先与 ML Kit 中英 OCR 退路。 |
| `android/app/src/main/java/com/newmark/mobile/ui/BrowserSession.kt`, `RightSidebar.kt` | 前后台独立画幅、可见面板缩放、PDF MIME 识别、观察状态和失效检查。 |
| `android/app/src/main/java/com/newmark/mobile/vm/ChatViewModel.kt` | 当前视觉模型或已启用视觉模型协作，保留文本主模型，不把截图加入对话历史。 |
| `android/app/src/main/java/com/newmark/mobile/data/LocalTools.kt` | 移动端 browser_use 参数定义及说明。 |
| `DESKTOP/scripts/test-browser-vision-viewport.cjs` | 真实 Electron、PDF 流与模型 HTTP 协议回归。 |
| `android/app/src/androidTest/java/com/newmark/mobile/ui/BrowserVisionViewportTest.kt` | 设备端压缩/扫描 PDF、视觉/OCR、前后台画幅、无后缀 PDF 和 Cookie 回归。 |
| `android/app/src/main/java/com/newmark/mobile/data/MobileModels.kt`, `RemoteTrackingContract.kt`, `vm/DesktopLinkViewModel.kt` | 保留并展开 PC coalescedDeltas，按原片段 ID 合并快照和 SSE，消除过程文本双重显示。 |
| 本地归档（未纳入公开仓库） | 构建日志、截图、合成 PDF、测试报告和交付摘要。 |

## dev-0.6.2 内置浏览器本地 HTML

| 文件/目录 | 构造与作用 |
| --- | --- |
| `android/app/src/main/java/com/newmark/mobile/ui/BrowserSession.kt` | 网页、本地路径与 file/content URL 归一化；区分主动地址输入和页面发起的本地导航。 |
| `android/app/src/main/java/com/newmark/mobile/ui/RightSidebar.kt` | 前后台 WebView 共用文件/文档读取设置；保留 file-origin 跨源限制；导航和弹窗复用来源检查。 |
| `android/app/src/test/java/com/newmark/mobile/ui/BrowserUrlPolicyTest.kt` | 主机、文件路径、协议别名与页面来源边界回归。 |
| `android/app/src/androidTest/java/com/newmark/mobile/ui/LocalHtmlBrowserTest.kt` | 真实 WebView 验证含中文/空格/# 的文件与相对 CSS/JS/HTML。 |
| `DESKTOP/src/ui/index.html` | 地址栏识别本地绝对路径、file URL 和 files 别名，不再错加 https 前缀。 |
| `DESKTOP/src/core/browserUse.ts` | Browser-Use 主动导航支持本地绝对路径与 file URL，保留可执行协议和远程 file authority 拒绝。 |
| `DESKTOP/src/core/electronBrowserUseHost.ts` | 本地页面间的 file 导航通过，网页发起的本地导航保持阻止。 |
| `DESKTOP/scripts/test-local-html-browser.cjs` | 隔离配置与本地 HTML fixture，真实 Electron guest 加载、样式、脚本及链接验证。 |
| 本地归档（未纳入公开仓库） | 本轮构建、回归日志、PC 截图和修复说明。 |

## dev-0.6.2 全界面主题与玻璃协调

目标：统一 PC 与移动端各页面的状态色和控件反馈，并用真实渲染证据验证玻璃与现有 UI 的协调。

| 文件/目录 | 构造与作用 |
| --- | --- |
| `DESKTOP/src/ui/index.html` | 语义状态色、主题悬停与选区；白色选中开关；取消旧弹窗退出回调；本地空白浏览器背景同步。 |
| `DESKTOP/scripts/full-visual-audit.cjs` | 36 个 PC 页面/状态的双主题遍历、可见性与标签检查及原始截图。 |
| `DESKTOP/scripts/render-visual-gallery.cjs` | 原始截图图册、主题/平台筛选与接触表。 |
| `DESKTOP/scripts/test-liquid-switch-ui.cjs` | CDP 激活前台和焦点，避免后台动画节流干扰真实开关点击/拖动与持久化验证。 |
| `DESKTOP/scripts/test-popup-reopen.cjs` | 快速关闭/重开弹窗的真实渲染器回归。 |
| `DESKTOP/scripts/test-ui-consistency.cjs` | 增加选中开关圆点与 about:blank 主题检查。 |
| `DESKTOP/scripts/dev-{uniform-popup-visuals,popup-direction-regression}.cjs` | 更新现有设置页面就绪选择器，继续验证玻璃动态与方向边界。 |
| `android/app/src/main/java/com/newmark/mobile/ui/theme/NewmarkTheme.kt` | 补充 warning 与亮色可读状态色。 |
| `android/app/src/main/java/com/newmark/mobile/ui/{ChatScreen,Sidebar,RightSidebar,MemoryLabScreen,SettingsScreen}.kt` | 状态与图谱配色跟随主题，设置导航箭头统一 Lucide。 |
| `android/app/src/androidTest/java/com/newmark/mobile/ui/FullVisualAuditTest.kt` | 27 个移动端页面/状态、离线数据、PixelCopy 画面同步与系统栏主题。 |
| 本地归档（未纳入公开仓库） | REPORT、COVERAGE、gallery、逐页截图、玻璃动态探针和构建/测试日志；历史失败采集单独保留。 |


## dev-0.6.2 双端视觉一致性

目标：在适配各自窗口和输入方式的基础上，统一两端的图标笔画、文字层级和主题反馈。

| 文件或目录 | 构造与作用 |
| --- | --- |
| `DESKTOP/src/ui/index.html` | 11 处普通悬停背景改为 control-hover-bg 主题语义色。 |
| `DESKTOP/scripts/sync-mobile-navigation-icons.cjs` | 从已安装 lucide-static 的原始 SVG 生成 12 个 Compose 导航图标；--check 检查资源偏移。 |
| `DESKTOP/scripts/test-ui-consistency.cjs` | 隔离配置启动 Electron，验证两端文字色值、实际 hover 和设置操作布局，保存双主题截图。 |
| `android/app/src/main/java/com/newmark/mobile/ui/components/LucideIcons.kt` | 保留原图标，新增有上游来源的导航图标生成区；24dp viewBox、2px 圆头笔画。 |
| `android/app/src/main/java/com/newmark/mobile/ui/{ChatScreen,Sidebar,SettingsScreen,TerminalScreen,MemoryLabScreen}.kt` | 用 Lucide 替换实心 Material 图标，保留各控件尺寸、语义、回调与手势。 |
| `android/app/src/main/java/com/newmark/mobile/ui/theme/NewmarkTheme.kt` | 亮色文字层级与 PC 一致；补齐中性 Material 容器、次级色、反色和透明 surfaceTint。 |
| `android/app/src/androidTest/java/com/newmark/mobile/ui/CrossPlatformUiRenderingTest.kt` | 渲染真实侧栏与供应商详情页，保存双主题手机宽度截图。 |
| `android/app/src/test/java/com/newmark/mobile/ui/InputComposerAndModelMenuContractTest.kt` | 更新上箭头为 Lucide 资源的断言，保留输入栏几何约束。 |
| 本地归档（未纳入公开仓库） | 构建和回归日志、双端截图、报告及交付哈希。 |

复验：先运行 Desktop build，再运行 `npm --prefix DESKTOP run test:ui-consistency`；Android 执行 JVM、指定设备回归和 Release 编译。

## dev-0.6.2 移动端图标主题

目标：默认应用图标和系统栏图标严格使用当前应用主题，支持手动覆盖、跟随系统和恢复页面。

| 文件或目录 | 构造与作用 |
| --- | --- |
| `android/app/src/main/java/com/newmark/mobile/ui/theme/NewmarkTheme.kt` | 在 MaterialTheme 内提供默认 LocalContentColor，使普通 Icon 与 IconButton 继承主题前景色。 |
| `android/app/src/main/java/com/newmark/mobile/ui/theme/ThemeSystemBars.kt` | 解析宿主 Activity，在组合提交和生命周期恢复时应用系统栏图标亮暗属性，并清理观察者。 |
| `android/app/src/main/java/com/newmark/mobile/ui/NewmarkApp.kt` | 首次组合读取持久化主题，再驱动应用颜色和系统栏外观。 |
| `android/app/src/androidTest/java/com/newmark/mobile/ui/ThemeIconRenderingTest.kt` | 真实 Compose 图标像素、双向主题切换和恢复时系统栏属性回归。 |
| 本地归档（未纳入公开仓库） | 本轮报告、Gradle 日志、模拟器日志与图标截图。 |

统一版本源与 Desktop 元数据同步到 0.6.2，Android 为 0.6.2／602；本次未执行桌面打包安装或远程发行。

## 0.6.1 MSI 构建与安装状态

根目录 `VERSION`、`DESKTOP/package.json`、`DESKTOP/package-lock.json` 与 `android/app/build.gradle.kts` 已同步为 0.6.1／601。Windows 交付物位于 `release/Newmark-Agent-0.6.1-x64.msi`，已通过完整 release 门禁并安装到 `C:\Program Files\Newmark Agent\`。本地归档（未纳入公开仓库） 保存报告与 Windows Installer 详细日志。

Android 当前交付物为 `APK/Newmark-Agent-0.6.1-release.apk`。`release/` 仅保留 0.6.1 MSI 与 Windows ZIP，`APK/` 仅保留 0.6.1 APK；根目录历史 `release-*` 已删除。本地归档（未纳入公开仓库） 中历史发行二进制与解包目录已删除，项目报告、日志、测试数据和媒体等冷数据继续保留。

## dev-0.6.0 全平台发行

`VERSION`、Desktop package/lock 与 Android Gradle 绑定 0.6.0／600。`.github/workflows/release-linux.yml` 构建既有六平台资产，并读取 `DESKTOP/scripts/release-notes-dev-0.6.0.md` 的英文／简体中文发行说明。本地归档（未纳入公开仓库） 保存本轮构建、哈希和上传校验记录。

## 2026-09-07 PC P0 与跨端开关修复

移动端 `SettingsScreen.kt` 的 `ProviderDetailPanel` 将静态供应商名、可编辑 API 接口、横向协议轨道、竖向模型轨道拆为独立区域；端点保存调用现有 ProviderStore 持久化路径。`ProviderDetailEditingTest.kt` 检查浮块上界、端点保存及无效地址不写入。交付验证记录位于 本地归档（未纳入公开仓库）。

| 文件或目录 | 构造与作用 |
| --- | --- |
| `DESKTOP/src/core/modelResponseHealth.ts` | 按部署、端点、协议与凭据摘要隔离原子响应记录；独立合并 text/vision/tools 标识，观察失败不阻断通信。 |
| `DESKTOP/src/core/conversationKernel.ts` | 快照、切换及请求默认参数保留供应商部署标识，兼容已有裸名快照的已绑定会话。 |
| `DESKTOP/src/core/agent.ts`、`agentKernelRunner.ts` | 去除观察状态禁用；绑定真实结果、OCR 纠错及持久化；回退仅在当前请求内排除已失败部署。 |
| `DESKTOP/src/core/config.ts`、`autoRouter.ts` | 提供最新观察信息，保留用户启用与路由范围策略。 |
| `DESKTOP/src/llm/provider.ts`、`core/types.ts` | 传输错误携带明确来源，避免把正常回答中的错误字样误标为失败。 |
| `DESKTOP/src/ui/index.html` | 全宽模型行、灰色异常提示、用户开关、浮块完整生命周期与实时警告刷新。 |
| `android/app/src/main/java/com/newmark/mobile/ui/components/LiquidGlass.kt` | 点击/拖动分离、取消清理、固定中心锚点与先移动后落下。 |
| `android/app/src/androidTest/java/com/newmark/mobile/ui/LiquidSwitchRenderingTest.kt` | 四项实际 Compose 手势、浮块阶段及端点坐标回归。 |
| `DESKTOP/scripts/test-conversation-model-binding.cjs`、`test-model-response-health.cjs`、`test-image-ocr-recovery.cjs` | 实际 HTTP、跨部署隔离、冷加载、视觉重试及内置 OCR 恢复测试。 |
| `DESKTOP/scripts/test-liquid-switch-ui.cjs`、`test-live-pc-model-recovery.cjs` | Electron 实际输入/布局/截图与隔离真实供应商首轮测试；真实调用测试不加入自动测试链。 |
| 本地归档（未纳入公开仓库） | 本轮复现、被否决中间候选、测试日志、截图及最终验证边界。 |


## dev-0.5.15 本机 MSI 安装（2026-09-07）

已通过共享 MSI 安装器安装到 `C:\Program Files\Newmark Agent`，机器注册版本 `0.5.15.0`，MSI 返回 0。292 个安装文件与发行包一致，21,021 个既有 `.Newmark` 文件哈希未变；普通用户实际 CLI／GUI 均验证为 `0.5.15`。本地归档（未纳入公开仓库） 记录结果；同目录 `result.json`、`request.json` 和 MSI 日志记录身份与过程，`installed-smoke.log`／`installed-runtime.json` 记录独立运行验证，用户文件清单和 pending-operation 记录用于本地审计。此前发布报告的“未安装”边界保留为历史记录；本次安装未改变并行移动端工作。

## dev-0.6.0 移动端侧栏修复

| 路径 | 构造与作用 |
| --- | --- |
| `android/app/src/main/java/com/newmark/mobile/ui/components/LiquidHoldGesture.kt` | 持续刷新长按回调，保持已有指针生命周期，使重排后的手势使用当前列表。 |
| `android/app/src/main/java/com/newmark/mobile/ui/NewmarkApp.kt` | `UnclippedSidebarDrawer` 分离背景材质与内容，保留抽屉尺寸及系统栏避让，允许浮块溢出。 |
| `android/app/src/main/java/com/newmark/mobile/ui/Sidebar.kt` | 本地和远程浮块的中心右移从 16dp 减为 8dp，起落归零。 |
| `android/app/src/androidTest/java/com/newmark/mobile/ui/ConversationLiftRenderingTest.kt` | 实际抽屉材质下的包边像素、起落色块绑定和连续反向重排验证。 |
| 本地归档（未纳入公开仓库） | `REPORT.md` 为验收报告；`*.log` 为中间与最终门禁，`geometry.log` 为坐标；`validation.json` 为源码及包身份，`changes.patch` 为评审补丁；`pixels/` 保留初版截图，`*-held-final.png` 为最终截图，`installed-base.apk` 为安装回读字节。不代表 dev-0.6.0 已发布。 |

## dev-0.5.15 发布构造（2026-09-07）

`VERSION`、`DESKTOP/package.json`／lock 与 `android/app/build.gradle.kts` 绑定 0.5.15／515。`.github/workflows/release-linux.yml` 提供 Windows／Linux／Android 原生 runner 构建；手工 dispatch 只构建，dev 标签触发预发布；`publish.yml` 同标签触发 npm。`DESKTOP/scripts/dist-portable.cjs` 与 `dist-linux.cjs` 生成桌面资产；`verify-github-release-assets.cjs` 重新下载六资产并校验。当前发布计划与检查表位于 `tasks/`，每项执行日志、候选和最终身份在 本地归档（未纳入公开仓库）。

`dev-0.5.15` 标签绑定 `ec2e67642421545dd1f0de220b7edd09becf7304`，六资产实际构建提交为 `6210c9c118791aea4a9336f942ec667f2c5a845f`；差异仅为三个发行测试与说明，生产输入相同。标签平台 CI `34083419351` 四项成功并保留已验证资产，npm CI `34083419355` 成功，公开 npm 包通过来源签名与实际入口验证。GitHub 六资产全部重新下载，大小与 SHA256 逐件一致。GitHub Release 与 npm 为独立验收对象。

| 本次归档路径 | 构造与作用 |
| --- | --- |
| `REPORT.md`、`asset-manifest.json`、`SHA256SUMS.txt`、`tag-source-binding.json` | 发布状态、六资产身份、构建来源及生产输入未变证明。 |
| `assets/`、`downloaded-assets/` | 选定的六个本地发行资产与独立重新下载的远端字节，逐件核对。 |
| `windows/`、`windows-package-smoke-final.json`、`windows-payload-identity.json` | Windows MSI／ZIP／unpack、实际包门禁与全部 dist 文件身份。 |
| `android/` | 隔离 Gradle 输出、365 项测试/lint、APK 版本/签名/对齐和源码输入身份。 |
| `ci-artifacts/`、`linux/` | 原生 Linux 候选构建和 AppImage／deb／ZIP 实包验证、截图与缓存等价证据。 |
| `wsl-client-supplement/` | 完整测试中未进入的两个条件检查的实际补测，不改写主阶段 1707 计数。 |
| `dev008-wakeup-regression/`、`dev009-tool-identity-regression/`、`before-smoke-harness/`、`after-smoke-harness/` | 过时门禁的原始失败、当前合同、精确实包复验及测试修订。 |
| `npm/`、`npm/published/` | 区分 Windows 本地候选与公开 Ubuntu tarball；公开元数据、SLSA/Sigstore 验证和真实 CLI／ConPTY 日志。 |
| `final-tag-ci-*.json`、`github-*.json`／`.log` | 最终 CI、资产保留回执、发行说明与发布/下载校验过程。 |

## SubAgent 连续工作、mailbox 与缓存（2026-09-07）

| 路径 | 构造与作用 |
| --- | --- |
| `DESKTOP/src/core/subagent.ts` | 同一 peer 单执行器、4／16 槽 FIFO、精确 mailbox 批次、可选 v2 jobs 持久化、输入提交检查点及深拷贝快照；`patchMetadata` 保存 peer 请求状态。 |
| `DESKTOP/src/core/agent.ts` | 工作历史按实际变化保存；恢复压缩状态和 peer 请求缓存；32 个独立、按配置失效的 provider 槽；Ultra 主协调者与执行者责任区分。 |
| `DESKTOP/src/core/agentKernelRunner.ts` | 活跃 mailbox 先保存后确认、首请求输入检查点、跨 peer 续作复用请求元数据及工具供给顺序，保留实时工具权限判定。 |
| `DESKTOP/src/core/subagentCommunication.ts` | 发送者自行选择摘要、文本和完整工具调用／结果对；验证每类范围、默认最后一条可见文本、严格预算与源数据保真。 |
| `DESKTOP/src/core/conversationKernel.ts`、`DESKTOP/src/core/agentKernel/agent.ts` | 主代理静默邮件／显式唤醒、已读自动通知的精确队列撤回，以及单对话停止的运行身份边界。 |
| `DESKTOP/src/core/wslAgentClient.ts`、`wslAgentProtocol.ts`、`DESKTOP/src/wsl-agent-host.ts` | WSL 会话工作进程握手携带启动身份；停止期间保留所属进程树的身份锚点，失败保留错误及隔离状态。 |
| `DESKTOP/src/core/wslAgentRuntimePool.ts` | 以会话身份管理停止和回收；定时空闲回收捕获失败并保留原 entry，避免未处理拒绝影响共享宿主。 |
| `DESKTOP/src/core/wslRuntimeProcessTree.ts` | Python 3 标准库 pidfd 终止助手；校验 boot／进程出生信息，捕获所属子孙进程（包括新进程组），限定清理期限，拒绝退回裸 PID／PGID 信号。 |
| `DESKTOP/src/tests/subagentMailboxConcurrencyVerify.ts` | 连续唤醒、突发通信、停止／重启／降档、崩溃窗口、同步异常和快照隔离的确定性压力矩阵。 |
| `DESKTOP/src/tests/subagentUltraDelegationVerify.ts` | 真实 Agent/kernel/file tool 的 16 路并发、部署和任务归属、Plan 拒绝写入、provider 复用／失效／关闭／容量验证；供应商回复使用夹具。 |
| `DESKTOP/scripts/test-subagent-cache-continuity.cjs` | 隔离编译生产源码，对比实际供应商序列化输入，覆盖活跃 mailbox、冷恢复、执行中检查点、工具供给及配置失效；支持原始源码覆盖以复现失败。 |
| `DESKTOP/scripts/test-subagent-settlement-receipts.cjs` | 实际 Agent/native kernel 的已读结果去重、手工消息保留、持久化失败、主代理静默投递／唤醒和多对话停止隔离压力测试。 |
| `DESKTOP/scripts/test-subagent-real-provider-stress.cjs` | 有界真实 APInebula 验收：16 初始任务、16 mailbox、4 冷恢复及独立主模型自主分工模式；仅合成文件，凭据不进入证据。 |
| `DESKTOP/scripts/subagent-streaming-relay-stress.cjs` | 子代理实时事件身份、并发转发与取消订阅验证，使用显式注册的夹具部署。 |
| `DESKTOP/scripts/test-wsl-runtime-process-tree.cjs` | 两个真实 WSL client 与生产 asyncProcess 分离子孙进程，验证目标树停止、其他对话存活、过期身份拒绝、取消和失败隔离。 |
| `DESKTOP/package.json` | `test:subagent-continuity[:built]` 可重复专项门禁并纳入完整 Desktop 回归；`test:wsl-stop-isolation[:built]` 覆盖真实 WSL 停止，并随 `test:runtime-isolation` 执行。 |
| `DESKTOP/src/tools/index.ts` | `subagent_send` 的 `wakeup`、主代理目标、内容类型与范围参数；动态内容只进入消息尾部，不嵌入静态工具定义。 |
| 本地归档（未纳入公开仓库） | 本轮计划、修改前快照、原始失败、测试日志、真实模型 usage、独立审阅与最终 `REPORT.md`。 |
| 本地归档（未纳入公开仓库） | 调度器独立红绿测试、隔离 bundle、原始失败和场景报告。 |

## Build 连续性与协议兼容（2026-09-06）

| 路径 | 构造与作用 |
| --- | --- |
| `DESKTOP/src/core/agentKernelRunner.ts` | 当前请求的输出边界、连续无有效答复预算、同部署暂断恢复与已有工具结果续接；保留完整系统/schema前缀。 |
| `DESKTOP/src/core/agent.ts` | 重试等待绑定原 Build 取消信号；公开/持久化工具事件保留调用身份；中断与错误收口时保存已经公开的回复片段。 |
| `DESKTOP/src/core/autoRouter.ts` | 503 等服务端错误及超时保留真实 Retry-After，沿用既有自动重试预算。 |
| `DESKTOP/src/providers/chat-completions.adapter.ts`、`responses.adapter.ts`、`provider-events.ts`、`DESKTOP/src/llm/provider.ts` | 校验协议终止、错误、工具完整参数和调用身份；GitHub/Anthropic及辅助请求沿用真实完成语义。 |
| `DESKTOP/src/providers/provider-request-compat.ts` | 统一匹配流式/JSON的请求头，规范已知接口后缀并保留自定义网关前缀和查询参数。 |
| `DESKTOP/src/providers/provider-headers.ts` | 兼容各供应商响应头的请求ID、限流/重试时间，保持凭据过滤及HTTP缓存与token缓存的边界。 |
| `DESKTOP/src/core/workEventCoalescer.ts`、`types.ts`、`DESKTOP/src/ui/index.html` | 批次保留原始delta边界；GUI按事件身份展开去重，并拒绝过期停止/状态回包。 |
| `DESKTOP/src/tests/providerCompletionIntegrityVerify.ts`、`workEventCoalescerVerify.ts` | 真实本地HTTP协议终止与工具完整性、批次聚合/原始事件转发回归。 |
| `DESKTOP/scripts/test-build-recovery-continuity.cjs`、`test-build-retry-cancellation.cjs`、`test-build-continuity-http.cjs`、`test-build-continuity-ui.cjs` | 实际Agent恢复矩阵、取消等待、完整HTTP Build和真实renderer快照/停止竞态。 |
| `DESKTOP/scripts/test-provider-request-compat.cjs`、`test-provider-header-metadata.cjs` | 实际HTTP头/接口地址与响应限流头的兼容检查。 |
| 本地归档（未纳入公开仓库） | 本轮计划、原始失败、独立审阅、源码/编译与实际GUI证据；`REPORT.md`为入口。 |

## GUI 上下文计量（2026-09-06）

| 路径 | 构造与作用 |
| --- | --- |
| `DESKTOP/src/core/providerUsageAccounting.ts` | 请求句柄保存累计 usage 的已上报字段，按差值更新会话用量和缓存覆盖率；未知与明确零值分开。 |
| `DESKTOP/src/core/requestContextEstimate.ts` | 从实际提交的消息、系统和 schema 估算上下文组成；保留请求/Build/模型/时间身份，视觉 token 明确未估算。 |
| `DESKTOP/src/core/agent.ts` | 持久化 usage 覆盖信息及最近请求快照、绑定晚到回包的原目标、合并同库待写状态；维护普通输入的 Build 归属和辅助调用计量。 |
| `DESKTOP/src/core/agentKernelRunner.ts` | 每个正式请求创建计量句柄，提交前采集实际上下文；收到累计或部分 usage 时合并，持久化正文和工具结果的 run_id。 |
| `DESKTOP/src/providers/provider-events.ts`、`DESKTOP/src/core/agentKernelDiagnostics.ts`、`DESKTOP/src/llm/provider.ts` | 统一服务端 usage 字段与上报标记，按明确协议规范化输入口径；辅助文本请求通过可选回调交付实际 usage。 |
| `DESKTOP/src/ui/index.html` | 上下文计量口径、缺失数据提示、目标/代次/刷新序号保护及面板可用高度约束；其余玻璃交互保持既有规则。 |
| `DESKTOP/src/tests/providerUsageAccountingVerify.ts`、`providerUsageReportingVerify.ts` | 计量 reducer 与真实本地 HTTP 协议/回调回归。 |
| `DESKTOP/scripts/test-context-usage-ownership.cjs`、`test-context-request-accounting.cjs`、`test-context-inspector-accounting.cjs` | 会话归属和延迟保存竞态、实际 Build 请求链路、前端显示与过期快照验证。 |
| 本地归档（未纳入公开仓库） | 原始失败、修复前后源码、独立审阅、完整 Build/真实 Electron 测试及最终文件身份；`REPORT.md` 为本轮入口。 |

## Build 内缓存性能（2026-09-06）

| 路径 | 构造与作用 |
| --- | --- |
| `DESKTOP/src/core/agent.ts` | `engineModel` 可接收调用方持有的 `BuildProviderCache`；按完整模型和连接配置摘要复用实例，配置失效及 forced provider 保留原优先级。Agent 不存全局或跨 Build 的 provider 缓存。 |
| `DESKTOP/src/core/agentKernelRunner.ts` | 每个 Build 建立一个局部 provider 槽供主请求及压缩检查复用；同 deployment 重试保留原 system；只在有订阅者时准备完整请求诊断。 |
| `DESKTOP/src/core/agentKernelDiagnostics.ts` | 提供 sink/日志开关的联合判定；显式诊断输出和 usage 计量契约保持。 |
| `DESKTOP/src/tests/buildCacheDiagnosticsVerify.ts` | 实际 Build 中切换 sink/日志，检查不开诊断就不遍历请求，同时保留前缀和包括零值的 usage。 |
| `DESKTOP/src/tests/buildCacheRetryVerify.ts` | Guide、同 deployment 重试、失败耗尽及真实能力 fallback 的前缀和权限回归。 |
| `DESKTOP/src/tests/buildProviderReuseVerify.ts` | 缓存配置失效、跨 Build 隔离、真实 Chat/Responses 温度兼容重试及停滞取消恢复。 |
| 本地归档（未纳入公开仓库） | 红绿回归、诊断成本基准、编译及真实 Agent/本地 HTTP 证据；`REPORT.md` 为验收入口。 |

## 长对话持久化与实时状态（2026-09-06）

最终 `95F391A6…` unpack 的 PC/HTTP 450 条历史窗口、真实回包延迟隔离、上下文计量和正常重启验收为 21/21；证据入口为 本地归档（未纳入公开仓库）。此报告明确区分本地计量夹具与真实 APInebula Build 缓存观测。

`DESKTOP/src/core/agentKernelRunner.ts` 在单次 Build 内保存请求专用任务快照，系统提示从首轮起保持完整；`ToolProvisionSession` 追加已获准的原生工具 schema，避免重排已有序列。`contextCacheHitStressVerify.ts` 验证完整首轮前缀与历史追加，供应商真实命中另由归档中的实际 Build 调用记录证明，不能以 fixture usage 代替。

| 路径 | 构造与作用 |
| --- | --- |
| `DESKTOP/src/core/agent.ts` | 会话条目的可选 `providerUsage` 版本化快照保存实际累计和末次计量；加载、切换、所有者镜像与归档沿用会话归属，不用本地 token 估计补造历史计费。 |
| `DESKTOP/src/providers/provider-events.ts` | 统一解析 Responses/Chat 及兼容 usage 的缓存读写字段，区分标准输入明细、兼容别名与明确零值。 |
| `DESKTOP/src/ui/index.html` | 历史分页、目标状态与上下文窗口刷新使用目标和加载代次校验，过期回包不能写入当前会话。 |
| `DESKTOP/scripts/test-provider-usage-persistence.cjs` | 真实 Agent 的冷加载、同名跨工作区、分支/回退、镜像和归档计量回归。 |
| `DESKTOP/scripts/test-long-conversation-ui-ordering.cjs` | 真实界面函数与受控晚回包的顺序、目标和缓存隔离回归。 |
| `DESKTOP/scripts/test-conversation-history-window.cjs` | 实际 Agent/Kernel、运行池、client/host、IPC 与认证 HTTP 的窗口传递、游标、实时消息和停止缓存保护回归。 |
| `DESKTOP/scripts/test-flow-start-cancellation.cjs` | 实际 main 命令与 utility pool 停止保护，复现并验证 Flow 预启动时停止/继续队列的交接竞态。 |
| 本地归档（未纳入公开仓库） | 首轮失败、源码回归、真实 APInebula usage 与专项验收计划；测试数据和用户生产状态隔离。 |

## PC 弹窗 4px 与 80ms 参数边界（2026-09-06）

当前三类 list 菜单使用 `--liquid-list-popup-radius: 25px` 统一外框和 clip 圆角。`pc-list-radius/` 保存 CSS 专项差异及暗亮主题的实际 computed style 比对，动画 JavaScript 不因圆角调整变化。

`pc-direction-radius-final-checks/` 保存最终 95F391A6 unpack 的菜单锚定/圆角、可信鼠标受限外拉、受控有向材质与 80ms 时序证据。材料像素夹具会隔离颜色以测量轮廓，不能当作普通用户界面截图；完整菜单截图单独保留。`FINAL-CONTEXT-RADIUS-REPORT.md` 汇总新包身份、已验收范围和仍未解决的缓存/旧无响应问题。

最新方向反馈由 `setLiquidPopupOutset` 将原始 dx/dy 映射为四侧系数，既有 `--liquid-popup-outset` 单一长度继续负责限幅和回弹。原生 popover backdrop 与普通弹窗材料层沿用同一侧向尺寸/椭圆角公式；根容器与文字不参与扩大。`pc-directional-pull/` 保存旧对称扩展失败、新方向通过和受限源码差异。

历史窗口由 `main.ts` 选择当前会话的实际 owner，`conversationKernel.ts`、Electron/WSL runtime pool、client、protocol 和 host 逐层传递可选 `{window,before}` 至 `Agent.getConversationSnapshot`。返回绝对游标，main 不再次切片；历史页不替换运行池的最新状态缓存。`server.ts` 的认证移动端历史读取复用相同 owner，独立 server 保留原本直接 Agent 路径。

`DESKTOP/src/ui/index.html` 中 `LIQUID_POPUP_MAX_EDGE_JITTER_PX` 是 PC 弹窗统一的边缘形变预算，当前为 4 CSS px。按压沿用该预算的 0.4 比例，外拉通过原有材料扩展层使用完整预算。原有 PC 长按拖动入口统一改为 80ms 激活；色块轨道、选择提交、移动动画时长、CSS 与布局不变。`DESKTOP/src/tests/pcGlassMigrationVerify.ts` 执行真实弹窗函数，检查不同尺寸、方向、按压与清理后的边界；本地归档（未纳入公开仓库） 保存旧值失败、新值通过、源码差异和打包验证。实际 Electron 采样继续保存在相邻 `pc-popup-anchor/` 目录。此前 8px、4px/300ms 文档与包作为历史证据保留。

## 共同会话命令与双端队列（2026-09-06，验收进行中）

PC IPC 和配对移动端 HTTP 负责传输、认证及目标校验，随后进入同一个会话命令入口。可执行队列、Flow、持久化历史由同一目标的运行所有者协调；两端队列面板消费权威快照，不能创建第二份会自行执行的队列。相同文字依靠不同 ID 区分，已接受请求不会因错误被自动重放，接受前失败则保留条目并暂停。

| 路径 | 构造与作用 |
| --- | --- |
| `DESKTOP/src/core/conversationCommandState.ts` | 按工作区与会话持久化可见模式、输入模式和队列暂停策略，暂存后替换，写入失败保留旧状态。 |
| `DESKTOP/src/core/conversationKernel.ts` | 管理目标运行、稳定 ID 队列、实际接受边界、Flow 外部运行租用和归档生命周期。 |
| `DESKTOP/src/core/conversationListEvent.ts` | 构造工作区范围的会话目录通知；事件不强制接收端切换当前会话。 |
| `DESKTOP/src/main.ts` / `server.ts` / `preload.ts` | 将 IPC 与 HTTP 的发送、模式、队列及历史操作接入共同命令；发布会话状态和工作区目录变化。 |
| `DESKTOP/src/core/agent.ts` / `types.ts` | 区分普通消息和 Guide 身份，保留队列元数据与持久化历史，并携带完整跨端事件。 |
| `DESKTOP/src/core/electronUtilityRuntimePool.ts` / `wslAgentRuntimePool.ts` | 对已有或尚未运行的目标提供相同队列管理入口，与主进程持有的 Flow 运行协调。 |
| `DESKTOP/src/ui/index.html` | 显示权威队列，按目标与条目 ID 处理按钮、编辑和拖动；后台更新不改变用户当前选择。 |
| `android/app/src/main/java/com/newmark/mobile/ui/ChatScreen.kt` | 队列显示、完整 ID 重排、按会话保留编辑草稿和实际接受后清理输入。 |
| `android/app/src/main/java/com/newmark/mobile/ui/NewmarkApp.kt` | 连接本地与远程界面回调，保持模式、附件和编辑目标归属。 |
| `android/app/src/main/java/com/newmark/mobile/vm/DesktopLinkViewModel.kt` / `data/MobileApiClient.kt` | 冻结提交参数，传输图文消息，按目标代次消费 HTTP/SSE，等待真实接受结果；不自动重放结果不明的修改请求。 |
| 本地归档（未纳入公开仓库） | 保存旧版本失败、修复回归、构建身份、实际配对操作和未完成的无响应调查；历史候选包不等同最终交付。 |

完整架构边界见本地归档（未纳入公开仓库）。本节的最终包与设备验收尚在执行，不能沿用下一节此前阶段的通过结论。

## 双端响应生命周期与桌面增量渲染（2026-09-06，实包校准）

本轮修复集中于已复现的模型读取、停止和列表更新问题。PC 用增量 SSE 解码器保持跨字节块的换行与 UTF-8 状态；模型 POST 独立解除 Undici 的隐式 300 秒响应头/正文期限，流式与 JSON 请求均保留既有连接、代理及显式预算。JSON 取消控制覆盖完整正文，协议终止、用户取消和提前退出都清理底层响应体。Android 用一个结构化 HTTP 交换连接协程与整个 OkHttp 调用生命周期，显式流终止不再依赖 EOF。双方标题仍先成功持久化再开始正式响应，移除独立 15 秒期限并绑定父运行取消。

桌面渲染以内容变化决定 DOM 更新，缓存完整文本、语言和运行/终态上下文；等长思考文本、终态 Markdown、Guide 与图片节点得到正确更新或复用。隔离源码 Electron 的 500 条静态会话、30 次刷新对照记录了 45,000 → 0 次无谓 DOM 写入，单次均值约 11.13 → 2.95 ms；这不是最终包性能数据，也不代表所有场景都获得相同比例提速。主题、玻璃、轨道、8px 光学预算和鼠标无泛光保持原状。

最终 PC 完整发布测试退出 0；本轮 unpack 通过九项实际 GUI 流程，以及指定 `APInebula / gpt-5.6-sol` 的两轮 CLI、两轮 GUI 真实对话。最终 Android APK 通过 315 项 JVM、56 项设备测试和九项安装包导航，模拟器两轮真实 Sol 对话及进程重启恢复通过。供应商 503 后重启、恢复通道并重发也已实测，首输入没有重复提交。包身份、渲染与启动性能、失败记录和未覆盖环境统一见本地归档（未纳入公开仓库）；本轮未生成或安装 MSI。

| 路径 | 构造与作用 |
| --- | --- |
| `DESKTOP/src/providers/provider-events.ts` | 共享 `ProviderSseDecoder`、可取消读取与模型 POST 专用 dispatcher；保留已选择的直接连接/代理委托，仅覆盖其响应头与正文隐式期限。 |
| `DESKTOP/src/providers/chat-completions.adapter.ts` / `responses.adapter.ts` | 消费完整 SSE 事件、识别协议终态，并在正常结束、取消或消费者提前返回时清理 reader。 |
| `DESKTOP/src/llm/provider.ts` | 模型请求 facade、GitHub Models 流及 JSON 生命周期；正文读取完成后才释放父取消监听和显式请求计时器。 |
| `DESKTOP/src/core/agent.ts` | 首标题直接绑定父 signal、可取消退避等待；保留冻结部署、五次尝试、持久化首消息及正式响应硬门禁。 |
| `DESKTOP/src/ui/index.html` | 会话行按内容更新、工作事件精确渲染状态缓存、终态 Markdown 恢复及未变 Guide/图片节点复用。 |
| `DESKTOP/src/tests/providerStreamLifecycleVerify.ts` | 分包边界、Unicode、多行 SSE、明确终止、提前退出及取消的生产 adapter/本地 socket 回归。 |
| `DESKTOP/src/tests/providerTransportDeadlineVerify.ts` / `providerJsonLifecycleVerify.ts` | 模型 POST 的底层期限与完整 JSON 生命周期回归，覆盖其他 fetch、代理及显式预算边界；由既有 `providerAdapterV2Verify.ts` 接入发布测试。 |
| `DESKTOP/scripts/test-conversation-title-lifecycle.cjs` | 实际 Agent/LLMProvider 的健康 16 秒标题、在途停止、可取消退避、五次失败及首消息持久化检查；`providerTimeoutRecoveryVerify.ts` 调用构建后的入口，源码探测可在内存转译而不改 `dist`。 |
| `DESKTOP/scripts/dev-renderer-stability.cjs` | 隔离 Electron 的 500 行更新、长历史流式内容、Guide/图片复用和弹窗清理检查；支持 `--exe` 指定真实 unpack，源码预览路径与包验证互斥。 |
| `android/app/src/main/java/com/newmark/mobile/data/CancellableHttpExchange.kt` | 新增结构化 IO 交换，取消覆盖响应头、正文和后续调用注册间隙，关闭所属 OkHttp call。 |
| `android/app/src/main/java/com/newmark/mobile/data/ApiClient.kt` | 复用交换生命周期，明确结束 Chat/Responses 流，保留 Responses 完成状态校验及既有网络配置。 |
| `android/app/src/main/java/com/newmark/mobile/vm/FirstInputTitleRequest.kt` / `ChatViewModel.kt` | 标题作为服务运行的 suspend 子任务，使用普通 provider 策略；供应商失败只显示安全状态/错误码/固定原因，本地保存失败单独报告。完整快照保存成功后才发布标题并允许后续正式响应。 |
| `android/app/src/main/java/com/newmark/mobile/data/ConversationStore.kt` | 本地活跃会话与归档读取；活跃会话保存返回显式 Result，同目录暂存、同步并替换快照，失败保留原文件，串行化同一 store 的写入。 |
| `android/app/src/test/java/com/newmark/mobile/data/ConversationSnapshotWriteTest.kt` / `android/app/src/androidTest/java/com/newmark/mobile/data/ConversationSnapshotWriteDeviceTest.kt` | 受控真实文件写入、部分写入失败、不可用目录和取消回归；设备另验证 Android 替换已有快照与实际 ConversationStore 返回结果。 |
| `android/app/src/main/java/com/newmark/mobile/vm/DesktopLinkViewModel.kt` | 桌面 SSE 连接使用相同可取消交换，保留重连间隔、连接代次、事件批处理和目标约束。 |
| `android/app/src/test/java/com/newmark/mobile/data/ApiClientStreamLifecycleTest.kt` / `android/app/src/test/java/com/newmark/mobile/vm/FirstInputTitleRequestTest.kt` | 本地 socket 生命周期与标题行为 JVM 回归；标题用临时文件验证持久化先于模拟正式续行。 |
| `android/app/src/androidTest/java/com/newmark/mobile/data/ApiClientStreamLifecycleDeviceTest.kt` / `android/app/src/androidTest/java/com/newmark/mobile/vm/FirstInputTitleRequestDeviceTest.kt` | 在设备网络栈重复生产交换/标题辅助函数场景，不把辅助函数测试冒充完整 ViewModel 或真实供应商验收。 |
| 本地归档（未纳入公开仓库） | 原始分包/终止失败、真实长静默期限及 JSON 探测、隔离编译、Node/Electron 局部回归与源码身份。 |
| 本地归档（未纳入公开仓库） | 静态列表/内容复现及源码测量、10 项渲染场景、标题前后证据与 `TITLE-GATE-REPORT.md`；后续包测试不得沿用源码数字充当结果。 |
| 本地归档（未纳入公开仓库） | 旧生产 API 的 socket/标题期限复现、修复范围与源码冻结身份；最终构建和设备结果由根任务归档。 |
| 本地归档（未纳入公开仓库） | 本轮统一操作记录、修改前资料、完整构建日志、模拟器诊断和 unpack 实测证据；中间状态不能替代最终验收。 |
| `DESKTOP/scripts/release-real-provider-stress.cjs` / `test-real-provider-stress-harness.cjs` | 隔离凭据与运行根的真实供应商 CLI/GUI 压测；按本次目标、新 runId 判断终止失败，保留错误类别与启动清理；受控夹具核验旧运行不干扰、错误即时退出与原成功标记。 |

## 灰黑暗色主题与右栏渲染（2026-09-06）

双端共享中性灰黑层次，覆盖普通文字、画布、编辑器、玻璃及独立启动/预览窗口；功能色、浅色主题、现有轨道和动画参数保留。Android 宽屏根层提供不透明主题底色，手动暗色时系统图标前景也跟随应用主题。右侧分页分离静态色块、共享移动玻璃和固定图标层，实体触控只由轨道手势拥有，辅助功能点击调用相同切换入口。

| 路径 | 构造与作用 |
| --- | --- |
| `DESKTOP/src/ui/index.html` | 灰黑语义色、玻璃 RGB、原生选择器、编辑器及功能面板底色。 |
| `DESKTOP/src/ui/startup.html` / `DESKTOP/src/main.ts` | 独立启动页、原生窗口底色和独立预览文档的中性色。 |
| `android/app/src/main/java/com/newmark/mobile/ui/theme/NewmarkTheme.kt` | 中性主题 token 与 Material 容器，避免默认紫色表面染色。 |
| `android/app/src/main/java/com/newmark/mobile/ui/Sidebar.kt` / `ChatScreen.kt` / `MemoryLabScreen.kt` | 独立侧栏/聊天配色、执行栏与编辑器底色、普通图关系连线。 |
| `android/app/src/main/java/com/newmark/mobile/ui/NewmarkApp.kt` | 宽屏透明预留槽下的主题画布、系统栏图标对手动主题的响应。 |
| `android/app/src/main/java/com/newmark/mobile/ui/RightSidebar.kt` | 静止分页色块、共享浮起玻璃、独立图标前景；折射仅采样载体底色，保留 alpha 与统一触控入口。 |
| `android/app/src/androidTest/java/com/newmark/mobile/ui/RightSidebarRenderingTest.kt` | 真正硬件像素验证右栏载体、静止/长按/落地、图标和图标中心短按。 |
| 本地归档（未纳入公开仓库） | 本轮源码快照、调色清单、原始失败、构建日志与双端画面对照；交付状态见 `report.md`。 |

## 移动端触点、阻尼与对话浮块（2026-09-06）

浮块的轨道位置与手指光源位置分离：在原手势处记录窗口坐标，在实际移动的玻璃内重新投影绘制，保留 66dp 泛光半径和形状裁剪。55ms 阻尼仅影响显示位置，原轨道、选项与重排目标继续由真实输入决定。释放时将显示位置交接给原有移动后落地动画。弹窗的玻璃与内容共享实际图层变换。

本地与远程对话浮块显式从左上角测量超宽布局，消除 requiredWidth 的隐式居中偏移；28dp 横向扩展朝右呈现，2dp 抬起右移量落地归零。拖动位移使用同一事件坐标系内的前后点，并累计小步位移，避免行跟随手指后在松手时反向复位或误判为静止长按。287 项单元测试、25 项设备测试及九项最终 APK 导航检查通过，已复制 APK 并核验模拟器实际安装字节。交付状态见本地归档（未纳入公开仓库）。PC 源文件哈希与本轮开始时一致。

| 路径 | 构造与作用 |
| --- | --- |
| `android/app/src/main/java/com/newmark/mobile/ui/components/LiquidContact.kt` | 非消费式原始触点观察、窗口坐标状态、图层变换逆映射和释放后触点生命周期。 |
| `android/app/src/main/java/com/newmark/mobile/ui/components/LiquidDragFollower.kt` | 单协程拥有的短时阻尼、逐帧位置与速度、停止读回和取消清理。 |
| `android/app/src/main/java/com/newmark/mobile/ui/components/LiquidHoldGesture.kt` | 保留 300ms 阈值，统一接入触点；移动节点使用当前事件的 previousPosition 计算真实增量。 |
| `android/app/src/main/java/com/newmark/mobile/ui/components/LiquidGlass.kt` | 形状内触点泛光、浮块窗口坐标映射、按钮光学逆变换，以及弹窗内容和材质的共同弹性图层。 |
| `android/app/src/main/java/com/newmark/mobile/ui/components/ProviderSettingsCapsules.kt` | 横纵模型/供应商轨道接入触点和显示阻尼；保持既有扩边、选择与落地行为。 |
| `android/app/src/main/java/com/newmark/mobile/ui/Sidebar.kt` | 本地/远程对话与两组底部按钮的触点和阻尼；对话玻璃向右展开，点击与重排起终点不偏移。 |
| `android/app/src/main/java/com/newmark/mobile/ui/RightSidebar.kt`、`MemoryLabScreen.kt` | 分页浮块同样接入触点、阻尼和释放交接；图谱保留平移/缩放，同时参与弹窗按压反馈。 |
| `android/app/src/test/java/com/newmark/mobile/ui/components/LiquidContactAndDampingTest.kt` | 真实点逆映射、触点生命周期、不同刷新率阻尼、无越界与方向变化的数值回归。 |
| `android/app/src/androidTest/java/com/newmark/mobile/ui/PointerGlowRenderingTest.kt` | 横纵离轨手指、静止手指与移动浮块、快速拖动的实际光峰像素比较。 |
| `android/app/src/androidTest/java/com/newmark/mobile/ui/ConversationLiftRenderingTest.kt` | 开启真实硬件绘制；验证已渲染基准、右侧包边像素、点击逐帧端点及连续小步重排；结束恢复测试绘制状态。 |
| `android/app/src/androidTest/java/com/newmark/mobile/ui/ProviderGlassRenderingTest.kt`、`UtilityGlassRenderingTest.kt` | 等厚扩边、固定文字、弹窗内容共同变换、早释放、泛光裁剪及底部按钮导航时序回归。 |
| `android/scripts/verify-utility-apk.py` | 对最终发行 APK 执行九项真实导航、进程连续性、页面内容及截图检查，仅作用于指定模拟器。 |
| `android/isolated-release-mobile-pointer-20260906/` | 本轮独立 Release 构建输出，保留原发行目录。 |
| `APK/Newmark-Agent-0.5.15-mobile-pointer-20260906.apk` | 当前移动端交付包，66,784,518 字节，版本 0.5.15 / 515；已复制到剪贴板。 |
| 本地归档（未纳入公开仓库） | 原始快照、失败及被拒绝的截图证据、最终硬件绘制截图、源码/包身份、构建、测试和交付记录。 |

## PC 8px 方向反馈与透明度调整（2026-09-06，已打包并安装）

最新请求将 PC 光学弹性限定为 8px：按下立即内缩，原有 300ms 长按阈值触发色块移动时开始弹性恢复，之后受限外拉使单层真实磨砂面均匀向外扩展；拖动松手直接恢复。原内容和文字不缩放，色块轨道、目标和落地流程保留。弹窗独立 alpha 为共享偏好 alpha 的 0.82 倍，默认 0.5576；同时修复浅色通用样式误关闭命令弹窗磨砂的问题。

最终完整发布测试返回 0，暗亮四组按压时序、六组方向材质、15 项手势和八次滚动像素对照通过；最终源与包内 UI 字节一致。MSI 已完成一次提升与原生安装，294 个载荷、20,982 个既有用户文件、产品身份及重启队列核验通过，隔离资料 GUI 和实际开始菜单激活分别通过。当前产品 `{BFEDA7BF-0B0E-4578-A8FA-31B57ACBE932}`、包 `{737E20AA-55E0-4190-86F5-4085DDED49F0}`，安装 ASAR 为 `F6E9E0D2AC3A79828D1BDEC288B6CE074F72ACAAC9B2506637A65125C29BE637`。已核验 MSI/ZIP 同步标准 `release/`，完整证据见本地归档（未纳入公开仓库）。10px 中间安装、未安装的初版 8px 包及下方各次 MSI 身份均为历史构建。

| 路径 | 构造与作用 |
| --- | --- |
| `DESKTOP/src/ui/index.html` | 弹窗透明度与 8px 光学预算；原生菜单 backdrop 或同父级装饰面承担单层外扩磨砂，原文字、滚动和选项布局固定；负责释放、关闭及失焦时的光学清理。 |
| `DESKTOP/src/tests/pcGlassMigrationVerify.ts` | 桌面光学预算、方向、单层磨砂及释放渲染契约。 |
| `DESKTOP/scripts/dev-popup-direction-regression.cjs` | 暗亮三种弹窗真实外扩和内缩像素、外圈磨砂、滚动、重复拉动及取消清理验证。 |
| `DESKTOP/scripts/dev-popup-press-timing.cjs` | 按下、长按拾起回弹、轨道内移动、边界外拉及快速再按压的可信输入、逐帧和真实轮廓检查；隔离测试窗口以排除桌面外来鼠标事件。 |
| `DESKTOP/scripts/cdp-test-window-isolation.js` | 共享 Node 调试连接工具，验证自有测试进程身份后移动测试窗口；页面连接仍等待主界面就绪，保留真实渲染与生产事件处理，避免鼠标污染像素对照。 |
| `DESKTOP/scripts/dev-liquid-gesture-regression.cjs` | 实际 Electron 点击、长按、端点和宽浮块位置测量，并记录 UI 字节身份。 |
| `DESKTOP/scripts/dev-uniform-popup-visuals.cjs` | 等待设置真实内容就绪，再比较暗亮 14 阶段、文字几何和选项移动。 |
| `DESKTOP/scripts/dev-popup-scroll-regression.cjs` | 独立目录输出、实际材质透明度对照及滚动像素稳定性检查。 |
| 本地归档（未纳入公开仓库） | 方向复现、材质原型、最终像素/交互证据、源码与 Android 范围核对、发布日志和安装后 GUI/开始菜单交付证据。 |
| 本地归档（未纳入公开仓库） | 本轮独立安装事务、完整载荷及用户文件、产品身份和重启队列核验。 |
| `release-0.5.15-8px-press-phases-20260905/` | 本轮新建 MSI、ZIP 与对应 unpacked 载荷的输出目录。 |
| `release/` | 已核验并完成安装的当前 MSI 与配套 ZIP；替换前的标准产物保存在本轮归档的 `previous-standard-assets/`。 |
| 本地归档（未纳入公开仓库） | 已被本次要求取代的 10px 构建与安装证据，保留其并发用户启动导致原始用户状态校验失败的完整记录。 |

## PC 安装器与重启队列修复历史（2026-09-05，已完成，上方为最新构建）

该次构建位于 `release-0.5.15-frosted-safe-20260905/`，曾同步标准 `release/`，包含均匀磨砂弹窗、全程色块移动及固定滚动视口绘制。该 MSI 曾实际安装至 Program Files：ProductCode `{9AA8281A-1835-4674-AA60-FE1D4034874A}`、PackageCode `{039EC3F2-B615-443F-951D-0B072EC4AB0D}`、版本 `0.5.15.0`，294 个载荷与包一致，20,965 个既有用户文件未被安装改写。该次清除 3 组 Newmark 重启任务并原样保留其他 15 组；普通用户 GUI 和无测试参数的真实开始菜单启动通过。以上为历史身份，当前交付以上方章节为准。

首个中间 MSI 在后续审计中被发现仍受旧重启任务影响，已标记为被取代；最终提升曾被 Windows 取消，用户明确要求继续后，最终 worker 一次 MSI 事务完成并通过全路径核验。详细原因、原始失败与最终证据保存在本地归档（未纳入公开仓库）。

| 路径 | 构造与作用 |
| --- | --- |
| `DESKTOP/scripts/install-windows-msi.ps1` | 共享已授权提升协调器、原生安装事务、真实进程退出确认、目标重启队列归属/清理/回读、载荷与用户状态核验。 |
| `DESKTOP/scripts/patch-msi-project.cjs` | 为生产 MSI 目录表和两个检查返回值的安装动作补全声明；使用编码脚本，卸旧前停止相关产品进程，写入前清理目标队列。 |
| `DESKTOP/scripts/test-install-pending-operations.ps1` | NT/历史路径前缀、严格目录边界、其他应用原始 pairs、并发变化及回读失败回归。 |
| `DESKTOP/scripts/test-install-process-stop.ps1` | 真实隔离进程及错误场景，确认同目录进程退出、其他目录进程保留、残存时失败。 |
| `DESKTOP/scripts/test-msi-authoring.cjs` | 生产形态模板编译、实际 MSI 表与原生格式化、缺失目录声明、新建/特殊字符路径及编码脚本执行检查。 |
| `DESKTOP/scripts/test-install-windows-msi.ps1` / `test-install-update-msi.cjs` | 原有发布验证入口，已接入新增 pending、进程及原生作者回归。 |
| 本地归档（未纳入公开仓库） | 完整应用发布检查、首个中间构建及 GUI 记录；该 MSI 因后续队列审计被取代。 |
| 本地归档（未纳入公开仓库） | 最终重封装日志、仅一项载荷差异证明、包身份、最终 GUI/开始菜单检查、被拒绝中间包归档及交付记录。 |
| 本地归档（未纳入公开仓库） | 根因诊断、回归、实际发行 MSI 表/旧安装根检查、最终安装及队列/文件/用户数据证据。 |
| `release-0.5.15-frosted-safe-20260905/` | 最终 MSI、ZIP 及对应 unpacked 载荷，应用 ASAR 与完整发布检查通过的构建一致。 |

## Android APK 再次交付（2026-09-05 19:49）

本地归档（未纳入公开仓库） 保存本轮 `assembleRelease`/`lintVitalRelease` 日志、203 个输入文件哈希、签名/对齐/二进制 Manifest 检查、735 个 ZIP 条目校验及复制回执。`verify-content.py` 核对 DEX 修复标记和已知路径/令牌形态；`copy-apk.ps1` 核对源/副本哈希并写入、回读文件剪贴板。交付继续使用 `APK/Newmark-Agent-0.5.15-recovery-20260905.apk`，SHA-256 `A81F58BCC44814DD9B0DEE4EB6278B9056C97A9636BE62AFE9B2665740E32B63`。移动端源码和包内容未变，因此复用相同字节包的九项既有模拟器导航证据；本轮无新设备运行。

## PC 材质与滚动装饰层（2026-09-05 后续源码变更）

本轮只改 PC CSS 渲染，HTML 内容树和全部内联 JavaScript 与本轮前一致。弹窗使用主题中性半透明底色、可调磨砂和窄边；菜单活动色块不再切换玻璃。列表弹窗的边缘及触控光使用滚动视口自身绘制，绝对定位 Canvas/伪边框不再参与可见合成。这些界面字节已纳入顶部所列最终 MSI，安装状态以上方交付记录为准。

| 路径 | 构造与作用 |
| --- | --- |
| `DESKTOP/src/ui/index.html` | 共享材质 tokens、活动色块样式、滚动菜单背景/边缘绘制；DOM 和交互实现保持不变。 |
| `DESKTOP/scripts/dev-uniform-popup-visuals.cjs` | 隔离 Electron 真实设置、命令及模型菜单的暗亮 14 阶段截图、几何/内容/手势代码对照。 |
| `DESKTOP/scripts/dev-popup-scroll-regression.cjs` | 30 项滚动菜单，可信滚轮事件、逐像素固定外壳验证、均匀底色/背景透射/可见触控光检查。 |
| `DESKTOP/scripts/dev-liquid-renderer-performance-smoke.cjs` | 独立控件 WebGL 合成和资源预算检查；保留原生 pointer capture，固定可见的 CDP 测量视口。 |
| `DESKTOP/src/tests/pcGlassMigrationVerify.ts` | 新磨砂/色块材质契约及既有轨道、裁剪、5px 边缘约束。 |
| 本地归档（未纳入公开仓库） | 原始 CSS、文档快照、滚动复现与修复记录、构建及测试日志。 |
| 本地归档（未纳入公开仓库） | 实际 Electron 暗亮主题前后 PNG 和几何、材质、时序采样 JSON。 |

验证结论及范围以本地归档（未纳入公开仓库）为准。

## 当前修复状态与文件职责（2026-09-05）

项目目标是让桌面、CLI/TUI 和原生 Android 共享可持续的会话与工作区体验。本轮保留既有并行工作，集中修复液态玻璃的形状、位置、裁剪、手势生命周期及同版本 Windows 安装。最终状态与产物身份以本地归档（未纳入公开仓库）为准；下方旧版本完成勾选只代表历史记录。

当前验收已完成：Android 281 单测、14 设备绘制及九项最终 APK 导航通过；PC 15 项实际 Electron 交互及适用发布检查通过（WSL 环境不可用，记录跳过）。MSI 一次管理员事务安装成功，292 文件/产品身份/20,956 用户状态文件/CLI 与普通用户 GUI 均核验通过，实际开始菜单启动正确程序。最终安装记录见 本地归档（未纳入公开仓库）。

| 路径 | 本轮构造与作用 |
| --- | --- |
| `android/app/src/main/java/com/newmark/mobile/ui/components/LiquidGlass.kt` | 共享光学层、66dp 内部触控光源、独立内容绘制、按压生命周期与取消分支；采样浮块限定 CornerBasedShape。 |
| `android/app/src/main/java/com/kyant/backdrop/DrawBackdropModifier.kt` | 底层 backdrop/surface/front 轮廓裁剪及绘制失效，修复 surface pass 越界。 |
| `android/app/src/main/java/com/newmark/mobile/ui/components/ProviderSettingsCapsules.kt` | 横纵轨道实际等厚 12dp 外扩、轴互斥及到达后落地。 |
| `android/app/src/main/java/com/newmark/mobile/ui/Sidebar.kt` | 左栏三按钮及本地/远程会话浮块、静态同级 backdrop 记录、移动完成后导航。 |
| `android/app/src/main/java/com/newmark/mobile/ui/RightSidebar.kt` / `MemoryLabScreen.kt` | 分页选项移动、提前松手/取消的任务所有权；右栏按实际按钮边界约束拖动。 |
| `android/app/src/androidTest/java/com/newmark/mobile/ui/UtilityGlassRenderingTest.kt` / `ProviderGlassRenderingTest.kt` | 设备上的动画帧、实际位置、内容像素、光效裁剪、导航次数与取消验证。 |
| `android/app/src/test/java/com/newmark/mobile/ui/components/LiquidGlassMotionRegressionTest.kt` | 等厚外扩几何和实际协程动画衔接回归。 |
| `android/scripts/verify-utility-apk.py` | 在最终 Release APK 上安装并以实际输入检查三按钮、方向/主题、进程存活和目标页面，保存截图/XML/日志。 |
| `DESKTOP/src/ui/index.html` | 轨道/弹窗事件归属、选中色块连续移动、实际像素变形上限及鼠标/触控光源分流。 |
| `DESKTOP/scripts/dev-liquid-gesture-regression.cjs` | 真实 Electron 输入与逐帧矩形/像素回归；800px 宽浮块仍受 5px 边缘上限约束。 |
| `DESKTOP/scripts/install-windows-msi.ps1` | 准备 MSI 身份/管理映像、一次提升后的原生 API 事务、状态监控及安装逐文件验证。 |
| `DESKTOP/scripts/install-current-msi.ps1` / `DESKTOP/src/core/installUpdate.ts` | 手动、GUI、CLI 共用安装入口；旧根目录安装脚本转发至此。 |
| `DESKTOP/scripts/test-install-windows-msi.ps1` / `test-install-update-msi.cjs` | 路径转义、错误分类/重试、事务证据及内置安装调用回归。 |
| 本地归档（未纳入公开仓库） | 原包崩溃、需求矩阵、移动设备/构建结果及文档旧版归档。 |
| 本地归档（未纳入公开仓库） / 本地归档（未纳入公开仓库） | PC 真实交互前后证据与安装器诊断/旧入口归档。 |
| `release-0.5.15-recovery-20260905/` / `APK/` | 本轮隔离发布结果与已核验的 Android 交付副本；以修复记录中的最终哈希确认当前包。 |

## dev-0.5.14 上一发行版状态

当前统一版本为 Desktop/root `0.5.14`、Android `versionName=0.5.14` / `versionCode=514`。本轮修改覆盖：`DESKTOP/src/main.ts` 的退出生命周期和桌面队列 IPC，`DESKTOP/scripts/patch-msi-project.cjs` 的安装目录进程/待删除保护，`DESKTOP/src/core/agent.ts` 与 `DESKTOP/src/ui/index.html` 的首标题、Guide 和 PC 队列时间线，`DESKTOP/src/tools/` 的 provision-only `web_catch`，以及 Android `LocalTool*`、`NewmarkApp.kt` 的本地工具与跨端投影；`ChatScreen.kt` 既有的中点阈值避让/落点实现由全量契约继续覆盖。`DESKTOP/src/llm/provider.ts`、`providers/provider-events.ts`、`tools/index.ts` 新增统一的 `undici.ProxyAgent` 模型/网页代理链路；Android `LocalAgentForegroundService.kt` 接受 `TRANSPORT_VPN`、不依赖 VALIDATED 回调快照，并使用 API 29+ 低延迟 Wi-Fi 锁。本地归档（未纳入公开仓库） 保存每轮诊断、验证和发行证据；历史 `dev-0.5.13` 交付物保持原样，不冒充 0.5.14 候选。

`DESKTOP/src/ui/index.html` 的 `workRunDisplayImages`/`appendWorkDisplayImages`、`ChatItem.Bubble.displayedImages`/`WorkDisplayImagePreviews` 以及 TUI `appendChatMessage` 共同承担 `image_display` 的最终回复投影：Build 工具页证据保留，PC GUI、PC TUI 与移动端最终回复均按调用顺序在正文之前展示公开图片。

主要数据流：首用户输入 → 独立标题探测/持久化 → `conversation_title` 元数据刷新 → 正式 Agent Build；PC/移动端 Next → ConversationKernel 稳定队列 id → `queue_update`/snapshot → 双端同序投影；Guide → WorkRun 权威 sequence → 双端原位渲染；`web_catch` → 模式策略 → PC `tool_provision` / Android Build-Goal 直接 schema 暴露 → 公网/容量/工作区边界 → 临时文件原子落盘；模型/网页请求 → `proxy` 配置或 `HTTPS_PROXY/HTTP_PROXY`（未显式禁用时环境变量回退，且 `providerProxyConfig()` 不再误传 `enabled=false`）→ `undici.ProxyAgent`（显式禁用配置优先，回环直连）；Android 网络可用性 → INTERNET + (VALIDATED 或 VPN) + 实际状态直接检查。

当前验证基线：最终 `npm run test:full-release`、Desktop build、主验证 `1708/1708`、tool provisioning `80/80 + 80/80`、launcher `28/28`、带图队列/Guide 聚焦回归、PC/Mobile/TUI `image_display` 最终回复顺序画廊（24 张压力）以及 Android `71 suites / 270/270` JVM、lintVitalRelease 与 release assembly。生成的 release APK 位于 `android/app/build/outputs/apk/release/app-release.apk`，免安装输出目录另有 `Newmark-Agent-0.5.14-android.apk`。免安装 unpack 已构建并通过 packaged SSH/TUI、CLI、上下文压缩、console-wrapper、asar/图标和 ZIP 冒烟；0.5.14 MSI 已生成但未安装，仍未执行重启后的安装态 GUI/TUI 黑盒复验。

`release-0.5.14-full-platform/` 六个发行资产：Windows MSI `9576F6D5902CBFEC1ADFAF0B322ACFDDB4F6BD1B3610DCCC2A2A748EC95C8969`，Windows ZIP `68541B0A44F2788CCC06C232721080DDAC7534A4197DB508229AEB7BB72EAEF1`，Linux AppImage `02818508563A229DDC57F2F64541D6538DB1B0C0688807BC75D34CE0BEBB685A`，Linux Deb `D478F4E3D4F8B036B0D438997E5229F3F737C34987D70FCBCBA69EDB58F6DA80`，Linux ZIP `B1035B594CF7B843355D7034FE811DEBA6DFED267A5DC993F71404E39DE055CC`，Android APK `B609B36B382E7753A98789A8B415C5478142975AAE6E5F6C160F65A630A628F9`。

## dev-0.5.13 双端累计交付与当前 r5 APK + Windows MSI

全平台 `dev-0.5.13` 发行规范：Tag `dev-0.5.13`，Release 标题 `Newmark Agent dev-0.5.13`；`DESKTOP/scripts/release-tag-audit.cjs` 强制该格式，并保留远端历史 `dev-*` 正式 Tag。Windows、Linux、Android 六资产已通过本地 release-assets 校验，随后又通过 GitHub 远端下载哈希核对与 Windows/MSI、WSL AppImage/deb/ZIP 打包态 smoke，完整路径记录在 `DESKTOP/scripts/release-notes-dev-0.5.13.md`；发布归档见 本地归档（未纳入公开仓库）。

- PC 当前源码与构建产物已覆盖标题先行门禁、Search MCP 池、`browser_use.visible`、图片视觉、PDF 整体工具超时、局部快照稳定性、Build 暗色按压和中断回复恢复；typecheck、build 与完整 `test:full-release` 通过，包括 1702/1702 主验证、thinking tier 68/68、压缩压力 34/34、模型恢复、TUI、SSH/WSL、CLI 与三端压力。无供应商标题门禁错误同时保留 `No LLM configured` 可操作诊断。`pdf_read` 一个累计 deadline 覆盖异步文件读取、pdf.js 全文解析和扫描页浏览器观察，阶段性超时返回可恢复回执并允许同一 Agent 继续响应。既有 PC MSI/ZIP 早于本轮最终源码，因此本次不把它们作为当前交付物。
- Android 当前源码已覆盖标题先行门禁、冻结 provider/model/intelligence/native reasoning、OpenAI Responses、Search MCP 兼容层、后台 Agent 服务与恢复、输入/Guide、设置玻璃返回按钮、模型视觉 `image_inspect`、离线 Markdown/LaTeX 字体、代码块约束内软换行与亮暗主题高亮色板；Responses 聚焦 32/32、70 suites / 269/269 JVM、Vital Lint、R8、资源收缩及隔离 clean Release assembly 通过。
- 当前 APK：`APK/Newmark-Agent-0.5.13-dual-platform-final-r5-release.apk`，52,794,422 bytes，SHA-256 `C87DFA53B309D4FE1790FCB5F1EB2084F67BE6E44FC27D76D5E8E4E84A30A14B`。隔离构建源与交付副本字节一致；r2、r3、r4 均保留为历史候选且未被覆盖。
- 当前 Windows MSI：`release-0.5.13-r5-title-retry-msi-20260902-3/Newmark-Agent-0.5.13-x64.msi`，249,629,109 bytes，SHA-256 `AD9427B36178473BAF461C63119D14B5DF1B27EC510205205DD991845ECEE462`；配套 zip `Newmark-Agent-0.5.13-win-unpacked-x64.zip`，326,302,457 bytes，SHA-256 `91644890407C4C7A1F8BC8F84FEAB5D55F3B71D66517EDA7F744D71A0D97C803`。
- 移动端字体适配候选：`APK/Newmark-Agent-0.5.13-mobile-md-font-r8-release.apk`，66,686,998 bytes，SHA-256 `05A26E0EE66541F656E39412384A689B06AAA2A4ABA363043516C2B862D6A1FE`；AAPT 将字体短名化为 `res/wo.otf`（Noto Sans Mono CJK SC）与 `res/xz.ttf`（Noto Sans Math）。高亮色板按亮暗主题切换，亮色字色更暗且可读；r7/r6 保留为回滚候选。
- 二进制门禁：`com.newmark.mobile`、`0.5.13` / `513`、minSdk 24、targetSdk 36、`MainActivity` 可启动；`LocalAgentForegroundService` 为 `exported=false`、`stopWithTask=false`、`foregroundServiceType=specialUse`，subtype 为长期用户可见本地/远程 AI Agent 网络会话；zipalign 4 通过，APK Signature Scheme v2 通过。
- 逐 Zip entry 字节扫描未命中开发者 profile/workspace、其他用户目录、凭据或私钥；裸数字 `12252` 仅命中 6 个 vendor 文件（4 个 PDFBox CMap、2 个 BouncyCastle SIKE 常量），4 ABI ML Kit 库内的 `/home/build` 为第三方通用构建标记。API 35 `emulator-5554` 在 ADB 重启后冷启动恢复在线，`adb install -r` 成功；显式启动后 2 秒与 7 秒均为 `MainActivity` topResumed，PID 3173 保持不变，FATAL/ANR 为 0。该结果不替代真机设置按压帧、真实供应商、配对 PC stdio bridge 和后台长运行切网验收；签名仍为 Android Debug，非商店生产签名。

## dev-0.5.13 移动端设置返回按钮光学画布

- `android/app/src/main/java/com/newmark/mobile/ui/SettingsScreen.kt`：设置主页、设备管理、模型与供应商、新建供应商、模糊注入、权限、插件、供应商详情与新建模型共用的顶栏返回按钮，从直接挂载于 36dp RenderNode 的 `glassButtonSurface` 改为 `GlassButtonCanvas`。逐页 `when (page)` 返回目标、36dp 布局/命中区、20dp 图标、主题语义色与既有点击动画均保持不变。
- `android/app/src/main/java/com/newmark/mobile/ui/components/LiquidGlass.kt`：复用既有 8dp `GlassButtonCanvasOutset` 和 `CenteredInsetShape`，仅扩大不参与父级测量或点击命中的光学子层，从根因上容纳 1.065 浮起、高光、阴影与折射边缘。
- `SettingsBackButtonGlassCanvasContractTest.kt` 与 `GlassButtonCanvasOutsetContractTest.kt`：锁定共享顶栏、36dp 名义尺寸、圆形材质、返回语义和透明外扩实现，防止重新把玻璃绘制挂回按钮等大画布。
- 验证：设置玻璃聚焦契约与 Android 全量 `testDebugUnitTest` 通过。修复已进入上述当前 r5 APK；尚未执行真机逐帧视觉验收。

## dev-0.5.13 双端 Search MCP 兼容层

- `DESKTOP/src/core/searchMcpPool.ts`：维护九个候选名称的发行清单；每轮重新读取 `user/.Newmark/search-mcp.json`，完整访问所有启用节点，支持 stdio、Streamable HTTP 与 SSE，并在完成本轮检查后选择最高优先级成功结果。健康快照原子覆盖写入 `search-mcp-health.json`，运行时从不读取该文件做熔断或跳过。
- 同一文件只发现并调用 schema 已验证的公开网络搜索工具：必须有字符串查询字段，只允许查询、数量、排序、语言、地区、时间与安全搜索参数；命令、路径、文件、脚本、代码、header/body/method 等字段会使工具失去准入。结果文本与 `structuredContent` 均限制为 60,000 字符。
- `DESKTOP/src/tools/index.ts`：公开独立的 `webSearchMcpOnly` 边界；普通 `web_search` 仍使用 MCP 池 → Bing HTTP → DuckDuckGo HTTP 的固定容灾链，MCP-only 调用则只返回本轮 `invocationId`、`checkedAt`、结果与 attempts，绝不进入 HTTP fallback。
- `DESKTOP/src/server.ts`：提供 Bearer 认证 `/api/mobile/web-search-mcp`、兼容旧调用的完整 `/api/mobile/web-search` 与只读 `/api/mobile/search-mcp-manifest`；公开清单移除 stdio command/args/cwd，只公开非敏感元数据、env/header 名称和已脱敏 URL。
- `android/app/src/main/java/com/newmark/mobile/data/MobileSearchMcp.kt`：实现严格 JSON-RPC id 匹配的 Streamable HTTP/SSE search-only 客户端；stdio 通过配对 PC 的 MCP-only bridge 执行。桌面 MCP 与 Android 直连 MCP 全部完成后，外层才按 Bing → DuckDuckGo 回退。
- `android/app/src/androidTest/java/com/newmark/mobile/data/SearchOnlyHttpMcpDeviceTest.kt`：在 Android 设备网络栈上执行 Streamable HTTP 与 Legacy SSE 的 initialize → tools/list → tools/call 准入；固定回环用例验证非空公网 URL 和“仅非搜索工具时绝不调用”，显式 live 参数可经 `adb reverse` 连接宿主真实搜索 MCP，且不会预先写入用户清单。
- `DESKTOP/scripts/probe-search-mcp*.cjs` 与 本地归档（未纳入公开仓库）：记录真实握手/调用证据并自动清理 Windows/POSIX 本地路径。Wuxing 因缺少 SearXNG 保持默认禁用；`@ignidor/web-search-mcp` 是唯一真实调用成功的默认节点。
- `@ignidor/web-search-mcp` 包本身约 276 KiB，但声明可选 Playwright；当前 lock 中 Playwright/Playwright Core 文件约 18.5 MiB（不含浏览器下载）。search-only 路径不会调用其爬虫/截图工具，后续发行体积优化可通过安装阶段排除该可选依赖，但本轮保留以避免改变共享依赖解析。
- 验证：Desktop typecheck、build、`searchMcpPoolVerify`、`browserUseVerify`、`browserUseVisibleContractVerify` 与移动 API 53 项认证/契约探测通过；Android Search MCP JVM 专项 14/14 及全量 263/263 通过。模拟器设备网络栈 instrumentation 4/4 已通过 Streamable HTTP、Legacy SSE、非搜索工具拒绝和经 `adb reverse` 连接真实 Ignidor bridge 的 live 准入。

## dev-0.5.13 移动端供应商协议与 OpenAI Responses

- `android/app/src/main/java/com/newmark/mobile/data/ProviderConfig.kt`：定义 `openai`、`openai_responses`、`anthropic`、`github_models` 四个规范协议，并在旧配置、设备导入与 Agent 设置写入边界迁移 `responses`、`openai-compatible`、`claude`、`github` 等历史别名。
- `android/app/src/main/java/com/newmark/mobile/data/ProviderStore.kt` 与 `LocalToolExecutor.kt`：读取、保存及 `settings_update.providers` 全量替换统一规范化协议，同时保留供应商 ID、名称、接口、API Key 与模型字段。
- `android/app/src/main/java/com/newmark/mobile/ui/SettingsScreen.kt` 与 `ChatViewModel.kt`：新建、模糊注入及既有供应商详情均使用同一横向协议胶囊切换；变更直接落入供应商配置，不引入全局协议开关。
- `android/app/src/main/java/com/newmark/mobile/data/ApiClient.kt`：显式 Responses 供应商跳过 Chat Completions；官方 API 根补齐 `/v1/responses`，`/v1`、完整 Chat/Responses 端点和兼容网关自定义路径保留其前缀。流式解析覆盖 reasoning、output/refusal text、function call 与参数增量；`response.completed` 还会校验内嵌状态，非流式 JSON 也只接受明确 `status=completed`。`failed`、`incomplete`、`cancelled/canceled`、`queued`、`in_progress`、未知或缺失状态全部失败，`incomplete_details.reason` 会进入受控错误原因。
- 聚焦回归位于 `ApiClientStreamTest.kt`、`ManualProviderModelCreationTest.kt`、`ProviderCatalogMergeTest.kt`、`ProviderStoreCleanInstallContractTest.kt`、`LocalToolContractTest.kt` 与 `ProviderSettingsCapsuleRailContractTest.kt`。`ApiClientStreamTest` 32/32、Android 全量 269/269 均通过。

## dev-0.5.13 运行时稳定性增量

- `DESKTOP/src/core/displayImages.ts`：提供工作区内 PNG/JPEG 的统一只读视觉加载器，复用 10 MiB、格式一致性、真实路径边界和 40MP 解码限制。
- `DESKTOP/src/core/agent.ts`：`image_inspect` 新增 `inspect + path`，只在当前模型已通过视觉验证时生成一次性模型观察。
- `DESKTOP/src/tools/index.ts`：公开工作区图片视觉 schema；`pdf_read` 增加工具级 `timeout_ms` 与可恢复超时回执。
- `DESKTOP/src/ui/index.html`：仅在长运行局部快照明确携带 `chatMessages` 时重建文字对话。
- `TUI/src/data.js` 与 `DESKTOP/scripts/release-linux-real-provider-smoke.cjs`：移除开发者机器路径，改用虚构演示地址和安装者本机 `.Newmark` 动态路径。
- `DESKTOP/src/tests/verify.ts`：覆盖视觉、PDF 超时、局部快照稳定性与发行路径隐私门禁。

## dev-0.5.13 PC Build 展开按压暗色修复

- `DESKTOP/src/ui/index.html`：将 `.conversation-work-run-head` 从通用 `:active { background-color: revert }` 回退规则中拆出，按住态显式保持透明且无背景图，避免 Chromium 原生白色按钮底覆盖暗色对话时间线。
- `DESKTOP/src/tests/pcGlassMigrationVerify.ts`：增加 Build 标题按住态不得进入 `revert` 背景规则的静态契约。
- `DESKTOP/scripts/release-ui-work-review-bars-smoke.cjs`：在真实 Electron 暗色页面按住已展开 Build 标题，读取计算样式并保存按住帧截图；展开状态、无伪元素、无滤镜与透明背景同时受检。
- 版本同步为 root/Desktop/Android `0.5.13`、Android `versionCode=513`。`npm.cmd run build`、`pcGlassMigrationVerify`、1676 项主断言、版本门禁和真实 Electron UI smoke 全部通过；本轮未构建安装包。

## dev-0.5.12 变更

- Android 各宽度布局移除右侧栏折叠态展开按钮，展开入口统一为右缘左滑。
- 新建本地对话默认 Chat；Chat 复用既有 `terminal_exec` 权限，并在执行边界仅放行 `date`、`time`、`now`，不新增工具。
- 模式/模型选择一级、二级弹窗圆角调整为 26dp。

## 2026-08-29 dev-0.5.11 模型供应商浮块生命周期与轴互斥

- `android/app/src/main/java/com/newmark/mobile/ui/components/ProviderSettingsCapsules.kt`：新增 `ProviderRailMotionCoordinator`，横向协议浮块与纵向胶囊浮块共享单一轴占用；点击均执行完整浮起、并行移动、落下生命周期。协议行作为纵向不可穿越边界，跨区选择在边界两侧分段起落。
- 同文件删除原 28dp 左侧轨道区域、4dp 轨道绘制和相关占位；纵向手势、语义与浮块直接覆盖全宽胶囊列表。
- `android/app/src/main/java/com/newmark/mobile/ui/SettingsScreen.kt`：供应商、新建供应商、模糊注入、新建模型和详情页的导航操作不再由胶囊自身 `clickable` 绕过动画；供应商详情的新建模型和删除供应商均在纵向浮块落地后执行。
- `ProviderSettingsCapsuleRailContractTest`：增加无遗留轨道、横纵互斥、协议边界和落地后导航契约。全量 Android 213 tests / 61 suites、Vital Lint、R8 与 Release assembly 通过。
- APK：52,750,472 bytes，SHA-256 `E88BF45E495726A952AA4C209C759EFC0AEC21886F0B4DAFC1D97A61AD65B8E0`。

## 2026-08-29 dev-0.5.11 PC 启动响应优化

- `DESKTOP/src/core/runtimeLifecycle.ts`：新增启动前异步生命周期预处理，以 24 个 marker 为一批读取和清理 inactive/corrupt 历史记录；active marker 继续用于异常退出恢复。正常退出优先删除当前 marker，删除失败才回退写 inactive 状态。
- `DESKTOP/src/main.ts`：桌面模式先显示轻量 `startup.html`，待生命周期预处理和 Agent 初始化完成后，使用同一个 `BrowserWindow` 导航到 `index.html` 并提升为主窗口；自动化唤醒模式仍保持无窗口执行。
- `DESKTOP/src/tests/runtimeLifecycleStartupVerify.ts`：用 1000 个 inactive marker 和 1 个 crashed marker 验证清理、异常恢复与正常退出删除。
- `DESKTOP/src/tests/startupPrewarmVerify.ts`、`DESKTOP/src/tests/verify.ts`：锁定轻量启动页先显示、同窗导航、Agent 构造前预处理以及托盘/自动化唤醒契约。
- `DESKTOP/scripts/measure-startup-responsiveness.cjs`：在临时根目录构造 1000 个旧 marker，复用统一 CDP 主界面可交互门禁并采样 Windows `Process.Responding`；不触碰用户真实运行目录。
- 历史基线：Agent ready 8122ms、main UI ready 14974ms。最新实测：startup shell 721ms、index navigation 2567ms、interactive 2772ms、nonResponding 0、remaining markers 1。
- 验证：`npm run test:full-release` 全套通过；`npm run test:startup-responsiveness`、`npm run release:version-check` 通过。Android Release APK 为 52,750,472 bytes，SHA-256 `9E10F3FB8E20EB138FE7E16C699BC5767534865FD065BE27B9115673453D2EBC`。

## 2026-08-29 dev-0.5.11 模型与供应商单行胶囊及液态滑轨

- `android/app/src/main/java/com/newmark/mobile/ui/components/ProviderSettingsCapsules.kt`：集中定义 44dp 单行胶囊行、字段、纵向设置滑轨和横向协议滑轨；两个滑轨均使用真实 `GlassButtonCanvas` 浮块、共享 300ms 长按拖动和 4dp 边界阻尼契约。
- `android/app/src/main/java/com/newmark/mobile/ui/SettingsScreen.kt`：模型与供应商列表、供应商详情、新建供应商、新建模型、模糊注入五页全部迁移为单行胶囊；纵向滑轨可点击/拖动定位，协议选择使用横向玻璃浮块，原持久化、远程拉取与模糊发现行为保持不变。
- `ProviderSettingsCapsuleRailContractTest` 约束五页接入、协议滑轨、单行输入和共享液态手势。全量 Android 212 项 JVM 测试、Vital Lint、R8 与 Release assembly 通过。

## 2026-08-29 dev-0.5.11 移动端手动新建供应商与模型

- `android/app/src/main/java/com/newmark/mobile/ui/SettingsScreen.kt`：模型与供应商列表新增“＋ 新建供应商”；创建页覆盖名称、协议、接口与 API Key，保存后进入供应商详情。详情页原单字段添加框升级为“＋ 新建模型”入口，模型页覆盖标识、显示名、上下文长度、描述、视觉与思考能力。
- `android/app/src/main/java/com/newmark/mobile/data/ProviderConfig.kt`：`createManualProviderConfig` 与 `createManualModelConfig` 负责裁剪、验证和 PC 兼容默认值；GitHub Models 使用 PC 同款 `https://models.github.ai` 默认接口。
- `android/app/src/main/java/com/newmark/mobile/vm/ChatViewModel.kt`：新增 `upsertModel`，供应商和模型继续写入现有 `ProviderStore`；模糊注入和远程目录合并保持不变。
- `ManualProviderModelCreationTest` 覆盖供应商形状、默认接口、模型能力字段与页面导航/持久化绑定。全量 Android 209 项 JVM 测试、Vital Lint、R8 与 Release assembly 通过。

## 2026-08-28 dev-0.5.10 PC 固定玻璃源绘制修复

- `DESKTOP/src/ui/index.html`：固定玻璃按钮浮起时使用 `.liquid-fixed-source-covered` 停止源按钮的文字、子节点、背景/渐变、边框、阴影和伪元素绘制，不再追加近似背景遮罩；源元素本身不设 `visibility:hidden` 或 `opacity:0`，布局与命中框保持不变。
- 同一交互事务增加重复结束保护，以及 pointer cancel、窗口失焦、页面卸载和超时清理。完整落下清理并恢复源按钮后才执行原始 `click()`，避免重影与组件永久消失。
- `DESKTOP/src/tests/pcGlassMigrationVerify.ts`：新增唯一浮块/源停绘/清理先于点击的负向回归契约。
- `DESKTOP/scripts/verify-fixed-liquid-source.cjs`：连接 Electron DevTools，实际按住 `#left-ws-add`，检查计算样式、浮块可见性及松开清理；运行页面确认是 `DESKTOP/dist/ui/index.html`。
- 验证：`npm run build`、`node dist/tests/pcGlassMigrationVerify.js` 通过；实际 Electron 按住帧验证通过，截图为 本地归档（未纳入公开仓库）。

## 2026-08-28 dev-0.5.10 全移动浮动玻璃灵动响应与 PC 安装

- `android/.../components/LiquidGlass.kt`：新增共享 `resistedLiquidBoundaryPosition`。全部 `glassButtonSurface` 已有玻璃按钮在按住拖动时保持完整浮起，沿任意方向产生最多 4dp 的平方根阻尼位移，并按拖动主轴轻微拉伸/正交压缩；松开归零后完成 165ms 落下。
- `RightSidebar.kt`、`MemoryLabScreen.kt`、`Sidebar.kt`、`ChatScreen.kt`：右栏分页、Memory Lab 分页、折叠/展开工具栏、远程/本地对话排序与输入菜单浮块的边界硬截断接入共享阻尼函数。提交位置仍被严格限制在合法目标，受阻位移只影响视觉浮块。
- 测试：Android 定向玻璃/侧栏契约与全量 JVM 测试通过；`lintVitalRelease`、R8、`assembleRelease` 通过。
- Android APK：`android/app/build/outputs/apk/release/app-release.apk`，52,717,704 bytes，SHA-256 `AEAA50709EEBD6860AA863F00D88EB00E4AE12CC7C153467C0D843582756C59F`，签名者 `C=US, O=Android, CN=Android Debug`。
- Windows MSI：`release/Newmark-Agent-0.5.10-x64.msi`，226,412,624 bytes，SHA-256 `C3D74F3460B7FDF50B2438783851E0EAF921631533C37BA43E1160AA8994FD9B`。安装版注册表为 `0.5.10.0`，CLI 返回 `0.5.10`，GUI 实际启动并保持响应；安装目录 `app.asar` 与打包产物 SHA-256 完全相同。
- Windows ZIP：`release/Newmark-Agent-0.5.10-win-unpacked-x64.zip`，292,554,468 bytes，SHA-256 `7F4BDC0EE43B7A3FD9706867D3DF75BAB1148A4D7E49B0A1447E57AAE7CE28E3`。

## 2026-08-27 dev-0.5.9 全平台发布状态

`npm run release` 已通过 Desktop full release、Android JVM/Vital Lint/R8/Release assembly，并生成 Windows MSI/ZIP、Linux AppImage/deb/ZIP、Android APK 六资产。Windows MSI/ZIP 完成独立打包态 smoke；Linux 三包在 Ubuntu 24.04 WSL 环境完成真实 GUI 启动、Bash/sh 终端回环和进程退出验证。APK 为 v2 签名，签名者 `C=US, O=Android, CN=Android Debug`；Windows 未做 Authenticode 签名。

最终六资产位于根目录 `release/`。Android APK 为 52,717,700 bytes，SHA-256 `2BA403506ACC39B58DAFFE1AECBE53715C58302AD4B643B3AB7C448E7F8FADB3`。其他资产哈希记录于 `README.md` 与 本地归档（未纳入公开仓库）。回滚点为上一稳定标签 `dev-0.5.8`；macOS DMG 需要 macOS 原生主机，不属于本机发布矩阵。

## 2026-08-27 PC/移动端 Chat 模式与移动队列标题精简

- `DESKTOP/src/core/types.ts`、`agent.ts`、`toolPolicy.ts`：Chat 成为正式 `AgentMode`，系统提示要求联网取证后尽快总结；工具公开层与执行层均只允许 `web_search`、`web_fetch`。
- `DESKTOP/src/ui/index.html`、`cli.ts`、`cli-commands.ts`：GUI 与 CLI 均可选择 Chat，并保留对话级模式持久化。
- `DESKTOP/src/tests/chatModePolicyVerify.ts`：验证 Chat UI、提示词、两个公开工具及对写入/终端调用的权限拒绝。
- `android/.../LocalToolCatalog.kt`、`LocalTools.kt`、`LocalToolExecutor.kt`、`LocalContextContract.kt`：移动端本地 Chat 使用相同双层工具边界和快速证据总结契约。
- `android/.../ChatViewModel.kt`：Chat 可持久化、入队、出队恢复并把当前模式传入工具执行边界。
- `android/.../ChatScreen.kt`：本地模式菜单加入 Chat；队列头只显示 `n 条待处理`，移除“排队对话”标题。
- 验证：PC 1673 项主套件断言通过；Android JVM、Vital Lint、R8、Release assembly 全部通过。

## 2026-08-27 移动端紧凑玻璃按钮真实外扩画布

- `android/.../ui/components/LiquidGlass.kt`：新增共享 `GlassButtonCanvas` 与 8dp `GlassButtonCanvasOutset`。外层参与 Compose 测量并提供透明光学空间，内层保留按钮视觉尺寸、点击语义和菜单锚点。
- `android/.../ui/ChatScreen.kt`：顶栏远程设备/新对话，输入区 `+`、模型、发送/停止入口使用真实外扩槽；停止态跑马边框仍保持 36dp 并居中于 52dp 画布。
- `android/.../ui/Sidebar.kt`：本地对话新增按钮迁移到共享画布。
- `GlassButtonCanvasOutsetContractTest.kt`、`GlassClickLifecycleContractTest.kt`：约束共享外扩、六个入口接入、名义点击框与完整浮起/落下生命周期。
- 发布验证：202 项 JVM 测试、Vital Lint、R8 与 Release assembly 全部通过。

后续视觉回归修正：外扩画布不得参与父级测量。`GlassButtonCanvas` 现在向 Row/Box 只报告原始 24/28/36dp，光学层用居中的 `requiredSize(visualSize + 16dp)` 独立绘制。输入区恢复原有 32dp `+` 槽、36dp 模型槽、36dp 发送/停止按钮及全部既有 padding/间距；完整门禁为 203 项 JVM 测试通过。

## dev-0.5.9 implementation state (2026-08-27)

移动端本地 Agent 工具声明已完成独立性修复。`android/app/src/main/java/com/newmark/mobile/data/LocalTools.kt` 统一生成闭合 JSON Schema，并为普通、Plan、共享文件、应用列表以及 Root/Shizuku/ADB 工具补充完整用途、输入格式、权限条件、副作用和返回语义。`settings_update` 从 `json: string` 改为直接接收 `providers` 与/或 `active`，避免兼容服务在双层 JSON 转义处反复失败；执行器仍接受 dev-0.5.8 历史调用格式。

`LocalToolContractTest` 覆盖普通 Build、普通 Plan、全能力 Build、全能力 Plan 四套最终工具集，检查无重复名称、schema 闭合、required、字段类型与嵌套结构完整，并校验高权限清单和六档 intelligence。Android 全量 `:app:testDebugUnitTest`、Vital Lint、R8 与 Release assembly 通过。版本为桌面/Android `0.5.9`，Android `versionCode=509`。Release APK 为 `android/app/build/outputs/apk/release/app-release.apk`，SHA-256 `376A28FADD8F7B071734ACBCD18F403CFBD61263F358EE635A956571048D6430`。

### dev-0.5.9 incremental mobile writes

`ProviderConfig.kt` 提供 provider/model/active 纯 patch 合并器，只覆盖显式字段。settings 支持 provider/model upsert/delete；旧 providers 数组仍作为兼容全量入口。文件写入共享 overwrite/append/replace 合并器，唯一片段替换默认拒绝多处命中，`expected_sha256` 防止读后目标变化；`read_file` 和共享 `stat` 返回 SHA-256。Memory Lab 增加按 component 的 patch，元数据与正文可独立修改，继续执行 expectedUpdatedAt、归档、policy log 和 rebuild receipt。

### dev-0.5.9 Memory Lab parity and desktop patch-first writes

`android/.../MemoryLabStore.kt` 现在是 UI 重建按钮与 Agent `memory_lab_reindex` 的唯一规范化入口。它复用 PC 的已知同义词表、语言偏好主标签选择、aliases 保留和组件 tags/tagPaths 重写规则，且重复重建保持相同图结构。移动端单测覆盖英/中文主标签、孤立旧别名节点清除、入口共用与幂等性。

PC Agent 写入面审计后，`memory_lab_update` 支持按 component 保留未提交字段、正文 append 或唯一片段 replace；`flow_save` 支持单组件 upsert/delete；`linked_plan` 支持 append 与 revision-checked old_text/new_text。三者都保留旧全量替换兼容。`automation_update`、task、Goal 已是字段或单项更新，文件已有 `edit`，因此没有增加重复工具。桌面构建与主验证 `1673/1673` 通过；Android `196` 项 JVM 测试、Vital Lint、R8 和 Release assembly 通过。

### dev-0.5.9 mobile Memory Lab controls and ripple boundary

`NewmarkTheme.kt` 现在同时以 `NoVisualIndication` 和 `LocalRippleConfiguration=null` 关闭包括设置页在内的全应用 Compose Foundation/Material3 灰色涟漪，避免 Material3 自有按钮绕过普通 clickable 策略。`RightSidebar.kt` 的开栏、分页及图标按钮显式使用 `indication=null`；`MemoryLabScreen.kt` 将新增、重建索引、双向/父链/子树/直接、清除和重置收敛为 `MemoryLabGlassAction`：固定高度/最小宽度、稳定间距、静态浅色材质底、按压外扩玻璃边缘和禁用态。该改动针对实机截图中右边栏和 Memory Lab 的 MD3 灰色涟漪会压脏浅色玻璃表面的问题。移动端主题层只保留内置 `NewmarkDarkThemeColors` / `NewmarkLightThemeColors` 两套语义色，不存在用户自定义调色状态、设置入口或持久化字段；`FixedThemeColorsContractTest.kt` 阻止调色板/颜色选择器能力回归。

本轮 Android 发布资产为 `release-0.5.9-packages/Newmark-Agent-0.5.9-android.apk`，大小 52,717,700 bytes，SHA-256 `5750357AAA0CDF6C335C0954325B36250F9D497F36C0DAF599ED98CA390E8155`。全量 JVM、Vital Lint、R8 与 Release assembly 均通过。

`ChatScreen.kt` 的 `QueuePanel` / `QueueRow` 使用队列专属 `QueueIconButton`，不再复用带玻璃边缘的通用 `StackIconButton`。队列内暂停、展开、Guide、编辑、删除按钮均无 `.border` 和 `glassButtonSurface`，由透明静止态、同色按压晕染、轻微抬升/放大承担反馈；标题区显示“排队对话”、状态点和待处理计数，行高从 40dp 调整为 44dp 并增加弱背景层次。`QueuePanelVisualContractTest.kt` 固化无边框、无 MD3 indication 和队列专属反馈契约。

排队对话美化后的 Android Release APK 为 52,717,700 bytes，SHA-256 `E768C0480BDD9362A3804B4653A479908F7AB8B740977D5376E0677CE4486DD7`，已覆盖 `release-0.5.9-packages/Newmark-Agent-0.5.9-android.apk`。Android 全量 JVM、Vital Lint、R8 与 Release assembly 通过。

`LiquidGlass.kt` 统一管理移动端玻璃边缘厚度：`MobileInteractionGlassEdge` 从 6dp 增至 7dp，半圆端捕获外扩同步维持两倍关系为 14dp；显式弹窗折射边带从 4dp 增至 5dp，开关按压浮块从 8dp 增至 9dp。`thickGlassHighlight` 将标准 Kyant 高光宽度统一增加 1dp，`kyantGlassEdge` 的启用与降级包边也各增加 1dp。`liquidGlassModifier` 对 RGB 色散和折射传入相同的加厚 `refractionHeight`，`GlassEdgeThicknessContractTest.kt` 防止任一玻璃路径退回旧宽度。

玻璃边缘增厚后的 Android Release APK 为 52,717,700 bytes，SHA-256 `16E7AC7290995BBE656431958522C9B131FB76B10B723EC7F6034C3254789EDA`，已覆盖 `release-0.5.9-packages/Newmark-Agent-0.5.9-android.apk`。Android 全量 JVM、Vital Lint、R8 与 Release assembly 通过。

`Sidebar.kt` 为本地与远程对话 LazyColumn 条目增加 `animateItem` placement/fade 规格；归档胶囊完成自身 220ms 退场并从数据源移除后，其余胶囊以 260ms `PcEaseOutExpo` 平滑补位。`LiquidGlass.kt` 的 `runOverlappedLiquidFlight` 仍允许 lift/move 并行，但现在严格等待 lift 与 move 都完成后才调用 `onLandingStarted` 和 `land`。`glassButtonSurface` 使用逐次点击队列，每次点击必须完成 105ms 浮起至完整尺寸，再完成 165ms 回落；快速点击不会截断前一次动画。`ChatScreen.kt` 移除输入条对 + 按钮外扩浮块的父级 clip，仅保留带 shape 的背景与边框。

本轮 Android Release APK 为 52,717,700 bytes，SHA-256 `FD509BBC9C2959DDF7F07ABC1AF447CBAF06F2A9C71D136387235A82836CCE5A`，已覆盖 `release-0.5.9-packages/Newmark-Agent-0.5.9-android.apk`。Android 全量 JVM、Vital Lint、R8 与 Release assembly 通过。

`DrawBackdropModifier.kt` 新增 `clipToShape` 内部画布策略，默认完整玻璃面板仍按 shape 裁剪；`kyantGlassEdge` 显式使用 `clipToShape=false`，使按钮玻璃的高光、阴影和放大形变能绘制到按钮布局边界之外。`HighlightModifier.kt` 不再使用固定 2px 安全画布，而按 `highlight.width + blurRadius` 计算密度感知 outset。全项目审计确认 Chat、Settings、RightSidebar、Sidebar、Terminal、MemoryLab 共 33 处 `glassButtonSurface` 均通过这一统一路径，`GlassButtonCanvasOutsetContractTest.kt` 固化底层无截断契约。

本轮 Android Release APK 为 52,717,700 bytes，SHA-256 `7DBEEBC05B794473E50476E270A5BBBC315FEBF5E0F4A2351CA07840BB09C85B`，已覆盖 `release-0.5.9-packages/Newmark-Agent-0.5.9-android.apk`。Android 全量 JVM、Vital Lint、R8 与 Release assembly 通过。

审计确认 `task_create` 已是单项 create/update/clear；calendar/alarm 是一次性系统 Intent；memory reindex 只在设备内重建，均不存在模型回传全量集合的问题。全量 JVM、Vital Lint、R8 和 Release assembly 通过。最新 APK SHA-256 为 `CD2A5E889937573DA870BB74471FFBB76B76E4243FADB383354DA699FBFB8DF2`。

## dev-0.5.8 implementation state (2026-08-26)

dev-0.5.8 implements a focused desktop runtime/UI correction plus mobile Agent stability work. `DESKTOP/src/core/emptyResponseRetry.ts` owns the explicit-empty outcome state machine. `agentKernelRunner.ts` treats the initial explicit failure as streak 1, performs five same-deployment retries after 200ms, 800ms, 2s, 10s, and 60s, and terminates only when the fifth retry also returns an explicit empty failure (six consecutive explicit empty outcomes total). On Android, thought/reasoning, assistant text, tool calls, and other observable stream activity all reset the local streak immediately. Empty classification remains separate from waiting, silence, EOF, stream closure, abort, content filtering, explicit errors, and unrelated transport failures.

Transcript Build/history disclosure in `DESKTOP/src/ui/index.html` is now fully motionless and glass-free. The header overrides generic button transitions, animations, transforms and filters; the chevron changes orientation instantaneously. Synchronous click/keyboard activation and the direct `display` body switch remain intact.

Planning artifacts:

```text
tasks/plan.md                              # dependency-ordered dev-0.5.8 implementation plan
tasks/todo.md                              # executable acceptance and release checklist
taste.md                                   # persistent retry/UI interaction style contract
本地归档（未纳入公开仓库）     # source findings and decisions from this planning pass
```

Verification covers the pure retry state machine, auto-agent integration, model recovery stress, normal chat regression, static PC glass contracts, and real Electron disclosure computed styles. The shared version is `0.5.8` (`versionCode 508`).

### dev-0.5.8 cross-platform prerelease (2026-08-27)

`DESKTOP/scripts/release-all.cjs` completed successfully on Windows with WSL2 Ubuntu 24.04 and JDK 17. The release gate ran the desktop full-release suite, Android unit/Vital Lint/R8/Release tasks, Windows packaging and packaged smokes, then native Linux packaging in an isolated WSL filesystem. `DESKTOP/scripts/verify-github-release-assets.cjs` independently verified exact names, byte sizes, SHA-256 equality, Windows MSI/ZIP startup, and WSL AppImage/deb/ZIP GUI plus Bash/sh terminal isolation.

```text
release/
├─ Newmark-Agent-0.5.8-x64.msi                 # Windows machine installer, 226388047 bytes
├─ Newmark-Agent-0.5.8-win-unpacked-x64.zip    # Windows portable package, 292541435 bytes
├─ Newmark-Agent-0.5.8-x86_64.AppImage         # Linux AppImage, 176643327 bytes
├─ Newmark-Agent-0.5.8-amd64.deb               # Debian/Ubuntu package, 136028248 bytes
├─ Newmark-Agent-0.5.8-linux-unpacked-x64.zip  # Linux portable package, 172766280 bytes
└─ Newmark-Agent-0.5.8-android.apk             # Android release APK, 52701316 bytes
```

Commit `ee98a43af6b3e15dd20eab9b70ed0b4fbb4c1f5c` and annotated tag `dev-0.5.8` are published. The GitHub prerelease contains exactly the six bound assets, `newmark-agent@0.5.8` is published to npm, and both the npm workflow and Windows/Linux/Android release workflow passed. A clean remote download revalidated every byte size and SHA-256, then reran Windows MSI/ZIP and WSL AppImage/deb/ZIP packaged smokes. Windows executable signing remains disabled. The APK verifies with APK Signature Scheme v2 and the existing Android Debug certificate, so it is suitable for sideload testing but not store distribution. No ADB device was connected for install/runtime validation. The repository has a macOS DMG target, but Electron's macOS packaging constraint requires a macOS host; DMG is outside the current six-asset Windows/Linux/Android release matrix and was not produced here. Full evidence and hashes are in 本地归档（未纳入公开仓库）.

The local Windows installation was also validated through UAC. A same-version MSI repair returned success but left the already-missing `resources/app.asar` absent, so the final accepted path performed one elevated uninstall followed by a fresh install. Both Windows Installer phases returned `0`; the new registration is `0.5.8.0` with product code `{78E73760-F636-4FF1-9D2F-C294697BA352}`. Installed and packaged `app.asar` are both 160,431,960 bytes with SHA-256 `826CB38FC9652B0E8A9BD30766DDF726598C189FDD849A86AEBCD34C66799E4D`. The existing user config hash stayed unchanged, installed CLI version checks returned `0.5.8`, shortcuts were restored, and the main/GPU/renderer/utility process set became responsive after startup.

### Android latest-file exposure

The local Android Agent no longer depends on knowing a storage directory in advance. `LocalTools.kt` exposes the read-only `recent_files` tool in Build and Plan modes. `LocalToolExecutor.kt` queries MediaStore document, image, and video collections, merges them by `DATE_MODIFIED DESC`, and returns bounded metadata plus readable `content://` URIs. `files_read_all` is always exposed for URI reads and returns UTF-8 text for textual formats or bounded Base64 metadata for binary files up to 20 MiB.

This capability is independent of Root/Shizuku and does not require `MANAGE_EXTERNAL_STORAGE`. Android 13+ media permissions expand image/video coverage. The system “all files access” page remains an explicit user-controlled expansion for arbitrary shared-storage paths and file management; `Android/data`, `Android/obb`, symbolic-link escapes, recursive deletion, and overwrite remain blocked.

The final permission contract is double-gated. When the in-app all-files switch is off, `recent_files`, `files_read_all`, and `files_manage` are absent from the local Agent tool surface; only the internal safe workspace file tools remain. When enabled, Android media permissions and the app-specific all-files settings page are opened, and arbitrary shared-storage management requires both the saved in-app choice and the live system grant. Application-list tools likewise require both the saved in-app switch and Android Usage Access (`PACKAGE_USAGE_STATS`) authorization. Returning from system settings refreshes both live states.

`NewmarkApp.kt` now initializes `preferLocal=true`. Cold start immediately renders the persisted `ChatViewModel.currentId` local conversation instead of selecting a paired remote surface while the desktop link hydrates. Remote mode remains available through explicit device selection.

## dev-0.5.7 corrective release (2026-08-25)

dev-0.5.7 implements the planned Android long-press, cross-platform glass geometry/animation, PC response-time, scoped light-surface, fallback-boundary, transcript-disclosure, and popup-radius corrections. Android's interaction edge uses a fixed 6dp outer band. Desktop and Android moving glass deform more responsively from live velocity, stretching along travel and contracting across it while keeping refraction inside the transformed glass. Desktop dispersion is primed on low-frequency hover/focus intent, uses a single pooled off-DOM WebGL context, and refreshes through CSS-resolution JPEG bytes plus ImageBitmap decoding; a pooled alpha-enabled 2D surface performs final Chromium composition to avoid Windows' reused-WebGL black-frame defect. Geometry and uniform caches suppress duplicate GPU work, and production performs no CPU pixel readback.

Android local and remote conversation capsules now use one overlay lifecycle for tap flight, stationary-hold pickup, drag tracking, release landing, and cancellation. The overlay uses required dimensions so its fixed 6dp band is not reduced by the row/list constraints; the carried content row no longer creates a second glass node. Gesture velocity and `Animatable` flight velocity feed the same liquid deformation transform as the refractive overlay, preserving stretch/squash through pickup, movement, and landing.

Conversation rows and their floating overlay now have mutually exclusive edge ownership: a glass-covered local or remote capsule renders no static border, and a running remote capsule also pauses its marquee border while covered. This ownership contract also covers both forms of the left-sidebar bottom three-option utility selector and the right-sidebar tab strip; each selector derives coverage from its live moving target index, so the border transfers as the float crosses options. Reorder preview and commit share stored source/destination group indices plus the source height captured at pickup. Pointer deltas update that destination snapshot; release consumes the same snapshot instead of recomputing against bounds that may be changing under avoidance animation or optimistic list updates.

Android live activity notifications now restore the native API 36 `Notification.ProgressStyle` promoted-ongoing route used by Fluid Cloud/Live Updates. The platform progress carrier has exactly three alternating black/white segments, while the remote and local running-Agent counts remain separate lines. API 35 and below keep the pre-existing custom two-line notification and marquee resources unchanged.

Desktop light-theme `sub-win` carriers opened by every left tool entry now use the same bright surface token previously limited to Settings. PC liquid selectors attach active pointer move/up/cancel listeners at `window` capture scope and project out-of-region coordinates onto the selector axis, so the glass keeps moving and resolving the nearest landing option until release. Conversation native drag adds document-capture `dragover` plus source `drag` tracking while retaining list-scoped reorder/drop ownership.

Click-driven PC selectors use a separate paced class so release does not truncate the flight: lift/movement lasts 360ms and landing lasts 180ms, while the selected action is still dispatched synchronously. Crossing the drag threshold removes that paced class and restores the lower-latency drag transition.

The PC RGB shader weights chromatic separation by the full fixed edge profile, so long conversation capsules retain visible dispersion along straight horizontal and vertical edges instead of reaching zero on their center axes. Scrollable selector menus derive candidates from the overflow viewport, prefer fully visible rows, fall back to intersecting rows, and clamp projected centers to the visible menu track. Pointer release records the final float geometry before invoking an option click; popup teardown therefore cannot invalidate the non-blocking landing animation.

The PC interaction layer now serializes visual commits. A conversation capsule covered by the top-layer float suppresses both its static border and marquee border. Selector and conversation clicks can redirect the one existing float without starting a second animation; only its final landing callback dispatches the page switch, control command, or popup close. Scrollable menus reject only rows entirely outside the clip, retaining partially visible rows as valid targets.

Hard product contracts established by the plan:

- PC interaction-glass edge is exactly 6px; its refraction and dispersion spatial thickness use the same edge token.
- Android interaction-glass edge is exactly 6dp on every side and is created by fixed outer bounds, not proportional scale.
- `fallback_on_unavailable=false` permits retrying the exact same deployment but forbids switching to any other model identity in fixed or Auto execution.
- PC transcript block/tool/review disclosures never create floating interaction glass.
- PC logical clicks do not wait for backdrop capture or visual landing; landing remains a complete non-blocking shrink/fade animation.
- PC transparent WebGL remains off-DOM; only its small synchronized 2D display surface enters Chromium composition, and first plus reused compositor frames are regression-tested.
- Light-theme brightness changes are scoped to Android sidebars and PC settings/modal carriers, preserving the already-correct Android popups and PC sidebars.

Affected project tree:

```text
Newmark Agent/
├─ DESKTOP/
│  ├─ src/ui/index.html                         # PC glass state machine, 6px geometry, theme surfaces, transcript exclusions
│  ├─ src/core/agent.ts                         # fixed/Auto fallback enforcement and preflight behavior
│  ├─ src/core/autoRouter.ts                    # same-deployment retry versus model-substitution planning
│  ├─ src/main.ts                               # live GUI config propagation into existing runtimes
│  ├─ src/tests/
│  │  ├─ pcGlassMigrationVerify.ts              # geometry, landing, non-blocking click, disclosure exclusions
│  │  ├─ visualPreferencesVerify.ts             # scoped light-theme token contracts
│  │  ├─ modelRecoveryStressVerify.ts           # fallback-off deployment identity matrix
│  │  └─ autoAgentIntegrationVerify.ts          # Auto/fixed runtime route integration
│  └─ scripts/dev-liquid-renderer-performance-smoke.cjs # real Electron input-to-command timing
├─ android/app/src/
│  ├─ main/java/com/newmark/mobile/ui/
│  │  ├─ Sidebar.kt                             # remote long-press lifecycle, conversation glass bounds, light sidebar
│  │  ├─ ChatScreen.kt                          # selector outer bounds, landing, 22dp popup shape
│  │  ├─ RightSidebar.kt                        # fixed 6dp tab glass, velocity deformation, and 22dp dialog shell
│  │  ├─ MemoryLabScreen.kt                     # fixed 6dp pager glass, velocity deformation, and 22dp dialog shell
│  │  ├─ SettingsScreen.kt                      # 22dp device/settings dialog shell
│  │  ├─ components/LiquidGlass.kt              # shared 6dp edge, motion deformation, and popup shape tokens
│  │  ├─ components/LiquidHoldGesture.kt        # cancel-safe hold/drag lifecycle
│  │  └─ theme/NewmarkTheme.kt                  # Android light-sidebar semantic surface
│  └─ test/java/com/newmark/mobile/ui/          # gesture, bounds, theme, and popup-shape contracts
├─ tasks/
│  ├─ plan.md                                   # detailed implementation plan and acceptance criteria
│  └─ todo.md                                   # phase-ordered execution checklist
├─ 本地归档（未纳入公开仓库） # planning evidence and repository findings
└─ 本地归档（未纳入公开仓库）   # implementation, gates, artifact hash, and manual gaps
```

Verification completed on the implementation tree: desktop `npm run test:full-release` exited 0, including the 1670/1670 core feature gate, Auto Router 39/39, Auto Agent integration 28 assertions, GUI/TUI/CLI stress, and the real Electron input probe. That probe kept one WebGL2 context, compiled two shaders, linked one program, uploaded two textures, and measured approximately 0.1ms p95 from pointer release to command. Android `testDebugUnitTest lintVitalRelease assembleRelease --no-daemon` completed successfully across 73 tasks. After version synchronization, `assembleRelease` rebuilt and verified the 0.5.7/507 package. The resulting 45,938,144-byte APK has SHA-256 `25A3229D531FF15395CCF8979C32AE4747D9958A1260E5A1D23181751769F965`.

The automated gates do not substitute for physical-device or packaged-desktop visual acceptance. Non-active remote-conversation hold behavior, Android portrait/landscape/foldable rendering, and packaged Electron light-surface/disclosure behavior remain explicit manual checks in `tasks/todo.md`.

## dev-0.5.6 cross-platform switch and conversation drop-preview correction (2026-08-24)

- Android `LiquidGlassSwitch` and PC checkbox sliders now separate taps from drags. A tap always toggles the prior value, regardless of the pressed track half. Only horizontal movement beyond the platform slop/threshold owns the gesture, updates the liquid thumb, and settles from the release fraction; vertical movement is treated as scrolling and does not toggle.
- Mobile local-conversation capsule titles are vertically centered and left-aligned. Local and remote reorder surfaces calculate the future insertion slot while dragging and animate intervening rows away from that slot: rows below an upward move shift down, and rows above a downward move shift up.
- PC workspace rows and second-level conversation rows use full capsule geometry, while workspace thumbnails are circular. Conversation dragover now reorders the live DOM preview inside the same pin group; cancellation restores the model order and drop persists the visible preview order.
- Verification: desktop TypeScript build and all `pcGlassMigrationVerify` checks pass. Android reports 133 debug JVM tests with 0 failures; `lintVitalRelease`, R8, and `assembleRelease` pass. The 45,932,364-byte Release APK has SHA-256 `30E1A35A4460530262C55D4D8CE6F4AA929E94521BC471063807E0C913741509`; it installed on `emulator-5554`, cold-started `com.newmark.mobile/.MainActivity`, remained alive as PID 5254, and the bounded log scan found no matching Java FATAL, native fatal signal, app ANR, or input timeout. A fresh screenshot confirms local conversation names are vertically centered and left-aligned; tapping the already-off/left half of the dark-mode switch changed it to on/right, directly exercising tap-to-toggle rather than release-position selection, after which the original setting was restored. Drag geometry still requires direct visual acceptance on the target physical device.

## dev-0.5.6 mobile 300ms liquid gesture and conversation reorder correction (2026-08-24)

- Added `ui/components/LiquidHoldGesture.kt` as the shared mobile gesture boundary: taps dispatch immediately after release, glass drag takes ownership only after a stationary 300ms hold, and pre-hold movement beyond touch slop remains unconsumed for LazyColumn/sidebar scrolling. A non-consuming candidate lock is installed on DOWN, and the app-wide edge recognizer aborts on the next event when that lock exists; the Material drawer's own `gesturesEnabled` stays stable so button-driven open/close settle animations are preserved.
- Expanded/folded Command / Memory Lab / Settings selectors, local-mode and remote-mode right-sidebar tabs, and Memory Lab overview/detail use the same boundary. Right tabs now center a 44x40dp glass around 32x28dp tags; Memory Lab centers a 76x46dp glass around 64x34dp tags, giving a fixed 6dp band on every side without negative-Y positioning.
- Local and remote conversations now share the asserted long-press contract: the active conversation glass flies to the held row, the held row follows vertical drag, release reorders only inside the same pin group, and an unchanged hold opens the action menu. Local reorder is persisted by `ChatViewModel.reorderConversations`; local capsules are thinner and show only a centered single-line name.
- Tap flights are redirectable: another tap in the same selector cancels only the previous destination, continues from the float's current rendered position, and lands/commits only at the latest target. Pager/tool flights use 380ms and conversation flights use 340ms so low-frame-rate devices retain visible intermediate positions.
- Conversation rows use capsule geometry and 6dp Kyant refraction edges. Action-menu rows gain press-only glass with shape-clipped Material interaction; borderless transcript Copy/Edit controls no longer create glass borders. Shape-bearing buttons clip their Material indication to the same capsule before click handling.
- Verification: `compileDebugKotlin`, 130 debug JVM tests, `lintVitalRelease`, R8, and `assembleRelease` pass. A rooted emulator input stream held one pointer stationary for 360ms and then moved it; the captured frame shows the utility glass following the pointer without opening a page. The final release APK installs successfully on `emulator-5554`, cold-starts `com.newmark.mobile/.MainActivity`, remains alive, and produced no matching Java FATAL, native fatal signal, app ANR, or input timeout in the collected log. APK SHA-256: `3843F0290FC3762B10C5D1C16B4635000D4AAC8E3F0EC3B190AAB0CC73BABDAC`.

## dev-0.5.6 original glass renderer restoration and RGB dispersion (2026-08-24)

- The PC floating selector is restored byte-for-structure from the archived pre-GPU-optimization `0.5.6` package: each gesture awaits a fresh Electron `capturePage` data URL, creates its own WebGL2 canvas/context/program/texture, uploads that frame, and renders the complete Kyant rounded-rectangle lens. The pooled renderer, pointerover prewarm, stale frame cache, Blob transport, 64px backing buckets, and four-sided 9px center-hole mask are removed.
- Kyant SDF, `circleMap`, depth normal, refraction height/amount, full-capsule interior sampling, source-to-target flight, and viewport top-layer placement remain unchanged. Only dispersion reads are reduced from seven to three: red at `+dispersion`, green at the refracted center, and blue at `-dispersion`; output channels are composed directly from those three samples and alpha is their average.
- Android's vendored Kyant AGSL shader uses the same RGB-only three-sample reduction without changing the Compose recorder/consumer topology or gesture movement code.
- Verification: desktop TypeScript build, `pcGlassMigrationVerify`, `visualPreferencesVerify`, fresh source and installed Electron renderer/flight captures, Android unit tests, Vital Lint, R8, and Release assembly pass. MSI administrative-image smoke passed 22 + 12 assertions. The current x64 MSI is 226,342,929 bytes with SHA-256 `C983EBF0735A8C3B7238ACE407E49C29156A7EF876ACAA02EE6C92D287574278`; UAC installation returned 0, HKLM/EXE/CLI report `0.5.6`, and packaged/installed `app.asar` hashes both equal `C420C86AF89A3E7E7B5CD7325D9D82BD430B7D6DF9DEB3B49AF5EADACB4B90DA`.

## dev-0.5.6 mobile liquid-selector correction (2026-08-24)

- Mobile left-sidebar local/remote conversations now use the same source-to-target glass flight model as PC; remote long-press reorder waits for the glass to arrive before the real row is lifted and translated.
- Expanded and folded Command / Memory Lab / Settings groups, right-sidebar tabs, and Memory Lab overview/detail tabs use one content-free floating glass block. Gesture keys are structural rather than callback-list identities, every active selector locks app-wide sidebar swipes, and drag coordinates update through `graphicsLayer` without measure/layout churn.
- Each selector records only its own static option layer while pressed, then its sibling Kyant `drawBackdrop` consumer refracts that live content. This fixes the nearly invisible float caused by sampling the uniform chat backdrop and preserves the no-self-referential-recorder rule.
- Input popups regain a first-mount scale/fade entrance, keep one popup shell plus one interaction glass, and no longer clip the moving glass at the popup outline. Mobile refraction edge height is 6dp and named circular controls use the stronger shared press lift.
- The expanded 48dp rail fades out as the full sidebar covers it, removing the dark-mode double-alpha strip. Memory Lab Dialogs center inside explicit 92% x 88% constraints and opt into full-display cutout layout for foldable/landscape symmetry.
- Verification: 128 JVM tests, `lintVitalRelease`, R8, and `assembleRelease` pass. Emulator portrait/landscape screenshots confirmed the dark strip is gone, the floating selector appears on press with live option refraction, and the Memory Lab surface is bounded by the centered large-screen shell; final cutout-mode geometry remains covered by the source contract and final package gate.

## dev-0.5.6 glass interaction correction (2026-08-24)

- PC floating glass now keeps one prewarmed WebGL2 renderer instead of creating a context and recompiling the Kyant shader for every gesture. PNG backdrop transfer uses binary IPC/object URLs, uniform locations are cached, canvas backing storage grows in 64 px buckets, and animation redraws are coalesced into one `requestAnimationFrame` loop.
- Pointerdown no longer awaits Electron `capturePage`/PNG decode. It mounts the source float synchronously using the latest valid cached texture and refreshes the backdrop asynchronously. The real Electron probe measured the capture path at about 233 ms but confirmed the mounted float already had `textureReady=true` after pointerover prewarm and used renderer ID `1` throughout the flight.
- Android menu floats, collapsed-rail floats, and liquid switch thumbs now move through `graphicsLayer` translations rather than layout `offset` updates, keeping drag animation off the Compose measure/layout path.
- PC popup/rail floating glass is transparent and does not clone option content; only conversation reordering wraps the real row content.
- Popup, rail, resize, and conversation gestures use an explicit lock. Menu selection remains row-snapped, while pointer capture re-hit-tests by coordinates.
- Android menus use enlarged corners and 1.14 lift; collapsed utility entries are circular and share a locked three-item vertical drag. Android/PC switches follow pointer position and settle to the nearest stop.
- PC right sidebar has rounded left corners without left glow; borderless copy/edit actions opt out of the button glass pseudo-layer.
- Latest gates: PC build, `pcGlassMigrationVerify`, `visualPreferencesVerify`, real Electron geometry/renderer probe, and MSI administrative-image smoke passed; Android `testDebugUnitTest` and `assembleRelease` passed. Current APK SHA-256 is `06B88DCD3C3D42D829A2F46CD83F08411630E11D557252DB2E09CF8AB8DBB484`.
- Final corrected x64 MSI is `release/Newmark-Agent-0.5.6-x64.msi`, 226,355,217 bytes, SHA-256 `B34714E9AB035574233E8EF2F12EF9E56B3E896A6FD1FD43A19B7A489E1409C0`. The 9px edge mask now leaves the WebGL canvas at full size, preserving actual refraction/dispersion, while the shader uses four displaced red/yellow/cyan/blue samples instead of seven (about 43% fewer texture reads). Real UAC installation returned 0; HKLM registers `0.5.6.0`, installed CLI returns `0.5.6`, and installed/package `app.asar` hashes both equal `CB2F98070564F5009A87A7CA4AC0718FEF2534A26C954E09FFD48CB2003DFB5A`. The installed executable was launched through CDP and its captured flight frame shows live tool text through the transparent center with the edge ring rendered.

## dev-0.5.6 严格审查与矫正结论 (2026-08-23)

- **原同事修复不符合发布预期**：静态门禁虽然通过，但真实 Release 冷启动暴露 Kyant backdrop 递归渲染树，`RenderThread` 发生 `SIGSEGV`/stack overflow（512 层 `RenderNode::prepareTreeImpl`），此前的 `Size is unspecified` Java 崩溃修复并不充分。
- **本轮矫正**：根布局不再让 `layerBackdrop` 包住抽屉/右栏/弹层消费者；主界面仅在会话背景内容或基础 `Row` 上录制，玻璃面作为兄弟覆盖层消费；三个独立 Dialog 均增加独立背景采样层。`LiquidGlassContractTest` 新增 recorder/consumer 拓扑守卫，防止自引用 RenderNode 回归。
- **门禁证据**：桌面最终综合测试 `1670/1670`；Android 定向契约测试、R8、`lintVitalRelease`、`assembleRelease` 均成功；`DESKTOP` 版本检查显示 desktop/android `0.5.6`、versionCode `506`；`git diff --check` 无空白错误。
- **设备验收状态**：修正后 APK 尚未能完成第二次真实冷启动复验。此前 AVD 在 native 崩溃后被拖入 PackageManager data scan，重启后超过有界等待仍未置 `sys.boot_completed=1`，故不能将修正后的 APK 宣称为发布候选。必须在健康设备/AVD 上重新安装并检查 Java FATAL、native signal、应用 ANR、UI dump 与截图。

## dev-0.5.6 队列自动发送消息显示修复（用户输入时间线）(2026-08-23)

- **用户报障：排队自动发送的消息没有显示在用户输入时间线**。根因：enqueueSameSession 入队 followUp 消息时保留 clientMessageId 并把 runId 固定为入队时运行的 runId；drain 原样传给 process 后，chatMessages 的用户消息携带旧 runId + clientMessageId，两端渲染（PC renderTranscript / 移动端 projectRemoteConversationItems）把「clientMessageId + runId 命中 workRuns」的消息误判为 guide 消息跳过气泡。
- **修复**：ConversationKernel 新增 drainQueuedFollowUpMessage——drain followUp 分支清除 clientMessageId/runId（process 走普通用户消息分支，mode 取 visibleMode，runId 取当前 run），保留 text/visibleUserInput/visibleMode/images/attachments；string 载荷透传；steer guide 消息不受影响。
- **验证**：新增 queueDrainUserMessageVerify（13 项）接入 test:desktop:built 与 test:queue-unify-stress；verify.js 1643 PASS / 27 FAIL（27 项为既有环境依赖）。

## dev-0.5.6 mobile scroll-to-bottom targets the real transcript end (2026-08-23)

- **用户报障：移动端回到底部按钮点击后只回到最新 build block 顶部而非末端**。根因：LazyColumn 中 build block 是超高单行（一行承载整个 work run），按钮 `scrollToItem(items.size - 1)` 只把该行顶部滚到视口；且 `atBottom` 判定 `lastVisible.index >= totalItemsCount - 2` 在超高行顶部进入视口时就误判为"在底部"，按钮提前隐藏。
- **修复（ChatScreen.kt ChatContent）**：
  - 新增纯函数 `transcriptEndIndex(itemCount, isSending)`：末端 reserve 行 index = item 数 +（isSending 时 ThinkingDots 1 行），该行是 LazyColumn 最后一行。
  - 回到底部按钮与自动跟随统一 `scrollToItem(transcriptEndIndex)`，越过 build block 尾部直达真实末端。
  - `atBottom` 判定改为 `lastVisible.index >= totalItemsCount - 1`（最后一行可见才算到底），超高 build block 不再误判。
- **验证**：`TranscriptLayoutContractTest` 新增 2 项（transcriptEndIndex 索引计算、ChatContent 源码断言 scrollToItem(transcriptEndIndex) + 最后一行判定）；`testDebugUnitTest`/`assembleDebug` BUILD SUCCESSFUL。


## dev-0.5.6 work-review dedup: incremental snapshot refreshes no longer duplicate Build block file-change cards (2026-08-23)

- **用户报障：增量更新导致 build block 抬头的审查文件变动重复绘制**。根因：`applyConversationSnapshot`/发送消息快照路径每次刷新都重设 `lockedUi.pendingWorkReview = r.diffs`，且 `addWorkReview` 消费后**从不清除** `pendingWorkReview`，导致每次增量快照都重新 `appendChild` 一张相同的 review 卡片。
- **修复（DESKTOP/src/ui/index.html）**：
  - `addWorkReview` 增加按 `data-files`（规范化 diffs 的 JSON）去重：chat-area 已有相同 review 时直接返回已挂载元素，不重复 append。
  - 快照路径消费 `pendingWorkReview` 后立即置 null（消费即清除），并把 review 渲染从 `else if (stillActive)` 分支提升为 `if (stillActive)` 无条件执行——`responseOwnedByRun=true`（快照含 chatMessages）时 review 也能渲染一次。
  - `pendingWorkReview` 设置改为幂等（`!lockedUi.pendingWorkReview` 时才设置），后续增量快照不再重新武装已消费的 review。
- **验证**：新增 `workReviewDedupVerify`（JSDOM 沙箱提取真实 `addWorkReview` 执行）：首次挂载 1 张、重复相同 diffs 调用 4 次仍 1 张、不同 diffs 挂第 2 张——全部 PASS；接入 `test:desktop:built`。verify.ts 新增源码断言（去重 + 消费清除 + 幂等设置）通过；`verify.js` 1643 PASS / 27 FAIL（27 项为既有环境依赖，与基线一致）。


## dev-0.5.6 remote queue export fix: queue_update carries structured queueItems (2026-08-23)

- **用户报障：移动端看不到远程的排队消息**。排查确认是"入口同化、出口未同化"：dev-0.5.5 队列同化让 PC UI 按 kernel id 管理 backendManaged 行（入口），但 kernel 广播的 `queue_update` 工作事件只带 `queue`（文本列表），**不带 `queueItems`（结构化 id 列表）**；且移动端 `applySseEvent` 完全不处理 `queue_update` 事件，导致移动端只能靠自己 enqueue 的响应或手动 refresh 看到队列，PC 端/其他端的排队变化无法实时同步。
- **PC 端修复**：`AgentWorkEvent` 增加 `queueItems`/`queuePaused` 可选字段；`ConversationKernel.emitQueueUpdate` 广播 `queue_update` 时携带 `queueItems: this.queueItems(runtime.target)` 与 `queuePaused`。PC UI 既有 `syncQueueItemsFromSnapshot`（读事件 queueItems）随之拿到 id，`queueItemIdForText` 可解析 backendManaged 行。
- **移动端修复**：`RemoteWorkEvent` 增加 `queue`/`queueItems`/`queuePaused` 字段；`RemotePayloadNormalizer` 暴露 `queue`/`queueItems`/`queueItem` 规范化；`DesktopLinkViewModel.applySseEvent` 新增 `queue_update` 分支——从事件更新 `conversationUiState.queueItems`/`queued`/`queuePaused`（带 runId 匹配守卫），移动端实时镜像远程队列。
- **验证**：Android `testDebugUnitTest`/`assembleDebug` BUILD SUCCESSFUL（新增 `RemoteQueueEventContractTest` 3 项：queue_update 事件解析、规范化、queueItems 列表）；PC `tsc --noEmit` + `npm run build` 通过；`queueUnifyStressVerify` 全过；`verify.js` 1642 PASS / 27 FAIL（新增 kernel queue_update 导出断言通过，27 项为既有环境依赖，与基线一致）。


## dev-0.5.6 长期历史显示修复 (2026-08-23)

- **诊断**：非落盘问题，是显示计算问题。历史在 this.history 正常，但 compressionBuildBlockStart 在无活动 run 时返回 boundary=0，全部历史被算进 buildBlockTokens，上下文窗口 longHistoryTokens 恒为 0。
- **修复**：compressionBuildBlockStart 增加空闲回退——无活动 run 时 boundary 取最后一个 run 起点之后（该 run 及之前 = 长期历史），无 run_id 时全部算长期历史；有活动 run 保持原有语义。
- **附带收益**：修复前长期历史永不触发 maybeCompress 的 20% 阈值；修复后空闲对话历史积累到 20% 正常触发压缩。
- **验证**：新增 longHistoryDisplayVerify（12 项，含真实 workspace 链路场景）；verify.js 保持基线 1643 PASS / 27 FAIL；contextBudgetVerify 无回归。

## dev-0.5.6 PC-GUI 自制玻璃迁移到移植玻璃 (2026-08-23)

- **自制玻璃 → 移植玻璃**：PC-GUI 主要玻璃表面（#topbar / #left-secondary / #input-area / #bottom / #right）与弹层菜单（.conv-action-menu / .model-select-menu / .newmark-select-menu）从自制玻璃（--glass-bg-* 半透明背景 + 内联 backdrop-filter）迁移到 kyant 移植玻璃 .liquid-glass 类。移除 8 处重复内联 backdrop-filter（由类统一提供），补充 4 处 position: relative（伪元素定位上下文），保留原有背景色/布局/边框 token。
- **不破坏规划**：次要控件（.right-open-btn / .flow-takeover / tooltip / .sub-win / #context-inspector）轻模糊保留；light 主题覆盖不变；布局结构零改动。
- **验证**：新增 pcGlassMigrationVerify（24 项 JSDOM+静态断言）接入 test:desktop:built；verify.js 恢复基线 1643 PASS / 27 FAIL（27 项为既有环境依赖）；verify.ts 两处类名断言随演进更新。

## dev-0.5.6 mobile popups migrated to Kyant liquid glass (2026-08-23)

- **弹窗全部改用 kyant 玻璃**：把移动端所有自制玻璃弹窗（半透明背景 + 手动 shadow/border）迁移到 kyant backdrop 液态玻璃。
- **共享 backdrop 传播**：`LiquidGlass.kt` 新增 `LocalLiquidBackdrop` CompositionLocal（staticCompositionLocalOf<LayerBackdrop?>），根布局 `NewmarkApp.kt` 用 `CompositionLocalProvider` 提供共享 backdrop；应用窗口内浮层（AnchorMenu Popup、ChatScreen 输入菜单浮层）自动复用根 backdrop 折射主窗口内容。
- **`liquidGlassModifier` 增强**：`backdrop` 参数改为可空，null 时回退 `LocalLiquidBackdrop`；两者皆无时用 `EmptyBackdrop` 仅输出 kyant 高光/内阴影/半透明表面（独立 Dialog 无捕获背景时的兜底）。
- **Dialog 弹窗自建 backdrop**：Dialog 是独立 window，无法复用根 backdrop，故在 Dialog 内容根 Box 挂 `layerBackdrop(backdrop)` 捕获 Dialog 窗口内背景（scrim），弹窗表面用 `liquidGlassModifier(backdrop=...)` 折射。覆盖：MemoryLabDialog（14dp 圆角/0.78 alpha）、SubagentHistoryDialog（12dp/0.78）、SettingsScreen 设备选择 Dialog（16dp/0.92）。
- **浮层 Popup 迁移**：AnchorMenu 菜单 Popup 与 ChatScreen 输入菜单浮层移除自制 `.background()` + 双层 border，改用 `liquidGlassModifier`（shape 传入原圆角，保留外 shadow）。
- **保留**：SettingsScreen 高权限确认框为 Material3 `AlertDialog`（自带玻璃容器），未改动。
- **验证**：`compileDebugKotlin`/`assembleDebug`/`testDebugUnitTest` BUILD SUCCESSFUL；`LiquidGlassContractTest` 新增弹窗玻璃参数断言（14/12/16dp 圆角、0.78/0.92 alpha、kyant 默认高光/阴影/内阴影）。


## dev-0.5.6 Kyant AndroidLiquidGlass liquid glass on mobile and PC (2026-08-23)

- **移动端接入 kyant AndroidLiquidGlass (backdrop) 库**：拉取 `io.github.kyant0/backdrop` 1.0.0 源码 vendor 进 `android/app/src/main/java/com/kyant/backdrop/`（Compose Multiplatform 液态玻璃库，含 lens 折射、blur、vibrancy、highlight、innerShadow、shadow 效果）。因 Maven AAR 需 Kotlin 2.2.21+/Compose 1.9.4+，项目为 Kotlin 2.0.21/Compose 1.7.4，故采用源码 vendor 并适配：`LayerRecorder.kt` 的 `context()` 接收者改写为显式参数（Kotlin 2.0 兼容），`InverseLayerScope.kt` 移除 Compose 1.8+ 才有的 `blendMode`/`colorFilter` 属性，补充 `org.jetbrains:annotations` 依赖。`compileDebugKotlin` 通过。
- **移动端玻璃应用**：新增 `LiquidGlass.kt` 封装（`liquidGlassModifier` Modifier 扩展 + `rememberLiquidBackdrop`），参数对齐 PC `--glass-blur-3`/`saturate(140%)`。根布局挂 `layerBackdrop` 捕获应用背景；左侧抽屉 `ModalDrawerSheet` 与右侧栏 `MobileRightSidebar` 改用液态玻璃渲染（折射 4dp/8dp、模糊 3dp、饱和度 1.4、顶部高光、内阴影、外阴影），API 31+/33+ 自动生效，旧系统退化为原半透明表面。新增 `LiquidGlassContractTest`。
- **PC-GUI 液态玻璃等价移植**：PC 为 Electron+HTML/CSS，无法运行 Compose 库，故在 `DESKTOP/src/ui/index.html` 用 CSS 等价实现 kyant 库视觉：新增 `--liquid-*` token（顶部高光/内阴影/外阴影/折射渐变/边缘光）与 `.liquid-glass`/`.liquid-glass-strong` 工具类（backdrop-filter 增强 + 折射渐变伪元素 + 高光边缘）。应用到左/右侧边栏（`#left-secondary`/`#right`）、顶栏 `#topbar`、输入区 `#input-area`、底部终端 `#bottom`、弹层（`.conv-action-menu`/`.model-select-menu`/`.newmark-select-menu`）：`saturate(130%)→140%` + `brightness(1.02)` + 高光/内阴影。
- **版本同步**：三端升级 dev-0.5.6（`VERSION`/desktop `package.json`/android `versionCode 506`），`sync-release-version --check` 通过。
- **验证**：Android `testDebugUnitTest` BUILD SUCCESSFUL（含新增 LiquidGlassContractTest）；PC `tsc --noEmit` + `npm run build` 通过，`verify.js` 1641 PASS / 27 FAIL（27 项为既有 Electron host tool bridge 环境依赖：terminal_takeover/computer_use/browser control，与基线一致，与本次改动无关）。
# Newmark Agent Overview`r`n`r`n## dev-0.5.12 变更`r`n`r`n- Android 各宽度布局移除右侧栏折叠态展开按钮，展开入口统一为右缘左滑。`r`n- 新建本地对话默认 Chat；Chat 工具面新增只读 `time` 并纳入权限白名单。`r`n- 模式/模型选择一级、二级弹窗圆角调整为 26dp。

## dev-0.5.5 provider-boundary fallback, runtime capacity, and interruption fixes (2026-08-23)

- **串供应商修复（用户报障：科技云 deepseek-v4-flash 一直跑成 opencode 的同名模型）**：固定模型回退 `scopedSwitchModels` 的供应商解析此前在模型重名时经 `findModel` 失败后落回全局 `auto_switch_anchor_provider`（曾被旧回退逻辑污染为 opencode），导致科技云失败后整个回退池变成 opencode 的模型并选中同名 flash。修复：解析顺序改为 deployment-first（activeModelConfig → fixedDeployment → activeDeployment），绝不落回全局 anchor；无法唯一确定供应商时返回空池（宁可失败绝不跨供应商）。同时删除回退成功后改写 `auto_switch_anchor_provider` 的副作用（一次瞬时失败不再永久把 Auto 路由与未来回退池锚到恢复供应商）。
- **Auto 回退同供应商**：`AutoRouter.planAttempts` 的回退候选强制 `deployment.providerId === 当前失败部署的 providerId`，即使原始 Auto selection 是 global scope（回退是恢复操作，不是新的全局路由决策）。
- **对话记录佐证**：用户对话的 `modelSelection` 已被串到 `provider-opencode-001/deepseek-v4-flash`，并伴随 `Stream read timeout after 30000ms`（已修）、`[LLM Error: 503]` 与 opencode 余额 403 中断。中断根因 = 30s 流空闲超时（已修）+ 回退跨供应商把请求带到余额不足的供应商。
- **并行限制修复（用户报障：PC 只能并行一个对话，新运行报 Runtime exceeded）**：`ElectronUtilityRuntimePool`/`WslAgentRuntimePool` 的 `maxResidentRuntimes` 默认值从 2 提升到 8——池按对话 target 每对话一个 runtime，旧默认 2 使第三个对话被 `runtime_pool_capacity` 拒绝。idle LRU 驱逐保留，容量测试显式传 `maxResidentRuntimes: 2` 锁原有容量语义，并新增默认容量 6 对话并行断言。
- **preset 子代理模型降级**：imported preset 引用的裸模型名在 catalog 中不存在时，peer 继承父部署运行（qualified deployment 值仍 fail closed）；修复 verify.js "Agent task preset" 回归。
- **验证**：`npm test` 全绿（含 verify.js 1669/1669）；autoRouterVerify 37/37；modelRecoveryStressVerify（250 编辑 + 2000 quota 路由 + 30 轮同供应商链式 402 failover + 跨供应商禁止断言）；runtimePoolCapacityVerify（含默认容量并行断言）；streamUnlimitedTimeoutStressVerify / queueUnifyStressVerify 通过；Android `testDebugUnitTest` BUILD SUCCESSFUL。

## dev-0.5.5 stress tests: stream unlimited timeout + queue unification (2026-08-23)

- **streamUnlimitedTimeoutStressVerify（14 项全过）**：验证 `readProviderStreamChunk` 默认 `timeoutMs = 0`（无限）——慢流 25x40ms 完成、停顿流不超时、abort 立即生效并取消 reader、显式正超时仍触发 TimeoutError、并发 reader 独立、500-chunk 突发无泄漏。
  - **发现并修复真 bug**：`timeoutMs = 0` 时 `setTimeout(fn, 0)` 下一 tick 立即触发 → `Stream read timeout after 0ms`。修复为 `timeoutMs > 0` 才 arm timer，否则 race 永挂起 Promise。
- **queueUnifyStressVerify（22 项全过）**：TypeScript AST 提取真实 UI 函数在沙箱执行——`queueItemIdForText` 按文本解析 kernel id；backendManaged 有 id 的行 delete/guide 转发 `queue_delete`/`queue_guide` 并携带 id；无 id 行保持锁定；focus 进入编辑并保留 originalText；拖动 drop 转发 `queue_reorder` 完整 orderedIds；本地行保持本地路径不转发。
- 接入：`package.json` 新增 `test:stream-unlimited-timeout-stress` 与 `test:queue-unify-stress`；`npm run build` 后独立运行。
- 回归：verify.js 1642 PASS / 27 FAIL 与基线一致；providerTimeoutRecoveryVerify 全部 PASS（显式 50ms 超时契约不受影响）。

## dev-0.5.5 stream timeout removal and mobile/desktop queue unification (2026-08-23)

- **Stream read timeout 修复**：`DESKTOP/src/providers/provider-events.ts` 的 `readProviderStreamChunk` 默认 `timeoutMs` 从 30_000 改为 0（无限），与请求级 `DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS = 0` 和 Android 端 `readTimeout(0)` / `SSE_IDLE_TIMEOUT_MS = 0L` 语义一致。此前 PC 端流式 chunk 读取残留 30s 空闲超时，导致长响应报 `Stream read timeout after 30000ms`。显式传正值的调用（providerTimeoutRecoveryVerify 传 50ms 验证 reader 取消）不受影响。
- **队列同化**：PC 端 `renderQueuePanel` 对 `backendManaged`（移动端 enqueue）项锁定编辑/删除/拖动。修复：PC UI 新增 `queueItemsByTarget` 状态与 `queueItemIdForText` 关联，快照/事件同步保存 `s.queueItems`；`server.ts` 新增 `/api/queue-action` 端点（复用 `hostedConversationUiAction` 的 queueAction 路径）；`api.queueAction` 桥接；`deleteQueueItem`/`focusQueueItem`/`guideQueueItem`/拖动对 backendManaged 有 id 的项转发 `queue_delete`/`queue_update`/`queue_guide`/`queue_reorder`，与移动端同一 kernel 机制。
- 验证：`tsc --noEmit` 通过；verify.js 1642 PASS / 27 FAIL 与基线一致；providerTimeoutRecoveryVerify 全部 PASS；dist 已同步。

## dev-0.5.5 mobile image preview, send-image NPE fix, and scroll-to-bottom (2026-08-23)

- **图片预览**：移动端添加图片后，输入框上方显示 PC .prompt-attachments 同款的缩略图 + 文件名 + 移除按钮（ChatScreen.kt InputArea 新增 pendingImage 参数与预览 Row，主函数 onRemovePendingImage 清除）。
- **发送图片 NPE 修复**：Attempt to invoke interface method boolean java.util.Collection.isEmpty() on a null object reference 根因是旧版 conversations.json 由 Gson 反序列化时缺失 imageAttachments 字段被赋 null。修复：ConversationStore.normalizeConversations 加载时统一补齐空集合（含 messages/modelContext/branchTree.nodes）；ApiClient 两处 isNotEmpty() → isNullOrEmpty() 防御；ChatViewModel OCR 路径 orEmpty()。
- **回到底部按钮**：移动端 ChatContent 增加 PC #scroll-bottom-btn 同款浮动按钮，derivedStateOf 检测视野不在底部时显示，点击 chatScope.launch { listState.scrollToItem } 回到底部；同时 LaunchedEffect 改为仅在 tBottom 时自动跟随（PC 语义，向上滚动不强制拉回）。
- 验证：:app:compileDebugKotlin 与 :app:testDebugUnitTest BUILD SUCCESSFUL；PC verify.js 1640 PASS / 27 FAIL 与基线一致。

## dev-0.5.5 PC-GUI scroll-follow and Guide duplication fixes (2026-08-23)

- **滚动跟随修复**：`_chatScrollNearBottomPx` 从 80 缩小到 24（约一行高度）。此前阈值过宽，用户向上滚动 50-80px 内仍被判定"在底部"，`_chatShouldAutoScroll` 保持 true，Agent 每次产生回应时 `autoScrollIfAtBottom` 把视野强制拉回底部（"向上拖不动"）。缩小阈值后，用户滚动超过约一行高度即解除跟随；视野确实在底部时仍正常跟随新内容。`autoScrollIfAtBottom` 保留 `if (_chatShouldAutoScroll)` 标志逻辑（实测确认：底部时 `followedToNewBottom=true`，向上滚动 600px 后 `wasYanked=false`）。
- **Guide 重复修复**：Build block 折叠再展开后，已应用的 Guide 除了正确注入位置外，还在聊天末端出现标记为"已应用"的重复消息。根因：`updateConversationWorkRunElement` 折叠/展开重建 DOM 时调用 `renderPendingGuideMessages(run.target, {})`，传空 `persistedGuideIds` 导致 `guideMessagesForTarget` 中所有记录（含已应用 Guide）被当 pending，`findGuideMessageElement` 在重建瞬间找不到元素，于是 `addMsg` 在末端创建重复消息。修复：新增 `workRunOwnsGuide(runId, clientMessageId, target)` 判断 Guide 是否已由 run 的 events/guides 承载；`renderPendingGuideMessages` 的 filter 排除此类 Guide，并在 forEach 中清理历史遗留的独立副本（非 awaitingAck 且 run 已承载时 `element.remove()`）。
- 验证：Electron CDP 复现脚本确认折叠前 1 个 Guide、折叠后 1 个（修复前 2 个）、展开后 1 个（修复前 2 个）；`verify.js` 全部 Guide/滚动断言 PASS（1642 PASS / 27 FAIL 与基线一致，27 项为环境依赖）。

## dev-0.5.5 PC-GUI marquee animation restored (2026-08-23)

- PC-GUI 跑马灯边框恢复旋转动画：`.marquee-border::before` 由 dev-0.4.7 的 `animation: none`（静态黑白渐变）恢复为 `marquee-rotate var(--marquee-speed) linear infinite`，`@property --marquee-angle` 注册的 conic-gradient 扫动重新生效，3 秒一圈无限循环，黑白四段渐变（`--g1..--g4`）与 2px 边框宽度保持不变。`will-change: transform` 提示合成层。`@supports not` 回退分支同步恢复 `marquee-rotate-fallback`（hue-rotate 方案）。
- 同步更新三处锁定"静态边框"的断言：`verify.ts`（ui html 运行中会话断言改为验证 `marquee-rotate` 动画存在）、`release-ui-icon-smoke.cjs`（titlebar 状态边框断言从 `borderAnimationName !== 'none'` 改为 `!== 'marquee-rotate'`）、`release-ui-render-performance-smoke.cjs`（从 `animated !== 0` 失败改为 `animated === 0` 失败，即要求动画活跃同时输入不饿死）。
- 验证：`tsc` 编译通过；`verify.js` 跑马灯相关 9 项断言全部 PASS（含更新后的 3 项）；Electron CDP 实测 `animationName=marquee-rotate`、3s/infinite、conic-gradient 黑白渐变、`@property` 已注册；`startupPrewarmVerify` 74 项通过。
- terminal_takeover / computer_use / browser control 共 27 项失败为预先存在的环境依赖（Electron host tool bridge 不可用），基线（stash 后原始代码）同样失败 27 项，与本次改动无关。

## dev-0.5.4 mobile AlarmManager tool (2026-08-22)

- 移动端本地 Agent 新增 `alarm_manage` 通用工具，支持通过 Android `AlarmManager` 创建、列出和取消本应用闹钟；闹钟记录仅保存于应用私有 `files/newmark/alarms.json`。
- 创建默认使用 `setExactAndAllowWhileIdle`，设备未授予精确闹钟特殊访问时由应用跳转系统 `ACTION_REQUEST_SCHEDULE_EXACT_ALARM` 页面并拒绝本次执行；`exact=false` 使用系统允许的非精确闹钟路径。
- Manifest 声明 `SCHEDULE_EXACT_ALARM`，并注册非导出的 `AlarmReceiver`；触发后通过系统通知渠道提示用户，不接收外部隐式广播。
- 验证：Android `testDebugUnitTest lintVitalRelease assembleRelease` 通过。

## dev-0.5.4 mobile local image attachments (2026-08-22)

- 移动端本地输入菜单新增“选择图片”，仅接受 PNG/JPEG，单图上限 12 MiB，最多随消息发送 4 张；图片以受限 Data URL 作为 `ChatMessage.imageAttachments` 持久化。
- Android Chat Completions 与 Responses 请求均将本地图片序列化为标准文本 + `image_url`/`input_image` 内容；远程桌面消息仍只走原有文本发送路径。
- 图片选择失败、空文件、非图片和超限输入均在本地拒绝，不写入对话；现有视觉拒绝时可继续进入 mini OCR + 文本校正退路。
- 本地图片视觉请求失败且当前供应商没有其它启用视觉模型时，Android Agent 对附件运行 ML Kit 中英文 OCR，再用纯文本模型做保守校正；备用视觉模型存在时不抢先 OCR。

## dev-0.5.4 final visual fallback (2026-08-22)

- PC 与移动端统一落实最终视觉退路：语义文本/DOM/PDF 与可用视觉模型优先；当前模型拒绝图像且同供应商没有可用备用视觉模型时，才进入本地 mini OCR，再以纯文本请求做保守校正。
- 回退结果保留 `raw_ocr`/`text`、校正文本、近似警告和不确定性状态；不支持的视觉模型不会再次收到原图，OCR 无结果时明确失败且不编造内容。
- 桌面内核在固定非视觉模型的预检和视觉请求路由耗尽后触发回退；移动端浏览器识别复用 ML Kit OCR，并由本地 `ChatViewModel` 的无图文本请求填充 `corrected_text`。
- 验证：桌面 `npm run build`、`localOcrFallbackVerify`，Android `:app:testDebugUnitTest` 均通过。

## dev-0.5.4 mobile capabilities and privilege boundary (2026-08-22)

- Shizuku 已正式接入 `dev.rikka.shizuku:api/provider:13.1.5` 与官方 UserService/AIDL 中转；Root 和 Shizuku 现在是独立能力域，分别由 `root_exec`、`shizuku_exec`/`adb_exec` 暴露，不再互相回退。高权限命令行支持 `root`/`shizuku` 显式边界，未知命令在高权限模式下按当前可用边界执行。
- 高权限开关增加不可逆风险警告弹窗，必须选择“继续”才会启用或请求 Shizuku 授权；“退出”保持关闭。
- 全模式新增 `files_manage` 与 `apps_inspect`：文件工具仅操作共享存储、拒绝符号链接逃逸、Android/data/obb、非空目录递归删除、覆盖写入和未确认删除；应用工具只返回 PackageManager 可见公开元数据，不读取其他应用私有数据。

- Android 新增 `MobileCapabilityStore`：设置页可请求“读取所有文件”（系统特殊访问页）与“读取应用列表”，并通过 `MANAGE_EXTERNAL_STORAGE`、`QUERY_ALL_PACKAGES` 声明接入系统能力。
- 新增高权限模式开关与 `PrivilegedToolBridge`。桥接层优先检测 Shizuku，回退 Root `su -c`；`high_privilege_exec`/`adb_exec` 只在高权限模式且授权有效时动态暴露，执行器每次调用再次阻断，关闭开关后旧 prompt 也不能触及高权限工具。
- 新增插件设置页与 `MobilePluginStore`，Skill/MCP 启用状态持久化到 `files/newmark/plugins.json`，并通过 `skills_list`/`mcp_list` 暴露给本地 Agent。
- Android/Termux 命令目录扩展到 `pkg`、`pm`、`am`、`cmd`、`dumpsys`、`logcat` 及常用 `termux-*` 命令；系统修改类命令强制走高权限中转层，普通命令保持受控 shell。
- 版本同步至 `0.5.4`（`versionCode 504`）。`testDebugUnitTest` 通过 102 项。

## dev-0.5.3 remote reconnection and error classification fix (2026-08-21)

- Remote transcript ownership is now based on paired-device intent, not transient `Connecting`/`Reconnecting`/`Disconnected` status. A reconnect keeps the focused remote conversation mounted instead of replacing it with the local conversation.
- A disconnected remote surface retains its selected workspace/conversation IDs. The reconnect action retries the link in place; switching to local remains explicit.
- Local provider transport retries exactly once after a fresh `Software caused connection abort` before any HTTP response is obtained. The stale OkHttp connection pool is evicted first, so a retry cannot duplicate a request that already produced a response.
- Local Agent error text mentions API configuration only when `ApiConfig.isReady` is false. Configured-provider network, provider, tool, and parsing failures preserve their actual error.
- Regression contracts cover remote surface ownership, one-shot connection-abort recovery, and error classification. Full Android unit tests, Vital lint, R8/resource shrinking, and Release assembly passed.
- Final APK: `android/app/build/outputs/apk/release/app-release.apk`, 45,841,568 bytes, SHA-256 `2B454650D9359AEAB65F08892CCCC8457AC303B2734FEEBC996ACBE704CACDC2`.

## dev-0.5.3 mobile duration display parity (2026-08-21)

- Mobile processed duration now matches PC `formatWorkDuration`: `1s..59s`, then `1m 00s..59m 59s`, then `1h 00m 00s` and above. Sub-second values remain `1s`, and minute/second fields are zero-padded exactly like PC.
- `MobileRuntimeParityContractTest` locks the hour/minute decomposition and zero-padding contract. Android Debug unit tests pass after the change.

## dev-0.5.3 mobile local Agent runtime parity and background stability (2026-08-21)

- Local Agent processing duration now uses integer seconds with a minimum display of `1s`, matching the PC presentation contract.
- Android provider SSE uses a 120-second read-idle timeout. OkHttp resets this deadline on each received stream line, so a long-running response is not timed out from its start time; only silence after the latest provider response can time out.
- Local Agent jobs hold a short-lived `PARTIAL_WAKE_LOCK` from job entry through cleanup, allowing screen-off/background provider and tool work to continue without a permanent battery lock. The lock is released in `finally`.
- Mobile marquee borders now use one immutable closed conic gradient (`g1...g4,g1`) and rotate the draw scope. This removes both stop-reordering jumps and the non-interpolated color seam at the 0/360-degree closure, preserving the PC 3-second cycle and 2dp border.
- Added runtime parity contracts for duration, idle timeout, wake-lock lifecycle, and marquee continuity. Existing local/remote response, Markdown/LaTeX, null filtering, legacy SSE, and duplicate-final-response contracts remain in the same suite.
- Verification: `testDebugUnitTest` passed 90 tests; `lintVitalRelease` and `assembleRelease` passed. Release APK SHA-256: `371A495A40DE91E3C3C904DB276521991BA6A8EEC3AAEE9DD163D9C03A9105E6`.

## dev-0.5.3 mobile local/remote conversation parity (2026-08-21)

- Android local Agent now mirrors the desktop Chat-to-Responses and temperature-capability fallbacks. A recognized 4xx rejection of Chat Completions tool calling with `reasoning_effort` retries `/responses`; an explicit HTTP 400 unsupported-`temperature` response retries once without that parameter and caches the endpoint/model capability. Responses reasoning summaries, output text, and function calls are normalized into the existing local conversation event stream. Unrelated 4xx/5xx responses are not retried.
- Android local Agent responses now use the same conversation timeline structure as paired-desktop responses: the user message, standalone Build activity row, and terminal assistant message are projected separately through the shared `ChatScreen` renderer. Local-only differences remain at capability and right-sidebar boundaries, not in transcript presentation.
- Local Chat Completions streaming ignores explicit JSON `null` values instead of appending the literal word `null` to thought or answer buffers. Current and legacy readable reasoning fields (`reasoning_content`, `reasoning`, `thinking`, `analysis`) are normalized with Gson, and legacy response wrappers remain accepted.
- Paired-desktop SSE accepts both `data: payload` and legacy `data:payload` lines. Public thought deltas continue to update one active thought item while `thought_result` supplies its terminal content.
- The shared Android Markdown renderer now recognizes the PC formula delimiters `$...$`, `\(...\)`, `$$...$$`, and `\[...\]`, preserving readable fractions, roots, scripts, Greek letters, and common operators in both local and remote conversations.
- Desktop and Android versions are synchronized to `0.5.3` (`versionCode 503`). Focused stream/projection/SSE/Markdown tests pass, followed by the complete Android unit suite and Debug APK assembly. Detailed evidence is recorded in 本地归档（未纳入公开仓库）.
- The mobile provider compatibility fix is covered by real two- and three-request MockWebServer tests and the complete Android unit/Vital lint/R8/Release gate. Details and APK digest are recorded in 本地归档（未纳入公开仓库）.
- Local completed Agent replies now render once: the persisted assistant message owns the final Markdown body, while its WorkRun remains only the adjacent Build activity. This prevents the same response from appearing once inside the Build row and once as the terminal Agent row.

## dev-0.5.2 three-platform release (2026-08-21)

- Desktop and Android are bound to `0.5.2` (`versionCode 502`). The release matrix contains Windows x64 MSI/portable ZIP, Linux x86_64 AppImage/amd64 deb/unpacked ZIP, and Android APK.
- The complete desktop release gate, Android unit/Vital lint/R8 gate, packaged Windows SSH/CLI/context/console checks, and isolated WSL Linux build pass. The hardened focused desktop verifier reports `1667/1667`.
- The machine-wide MSI upgrade reports CLI `0.5.2` and registry `0.5.2.0`. Installed and candidate `app.asar` hashes match, the existing user config hash is unchanged, and the installed GUI is responsive.
- Release tooling supports one optional unified artifact root for externally locked workspaces, binds packaged CLI smoke to the actual candidate executable, and preserves no-space Windows paths across WSL packaging. Default CI output remains `release/`.
- Annotated tag `dev-0.5.2` points to `899f9e826d53c0f2e3e88328b3185a4174d3ee14`. GitHub prerelease publication and the Windows/Linux/Android/publish matrix completed successfully; the six server-side asset sizes and SHA-256 digests match the locally installed and gated candidates.
- Exact asset hashes, installation evidence, recovery findings, and publication state are recorded in 本地归档（未纳入公开仓库）.

## Cross-platform live thought streaming and Android identity/accessibility fixes (2026-08-21)

- Desktop and Android now present provider-authored readable reasoning incrementally inside the active Build thought item. Chat Completions reasoning fields and Responses API reasoning-summary deltas flow through a public `thought_delta` event; UI projection mutates one incomplete thought in place, and only the final `thought_result` is durable.
- Android local chat/completions requests use SSE streaming, independently accumulate thought, answer text, and fragmented tool calls, and update Compose state on the main dispatcher. Remote Android conversations consume the same desktop `thought_delta` event contract through the paired SSE bridge.
- Android model selection identity is provider-qualified for local catalogues and deployment-qualified for remote catalogues. Providers may therefore expose the same display model name without sharing selection state or resolving the first-level label to the wrong provider.
- Memory Lab overview tag labels use theme palette text tokens instead of a fixed pale ARGB value. Light and dark palette tests require WCAG AA contrast for both emphasized and ambient labels.
- Desktop build, focused bridge/coalescer checks, and the complete desktop source verifier pass (`1663/1663`). Android focused projection/streaming contracts pass; the final Release unit/lint/R8/APK gate is recorded in 本地归档（未纳入公开仓库）.

## dev-0.5.1 provider migration and release (2026-08-21)

- Desktop and Android share version `0.5.1` (`versionCode 501`). Android uses the fixed product glass level and no longer exposes a glass-strength setting.
- A paired Android device can explicitly import the desktop provider catalogue with API credentials through an authenticated endpoint. Ordinary Remote Touch state and model menus remain credential-redacted; local keys are preserved during merges and providers previously imported without keys are repaired.
- The complete release command passed desktop, context, performance, TUI, SSH, WSL, CLI, GUI/TUI/CLI, Android unit, Vital lint, R8/resource-shrink, and packaging gates. The focused desktop source verifier reports `1663/1663`.
- Six local assets were built: Windows MSI/ZIP, Linux AppImage/deb/ZIP, and Android APK. Candidate metadata reports Windows `0.5.1`, deb `0.5.1`/`amd64`, and Android `0.5.1`/`501`.
- Windows machine installation completed on the third interactive UAC attempt with Windows Installer exit `0`. Program Files and the registry report `0.5.1`/`0.5.1.0`; installed and packaged `app.asar` are byte-identical, the existing user config hash is unchanged, and the installed GUI reached a responsive window. The GitHub prerelease contains exactly six assets whose server-side sizes and SHA-256 digests match the local candidates. Exact evidence is recorded in 本地归档（未纳入公开仓库）.
- The first tag CI reproduced all three platform builds but its publish job lacked repository context. `.github/workflows/release-linux.yml` now passes `--repo "$GITHUB_REPOSITORY"` to GitHub CLI release operations; corrected tag run `32448463305` completed Windows, Linux, Android, and publish jobs successfully while preserving the already verified release assets.

## Mobile clean-install provider baseline (2026-08-20)

- `ProviderStore.kt` now persists and returns an empty provider list when `filesDir/newmark/providers.json` does not exist. Existing provider files remain authoritative and are not migrated or erased.
- The bundled `NewmarkPresets.kt` seed catalogue was removed, so clean installs no longer contain DeepSeek, APInebula, OpenAI-Hub, or OpenCode defaults.
- `ProviderStoreCleanInstallContractTest.kt` locks the empty first-load branch and absence of bundled presets. Full unit tests, Debug/Release assembly, and Release lint/R8/resource shrinking passed. Evidence: 本地归档（未纳入公开仓库）.

## Mobile model-menu catalogue ownership (2026-08-20)

- `NewmarkApp.kt` selects exactly one catalogue owner: paired desktop `remoteModelOptions()` in remote mode or `ChatViewModel.enabledModelOptions()` in local mode.
- `ChatScreen.kt` closes and rekeys its retained input-popup state when `remoteMode` changes, preventing a remote Models page from surviving into a local conversation.
- `selectedModelMenuLabel` resolves local labels and remote deployment identifiers through the active catalogue so the first-level row shows only the model display name; provider names remain second-level group headings.
- `InputComposerAndModelMenuContractTest.kt`, full unit tests, Debug/Release assembly, and Release lint/R8/resource shrinking passed. Evidence: 本地归档（未纳入公开仓库）.

## Mobile composer popup coordinate-space fix (2026-08-20)

- `ChatScreen.kt` now measures the popup container and its plus/model anchors in window coordinates, then `inputMenuAnchorInContainer` converts each live anchor into the overlay's local coordinate space.
- This removes the duplicated 48/240/280dp primary-sidebar offset and the optional additional 220dp secondary-sidebar offset while retaining centered-above-control placement.
- `InputComposerAndModelMenuContractTest.kt` models 280px and 500px container origins and requires both to resolve to the same local anchor. Full unit tests and Debug/Release assembly plus Release lint/R8/resource shrinking passed. Evidence: 本地归档（未纳入公开仓库）.

## Mobile Settings predictive-exit handoff (2026-08-20)

- `android/app/src/main/java/com/newmark/mobile/ui/PredictiveBackMotion.kt` distinguishes a cancelled gesture from a committed back and can retain the committed release transform while an owning overlay exits.
- `SettingsScreen.kt` enables that retention only on `SettingsPage.Main`. Nested settings backs still reset progress because the settings surface remains visible, while cancellation always returns the current page to rest.
- This removes the frame where Settings first snapped to its untouched layout before `NewmarkApp.kt` began the retained `AnimatedVisibility` exit.
- `PredictiveBackMotionContractTest.kt`, full unit tests, Debug assembly, and Release lint/R8/resource shrinking/assembly passed. Device-frame evidence remains pending because no ADB target was connected. Evidence: 本地归档（未纳入公开仓库）.

## Mobile wide composer menu live anchoring (2026-08-20)

- `android/app/src/main/java/com/newmark/mobile/ui/ChatScreen.kt` keeps separate live root-coordinate anchors for the composer plus and model controls. Sidebar-driven wide-layout remeasurement now moves the matching overlay with its button.
- Anchor movement updates only popup placement and cannot restart the menu entrance animation. Dismissal retains the last valid anchor for its fade-out interval.
- `centeredInputMenuX` aligns popup and control centers, clamps to an 8px viewport margin, and the existing vertical formula keeps the popup bottom 6dp above the control top.
- `InputComposerAndModelMenuContractTest.kt` covers centered placement, both edge clamps, live anchor binding, and vertical attachment. Full unit tests and Release lint/R8/resource shrinking/assembly passed. Evidence: 本地归档（未纳入公开仓库）.

## Mobile independent-page exit smoothness (2026-08-20)

- `android/app/src/main/java/com/newmark/mobile/ui/NewmarkApp.kt` gives compact SubAgent, Settings, Terminal, and Memory Lab separate `MutableTransitionState` owners. Their overlays stay mounted until exit completes.
- Entry retains the existing 320 ms `PcEaseOutExpo`; exit uses a directional 260 ms `CubicBezierEasing(0.4, 0, 1, 1)` instead of replaying the entry-oriented deceleration profile.
- The root view requests Android 15 HIGH frame rate while a sidebar or independent-page transition is active and restores DEFAULT after every transition becomes idle.
- `MemoryLabAndSubagentAnimationContractTest.kt` and `ResponsiveSidebarContractTest.kt` lock the lifecycle, easing, and frame-rate bindings. Full unit, Release lint/R8/resource shrinking, and APK assembly passed; device-side frame timing remains pending because no ADB target was connected. Evidence: 本地归档（未纳入公开仓库）.

## 2026-08-20 mobile formal release package

- Formal APK: `release/mobile/Newmark-0.4.54-formal.apk` (`com.newmark.mobile`, `Newmark`, version `0.4.54`, versionCode `454`).
- Stress APK remains isolated under `android/app/build/outputs/apk/stress/app-stress.apk` with `com.newmark.mobile.stress` and display name `Newmark Stress`; it is never used as the formal package.
- Clean verification passed: `testDebugUnitTest`, `lintVitalRelease`, `assembleRelease`, and `assembleStress`.
- SHA-256: `BCB843C6EFB1557716079ECB6C791709AF90DFEFD9FCA8549E0EC8AE8995E33A`.

## 2026-08-20 mobile sidebar P0/P1 fix

- Expanded-layout right sidebar now releases its `Row` slot after folding; close animation keeps the slot only while progress remains non-zero.
- Left sidebar touch progress continuously drives the rail width on foldable/tablet layouts. The gesture modifier covers the full drawer/expanded row so blank sidebar regions can start a horizontal drag.
- Rebuilt formal APK SHA-256: `3683B959AC863A93AA13877C5D3CF1ED8AFF501FCBFD7B32E696179A3587EF21`.

## 2026-08-20 mobile sidebar boundary-follow refinement

- The folded left rail remains the original functional layer during the entire gesture. A separate expanded layer overlays it, and the conversation boundary begins moving only after the expanded edge crosses 48dp; the folded rail then exits left after expansion commits.
- The right panel's stable content is clipped by a continuously growing `panelWidth * progress` slot, so conversation avoidance follows the finger without a hard reservation or stretched content.
- Formal APK SHA-256: `B107BF840C4D00776FCAC91B6C50E7735828AEE543A55294AA687FC1FBF13BF3`.

## 2026-08-20 mobile sidebar aligned boundaries

- Left conversation avoidance is now `max(48dp rail, actual expanded-layer edge)`.
- Right conversation avoidance grows with the exact clipped slot width while fixed content translates from the right edge, removing the prior coordinate mismatch.
- Formal APK SHA-256: `E37C478412E69897B378A152934008D27679CBB1FE90C8D0F47285C527EF4D0D`.

## 2026-08-20 mobile fixed-width left sidebar

- Expanded left sidebar width is fixed per screen class (240dp medium, 280dp large) and animation changes translation only.
- The original functional 48dp folded rail remains the minimum occupied boundary.
- Formal APK SHA-256: `4AEB4FF1151A39A8E0838CF11EC4EF826EFAD6D0FA73CA977BC5F9EC17EE438F`.

## dev-0.5.0 pressure optimization

The desktop runtime reduces startup/运行中压力峰 at the cross-process event boundary. `DESKTOP/src/core/workEventCoalescer.ts` combines only same-run streaming `text` deltas for one 16 ms window; any non-text event flushes first and then is delivered immediately. `main.ts` applies this to Electron renderer/mobile bridge dispatch, while `server.ts` applies the same policy to hosted mobile SSE. Agent work-run storage and final-response persistence remain authoritative and unchanged.

Verification completed on 2026-08-20: `npm.cmd run build` passed; `workEventCoalescerVerify` passed 6 assertions; `performanceOptimizationVerify` passed 17 assertions; `runtimeIsolationVerify` passed; `git diff --check` passed. `DESKTOP/package.json` and lock metadata are `0.5.0`. Existing user modifications in the worktree were preserved. No package publication is claimed.

The complete Windows release path then passed 1664/1664 desktop assertions and the remaining context, performance, TUI, CLI, WSL, SSH, and GUI/TUI/CLI shared-backend gates. Local per-machine MSI upgrade completed with Windows Installer code `3010` (success; restart recommended). `C:\Program Files\Newmark Agent\Newmark.exe --version` reports `0.5.0`, registry display version is `0.5.0.0`, and the installed `app.asar` is byte/hash-identical to `release/win-unpacked`. Installation evidence and artifact hashes are in 本地归档（未纳入公开仓库）.

## dev-0.4.11 multi-dimensional verification

The dev-0.4.10 history-first conversation activation, Guide reconciliation, unsupported-temperature recovery, and provider-failure continuation boundary were verified in source and in the Windows packaging path. The final Feature Verify result is 1664/1664. The package metadata was advanced to dev-0.4.11. MSI, portable ZIP, and app.asar hashes are recorded in 本地归档（未纳入公开仓库）. Portable and installed `Newmark.exe` report 0.4.11; installed and packaged app.asar hashes match exactly.

## Mobile animated overlays and Memory Lab force graph (2026-08-20)

- 移动触摸契约：Memory Lab 总览使用单一高优先级触摸循环仲裁节点点击、整图平移和双指缩放；节点保留 PC 28/32px 半圆胶囊外观，但点击命中区至少 48dp。拖动永远只修改相机，不修改任何节点坐标；交互期间物理布局、环境漂移、聚焦镜头和流光全部暂停，抬手恢复。默认/重置镜头为 0.88，缩放允许进入 `<0.28` 点模式。
- `MemoryLabAndSubagentAnimationContractTest.kt` 锁定手势仲裁、冻结状态、点模式可达、父链/子树和胶囊契约；本地归档（未纳入公开仓库） 保存实机证据与冷启动风险边界。

- `NewmarkApp.kt` keeps the main surface mounted while Settings, Terminal, Memory Lab, and compact SubAgent pages animate as retained overlays in both directions.
- `PredictiveBackMotion.kt` maps Android predictive-back progress to live translation, alpha, and scale while preserving nested page back semantics.
- `MemoryLabScreen.kt` renders the PC-style force-directed tag/component graph with relationship edges, focus modes, pan/zoom, and the complete detail relationship/component preview.

## dev-0.4.10 history-first conversation activation (2026-08-20)

- `DESKTOP/src/ui/index.html` owns a composite `workspaceId + conversationId` message cache. Conversation selection restores readable messages and WorkRuns immediately, while durable-history reading and runtime activation settle independently. Empty or failed activation snapshots cannot erase readable history or return the renderer to the welcome state.
- Accepted Guide events retain their authoritative WorkRun sequence. Only `awaitingAck` optimistic Guides use `.work-run-pending-guides` at the expanded Build body's bottom; multiple submissions render together and disappear when the authoritative acknowledgement arrives.
- `DESKTOP/src/llm/provider.ts` detects only explicit unsupported-`temperature` HTTP 400 responses, retries the request once without that field, and caches the endpoint/model capability for later streaming and non-streaming requests.
- `DESKTOP/src/core/conversationKernel.ts` treats provider failure as a hard boundary for automatic Goal/Guide continuation and removes hidden continuation work from memory and durable queues, preventing error-only retry chains without fresh user input.
- `DESKTOP/src/tests/conversationHistoryFirstVerify.ts`, `guideUiReconcileVerify.ts`, `guideWorkRunVerify.ts`, and `providerTimeoutRecoveryVerify.ts` lock these contracts. `android/app/src/main/java/com/newmark/mobile/ui/MemoryLabScreen.kt` includes the Compose layout/animation imports required by the current Memory Lab implementation so the full Android Release gate remains buildable. Packaged fast-switch pressure additionally locks the target-bound activation barrier and expanded readable error Build.

Relevant tree:

```text
Newmark Agent/
├─ DESKTOP/src/
│  ├─ ui/index.html
│  ├─ llm/provider.ts
│  ├─ core/conversationKernel.ts
│  └─ tests/conversationHistoryFirstVerify.ts
├─ android/app/src/main/java/com/newmark/mobile/ui/MemoryLabScreen.kt
└─ 本地归档（未纳入公开仓库）
```

## 2026-08-20 移动形态压力续测

SubAgent、MemoryLab 真实截图与 mock 失败边界记录于 本地归档（未纳入公开仓库）。MemoryLabStore 已增加跨应用 coreMd 回退，Canvas 手势已移除动态 pointerInput key 以保证拖动连续跟手。

The final local Windows artifacts are MSI 226,322,512 bytes (`F3A5EF6C63B264B580AAADDB509157ACA99ACC358E0B93DBBF9C9B79C9C33690`), win-unpacked ZIP 292,453,099 bytes (`8B4181D7514AC060E4C6675E287FECCF03BA143ED7530E94778C7B2F2A37AB7D`), and app.asar 160,066,102 bytes (`C837571A10A875D0ADD0C6819E54F7816EA40EE8EAEAFD3E8555BD8019019627`). The candidate reports `0.4.10`; machine-wide installation is pending interactive UAC confirmation, while the existing Program Files installation remains `0.4.9`.

## Android conversation browser recognition (2026-08-20)

- `android/app/src/main/java/com/newmark/mobile/ui/BrowserRecognition.kt` owns bounded WebView capture, bundled Chinese/English OCR, guarded PDF download, text-layer-first reading, and first-page render fallback.
- `BrowserSession.kt` routes `browser_use observe/extract` through the PC-compatible recognition receipt; `RightSidebar.kt` binds it only for the lifetime of the matching conversation WebView and releases it on disposal.
- `android/app/src/test/java/com/newmark/mobile/ui/BrowserRecognitionContractTest.kt` covers PDF text extraction, bilingual evidence selection, recognition order, and conservative-repair constraints.

## Mobile PC-style model grouping and stable composer shape (2026-08-19)

- `android/app/src/main/java/com/newmark/mobile/data/ProviderConfig.kt` extends `ModelOption` with separate provider and display labels while retaining wire-compatible defaults.
- `android/app/src/main/java/com/newmark/mobile/vm/ChatViewModel.kt` and `DesktopLinkViewModel.kt` project local and remote provider catalogues into the same model-option contract.
- `android/app/src/main/java/com/newmark/mobile/ui/ChatScreen.kt` groups the second-level model menu by provider, renders only the model display name in each row, preserves the compact popup/morph animation, and adds horizontal overflow scrolling beside the existing vertical catalogue scroll. Its composer is one line by default, caps growth at five lines, scrolls additional lines internally, keeps the one-line `24dp` corner radius, and bottom-aligns all three action controls.
- `ui/theme/NewmarkTheme.kt` owns the fixed 85% product glass level, PC-equivalent opacity/transparency/three-tier blur curve, and bounded mobile backdrop mapping. `NewmarkApp.kt`, `Sidebar.kt`, `RightSidebar.kt`, `ChatScreen.kt`, and `components/AnchorMenu.kt` consume the read-only `LocalGlassMode`; Android no longer exposes or persists a glass-strength slider.
- `android/app/src/main/java/com/newmark/mobile/ui/Sidebar.kt` owns the circular local-conversation add control.
- `android/app/src/test/java/com/newmark/mobile/ui/InputComposerAndModelMenuContractTest.kt` locks the five-line cap, fixed corner radius, provider grouping, unprefixed model rows, and legacy combined-label compatibility. `ui/theme/GlassPresentationContractTest.kt` locks the PC 85% curve and the accepted 32dp default portrait backdrop.
- Formal emulator evidence and the data-preserving installation ledger are recorded in 本地归档（未纳入公开仓库）.

## Mobile system-aware launch theme (2026-08-19)

- `android/app/src/main/AndroidManifest.xml` assigns `Theme.Newmark.Starting` before `MainActivity` or Compose exists, so launch colors follow Android configuration rather than a later application preference.
- `android/app/src/main/res/values*/themes.xml` owns pre-Android-12 launch-window colors and Android 12+ system Splash attributes. Day resources retain `#F2F2F7`, dark resources select `#000000`, and both status/navigation icon appearances follow the same qualifier.
- `android/app/src/main/res/values*/colors.xml` owns the day/night launch and adaptive-icon background tokens. The existing monochrome Newmark foreground therefore becomes black-on-light or white-on-black without a second application-rendered splash page.
- `android/scripts/mobile-agent-stress.ps1` now isolates each sidebar/popup iteration, uses an ADB reverse tunnel for its same-host fixture, and records package-scoped ANR/FATAL evidence even when a UI assertion aborts early.
- Formal Release evidence is 本地归档（未纳入公开仓库）, 本地归档（未纳入公开仓库）, 本地归档（未纳入公开仓库）, and 本地归档（未纳入公开仓库）.

## Mobile runtime continuity pressure infrastructure (2026-08-19)

- `android/scripts/mobile-agent-stress.ps1` uses one authoritative live hierarchy for Build, Goal, Flow, and Queue before exercising remote enqueue, preventing observation cost from consuming the run window.
- `android/scripts/mobile-remote-target-switch-stress.ps1` pairs only the isolated Stress package, keeps a primary Build live, drives the real portrait sidebar through two A↔B workspace/conversation cycles, checks target-specific UI markers, stable PID/SSE ownership, and restores the formal app foreground during cleanup.
- `android/scripts/mobile-queue-animation-benchmark.ps1` installs the non-debuggable Release-equivalent Benchmark package, locates Queue before the sample, then records an observer-free fixed-coordinate expand/collapse graphics window; cleanup uninstalls only the isolated package and restores the formal app.
- `DESKTOP/scripts/mobile-mock-server.cjs` models real Flow suspension and two independent target-scoped workspace/conversation states. Its bounded `targetReads` ledger proves which target each conversation, UI-state, and workspace-list read addressed.
- Current evidence covers a 300-event/90-loop remote run, local 17-tool Queue/Guide execution and restart, three live service restarts, alternating sends, Flow pause/resume, ordinary stop, foreign-target rejection, and visible live-target switching without state leakage.
- Evidence: 本地归档（未纳入公开仓库）, 本地归档（未纳入公开仓库）, and 本地归档（未纳入公开仓库）.

## dev-0.4.9 Windows/Linux release ownership and gate (2026-08-19)

The desktop package metadata is `0.4.9`; the prerelease identity is `dev-0.4.9`. The same final `win-unpacked` tree produced the verified MSI and ZIP. The installed candidate at `C:\Program Files\Newmark Agent` is byte-identical at `resources/app.asar`, reports `0.4.9`, keeps mutable runtime state outside Program Files, and passes CLI/TUI/GUI restart and hosted remote-service parity gates. Ubuntu 24.04 WSL independently copies the candidate to a native Linux filesystem, performs a fresh dependency install and full platform suite, and produces the AppImage, deb, and unpacked ZIP.

Relevant tree:

```text
Newmark Agent/
├─ DESKTOP/
│  ├─ package.json
│  ├─ scripts/
│  │  ├─ release-notes-dev-0.4.9.md
│  │  ├─ release-pc-gui-tui-remote-service-stress.cjs
│  │  ├─ release-safe-installed-shape-stress.cjs
│  │  ├─ release-safe-shared-root-restart-stress.cjs
│  │  ├─ release-ssh-tui-stress.cjs
│  │  └─ release-ui-model-settings-smoke.cjs
│  └─ src/tests/
│     ├─ modelRecoveryStressVerify.ts
│     └─ remoteTouchServerStatusVerify.ts
├─ release/
│  ├─ Newmark-Agent-0.4.9-x64.msi
│  ├─ Newmark-Agent-0.4.9-win-unpacked-x64.zip
│  ├─ Newmark-Agent-0.4.9-x86_64.AppImage
│  ├─ Newmark-Agent-0.4.9-amd64.deb
│  ├─ Newmark-Agent-0.4.9-linux-unpacked-x64.zip
│  └─ {win,linux}-unpacked/
└─ 本机私有归档（已从公开仓库排除）
   ├─ 20260819-213000-dev-0.4.9-windows-package-install.md
   ├─ 20260819-dev-0.4.9-remote-touch-dark-packaged.png
   ├─ 20260819-dev-0.4.9-remote-touch-light-packaged.png
   └─ 2026-08-19T13-29-33-036Z-pc-gui-tui-remote-service-stress.json
```

- `release-ui-model-settings-smoke.cjs` owns the real packaged Electron/CDP dark/light geometry, typography, transparency, model-edit recovery, and hosted-service status checks. It verifies the two remote actions at the same `120×30` geometry and rejects horizontal or vertical text overflow.
- `release-ssh-tui-stress.cjs` keeps the source cold-start gate at 12 seconds and gives the packaged double-sidecar cold start a measured 15-second envelope; the final package reached the full TUI in 11.095 seconds, then passed interaction, light theme, four restarts, and explicit-root isolation for both console entrypoints.
- `release-safe-installed-shape-stress.cjs` and `release-safe-shared-root-restart-stress.cjs` verify that installed CLI/TUI/GUI lifecycles do not write mutable data into Program Files and preserve explicit roots containing spaces across GUI restart.
- `release-pc-gui-tui-remote-service-stress.cjs` owns the installed black-box hosted-service gate. Three GUI/TUI cycles completed 200 pressure requests per phase with authentication, SSE, authoritative core reads, renderer/HTTP and CLI/HTTP equality, mutation boundaries, and clean port release.
- `dist-linux.cjs` owns the isolated WSL/native Linux release path. The full suite, latency benchmark, AppImage/deb/unpacked GUI smoke, Bash/sh isolation, and same-root exit lifecycle passed before publication.
- Artifact hashes and UAC install evidence are recorded in 本地归档（未纳入公开仓库）; the Git tag and GitHub prerelease publish the five Windows/Linux distributable assets.

## Mobile remote lifecycle and reconnect ownership (2026-08-19)

- `DESKTOP/src/server.ts` remains the hosted mobile transport owner. GUI and TUI bind the server to their own lifetime; the installed-package stress verifies repeated cold start, concurrent mobile reads, SSE readiness, network reachability, state parity, and port release.
- `android/app/src/main/java/com/newmark/mobile/vm/DesktopLinkViewModel.kt` now projects SSE transport truth into the visible device state. An ended stream moves the exact session to `Reconnecting`, a successful handshake restores `Connected` and rehydrates the selected target, and the existing five-minute outage boundary maps to `Disconnected` without abandoning retries.
- `android/scripts/restore-formal-mobile-pair.ps1` supports non-debuggable Release packages without relying on `run-as`; it retains the stronger private-file probe when the installed package is debuggable.
- The relaxed runtime gate is operational: no freeze, ANR, FATAL, OOM, process death, or obvious instantaneous CPU/memory-pressure event. Jank remains recorded but is no longer a hard pass/fail threshold.

Relevant tree:

```text
Newmark Agent/
├─ DESKTOP/
│  ├─ src/server.ts
│  ├─ src/tests/remoteTouchServerStatusVerify.ts
│  └─ scripts/release-pc-gui-tui-remote-service-stress.cjs
├─ android/
│  ├─ app/src/main/java/com/newmark/mobile/vm/DesktopLinkViewModel.kt
│  └─ scripts/restore-formal-mobile-pair.ps1
└─ 本机私有归档（已从公开仓库排除）
   ├─ 20260819-210840-mobile-remote-lifecycle-stability.md
   ├─ 2026-08-19T12-47-33-373Z-pc-gui-tui-remote-service-stress.json
   ├─ 20260819-formal-mobile-sse-state-restart-fixed.json
   └─ 20260819-formal-mobile-cold-async-fixed.json
```

## PC remote-touch hosted serve health architecture (2026-08-19)

- `DESKTOP/src/server.ts` owns the configured hosted-server root/options, authenticated reachability probe, listener/error/start timestamps, bounded stop, connection cleanup, subscription cleanup, and stop-before-start lifecycle. `hostedServerStatus()` maps the real listener/probe result to `off | listening | error`; the LAN/Tailscale address is cached for 30 seconds while the health request still runs every five seconds.
- `DESKTOP/src/main.ts` registers the GUI runtime bridge even when remote touch starts disabled, exposes `mobile:serverStatus` and `mobile:setRemoteTouchEnabled`, persists the switch, and applies the service lifecycle in the current GUI process.
- `DESKTOP/src/preload.ts` exposes only the two purpose-scoped renderer operations. `DESKTOP/src/ui/index.html` renders the transparent status control flush left, binds it and the left-aligned pairing action to one `.remote-touch-action` geometry, gives both rows the same bold short-title plus light-gray description hierarchy, preserves green/orange/red border glow, and owns the five-second poll/timer cleanup.
- `DESKTOP/src/tests/remoteTouchServerStatusVerify.ts` dynamically isolates the fixed server port and verifies ten complete on/listening/reachable/off cycles. `DESKTOP/scripts/release-ui-model-settings-smoke.cjs` drives the real source renderer through CDP and verifies off/error/listening mappings, transparency, toggling, and model recovery in the same Settings surface.
- Evidence: 本地归档（未纳入公开仓库）, 本地归档（未纳入公开仓库）, and 本地归档（未纳入公开仓库）.

Relevant tree:

```text
Newmark Agent/
├─ DESKTOP/
│  ├─ src/{server.ts,main.ts,preload.ts}
│  ├─ src/ui/index.html
│  ├─ src/tests/remoteTouchServerStatusVerify.ts
│  └─ scripts/release-ui-model-settings-smoke.cjs
└─ 本机私有归档（已从公开仓库排除）
   ├─ 20260819-190537-pc-remote-touch-serve-status.md
   ├─ 20260819-remote-touch-serve-status-ui.png
   └─ 20260819-remote-touch-listening-ui.png
```

## PC model recovery and quota failover architecture (2026-08-19)

- `DESKTOP/src/core/agent.ts` invalidates stale validation/evaluation evidence only when the model configuration or provider connection identity changes, treats `discovered` as manually usable but not Auto-eligible, scopes balance blocks by deployment identity, and resolves fixed fallback by provider + model rather than bare model name.
- `DESKTOP/src/core/autoRouter.ts` classifies exhausted balances/quotas as non-retryable but switchable and fills the bounded three-attempt ladder with up to two distinct ordinary eligible alternates when stream/side effects remain uncommitted.
- `DESKTOP/src/core/agentKernelRunner.ts` records balance failure against the active deployment and re-resolves the provider after switching. `DESKTOP/src/ui/index.html` carries the prior model identity through edit save and renders discovered validation as localized “未检测”.
- `DESKTOP/src/tests/modelRecoveryStressVerify.ts` owns no-op/key/endpoint/rename edit invariants, 250 repeated edit resets, 2000 classification/routing rounds, 500 non-quota guards, fixed fallback, and 30 real three-deployment provider-process failovers. Auto and normal-chat suites cover selection and regression boundaries; the CDP Settings smoke verifies the real renderer/backend edit path.
- Evidence: 本地归档（未纳入公开仓库） and 本地归档（未纳入公开仓库）.

Relevant tree:

```text
Newmark Agent/
├─ DESKTOP/src/core/{agent.ts,autoRouter.ts,agentKernelRunner.ts}
├─ DESKTOP/src/tests/{modelRecoveryStressVerify.ts,autoRouterVerify.ts,autoAgentIntegrationVerify.ts,normalChatRegressionVerify.ts}
├─ DESKTOP/src/ui/index.html
└─ 本机私有归档（已从公开仓库排除）
```

## Mobile Guide user-timeline projection (2026-08-19)

- `android/app/src/main/java/com/newmark/mobile/ui/ChatScreen.kt` renders WorkRun Guide receipts as PC-equivalent right-side user timeline messages. Expanded runs preserve event order; collapsed runs keep only Guide messages visible. Ordinary Build rows retain the right-side safety inset.
- `android/app/src/main/java/com/newmark/mobile/data/WorkRunProjection.kt` exposes the deduplicated collapsed-Guide projection shared by local and remote histories.
- `android/app/src/main/java/com/newmark/mobile/ui/NewmarkApp.kt` exposes the remote-to-local WorkRun conversion internally for direct contract verification; runtime behavior is unchanged outside the shared projection.
- `WorkRunProjectionTest.kt` and `RemoteGuideTimelineContractTest.kt` cover sequence, lifecycle upgrades, collapsed visibility, and complete remote receipt conversion.
- Formal Release evidence and stress observations are recorded in 本地归档（未纳入公开仓库）.

## Mobile secondary popover regression guard (2026-08-19)

`ChatScreen.kt` 保留已验收的一级按钮原点动画；一级进入二级或由二级返回时，不创建独立弹窗，而是在同一玻璃外壳内以 `AnimatedContent + SizeTransform` 连续变换宽高。页面内容同步淡入淡出，关闭仍直接淡出。所有页面继续使用 190dp 紧凑壳与 320dp 内部滚动上限。

`NewmarkApp.kt` 在 RemoteWorkRun → LocalWorkRun 边界统一正规化 Gson 可能产生的运行时 null，避免旧桌面事件缺省字段在 Release/R8 中逐字段触发 NPE。证据位于 本地归档（未纳入公开仓库）、本地归档（未纳入公开仓库） 和对应归档说明。

## Mobile remote event terminality contract (2026-08-19)

`android/app/src/main/java/com/newmark/mobile/data/RemoteTrackingContract.kt` now owns both exact target/run identity and terminal-run late-event rejection. `DesktopLinkViewModel` consults this pure contract before creating or extending a live Build, while still accepting an exact PC resident-runtime recovery identity. The deterministic injection fixture and formal input-menu/startup results are recorded in 本地归档（未纳入公开仓库）.

## Current mobile UI note (2026-08-19)

`android/app/src/main/java/com/newmark/mobile/ui/ChatScreen.kt` owns the in-window input composite menu overlay. Its first-level Mode/File and Model/Intelligence surfaces use explicit button-centred entrance progress while retaining the PC-derived small-popover geometry and input-row anchoring. The corresponding operation record is 本地归档（未纳入公开仓库）.

## 2026-08-19 dev-0.4.8 Windows local candidate plan

Desktop package metadata is `0.4.8`; the prerelease name is `dev-0.4.8`. The Windows full release tests, clean package generation, win-unpacked stress, MSI smoke, and machine-wide local installation passed. After installed-build acceptance, Ubuntu 24.04 WSL performed an isolated `npm ci`, complete Linux `npm test`, latency benchmark, native AppImage/deb/unpacked packaging, and artifact smoke before remote publication.

Windows packaging and local installation are complete. `release/win-unpacked/` is the tested unpacked application tree; `release/Newmark-Agent-0.4.8-win-unpacked-x64.zip` is its distributable archive; `release/Newmark-Agent-0.4.8-x64.msi` is the installed candidate. `DESKTOP/scripts/release-safe-installed-shape-stress.cjs` verifies CLI/TUI/GUI startup while keeping mutable state outside Program Files, and `release-safe-shared-root-restart-stress.cjs` verifies explicit shared-root identity across CLI/TUI and two GUI starts. Both gates now wait for actual TUI surface readiness instead of treating the early mobile-server log line as readiness. `release-dev009-features-smoke.cjs` accepts the valid ordering where the first stop call completes an already-escalated force stop and the next observation is settled; the source runtime-isolation gate continues to enforce the ordinary graceful-to-force sequence.

Installed tree ownership and artifact evidence:

```text
Newmark Agent/
├─ DESKTOP/
│  ├─ scripts/
│  │  ├─ release-dev009-features-smoke.cjs
│  │  ├─ release-safe-installed-shape-stress.cjs
│  │  ├─ release-safe-shared-root-restart-stress.cjs
│  │  └─ release-notes-dev-0.4.8.md
│  └─ src/tests/screenCaptureIndependentVerify.ts
├─ release/
│  ├─ win-unpacked/
│  │  └─ resources/app.asar
│  ├─ Newmark-Agent-0.4.8-win-unpacked-x64.zip
│  └─ Newmark-Agent-0.4.8-x64.msi
└─ 本地归档（未纳入公开仓库）
```

The MSI installed with exit code `0`; installed `Newmark.exe --version` and help return `0`, an unknown argument fails closed with exit `2`, and installed `app.asar` matches the package hash `39EBFDD407E8984970A9DD4F27767F1BCD9BE31745187ACF5A83B486D18D9CEA`. Linux AppImage, deb extraction, and unpacked ZIP all pass real GUI startup, Bash/sh terminal isolation, version checks, and clean exit/same-root relaunch. Linux artifact hashes are `F0C2221F...DB96` (AppImage), `8EC7A7D9...33AC` (deb), and `C6CA2E95...BBEA` (ZIP).

## 2026-08-19 PC active screenshot tool status

`DESKTOP/src/tools/index.ts` defines the provision-only `screen_capture` read tool separately from `computer_use`. `DESKTOP/src/core/agentKernelRunner.ts` and `DESKTOP/src/core/agent.ts` route its capture through the same content-addressed user-image attachment/input channel and expose the attachment to `image_inspect` for source-size inspection and bounded pixel crop/magnification. The Electron utility and WSL bridge files carry the read-only operation to the Windows host without acquiring the Computer Use lease. `DESKTOP/src/tests/screenCaptureIndependentVerify.ts` owns cold/warm pressure, temporary-file cleanup, lease isolation, unified image-channel, and secondary crop/magnification regression coverage. Detailed evidence is archived in 本地归档（未纳入公开仓库）.

## 2026-08-18 Android 0.4.52 local tool/runtime architecture and stress status

- `android/app/src/main/java/com/newmark/mobile/data/LocalToolCatalog.kt` is the pure Kotlin Build/Plan inventory and browser-action policy.
- `LocalTools.kt` owns schemas for all 14 local tools. `LocalToolExecutor.kt` owns sandboxed file, Memory Lab, settings, web fetch/search execution; conversation-owned tools delegate to the ViewModel/UI runtime.
- `ChatViewModel.kt` executes task tools against the same persisted `LocalConversation.planItems` used by the right sidebar and binds each conversation to its Browser runtime. Tool calls/results, Guide events, final response, and model-only context persist in the assistant `workRun` and conversation context.
- `BrowserSession.kt` owns conversation navigation/public WebView text. `NewmarkApp.kt` mounts/selects the real Browser before local `browser_use`; `RightSidebar.kt` returns rendered body text after page completion.
- `DESKTOP/scripts/mobile-mock-server.cjs` provides remote API/SSE pressure and an isolated deterministic local provider. `android/scripts/fixtures/` contains credential-free stress configuration.
- `MainActivity.kt` accepts queue/Guide diagnostics only for `.stress` packages with an explicit extra; formal builds have no automatic diagnostic path.
- Formal verification passed Android unit tests, Release assembly, 10-file update guard, `speed-profile`, five 2208-2494 ms complete-interaction starts, and a 90-group stability window at 24.5-26.7 MB PSS / 21-24 threads with no fatal/ANR/process death. The 11-frame final graphics sample is invalid for a jank verdict.

Detailed evidence: 本地归档（未纳入公开仓库）.

## 2026-08-18 mobile complete-interaction performance, scheduler compatibility, and context lifecycle

- `android/app/src/main/java/com/newmark/mobile/ui/NewmarkApp.kt` separates transcript projection, the shared conversation command surface, compact layout, and expanded layout into stable Compose compilation units. This is a compilation-boundary change only: the page tree, sidebar order, responsive breakpoints, popup routes, and feature entry points remain present. Portrait applies blur only while a sidebar has nonzero progress; foldable/tablet layouts deliberately do not blur the main workspace when sidebars are open.
- `android/app/src/main/java/com/newmark/mobile/vm/ChatViewModel.kt` performs archived/conversation disk reads on `Dispatchers.IO`, history normalization and token budgeting on `Dispatchers.Default`, and local tool execution on `Dispatchers.IO`. Only snapshot state publication remains on the main thread. This avoids single-main-thread work while remaining valid on two-core and higher-core devices.
- `android/app/src/main/java/com/newmark/mobile/data/{ChatModels,LocalContextContract,ApiClient}.kt` owns the durable model-only context and bounded compression contract. Complete displayed `messages` never shrink. `modelContext` and `contextCompression` survive restart and normalization, follow the PC 70%/20%/12% thresholds, protect the latest complete user turn, and reset when a new branch is created.
- `android/app/src/test/java/com/newmark/mobile/data/LocalContextContractTest.kt` covers the PC threshold ratios, complete-turn retention, bounded fallback, 10,000-message pressure, and a multi-megabyte tool result.
- `android/scripts/install-mobile-debug-safe.ps1` still fingerprints every private file before and after `adb install -r`; Release installation additionally activates the packaged baseline profile and verifies a `speed-profile` compilation path before foreground launch.
- Formal Release `0.4.51` / `451` passed five two-vCPU complete-interaction runs at `1963, 2107, 2238, 2376, 2552 ms`, all under 4000 ms with zero fatal/ANR/not-responding/launch-timeout/process-death record. Post-start memory was about 42 MB PSS with zero swap.
- Structure smoke retained the input/send controls, left navigation, device expansion, Settings, Memory Lab, Terminal, Files, Editor, Plan, SubAgent, Browser, current-conversation plan, linked plan, plan creation, and browser navigation controls. The remote fixture had no real workspace row, so a live second-level remote workspace drawer was not falsely claimed from that smoke.
- Environment note: Android Emulator 37.1.11's visible gfxstream/QEMU backend hung after prolonged pressure. The userdata QCOW2 image was read-only checked and clean; no AVD wipe occurred. `-no-window -no-cache` restored the same data image and enabled the two-core application gates; a subsequent visible `-no-cache` start restored the foreground portrait window. A transient System UI ANR immediately after the first headless recovery was rejected as evidence; the final measured windows and later UI smokes contained zero ANR/error records.

Relevant tree:

```text
Newmark Agent/
├─ android/app/src/main/java/com/newmark/mobile/
│  ├─ data/{ApiClient,ChatModels,LocalContextContract}.kt
│  ├─ ui/NewmarkApp.kt
│  └─ vm/ChatViewModel.kt
├─ android/app/src/test/java/com/newmark/mobile/data/LocalContextContractTest.kt
├─ android/scripts/install-mobile-debug-safe.ps1
├─ 本机私有归档（已从公开仓库排除）
│  ├─ 2026-08-18-mobile-complete-interaction-context-performance.md
│  └─ mobile-stress-20260819-005444.json
└─ tasks/{plan,todo}.md
```

## 2026-08-18 mobile resident runtime projection and floating control geometry

- `DESKTOP/src/server.ts`, `DESKTOP/src/main.ts`, and the GUI runtime-pool/utility protocol files expose exact workspace/conversation resident state and actions. The desktop runtime remains the owner of remote Goal, Flow, queue, Guide receipts, Stop, messages, and WorkRuns.
- `android/app/src/main/java/com/newmark/mobile/data/MobileModels.kt` models the complete resident snapshot; `RemoteTrackingContract.kt` owns exact target/run reconciliation and the limited live-over-cold precedence rule.
- `android/app/src/main/java/com/newmark/mobile/vm/DesktopLinkViewModel.kt` single-flights target-scoped refreshes and atomically projects messages, WorkRuns, Goal, Flow, queue, and runtime identity. It does not create a remote Android-owned queue.
- `android/app/src/main/java/com/newmark/mobile/ui/ChatScreen.kt` clips Goal/Flow brushes inside each rounded `StackCard`, follows viewport height changes when floating bars appear, and centers the Flow takeover pill in a full-width floating container like PC `.input-float-stack`.
- `DESKTOP/scripts/mobile-mock-server.cjs` and `android/scripts/mobile-agent-stress.ps1` provide the reproducible 160-event remote runtime fixture and gates. The passing report is 本地归档（未纳入公开仓库）; the dated ledger is 本地归档（未纳入公开仓库）.
- `android/app/src/main/java/com/newmark/mobile/data/LocalQueueContract.kt` and its unit test cover local FIFO/pause/edit/delete/Guide state transitions. The local `ChatViewModel` execution backend still has a mobile-specific loop/channel and has not yet become the PC ConversationKernel; this is a recorded architecture gap.
- `android/app/build.gradle.kts` identifies the installed formal build as `0.4.50` / `versionCode 450`. The foreground screenshot is 本地归档（未纳入公开仓库）; it confirms the formal package is running but is not evidence of an active Flow pill because the stress fixture had already ended.

## 2026-08-18 mobile historical WorkRun ledger ordering

- `android/app/src/main/java/com/newmark/mobile/data/RemoteTrackingContract.kt` now owns the mobile port of the desktop orphan-WorkRun placement contract. `unownedRunsBefore` consumes the backend-ordered WorkRun ledger plus visible message ownership and returns only earlier legacy/unanchored runs that must be reconstructed before the next owned run.
- `android/app/src/main/java/com/newmark/mobile/ui/NewmarkApp.kt` uses that contract during transcript projection and no longer timestamp-sorts or blanket-appends historical runs ahead of the newest conversation edge.
- Regression coverage lives in `android/app/src/test/java/com/newmark/mobile/data/RemoteTrackingContractTest.kt`; the dated incident ledger is 本地归档（未纳入公开仓库）.
- Emulator evidence is 本地归档（未纳入公开仓库）; it confirms the historical Build remains between its owning user message and Agent reply. Duplicate terminal status rows inside that block are tracked separately and are not evidence of a remaining placement failure.

## 2026-08-18 mobile WorkRun identity and shared-backend boundary

- `android/app/src/main/java/com/newmark/mobile/data/RemoteTrackingContract.kt` is the pure target/run reconciliation contract. It requires exact workspace + conversation + non-empty run identity and makes durable WorkRuns authoritative over provisional SSE runs.
- `android/app/src/main/java/com/newmark/mobile/ui/NewmarkApp.kt` renders live and durable WorkRuns through one anchored collection. It does not append a second live bubble at the transcript frontier.
- `android/app/src/main/java/com/newmark/mobile/vm/DesktopLinkViewModel.kt` accepts remote events only for the exact selected target, carries event anchors into provisional runs, clears a provisional run when the durable snapshot contains its `runId`, and projects the PC-owned remote queue.
- `DESKTOP/src/core/conversationKernel.ts` owns remote queue item identity and mutation. Mobile queue operations are target-scoped runtime operations, not Android-local state.
- Architectural invariant for continuation work: Compose owns one conversation interaction surface. Local and remote implementations are transport adapters for the same snapshot/event/action protocol. Local execution must reproduce the PC ConversationKernel sequence and receipts instead of adding ViewModel-only queue/render semantics.

## mobile dev-0.4.47 远程 PC Goal/Flow/Queue 同构（2026-08-18）— source PASS

Android 远程输入栈现在直接投影并控制当前 `workspaceId + conversationId` 对应的 PC GUI runtime：Goal bar 可编辑、暂停/继续和删除；Flow prompt 与 takeover 气泡读取当前 Flow 运行/暂停记录；Guide/Next 选择写回同一 target；普通 Guide 与 Goal Guide 均通过桌面 runtime pool 的 `enqueueGuide` 进入 PC 原生 accepted/applied/deferred/rejected 生命周期；普通 Build Stop 通过 target-local `requestStop` 保持第一次协作停止、第二次强制停止的桌面语义。PC 自身发起运行时，移动端依据远程 runtime/Flow 快照切换发送按钮状态，而非只依赖移动 HTTP 请求是否仍在等待。

移动端维护的远程 Next 项按 target 隔离，并携带 `requestedMode` / `goalObjective`；PC 运行从任一端结束后，状态轮询会自动触发排空。Goal 编辑在 Guide + active Build 时成为 Goal Guide，在 Next 时进入带 Goal 声明的可编辑队列，空闲时才直接更新 Goal。移动本地只开放持久化可编辑排队消息；运行期输入统一进入 Next 队列，不伪造 PC Goal、Flow 或真实 steer 能力。

相关文件树：

```text
Newmark Agent/
├─ DESKTOP/src/
│  ├─ main.ts                         # GUI runtime 原生 Guide、Goal Guide、Stop 与 target 状态桥接
│  ├─ server.ts                       # 精确 target 的移动控制/发送 API
│  └─ tests/mobileWorkspaceApiVerify.ts # 鉴权、工作区隔离和 standalone fail-closed 契约
├─ android/app/src/main/java/com/newmark/mobile/
│  ├─ data/{ChatModels,MobileApiClient,MobileModels}.kt
│  ├─ vm/{ChatViewModel,DesktopLinkViewModel}.kt
│  └─ ui/{ChatScreen,NewmarkApp}.kt
├─ android/app/build.gradle.kts       # 0.4.47 / versionCode 447
├─ 本地归档（未纳入公开仓库）
├─ README.md
└─ tasks/{plan,todo}.md
```

验证：Desktop TypeScript/build 与完整 `verify.js` 回归 PASS；移动 API 43/43 PASS；Android `testDebugUnitTest` 与 `assembleDebug` PASS。`0.4.47` 已通过 `adb install -r` 数据守卫覆盖安装到 `emulator-5554`，8 个私有文件保持不变，MainActivity 在前台且启动后崩溃/ANR 扫描为空。

## mobile dev-0.4.46 本地运行状态实时呈现（2026-08-18）— source + device PASS

Android 本地对话不再把 `conversations.json` 中的终态 Build Block 当作运行期数据源。`ChatViewModel.send` 在接受发送的同一状态转换内创建 run id、开始时间、展开的 `running` WorkRun 和 `start` 事件；provider 等待、公开思考、本地工具调用、工具结果、最终回复、错误与终态随后逐事件发布同一 run 的不可变快照。`NewmarkApp.kt` 只把与当前本地对话 ID 匹配的临时块追加到历史末尾，避免切换对话时串线；持久化完成后再清除临时块，停止则把当前可见事件流保存为 `interrupted`。

`ChatScreen.kt` 的尾部跟随同时观察外层消息数量和 WorkRun 内部事件/状态修订。由于实时 Build 始终占用同一个 LazyColumn 条目，新增 thought/tool 事件现在也会保持在可视区域，不再产生“完成落盘时一次性出现”的错觉。完整链路为：同步 start → 逐事件内存快照 → Compose 当前对话投影 → 终态持久化替换。

相关文件树：

```text
Newmark Agent/
├─ android/app/src/main/java/com/newmark/mobile/
│  ├─ vm/ChatViewModel.kt         # 本地运行身份、同步 start、逐事件快照与终态持久化
│  ├─ ui/NewmarkApp.kt            # 当前对话限定的临时 WorkRun 投影
│  └─ ui/ChatScreen.kt            # WorkRun 内部事件修订驱动尾部跟随
├─ android/app/build.gradle.kts   # 0.4.46 / versionCode 446
├─ 本地归档（未纳入公开仓库）
├─ README.md
└─ tasks/
   ├─ plan.md
   └─ todo.md
```

验证：Android `:app:testDebugUnitTest :app:assembleDebug` PASS；Desktop `npm.cmd run build` PASS；`mobileWorkspaceApiVerify` 41/41 PASS；模拟器通过 `adb install -r` 数据指纹守卫安全覆盖安装，未卸载、未清除应用数据。

## 2026-08-18 mobile popover/glass correction (dev-0.4.37)

复合弹窗一级/二级定位继续向下调整至 44dp；远程模型二级菜单读取桌面端完整 provider/model 配置并保留精确 deployment 身份。已撤销会造成全屏模糊或遮蔽 Popup 内容的窗口级 blur 实验；当前仅保留弹窗/边栏自身的半透明深蓝玻璃衬底、折射边框与阴影，主体聊天区域不再被模糊。Android 单测/构建通过，安全覆盖安装到 `emulator-5554`，7 个私有文件指纹不变，版本 `0.4.37` / `versionCode=437`。

## mobile dev-0.4.34 顶栏操作区间距与旧本地会话迁移（2026-08-18）— source + device PASS

Android `ChatScreen.kt` 的 `ChatTopBar` 现遵循 PC 顶栏的独立操作区语义：仅当“连接桌面端”圆形按钮实际存在时，才在其与“新对话”之间插入固定 `8dp` 间隙。两个按钮仍各自保持 `36dp` 圆形尺寸、原有右对齐和点击语义，不引入额外空 rail 或改变本地/远程显示条件。

现场覆盖安装同时暴露并修复了旧 `conversations.json` 的前向兼容问题：Gson 对新增的 Kotlin 非空字段可在旧 JSON 中产生运行时 null，导致 `LocalConversation.copy()` 冷启动崩溃。`ChatViewModel.normalizeConversationMessages` 现进行完整的无损 `LocalConversation` 重建，缺失的 `mode` 规范为 `build`、`planItems` 规范为空列表；消息、分支树、归档标记、标题与时间戳全部保留。输入区还接收按对话持久化的 `selectedMode`，切换本地对话不会将 Build/Plan 标签串到另一会话。

验证：`:app:testDebugUnitTest :app:assembleDebug` PASS；`android/scripts/install-mobile-debug-safe.ps1 -SkipBuild` 以 `adb install -r` 覆盖 `emulator-5554`，安装前后 7 个 app-private 文件的完整路径+SHA-256 指纹一致。`com.newmark.mobile` 已启动并显示正式聊天界面，版本为 `0.4.34` / `versionCode=434`。截图 本地归档（未纳入公开仓库），详细记录 本地归档（未纳入公开仓库）。

相关文件树：

```text
Newmark Agent/
├─ android/
│  └─ app/src/main/java/com/newmark/mobile/
│     ├─ ui/ChatScreen.kt         # 顶栏独立圆形操作区与模式标签同步
│     ├─ ui/NewmarkApp.kt         # 当前本地会话模式传入输入区
│     └─ vm/ChatViewModel.kt      # 旧本地会话无损字段迁移
├─ android/scripts/install-mobile-debug-safe.ps1 # 保留私有数据的覆盖安装守卫
├─ 本地归档（未纳入公开仓库）
├─ README.md
├─ OVERVIEW.md
└─ tasks/
   ├─ plan.md
   └─ todo.md
```

## dev-0.4.7 统一预发布命名（2026-08-18）

本次跨平台候选统一使用：Git tag `dev-0.4.7`、GitHub Release 标题 `Newmark Agent dev-0.4.7`、桌面 package/executable 版本 `0.4.7`，资产名保持 `Newmark-Agent-0.4.7-*`。Windows 发布范围为 x64 MSI 与 win-unpacked ZIP；Linux 发布范围为 x64 AppImage、amd64 deb 与 linux-unpacked ZIP。Android 继续使用自身独立的 `versionCode/versionName` 发布线，不被桌面语义版本覆盖。

最终资产：Windows MSI `226,261,071` bytes / `FD46F635839626693F69D306A05547158BA5EAB0EA78045AC6356B90BE339417`，Windows ZIP `292,388,387` / `1814F9E5312E08D70BE6478B7418018482DA12A53C5E1434D5EE4BD9C054D9C8`，Linux AppImage `176,499,587` / `B5E9E16EDA8DC8D08A594D789C3BE1E21C6310504F834155544B02112EE0BB7B`，Linux deb `135,902,236` / `39388636D30F7A918C449AC0E714F6B9B42835D6867B76B62D82E62C33093817`，Linux ZIP `172,616,312` / `32831EEFF57FAEFCB5768F8B9918DDCF2A7ED127D09BCC8992DD034B8E0D3845`。Program Files 安装版为 0.4.7，安装/打包 app.asar 一致：`CE962FA83BE0CD35526317927C239B55249AB7AA4FF03AC556BC6CD29F96BB5C`。

## 基础工具初始暴露与进阶工具按需供给（2026-08-18）— source PASS

桌面 Agent 的 provider 工具面改为确定性两层结构。首轮完整 schema 仅包含 `bash`、`pwd`、`read`、`write`、`edit`、`delete_file`、`glob`、`grep` 八个基础工作区工具；它们仍先经过模式、原生工具设置和安全策略过滤。`SubAgent`、`task_read/task_create`、Git/GitHub、Browser、Computer Use、Skill、MCP、Automation、Flow、Memory Lab 等全部作为进阶能力，只进入 `tool_provision` 的紧凑目录，不再按自然语言意图自动注入 schema。

`DESKTOP/src/core/agentKernelRunner.ts` 负责基础集合、路由边界、能力目录、broker session 与系统 Prompt。Prompt 现在明确说明“功能存在不等于当前可调用”：进阶工具必须先以唯一工具调用执行 `tool_provision({ names: [精确工具名] })`，下一 provider 子轮拿到原始完整 schema 后才能调用目标工具。Plan policy、SubAgent sandbox、native-tool setting、删除与远程写安全策略均在目录生成和执行阶段继续硬拦截。

测试归属：`toolSurfaceV2Verify.ts` 固定首轮边界；`toolProvisioningVerify.ts` 覆盖 78/78 schema 保真、78/78 provider 子轮可达、Prompt 明示和同一 user run 动态执行；`autoAgentIntegrationVerify.ts` 覆盖 Auto/固定模型边界；`verify.ts` 的 Memory Lab、Flow、Automation、Computer Use 集成夹具均先 provision 再调用。当前 `npm run build`、专项工具供给测试与主验证 1643/1643 全部通过。操作记录：本地归档（未纳入公开仓库）。

相关文件树：

```text
Newmark Agent/
├─ DESKTOP/src/core/agentKernelRunner.ts        # 初始工具面、能力目录、Prompt 与 provision session
├─ DESKTOP/src/tests/toolSurfaceV2Verify.ts     # 八基础工具的确定性边界
├─ DESKTOP/src/tests/toolProvisioningVerify.ts  # schema 保真、可达性、Prompt、动态执行
├─ DESKTOP/src/tests/autoAgentIntegrationVerify.ts
├─ DESKTOP/src/tests/verify.ts                  # 进阶工具集成回归
├─ README.md                                    # 用户与开发者工具契约
├─ OVERVIEW.md                                  # 架构、文件职责与当前状态
└─ 本地归档（未纳入公开仓库）
```

## mobile dev-0.4.33 对话记录 WorkRun 完整投影（2026-08-18）— source + device PASS

Android 不再以简化 token/work event 列表渲染对话历史。`android/app/src/main/java/com/newmark/mobile/data/WorkRunProjection.kt` 以 PC `renderWorkRunEvents` 为唯一公开语义契约，统一投影本地 `LocalWorkEvent` 和远程 `RemoteWorkEvent`：稳定顺序为 `sequence → timestamp → id`；私密 reasoning/thinking/`<think>` 被拒绝；连续文本合并；`response` 覆盖尚未完成的流式片段；`thought_result`、`tool_result` 分别回填到相邻思考和按调用 ID 匹配的工具活动；连续工具调用聚合；Guide、公开用户图片、Agent 展示图片以及 `done/error/interrupted/force_interrupted` 均保留可显示生命周期。

`ChatScreen.kt` 依据投影将历史布局恢复为 PC 顺序：存在真实 Agent 终态消息时显示“用户 → WorkRun → Agent 正文”，不重复 final response；仅缺失历史消息的旧快照才从 `primaryPrompt/final_response` 恢复一次。Build 标题严格跟随桌面 `workRunTitle` 中文状态词：`running=处理中`，完成态为 `已处理`，不再使用“构建”。`DesktopLinkViewModel.kt` 改用 Gson 直接读取完整远程事件字段，本地 Agent 也生成 `final_response`、稳定 ID/sequence、thought/tool completion 字段，故两条路径不再产生不同历史语义。

验证：`WorkRunProjectionTest` 覆盖私密过滤、思考/工具回填、多段 response、终态去重、中断和 Guide 升级；`:app:testDebugUnitTest` 与 Kotlin 编译、clean assembleDebug 均通过。APK `0.4.33`（`versionCode=433`）已安装并在 `emulator-5554` 前台运行；当前模拟器为 1080×2400 竖屏。远程历史端点在该模拟器网络下仍不可达，故真实端点人工历史回放待网络恢复后补测；投影回归已覆盖同构事件序列。详细记录：本地归档（未纳入公开仓库）。

## 桌面端输入卡死与工作期无响应修复（2026-08-18）— packaged PASS

本轮确认严重性能回归并非输入草稿逐字写盘，也不是对话/Build/SubAgent 持久化数据膨胀。根因是两个共享渲染热点叠加：一是 `.marquee-border::before` 的 masked `conic-gradient` 每帧无限旋转，多个运行态元素同时触发 GPU 持续重绘；二是每个工作事件都可能在下一 animation frame 通过 `innerHTML` 重建完整 Build DOM。真实 SubAgent 四路并行和逐实例监控没有创造这两个热点，但把事件频率放大到足以持续饿死输入主线程。

`DESKTOP/src/ui/index.html` 将状态边框和 working glow 改为静态呈现，并将非终止工作事件的 Build DOM 刷新限制为每 100ms 一次；`done/error/interrupted/force_interrupted/final_response` 仍立即刷新。`DESKTOP/scripts/release-ui-render-performance-smoke.cjs` 在真实打包 renderer 中同时施加约 500Hz 工作更新和 100Hz 输入事件，实测 1.05 秒内仅 6 次 Build 重绘、99 次输入全部处理、最大输入调度延迟 42.7ms、持续状态动画为 0。隔离源码 GUI 空闲 5 秒 CPU 增量为 GPU 0.00s、两个 renderer 均 0.00s、browser 0.09s；修复前基线为 GPU 7.91 CPU 秒/3秒、renderer 3.09 CPU 秒/3秒。

验证：主 verify 1641/1641 PASS；完整 `test:desktop:built` PASS；Windows 0.4.6 打包 PASS；性能 smoke PASS；图标/静态边框 smoke PASS；MSI smoke 22 + 12 断言 PASS。新 MSI 为 226,269,263 bytes，SHA-256 `510D60DF661EBFDF2CBA11431C4B1E54C5846562A0E5870911CCF0977DE7B769`；打包 app.asar 为 159,759,098 bytes，SHA-256 `0CC8C4E05EF012E80B346DF760199EF040B9574C799BBD134BF399D195AFF2EB`。UAC 安装退出码 0，Program Files 版本为 0.4.6，安装后 app.asar 与打包哈希完全一致；安装版空闲 5 秒采样 GPU/renderer/utility 均为 0.00 CPU 秒，browser 0.23 CPU 秒，所有进程均响应。详细记录见 本地归档（未纳入公开仓库）。

## 桌面端 SubAgent 工具身份、真实并行与 Build Block 硬限制（2026-08-17）— full desktop PASS

桌面端已彻底分离“任务清单”和“真实子代理”两类语义：模型公开创建工具精确命名为 `SubAgent`，`task_create` 只维护当前对话的任务清单，历史 `task` / `subagent_create` 仅保留执行兼容而不进入模型公开工具面。`DESKTOP/src/tools/index.ts` 与 `DESKTOP/src/core/agentKernelRunner.ts` 定义并固定公开工具契约；`DESKTOP/src/core/agent.ts` 在创建前校验当前运行中的 Build Block，并按该 Build 的 `queued` / `working` 真实记录执行硬限制；`DESKTOP/src/core/subagent.ts` 持久化 `buildRunId`、`intelligenceTier` 并提供按 Build 精确计数；`DESKTOP/src/ui/index.html` 直接按真实 SubAgent UUID 一对一渲染右侧栏入口，入口标题使用创建时名称，Build 芯片和历史弹窗只接受真实 ID。

硬约束为：Ultra 智能档位每个运行中 Build Block 最多 16 个活跃 SubAgent，其他档位最多 4 个。无运行中 Build、Build 已结束或达到上限的模型调用立即返回 `terminated: true`，不创建记录、不进入队列，也不会生成右侧栏监控入口。档位切换会同步调度器并发槽位，但计数和拒绝判定始终绑定调用所属 Build Block。`DESKTOP/src/core/toolPolicy.ts` 仅将公开 `SubAgent` 创建设为可并发的受控写操作，管理调用与其他副作用工具仍独占；Chat Completions / Responses adapter 对有工具请求显式发送 `parallel_tool_calls: true`。真实 APInebula `gpt-5.4-mini` 两种协议均得到单轮 4 调用、`maxOverlap=4`；medium 同批 5 创建严格为 4 接受 + 1 终止。完整 `test:desktop:built` 退出码 0，主 `verify` 为 `1642/1642 PASS`，工具供给 78/78×2 与删除安全 194/194 等后续门禁全绿；详细记录见 本地归档（未纳入公开仓库）。

本地 Windows 发布验证已于 2026-08-18 完成：`0.4.6` MSI 从本次源码生成，打包后 SSH/TUI、CLI、上下文压缩和安装包结构 smoke 通过；UAC 安装 `msiexec` 退出码 0。`C:\Program Files\Newmark Agent\Newmark Agent.exe --version` 返回 `0.4.6`，安装后 app.asar 的 SHA-256 与打包 `win-unpacked` 完全一致（`81755096FB2187D505CB98DE6A72CE940B28099D47C2C2678E23EA38FA72A40C`）。

## 移动端远程/本地 Agent 与 UI 综合压力测试设计（2026-08-17）

测试计划已按 Agent 功能、远程触及性/实时交流、持续性、UI 表现、动画和多核渲染六个面向建立。计划固定竖屏 1080×2400、平板/折叠屏 1600×2560、2/4/8 vCPU、`adb reverse`/LAN/Tailscale/断网重连等矩阵；使用 ADB `gfxinfo`、`meminfo`、线程 CPU、SurfaceFlinger（可用时）、logcat 和结构化 JSONL 采样。关键门限包括冷启动首帧 ≤1800ms、首次可交互 ≤2500ms、远程首 SSE 事件 p95 ≤1500ms、普通交互 p95 frame ≤16.67ms、jank <5%、30 分钟 PSS 增长 ≤25%，并定义 P0–P3 发布门禁。实现顺序和验收标准见 `tasks/plan.md`，执行清单见 `tasks/todo.md`。

## Android 模拟器桌面模型配置同步（2026-08-17）

Android 本地模型配置由 `android/app/src/main/java/com/newmark/mobile/data/ProviderStore.kt` 管理，运行时文件位于应用私有目录 `files/newmark/providers.json` 与 `files/newmark/active-model.json`。本次从桌面 `~/.Newmark/config.json` 的 `models.providers.value` 生成 Android 同构 provider 列表，保留模型能力、思考档位映射和凭据，并把缺省激活项安全回落为首个可用模型。模拟器重启后验证为 4 个 provider、41 个模型，激活 `provider-deepseek-001/deepseek-v4-pro`。敏感凭据未进入仓库或操作记录。

## mobile dev-0.4.32 PC 同构右侧栏与折叠态（2026-08-17）— source + device PASS

本轮将 PC `#right` 的五页结构移植到 Android：`RightSidebar.kt` 负责 Files、无预测随航的 Editor、Conversation plan/Linked plan、SubAgent 和 Browser，以及折叠态 `RightSidebarOpenButton`；`NewmarkApp.kt` 将展开状态提升到根布局并处理左滑、竖屏覆盖层和宽屏第三栏；`DesktopLinkViewModel.kt`、`MobileApiClient.kt`、`MobileModels.kt` 与桌面 `server.ts` 提供工作区文件、编辑保存、计划和 SubAgent 的精确目标契约；`MemoryLabScreen.kt` 提供宽屏大弹窗；`LucideIcons.kt` 复用 PC sprite 几何。

折叠态不渲染右栏 Column，也不参与 `Row` 宽度分配；按钮在聊天区 `Box` 内以 `Alignment.CenterEnd` 覆盖，尺寸 `18×48dp`，使用 PC 同源 `panel-right` 图标。1600×2560 实机 dump 中按钮图标 bounds 为 `[1572,1270][1592,1290]`，点击和左滑均能展开。`Sidebar.kt` 的 rail 态现只保留一级导航及底部固定入口，不再绘制本地对话气泡缩略列。响应式规则为：仅竖屏 SubAgent 详情加页，平板/折叠屏保持弹窗；Memory Lab 仅竖屏加页，平板/折叠屏为 94%×92% 大弹窗。

验证：桌面 build PASS、移动 API 38/38、桌面总回归 1641/1641、Android clean assembleDebug PASS、APK 432/0.4.32 安装成功。实机证据位于 本地归档（未纳入公开仓库）、`_right_open_final.*`、`_right_swipe_final.xml`、`_no_local_thumbs.*`；模拟器最终恢复 1080×2400、density 420。完整记录：本地归档（未纳入公开仓库）。

## mobile dev-0.4.31 二级边栏、分支树与连续时间线（2026-08-17）— source + device PASS

本轮移动端接续覆盖 Android UI、移动 API 与 PC 原生分支树桥接：

1. `android/app/src/main/java/com/newmark/mobile/ui/Sidebar.kt` 负责一级/二级边栏、竖屏顺序换栏和 PC GUI 风格的工作区对话列表；`components/LucideIcons.kt`、`AnchorMenu.kt`、`Marquee.kt` 提供 PC 同源图标、菜单与运行反馈。
2. `ChatScreen.kt` 在滚动容器层统一绘制用户输入右轨与 Agent 左轨，避免消息组件重排导致竖线断裂；分叉用户消息下方渲染 PC 同构分页器。
3. `ChatModels.kt`、`ChatViewModel.kt`、`ConversationStore` 所在 data 层保存本地分支节点、同源分页组、浏览节点与运行节点；编辑历史用户消息会保留原页并创建新页，分页浏览不立即改变运行分支，发送前才激活所阅页。
4. `MobileApiClient.kt`、`MobileModels.kt`、`DesktopLinkViewModel.kt` 和 `NewmarkApp.kt` 投影远程分支状态；桌面 `server.ts` 只桥接 PC 已有 `inspectConversationBranch`、`switchConversationBranch`、`branchConversation`，并严格校验 `workspaceId + conversationId` 成员关系，运行中创建/激活返回 `423`。
5. `DESKTOP/src/tests/mobileWorkspaceApiVerify.ts` 覆盖工作区隔离、分支创建、只读浏览、显式激活、跨工作区拒绝与运行态锁；`verify.ts` 将该套件纳入总门禁。

本轮还修复本地分页切换的祖先选择错误：`2/2` 页的祖先链同时含根页与当前页，切换逻辑现与分页器计算一致，选择距离当前浏览节点最近的分支节点。实机升级、冷启动和重新进入对话后，`hi2 · 2/2` 能切回 `hi · 1/2`；用户/Agent 两侧连续竖线保持可见。Android 版本为 `431 / 0.4.31`。验证：`node dist/tests/verify.js` 1630/1630、`gradlew clean assembleDebug` PASS、APK `adb install -r` PASS。证据：本地归档（未纳入公开仓库）。

## dev-0.4.5 git push + win/linux release + 本地 hash 校验（2026-08-16）— released

压力测试全绿后：commit `a2c58a7` push master、annotated tag `dev-0.4.5` push；`gh release create dev-0.4.5` 上传 5 资产（win MSI/ZIP + linux AppImage/deb/unpacked ZIP），GitHub digest 与本地 SHA-256 完全一致。产物：MSI `226,125,903`/`071A143A…DE73A8`、win ZIP `291,979,308`/`4954E803…C3B2E`、AppImage `176,106,215`/`0CD30D39…FA908A8`、deb `135,690,272`/`56FB4657…C8CCE`、linux ZIP `172,214,822`/`AF235879…9A9E59`。Linux 经 WSL Ubuntu-24.04 隔离构建 + 完整 `npm test` 全绿。证据：本地归档（未纳入公开仓库）。

## dev-0.4.5 WSL 交叉压力测试设计 + 全场景核心压力复测（2026-08-16）— source PASS

新增正交交叉压力测试 `release-wsl-cross-stress.cjs` + 内层 `release-wsl-cross-stress-linux.cjs`：在 WSL Ubuntu 直接复用 Windows `dist` 的纯函数模块，交叉「命令链 × 平台 × 场景 × ×100 确定性」。验证 **62/62 PASS 0 FAIL**（单删除 ×5 链 ×3 平台 ×100 全放行、多语句 ×6 链 ×100 全拦截、`windowsDrivePathToPosix` 路径映射、git-clean/递归别名跨平台）。结合 win-wsl-backend-stress 与 deletion-safety 构成 WSL 全场景核心压力复测。证据：本地归档（未纳入公开仓库）。

## dev-0.4.5 win 打包版 + WSL 后端表现压力测试（2026-08-16）— source PASS

新增 `release-win-wsl-backend-stress.cjs`：驱动 win-unpacked exe 的 WSL Agent 后端（Ubuntu-24.04），N 对话隔离 + 同对话连续多轮 + mock 计数精确匹配；扩展 `wsl-mock-provider.cjs` 支持 `WSL_STRESS_<n>` 序号 marker。验证 10 轮（6 对话 + 4 重复）、20 请求、10 write 工具调用全部成功，write 返回 `[write] OK: /mnt/c/...` 且文件出现在 Windows workspace（验证 WSL→Windows 跨环境路径映射）。适配三个既有约束：`prompt.disabled` 需 auto workspace、`routeToolSurfaceV2` 需消息显式命名 write、mock 取最新序号。证据：本地归档（未纳入公开仓库）。

## dev-0.4.5 打包 + win-unpack/MSI 压力测试新增项 + 全压力测试集合 + UAC 安装（2026-08-16）— packaged + installed

版本升至 `0.4.5`；新增打包后安全 smoke `release-dev045-security-smoke.cjs`（12 断言）并挂入 ZIP/MSI 两个 smoke；`test:full-release` 全绿（verify 1598/1598、deletion-safety 194/194）。产物：MSI `226,125,903` bytes / `071A143A8D36918305856D6941E4A7F4B7B3C113BB6330B43D3047308DDE73A8`、ZIP `291,979,308` bytes / `4954E803557AD7F88B671FB5C152DECF41190564E30E3FB9A25CC3C1A96C3B2E`、app.asar `157,889,701` bytes / `6B440C48471E4F6E2B963F32D136336000404D5A5C210EC4D5A97889DE36F451`。MSI smoke（dev010 22/22 + dev045 12/12）PASS；UAC 安装 `C:\Program Files\Newmark Agent` → `--version` 0.4.5，安装与打包 app.asar 一致。已知 dev009 打包后 UI smoke 历史时序失败（非本轮回归）。证据：本地归档（未纳入公开仓库）。

## dev-0.4.5 git 上传审查：高危信息只报类型、不向 Agent 暴露具体值（2026-08-16）— source PASS

`repo_security_audit`/`formatRemoteSecurityBlock` 的 findings 由 `{path,line,type,sample}` 收紧为 `{path,line,type}`，删除脱敏 sample——密钥值、隐私地址值、用户名绝不再进入工具返回或阻挡文本，避免经 API 中转被拦截窃取；仅保留「类型 + 数量 + repo 内相对路径 + 行号」供 Agent 完成二轮审查定位。验证：`verify` **1598/1598 PASS**（净增 3 条不泄露值断言）、`typecheck`/`build` EXIT=0、`lint` 0 errors/70 warnings。证据：本地归档（未纳入公开仓库）。

## dev-0.4.5 删除/git 安全策略精准拦截 + 并行串命令 + 跨平台全工具（2026-08-16）— source PASS

删除审查 `evaluateDeletionGuard` 精准化与跨平台补齐：① 修复 `||`（逻辑或）被误判为管道，`echo done || rm f.txt` 单删除不再误拦；② 移除误伤的 `/\bdone\b/`（普通英文 `done` 不再判循环）；③ 补齐 CMD `for /f … do del` 循环删除、PowerShell `ri -Recurse`、CMD `erase /s` 递归删除、`git clean`（非 dry-run，`-n`/`--dry-run` 放行）批量删除的硬性拦截；并行（`&`）/串行（`;`、`&&`、`||`）多语句删除由 `deletionVerbCount>=2` 精准拦截。覆盖 bash 与 terminal_takeover(write) 两条 shell 通道，跨 POSIX/PowerShell/CMD。验证：`deletion-safety-stress` **194/194 PASS**、`verify` **1595/1595 PASS**（净增 8）、`typecheck`/`build` EXIT=0、`lint` 0 errors/70 warnings。证据：本地归档（未纳入公开仓库）。

## dev-0.4.5 git 上传安全策略：高危硬性阻挡 + 隐私地址扫描 + Agent 二轮审查放行（2026-08-16）— source PASS

`git_push`/`gh_pr_create` 前自动跑 `repo_security_audit`，在 tracked/changed 文件里发现**个人密钥**（API key/token/私钥）或**隐私地址**（带凭据 URL、私网 IP、本地用户目录路径）时**硬性阻挡**远程写；阻挡结果脱敏列出 findings，要求 Agent 二轮审查处理/确认后，再次调用并传 `security_review_confirmed=true` 放行。实现：新增 `scanRepositoryPrivacyLeaks`/`collectRepositoryFiles`/`formatRemoteSecurityBlock`；`repoSecurityAudit` 合并 `privacy_findings` + `high_risk_findings`；`withRemoteSecurityPreamble` 增加确认参数并在高危未确认时返回阻挡；工具 schema 增加 `security_review_confirmed`；静态 prompt 同步二轮审查语义。验证：`verify` **1587/1587 PASS**（净增 4 条断言：secret 阻挡 / 确认放行 / 隐私地址阻挡 / privacy+high_risk 聚合）、`typecheck`/`build` EXIT=0、`lint` 0 errors/70 warnings。证据：本地归档（未纳入公开仓库）。

## dev-0.4.5 WSL 下 Windows 工作区跨环境优化 + conversation_rename 独立并行 API（2026-08-16）— source PASS

1. **WSL 下 Windows 工作区跨环境文件操作与 bash**：Linux `path.isAbsolute` 不认识 Windows 盘符，`C:\...` 会被 `resolve` 误拼到 `/mnt/...` 工作区下、并被 bash 越界检查误判。新增 `workspace.ts` 纯函数 `windowsDrivePathToPosix`（盘符 → `/mnt/<drive>/...`）；`tools/index.ts` 新增 `normalizeCrossEnvPath`（文件工具 `resolve` + bash `extractCommandPathRefs` 统一归一）与 `translateWindowsPathsForWslBash`（保守翻译 bash 命令里的盘符路径 token）；`bash()` 归一 `cwd`。仅在 `NEWMARK_WSL_DISTRO` 下启用，非 WSL 行为与旧实现完全等价。
2. **conversation_rename 独立为「并行响应 API」**：首个完成 Build 的最终响应到达时 fire-and-forget 发起独立 `provider.chat` 请求（system 严格约束「只返回简短名词短语标题」、15s 独立 AbortController 超时），按格式拿到标题后 `renameConversation`，不阻塞主流程、不共享主前缀缓存；失败/无 provider 回退本地 `deriveConversationTitleFromSummary`。`conversation_rename` 工具与 `shouldPromptConversationRename` 判定均保留，首轮 prompt 仍不注入一次性 tool-call 指令。

验证：`npm run typecheck` / `build` EXIT=0；`node dist/tests/verify.js` **1583/1583 PASS**（新增 3 条 source-contract 断言：`windowsDrivePathToPosix` 映射、tools WSL 跨环境归一、rename 独立并行 API）；`goalConversationToolVerify` 16/16、`nativeBashVerify`、`automationBashStressVerify` PASS；`npm run lint` 0 errors / 70 warnings（无新增 warning）。未打包、未 UAC 安装、未 tag / 未远程发布。证据：本地归档（未纳入公开仓库）。

## dev-0.4.4 TUI 备用屏 VT 启用修复（光标追踪最终根因，2026-08-16）— packaged + installed

安装版 `Newmark --TUI` 走 `Console Runtime.exe`(Electron) → `ELECTRON_RUN_AS_NODE` sidecar，该 sidecar 不像纯 Node 那样自动启用输出句柄 `ENABLE_VIRTUAL_TERMINAL_PROCESSING`，且 `setWindowsConsoleMode` 用错句柄（`-10` 输入而非 `-11` 输出）→ `?1049h` 不被 ConHost 解析 → 备用屏不进入 → 主屏保留滚动历史（滚轮能滚回旧帧、光标追踪错位）。修复：`setWindowsConsoleMode` 改为输出句柄 `-11` 设 `0x4` + 输入句柄 `-10` 设 `0x200`，并在 spawn sidecar 前调用；`app.js` 加 `enableWindowsVirtualTerminal()` 保险；`verify.ts` 加 3 条断言。重新打包 + UAC 安装（`MSI_INSTALL_EXIT=0`、app.asar `A42000BFF5BE34A250912BDF8624B02A61D100B7B53903C57B49C0E5C8EF94FC`）。commit `4ae2499`。证据：本地归档（未纳入公开仓库）。

## dev-0.4.4 模型切换行为修复（同事）+ 重新打包 + UAC 安装（2026-08-16）— packaged + installed

review 并落地同事的 GUI 模型切换修复（14 文件）：`agent:setModel` 改用 `modelSelectionValue()` 比较 qualified deployment（同名跨 provider 模型切换不再误判）；`ConversationKernel.setModel` 在 Build 运行中记录 pending 选择、下次 dequeue `syncPendingModel` 仅在变化时切换，Electron/WSL 全链路补 `set_model`；`resolveWindowModel` 经 active qualified deployment 解析上下文窗口；GUI 模型切换后立即刷新上下文环/检查器；`verify.ts` 新增同名校窗口断言 + `modelSwitchBehaviorVerify.ts` 挂入 `test:desktop:built`。`dist:windows-release` 完整门禁全绿 → 重新打包 → UAC 安装（`MSI_INSTALL_EXIT=0`、`--version` 0.4.4、安装与打包 app.asar 一致 `CFED407C...`）。产物 MSI `B661C896DCB2262F9E15A34C9AA486076E81954DF2A69F8320DF6F8D566929D2`、ZIP `A1D7B601D4761DB9DD7CC2CF28EE6F2A3929E46D00B925C85BBC72A514F83B99`。已 commit `6a869f3`。证据：本地归档（未纳入公开仓库）。

## dev-0.4.4 备用屏缓冲修复（TUI 光标追踪最终根因，2026-08-16）— source PASS

TUI 此前一直在主屏绘制，主屏保留滚动历史：鼠标滚轮能滚回旧帧、终端滚动会让 `2J` 全量重绘错位——这正是"光标（高亮）离开屏幕"的真正根因。修复：① 启动进入**备用屏幕缓冲**（`\u001b[?1049h`，无滚动历史、滚轮无效），每次刷新在备用屏内 `?25l 2J H` 全量重绘；② 退出 `fs.writeSync` 同步写 `\u001b[?25h\u001b[?1049l\u001b[0m\u001b[2J\u001b[H` 恢复主屏与光标（此前异步 write + `process.exit` 会丢退出消息）；③ `paint.cancel()` 丢弃退出前排队的重绘，避免恢复主屏后又被画一帧。pty 门禁重构为普通脚本 `cursor-follow-pty-gate.js`（node-pty 的 ConPTY 辅助进程会让 node --test 挂起），挂入 `test:tui:built`：断言启动 `?1049h`、退出 `?1049l`/`?25h`/关闭消息、三窗口（100x24/40x12/60x16）模型列表高亮+描述行同屏、真实 resize（100x24→40x12→90x28→52x15）自适应。验证：`verify` 1574/1574、TUI demo 61/61 + stress 7/7 + pty gate ALL PASS + launcher 28/28、lint 0 errors。

## dev-0.4.4 打包 + MSI 本地 UAC 安装（2026-08-16）— installed

`npm run dist:windows-release` 完整门禁全绿（deletion-safety 156/156、SSH TUI stress 4 重启、release-cli-smoke、context-compress-cli-stress 9 请求、console-wrapper-boundary-stress version=0.4.4）后产出 MSI/ZIP；UAC 提权安装 `msiexec /i Newmark-Agent-0.4.4-x64.msi /qb /norestart` → `MSI_INSTALL_EXIT=3010`（成功、提示重启）；`Newmark.exe --version` → 0.4.4 exit 0，安装目录与打包 `app.asar` SHA-256 完全一致（`AB89CC211A5C0FB653E1B7B589029A817CE0957E843CCEB854275D5F4FDB0D8A`，157,821,714 bytes）；CLI 未知参数 fail-closed exit 2、GUI 入口 CLI 帮助契约正常、无残留进程。产物：MSI `226,097,231` bytes / `7AE4BC45D449693F3FBB03CF12594BC2ED0CDACD4580C8B6F8CAFF66785CB671`；ZIP `291,954,360` bytes / `CFFF06C1153C2F4B68D471D28BBA8ABFB7B361DA3FDF1E4B0C61A1A9A371533D`。未 push、未远程发布。

## dev-0.4.4 历史 Build 信息主动复用 prompt + TUI 模型长菜单光标跟随加固（2026-08-16）— source PASS；已打包 + UAC 安装

1. **历史信息主动复用**：Build 任务台账（`buildConversationTaskLedger` 尾行）、`CORE_SYSTEM_PROMPT` 的 Build history disclosure、`build_history_query` 工具描述三处由「仅用户问细节时查询」改为「主动复用」语义：非首轮 build block 在任务延续/修复/验证/依赖历史工作时，**在重新调查（重跑命令/重读文件）之前**先调用 `build_history_query` 读取相关历史块的工具活动与结果并复用；保留「查询只读、不授权恢复工作」边界；三处静态文本不破坏 provider 前缀缓存（`contextCacheHitStressVerify` 29/29）。
2. **TUI 模型长菜单光标跟随加固（含用户复报后的窗口约束根因修复）**：① 内容视图滚动改为**居中跟随**（焦点行保持在视口上 1/3，两行一组的模型选项主行+描述行同屏可见——实测高亮从 row 26 移到 row 17）；② `modelView` 焦点行号由硬编码（`14 + index*2`）改为动态计算（`tierStart`/`deploymentStart` 由 `rows.length` 推导）；③ **窗口尺寸不再 `Math.max(52/20)` 强制放大**——终端窗口小于最小布局时帧会画到窗口外（高亮行落在窗口外不可见），改为严格采用终端实际尺寸 + 输出阶段按可见宽度/高度裁剪（`boundedBody`/`boundedFooter`/覆盖层截断），帧绝不越界；④ 新增 `readWindowSize()` 每次渲染实时读取（`getWindowSize` 优先 → `columns/rows` → `COLUMNS/LINES`），resize 后自适应；⑤ 新增"无功能 TUI"打包前 pty 门禁：`--demo` + `NEWMARK_TUI_DEMO_MODELS` 注入长模型列表，`cursor-follow-pty.test.js` 三窗口组合（100x24/40x12/60x16）遍历 + 真实 resize（100x24→40x12→90x28→52x15）自适应断言，挂入 `test:tui:built`；demo.test.js 补小窗口严格约束 + 实时尺寸单测；清理 TUI/test 历史遗留 tmp 调试文件。

验证：`npm run typecheck`/`build` EXIT=0；`node dist/tests/verify.js` **1574/1574 PASS**（新增 4 条 dev-0.4.4 断言）；`normalChatRegressionVerify`、`goalConversationToolVerify` PASS；`contextCacheHitStressVerify` 29/29；TUI demo 61/61 + stress 7/7 + pty 2/2 + launcher 28/28；`npm run lint` 0 errors（70 既有 warnings）。版本号升至 `0.4.4`，已 commit（`5367bb3` 及后续）并打 tag `dev-0.4.4`；未打包、未 UAC 安装、未远程发布。证据：本地归档（未纳入公开仓库）。

## dev-0.4.3 打包 + UAC 安装 + win/linux release（2026-08-16）— released

移动本地 tag `dev-0.4.3` 至 `dd08013` 并 push master 与 tag（远端此前无 dev-0.4.3）。Windows：`npm run dist:windows-release` 完整门禁（test:full-release + 打包）全绿后产出 MSI/ZIP，UAC 提权安装 `msiexec /i ... /qb /norestart` exit 0 → Program Files 0.4.3.0，安装目录与打包 `release/win-unpacked/resources/app.asar` SHA-256 一致（`8B241F04D761003ACE3C5C61F72C32F2A37A55406B7BB749CB3E5769C6AB4E1A`），`Newmark.exe --version` → 0.4.3 exit 0。Linux：WSL Ubuntu-24.04 隔离环境完整 `npm test` 全绿（含 thinkingTierMapCacheStressVerify 67/67、deletion-safety 156/156）后 electron-builder 产出 AppImage/deb/unpacked ZIP 并 rsync 回 `release/`。GitHub prerelease `dev-0.4.3` 5 资产全部上传（首次 create 因上传超时留下 draft/untagged 状态，删除后以 `--verify-tag` 重建并逐资产上传修正）。证据：本地归档（未纳入公开仓库）。

## dev-0.4.3 模型思考强度档位映射（2026-08-16）— released

在 dev-0.4.3 任务清单之上落地「模型原生思考强度档位 → Newmark 五档位」映射：

1. `ModelConfig` 新增可选 `thinking_tier_map`（模型原生档位名 → Newmark 档位 `low/medium/high/xhigh/max`）；`LLMProvider` 构造新增第 8 参 `thinkingTierMaps`（模型名 → 映射表），`reasoningEffort` 先经 `mappedNativeEffort` 反查：精确命中 → 就近降级（不高于目标档位的最高已映射档位）→ 全部高于目标时取最低档；未配置映射时默认不变动（模型名匹配时 Newmark 档位名原样透传，不匹配的模型仍不发送 effort，维持既有语义）。
2. v2 adapter 修复：`chatStreamWithToolsV2` 的 chat_completions 请求此前漏带 `reasoningEffort`（responses 桥路径一直携带），本次补上；`NormalizedAgentRequest.reasoningEffort` 类型由五档 union 放宽为自由字符串（映射后的原生档位名可能不是 Newmark 档位名）。
3. GUI：新增/编辑模型弹窗新增「思考强度档位映射」文本域（每行 `原生档位=Newmark档位`，留空即默认不变动映射），模型列表 chip 显示映射条目数；i18n en/zh 新增 `model.thinkingTierMap` / `model.thinkingTierMapHelp`；解析/序列化助手 `parseThinkingTierMap` / `serializeThinkingTierMap`。
4. 配置示例：`config.example.json` 模型条目新增 `thinking_tier_map` 示例（minimal/balanced/deep → low/medium/high）。

验证：`npm run typecheck` / `npm run build` EXIT=0；`node dist/tests/intelligenceTierVerify.js` 610 次请求捕获、8 个映射用例 PASS（精确/降级/ultra 归一/最低档/未配置透传/非思考模型不发/v2 chat 携带映射后档位）；`node dist/tests/verify.js` **1570/1570 PASS**（新增 5 条 source-contract 断言，含缓存压测挂载契约）；`npm run lint` 0 errors（70 既有 warnings）；`npm run test:desktop:built` 全绿（含新缓存压测 `thinkingTierMapCacheStressVerify` 67/67、deletion-safety 156/156）。缓存压测覆盖：真实 provider 序列化路径 30 轮同档位请求映射确定性 + system 前缀字节级稳定（映射档位绝不进缓存前缀）；6 档位 × 10 轮切换稳定；Agent 全链路 5 Build × 8 tool 子轮（默认 medium → balanced、ultra → deep）缓存命中率 ≥0.9 且统计不漂移。版本号保持 `0.4.3`。证据：本地归档（未纳入公开仓库）、本地归档（未纳入公开仓库）。

## dev-0.4.3 任务清单同步 + TUI 光标跟随 + 上下文窗口统计 + Guide 注入优化（2026-08-15）— source PASS

在 dev-0.4.2 之上完成 dev-0.4.3 任务清单并升版本号到 0.4.3：

1. 任务清单同步：`buildRequestTaskFocus` 不再把动态 `conversationPlan` 条目逐项注入 provider 请求，改为固定软性提示（`call task_read` + `task_create` 维护）；新增 `task_read`/`task_create` 工具读写 `conversationPlan`，policy/background 护栏同步更新，新增 `taskToolsVerify.ts` 并纳入 `test:desktop:built`。
2. TUI 长列表光标跟随：flowtask 焦点行按真实行号计算；command palette / flow-select 覆盖层各自维护滚动窗口；chat 左侧会话列表新增 `conversationListScroll` 跟随选中项。
3. GUI 上下文用量：`contextWindow()` 新增全对话 provider token 统计（input/output 累计）与缓存命中率；上下文管理窗口新增「全对话 token」与「缓存命中率」单元格（en/zh 文案）。
4. 删除「借鉴 DSH 动态预算」等借鉴声明文案（en/zh 均已改为中性表述）。
5. 上下文管理窗口去掉关闭按钮，点击窗口外部自动关闭（`document click` 监听，面板/触发环内部除外）。
6. Build Block「编辑了文件」默认折叠（移除内联文件 diff 的默认 `open`）。
7. `conversation_rename` 改为首轮响应总结命名：不再在首 Build bootstrap 注入 tool-call 指令，改在首个完成 Build 的最终响应处用摘要派生标题并自动 rename。
8. Guide 注入优化：同一 Build block 内连续到达的 receipt-tracked Guide 由 conversation kernel 合并为一次 provider 续接（`batchGuides`），Agent 批量持久化各 Guide 并合并图片到主消息；Build 内 Guide 按提交顺序执行并自动接续，跨 Build block 最新优先且不自动接续；意外中断 Build 的历史在下一个 Build 主动续接并共用上下文前缀。

验证：`npm run typecheck` / `npm run build` EXIT=0；`node dist/tests/verify.js` **1564/1564 PASS**；`taskToolsVerify` 15/15；`contextCacheHitStressVerify` 29/29（5 Build × 8 tool 子轮缓存命中压力：Build 内 system 前缀稳定、缓存命中率 95%）；`cursor-follow-stress.test.js` 5/5（chat/palette/flow-select/flowtask 长列表光标跟随压力）；`guideInsertionStressVerify` 41/41；`guideWorkRunVerify`、`normalChatRegressionVerify`、`contextSystemV2Verify`、`contextBudgetVerify` 通过；`npm run test:tui:built` 59/59 + 5/5 压力 + 28/28 + 2/2；`npm run test:desktop:built` 全绿（含 deletion-safety 156/156）；`npm run lint` 0 errors（70 既有 warnings）。未重新打包、未 UAC 安装、未远程发布。

## dev-0.4.2 git push + win/linux release（2026-08-15）— released

提交 `6b32a2b`、打 tag `dev-0.4.2`、push master 与 tag；WSL Ubuntu-24.04 完整 Linux `npm test` 全绿（含 deletion-safety 156/156）后构建 Linux 产物；创建 GitHub prerelease [dev-0.4.2](https://github.com/positer/Newmark-Agent/releases/tag/dev-0.4.2) 并上传 5 资产：Windows MSI `226,056,271` bytes / `FB7056A9A7BCC953071465317A52042CA21F66BB596A64BB452CA3D7980DAFFF`，Windows ZIP `291,914,694` bytes / `41CF0C9B37E568AB1D9C0407AB1E0B77F6F440E55FA98F4296C7EDC9A8ADB761`，Linux AppImage `176,036,624` bytes / `F5FB100DC357BB468A16CF85C3A48E90CE4A914EC75E50C8F35B927C8DDDE8B8`，Linux deb `135,641,332` bytes / `68A45610711C3D8B5C03C8FB501AE36BD15573691646623D13D793ADE08CCB82`，Linux unpacked ZIP `172,144,415` bytes / `FBB699170E43DC1DEDA32F5C4F6DE77CFFFE6921EC5D50B89C66F151E94DC832`。证据：本地归档（未纳入公开仓库）。

## dev-0.4.2 模型校验进度窗口修复（2026-08-15）— source PASS；rebuilt + UAC reinstalled + released

修复两个关联 GUI 问题：模型校验进度轮询每 150ms 整体重建 `sub-win-body` 导致 `marquee-border` 跑马灯动画重置（抽搐），且轮询无条件覆盖当前子窗口导致其他弹出窗口被强制变为模型校验、无法回退。修复后：首次渲染进度容器（`id="model-validation-progress"`），轮询经 `updateModelValidationProgress` 原地更新 `mv-*` 文本/进度条、找不到容器时 no-op；进度窗口打开时重复点击不重建不压栈；完成/失败时若进度窗口仍在则原地替换（关闭可回退上级），否则用聊天消息摘要不抢占窗口。验证：`npm run build` EXIT=0；`node dist/tests/verify.js` **1550/1550 PASS**（新增 1 条防回归断言）。修复后已重新打包并 UAC 重装 0.4.2.0。证据：本地归档（未纳入公开仓库）、本地归档（未纳入公开仓库）。

## dev-0.4.2 工具删除安全硬性审查 + 软性 prompt 要求（2026-08-15）— source PASS；package pending

在 dev-0.4.1 之上落地「允许删除、禁止脚本批量删除、仅在 Agent 监管下删除」的安全边界，并升版本号到 0.4.2：

1. 硬性审查：`DESKTOP/src/core/toolPolicy.ts` 新增纯函数 `evaluateDeletionGuard(command)`，拦截递归（rm -rf / Remove-Item -Recurse / rmdir /s / del /s）、通配符（rm *.log）、循环（for/foreach/while）、管道接收端（Get-ChildItem | Remove-Item）、find/xargs、多目标、多语句批量删除；单文件删除放行。
2. 受监管删除通道：`DESKTOP/src/tools/index.ts` 新增 `delete_file` 工具（单文件、拒目录、拒通配符），在 bash/terminal_takeover write 执行前接入删除审查；`nativeTools.ts` 与 `registry-seeder.ts` 注册（自动推断 destructive riskLevel）。
3. 软性要求：`DESKTOP/src/core/agent.ts` 的 `CORE_SYSTEM_PROMPT` 注入静态 `Deletion safety` 规则与 `delete_file` 工具说明；所有 prompt 改动均为静态文本、不改 `systemPromptCache` 的 identity 结构，故不破坏 provider 前缀缓存命中。
4. 测试：`DESKTOP/src/tests/verify.ts` 新增 15 条断言（delete_file 4、deletion guard 9、buildSystemPrompt 删除安全契约 + 缓存命中 2）。

验证：`npm run build` EXIT=0（0.4.2）；`node dist/tests/verify.js` 1549/1549 PASS；`npm run lint` 0 errors（70 既有 warnings，新增代码 0 warning）。删除安全压力测试 `DESKTOP/scripts/deletion-safety-stress.cjs` 修正 Windows/bash 虚拟路径语义后 **156/156 PASS**，并挂为 `test:deletion-safety` npm script、纳入 `test:desktop:built` 常驻门禁。Windows MSI/便携 ZIP 已重建并 UAC 提权安装（0.4.1.0 → 0.4.2.0；UI 修复后同版本重装）：MSI `226,056,271` bytes / SHA-256 `FB7056A9A7BCC953071465317A52042CA21F66BB596A64BB452CA3D7980DAFFF`，ZIP `291,914,694` bytes / `41CF0C9B37E568AB1D9C0407AB1E0B77F6F440E55FA98F4296C7EDC9A8ADB761`；安装目录与打包目录 `app.asar` SHA-256 一致（`40081F5B23046E5D05DBBD9C2BE64A3FF63E28A7E544CA016832582221071F1B`）。已 commit（`6b32a2b`）、打 tag `dev-0.4.2`、push 并发布 GitHub prerelease（Windows MSI/ZIP + Linux AppImage/deb/unpacked ZIP）。证据：本地归档（未纳入公开仓库）、本地归档（未纳入公开仓库）、本地归档（未纳入公开仓库）、本地归档（未纳入公开仓库）、本地归档（未纳入公开仓库）。

## dev-0.4.1 GUI/TUI 打磨 + 刷新配置锁定（2026-08-15）— source PASS；Windows 已打包 + UAC 安装

在 dev-0.4.0 之上落地一批 GUI/TUI 打磨项并升版本号到 0.4.1：

1. GUI Build 块活动摘要（「进行了思考 / 运行了命令」等）字体改小一号（与 "Response complete." 同级 11px）、去加粗、改用 --text-dim 更淡语义色（兼容字体颜色定制，不改变交互）。
2. GUI「刷新配置」改为锁定式重载：点刷新先复用启动封面锁定界面，后端重载 + 前端重新水合完成后直接显示新配置，消除「先闪现初始默认状态」的中间帧（sessionStorage flag + .config-reloading 封面 + 水合后揭盖）。
3. TUI：确认 Ultra 推理档位已存在并补测（无源码改动）；新增 MemoryLab O 键总览弹窗；内容区（模型选择 / MemoryLab tag 选择等几乎所有列表视图）光标跟随滚动；新增 TUI/src/i18n.js 使切换语言后界面骨架跟随（导航/侧栏/视图标题/设置等）；对话区 Build block 次级菜单支持 → 进入、↑/↓ 选中、Enter 逐条展开/收起「工具调用 / 思考」事件，并补渲染 thought/thought_result 事件。

验证：TUI 59/59 PASS；npm run typecheck / build EXIT=0（TUI 已复制到 dist/tui）。Windows MSI/便携 ZIP 已重建并 UAC 提权安装到 C:\Program Files\Newmark Agent（0.4.0.0 → 0.4.1.0）。产物：MSI 226,080,847 bytes / SHA-256 46751C0019D75AEC5A642E72BE2A29292776907FB53CA81B1DA9898C03A39DA7；ZIP 291,905,246 bytes / SHA-256 FF73E1894F64954C36B5EF3BC5910414FBC610DF29AC177D7406FDF437309F51。未打 git tag、未远程发布。证据：本地归档（未纳入公开仓库）、本地归档（未纳入公开仓库）。

## dev-0.4.0 分支交流 + 思考活动 + 历史卸载延迟（2026-08-14）— source PASS；package pending

在 dev-0.3.14 之上落地三块功能并升版本号到 0.4.0：

1. Build 块新增与「编辑了文件」「调用了工具」并行的「进行了思考」活动：对支持 reasoning 的模型（DeepSeek reasoning_content / Anthropic thinking_delta）采集思考过程，状态分「思考中/进行了思考」，展开暴露推理文本；推理绝不进入聊天正文与最终回复（沿用 sanitize 隐私剥离）。
2. context_history_manage 的 remove 改为「只卸载长期 log + 声明后当前 Build Block 结束后才对后续 Block 生效」：pendingHistoryRemovals 队列 + fingerprint 兜底，status 暴露 pendingRemovals，保证 block 内 provider 前缀缓存稳定。
3. 新增「允许分支交流」对话类型（创建时勾选，GUI 复选框 / CLI --branch-communication / 对话列表特殊标记）：移除运行分支唯一性（ConversationTreeState.runningNodeIds），每活跃分支独立维护完整缓存；新增 branch_list / branch_send / branch_read / branch_create 工具；SubAgent 缓存命中优化（delegatedPrompt 移除易变 flowPc、mailbox body 截断）。

验证：npm run typecheck / build EXIT=0；node dist/tests/verify.js 1530/1530 PASS；branch/SubAgent/gui-tui-cli 相关测试全绿。未重新打包、未 UAC 安装、未打 Git tag、未远程发布。证据：本地归档（未纳入公开仓库）；release-notes：DESKTOP/scripts/release-notes-dev-0.4.0.md。

## dev-0.3.14 goal/conversation tools + cordis-core migration + real-provider stress (2026-08-14) — release-usable

Added goal_manage (Agent self-enters/updates/completes/exits Goal state) and conversation_rename (Agent names the current conversation on its first Build Block, cache-friendly) tools; bounded build_history_query activity/guide content (max_chars, default 2000) for Build-internal cache; migrated the built-in toolchain to the cordis-core-compatible ToolRegistry by preserving real tool descriptions (previously degraded to name(domain) placeholders); added mode/input/navigation/theme/scroll shortcuts. verify 1521/1521 green, typecheck clean, lint 0 errors.

Repackaged dev-0.3.14 (MSI 226,040,216 bytes / SHA-256 1CAB2A1D558AC0C8DBF85D7DE60E539401EB828E361005F2F9320AEBAF4ABD7A; ZIP 291,866,935 bytes / 6E7298D42641B2393CC71665EB15E1E743A034D9D2D2589CDCC2653452CEBC3C). User-side real OpenRouter stress with deepseek/deepseek-v4-flash passed ALL 11 scenarios (cli-rounds, ui-rounds, ui-escape-stop, goal-continuation, goal-manage-tool, conversation-rename-tool, multi-mode-switch, queue-drain, conversation-isolation, long-context, release-process-cleanup) — Final Verdict release-usable.

Key re-test adjudication: goal-continuation previously failed on meta-llama/llama-3.3-70b (729s timeout); re-run on deepseek-v4-flash passes cleanly (assistantCalls=4), confirming the earlier failure was model exact-marker noncompliance, not an app regression. Evidence: 本地归档（未纳入公开仓库）; machine reports 本地归档（未纳入公开仓库）*.md.

## dev-0.3.14 package build + real OpenRouter provider stress (2026-08-14) — Windows MSI/ZIP rebuilt; 7/8 real-provider scenarios pass

Windows MSI and win-unpacked ZIP artifacts for 0.3.14 were rebuilt locally after all feature slices landed (editor Copilot prediction cache, tool backgrounding background_tool/read_tool_result, toolcall compression compress_tool_result, SubAgent communication cache/context regression, DSH dynamic compression + prefix-cache reuse, three-tier UI font hierarchy, keyboard full-coverage cross-stress). Artifact fingerprints: app.asar 157,465,514 bytes / SHA-256 05215A26B17E7CE874248FC49A1F69C0AB9EECF45BA8B89E776D5F57E4B30F22; MSI 226,040,216 bytes / BE9DEC38DEDF66519E2E10065DF27AF8ECF966F5FEAC51854F476CC8454D40B8; ZIP 291,852,625 bytes / B34E0E476823B570E9817EA4F47F6440DBBA2930871F3F7D4785B47B2E1D0FCD.

The real OpenRouter provider stress (meta-llama/llama-3.3-70b-instruct) passed 7/8 scenarios: cli-rounds (6), ui-rounds (4), ui-escape-stop, queue-drain, conversation-isolation, long-context (17400-char payload), and release-process-cleanup. goal-continuation failed as app-timeout-or-provider-timeout, adjudicated as harness exact-marker noncompliance by the open-source model (no max-depth warning; app Goal state machine normal per historical same-scenario evidence) rather than an app regression. Remote publication and Linux packages remain pending. Evidence: 本地归档（未纳入公开仓库） and machine report 本地归档（未纳入公开仓库）

## `dev-0.3.13` context compression, cache, and prompt policy (2026-08-13) — source PASS; package pending

The source candidate now separates context pressure by lifetime. The active Build block triggers and retains its working window at 70% of the resolved model context window; long-term history triggers and is summarized at a separate 20% budget. `context_history_manage status` exposes the active Build and long-history token counts, thresholds, retention budgets, usage percentages, and the combined trigger decision. Compression reuse checks for an existing summary across the retained history, preventing repeated compaction when the summary is not message zero.

System-prompt assembly is now cache-oriented: history-ranked skill selection is removed from the stable prompt, the complete linked-plan Markdown/revision is no longer injected into ordinary requests, and the fixed Context V2 `linked_plan` slot is left empty for ordinary model calls. The base prompt discloses that linked-plan exists and remains available through the explicit tool/Plan policy. A mandatory bounded inline task checklist is required for multi-step work with `pending`, `in_progress`, `completed`, and `blocked` states. Request-scoped task/bootstrap metadata is sent on the first provider request of a Build and once after compression, not on repeated tool sub-turns.

Source gates passed: `npm run build`; `node dist/tests/verify.js` `1501/1501`; performance/cache `17/17`; normal-chat regression; Context System V2; Context V2 stress `1461/1461`; compression pressure `34/34`; and `npm run lint` with `0` errors and 60 existing warnings. No `dev-0.3.13` package was rebuilt or published, no MSI/UAC installation was performed, and the last verified package remains `dev-0.3.12`. Detailed operation record: 本地归档（未纳入公开仓库）.

## Built-in editor Copilot prediction optimization (2026-08-13) — packaged candidate PASS; no additional UAC

The native editor's frequent `No completion` and slow-response path was reproduced and repaired. The old flow cancelled only at the renderer generation counter, sent up to 6,000/1,600 cursor context through the global non-streaming API mode, accepted unusable Copilot records, re-rendered full syntax highlighting on caret movement, and exposed empty/aborted results as a popup. The repaired path validates model credentials/status, prefers a usable Copilot with active validated fallback, uses 3,200/800 cursor-local context, 96 output tokens, a dedicated 6.5-second deadline, forced completion streaming with bounded chat fallback, owner-scoped cancellation, anchor fingerprint caching, and quiet empty results. Caret-only movement now updates status/ghost layers without rebuilding the entire highlight DOM.

Source/build evidence: `npm run build` passed, `node dist/tests/verify.js` passed `1495/1495`, and `npm run lint` reported 0 errors with 60 pre-existing warnings. Packaged evidence: native editor smoke, packaged CLI smoke, context-compression CLI pressure, console-wrapper boundary stress, deterministic SSE editor prediction, and final real APInebula `gpt-5.4-mini` editor IPC all passed. Real provider returned 11 chars through delta with `firstDeltaMs=4285` and `totalMs=4287`; this latency is provider/network response time, not hidden. Final app.asar content check confirms main delta IPC, preload listener, UI delta/cache/bounds, and forced editor `chat_stream`.

Final local candidate fingerprints: app.asar `157131813` bytes / `C197E6F992729C468B4CB4F6440CC0DBD1E1331F18F83EC067A49FA9A2F4B83F`; MSI `225896856` bytes / `27447481E6FFF8D20CC4CC629E55269FF1DBD1C7102474DD14C1B0535CD4AE38`; portable ZIP `299390078` bytes / `30079E9CECB1B77AAF70486D6C7FDAC042894669CB2F0DAD08371A429DF3AB74`. No additional global UAC install or Program Files mutation was performed in this slice. Full evidence: 本地归档（未纳入公开仓库）.

## Flow continuation, archive interruption, and lifecycle gate (2026-08-13) — safe package PASS; no UAC

This slice closes the user-visible Flow lifecycle failures. A paused Flow resume now explicitly reconciles only the interrupted target's stale `running` WorkRun before starting the next component, while the normal concurrent-Build guard remains active. Flow Stop/Esc during a resumed Flow returns to the same resumable paused state. Archive is now a destructive target boundary: it marks and aborts the active Flow owner, force-finalizes target WorkRuns, clears persisted suspension state, starts the runtime hard-stop in the background, and single-flights duplicate archive requests. The renderer removes both the conversation row and Flow takeover at the first click and never rolls the row back after a negative receipt; late Flow callbacks cannot recreate archived state.

The background/close path now records renderer unresponsive/responsive transitions and window-close/will-quit decisions in startup diagnostics. The real packaged lifecycle gate passed minimize-to-tray with a live hidden process, direct close with no packaged-process residue, and startup recovery with a responding window. No global `C:\Program Files\Newmark Agent` process was killed or UAC installation was initiated in this slice.

Verification passed: source feature gate `1482/1482`, Flow pause/stop/draft pressure (`8` iterations, `200` concurrent drafts, `12` churn cycles, no leaks), archive concurrency (`19` assertions), `48` asynchronous archives, context-compression pressure (`34` assertions), performance (`12` assertions), TUI `56/56本地归档（未纳入公开仓库）112 ms`, accepted three duplicate archive receipts, and confirmed the settling Flow returned `archived: true` without a suspension. Final safe-package fingerprints are app.asar `157099444` bytes / `5A4EC8CF1E4BC3F1E16749A822E62A4BFEC43B2588A8DA26405BDD064078C8D4`, MSI `225884568` bytes / `27CD340EBAA71CF088905007A171D4AE24A474F0617E1FF180F1A52FE0F02C45`, and portable ZIP `291752665` bytes / `D13376B03D541423C912049E82AD9FCF1FD9ADB3A4ED5641D0CA2928F0F9A688`. Detailed evidence: 本地归档（未纳入公开仓库）.

## Installed workspace recovery repair (2026-08-13) — pass; release payload rebuilt

The real `C:\Program Files\Newmark Agent` MSI installation reproduced a startup failure from the user screenshot: an older persisted external/current workspace pointed at the installation directory, and conversation prewarming attempted to create `C:\Program Files\Newmark Agent\conversations`, producing `EPERM` and preventing the main UI from opening. The workspace layer now treats package/install paths as protected, filters stale external entries, clears a stale current pointer before hydration, and lets normal configuration recover to a user-root internal workspace. A Windows regression test verifies that no protected `conversations` directory is created and that the cleaned registries are persisted.

After rebuilding and repairing the MSI in place, the real no-`--root` GUI promoted its CDP UI in about `2.1 s`; the new log contained `conversation-state-ready` and `prewarmed-ui-shown` with no new EPERM or startup-attempt failure. `Work/State.json` and `Work/External.json` no longer contained the Program Files path, and no installed-directory process remained after cleanup. The installed GUI↔CLI/TUI gate, real APInebula model CLI/TUI roundtrip with Esc stop/recovery/restart, protected-root redirection, and ZIP unpacked smoke all passed. Detailed evidence: 本地归档（未纳入公开仓库）.

Rebuilt artifact fingerprints are MSI `4D42B3AD865765A3944C349FAB638A1835E97FCB76DC1315588A9088DF7B62FE`, portable ZIP `A56B37A7173BB69441BBCDCAEBF5DC7D77C7F6D0C45FA799E6BF82FCCA4BDF8E`, and packaged `app.asar` `84D65F79E82FE5CCB47BD01CAFADDDDA3B1EEE5E7173EEDECA5D0F005B7C0433`. The published `dev-0.3.12` prerelease assets now contain this repaired payload. The startup/memory benchmark gate was also corrected to accept the shipped target-bound Browser partition instead of its obsolete fixed literal.

## Final dev-0.3.12 release audit (2026-08-13) — published prerelease; three Luna canaries and installed gates pass

The post-repair release gate now has three consecutive complete no-context black-box canary reports using only `gpt-5.6-luna` with `max` reasoning: the first covered the real CLI version/help/unknown-command/state boundary, the second covered the packaged Console Runtime and GUI help/version entrypoints, and the third covered `context_history_manage list` plus Console Runtime state in a fresh path-with-spaces root. All three explicitly reported that they could not find a new product problem; every canary cleaned its temporary root and left no Newmark/Electron process.

The repaired source and rebuilt package also pass the deterministic source/GUI/TUI/CLI/shared-backend gates, archive and context-compression pressure, protected-install root isolation, loopback PTY/light-theme/restart checks, and the 120-create/120-archive temporary-root stress. The direct packaged `Newmark Console Runtime.exe` TUI sidecar recognition, explicit-root legacy-data isolation, close/exit lifecycle, batch exit propagation, shared-root cleanup retry, and stale GUI smoke completion waits are covered by the current regression gates.

After the three canaries, the MSI was installed locally through elevated Windows Installer (`MSI_INSTALL_EXIT=0`). The real `C:\Program Files\Newmark Agent` payload reports version `0.3.12`; installed GUI help, console version, Runtime version, and isolated `state --root` probes all exited successfully with no residual process. Installed-directory pressure then passed GUI↔CLI sync, two TUI entrypoints with four restarts, local-mock compression, two real read-only validation rounds, real-model TUI long-output/double-Esc/recovery/restart/CLI roundtrip, 120 rapid archives plus 300-component Memory Lab restart recovery, and protected-root restart with Program Files mutable paths unchanged. Commit `fc5989c` is pushed to `master`, annotated tag `dev-0.3.12` is pushed, and the GitHub prerelease is published at [Newmark Agent dev-0.3.12](https://github.com/positer/Newmark-Agent/releases/tag/dev-0.3.12). GitHub-reported asset digests match the local MSI and portable ZIP fingerprints in the release notes.

## Post-repair Luna black-box round (2026-08-12) — safe rebuilt candidate PASS; UAC HOLD

The user-pressure repair cycle now carries three targeted fixes: `DESKTOP/newmark.bat` preserves child exit codes through `endlocal`; fresh GUI roots default to deterministic `general.close_behavior=exit` while explicit existing `minimize` remains supported; and legacy AppData migration is restricted to the canonical `~/.Newmark` runtime root, so an explicit `--root` cannot inherit conversations, archives, providers, or external workspaces. The rebuilt portable package's real loopback SSH/PTY gate now repeats the explicit TUI `--root` check and passed with empty providers/conversations/external workspaces and an internal workspace path.

Source and safe packaged gates pass: `test:full-release` (`1480/1480` feature checks, Context System V2 `1461/1461`, TUI `56/56`, launcher `27/27`, shared GUI/TUI/CLI `21` provider-request fixtures), serial packaged safe black-box `28本地归档（未纳入公开仓库）0` errors. The third fresh no-context black-box run is still in progress under the only permitted delegated model, `gpt-5.6-luna` with `max` reasoning; `5.6-sol` and other subagent models are not used. MSI/UAC remains intentionally unrun, and the existing Program Files installation remains untouched/stale pending explicit authorization.

Evidence: 本地归档（未纳入公开仓库）.

## Current dev-0.3.12 status (2026-08-12) — safe product gates pass; release-flow gate FAIL; installed-directory gate HOLD

The release work repaired the independent D1–D6 user-level pressure findings, completed the deterministic gate in disposable temporary roots, rebuilt the Windows MSI/portable package, added a protected-install shared-root/restart gate that exercises GUI/TUI/CLI without writing Program Files, and removed the visible Browser-tab startup latency found by the package pressure smoke. The safe rebuilt candidate's product gates remain `PASS`, but the latest independent no-context release-flow audit is `FAIL/HOLD` because the canonical `win-unpacked` directory was dirtied by post-package runtime state and two gate boundaries can misreport or trigger the installed environment. The existing `C:\Program Files\Newmark Agent` copy remains stale because no UAC installation was authorized.

## Latest independent no-context release-flow audit (2026-08-12) — FAIL/HOLD

The fresh black-box tester passed the main safe product probes but found one P1 release-boundary failure and two P2 release-gate risks. `release/win-unpacked` contains `292` files while the portable ZIP extraction contains `291`; the only extra path is `conversations/state.json`, written after the ZIP timestamp. This is classified as post-package runtime contamination/reproducibility failure, not proof that the builder put the file into the ZIP. The installed read-only validation script's `--help` did not short-circuit and launched the existing Program Files validation path after about `124 s`. GUI native exit codes were observable through the process handle but not `$LASTEXITCODE`, and invalid `validate-models` selection returned `[]` with exit `0`. Full evidence is 本地归档（未纳入公开仓库） and the delegated raw report 本地归档（未纳入公开仓库）.

Current release decision: `SAFE_PRODUCT_GATES=PASS_WITH_BOUNDARIES`; `RELEASE_FLOW_GATE=FAIL`; `LATEST_REBUILD_UAC=NOT_RUN`; `PROGRAM_FILES_PACKAGE=STALE`; `INSTALLED_DIRECTORY_ACCEPTANCE=HOLD/NO-GO`; `TUI_BLACKBOX=BLOCKED_NO_PTY`.

The latest targeted `BLACKBOX_GUI_NO_MODEL` gate is also closed: the rebuilt GUI, renderer runtime, WorkRun, and visible diagnostic all settle as terminal `error` with no `done/final_response`; evidence is 本地归档（未纳入公开仓库）. Full installed-directory evidence: 本地归档（未纳入公开仓库）.

## Current TUI light-theme repair (2026-08-12) — source and rebuilt safe package pass

The TUI now resolves appearance as one shared theme-safe pair during snapshot hydration and again at render time. A persisted `light` theme with empty legacy `ui.font_color`/`ui.background_color` fields receives `#1F2937` on `#F0F2F8`; an explicit low-contrast pair such as `#B7E4FF` on `#F0F2F8` is replaced for painting by the readable light defaults. This prevents the previous contrast guard from returning an unpainted ANSI frame and exposing black host rows. The fallback is local to TUI appearance rendering and does not alter conversation history or provider state.

Focused TUI coverage passes `55/55`, built GUI/TUI launcher verification passes `25/25`, loopback SSH/PTY interaction with resize/light theme and four restarts passes, and the complete source release gate passes. The rebuilt package then passes `SAFE_INSTALLED_SHAPE_STRESS` and `SAFE_BLACKBOX_GATES` (`28/28`); no UAC installation was performed. Detailed evidence: 本地归档（未纳入公开仓库）.

Latest package fingerprints are `release/win-unpacked/resources/app.asar` `157,068,983` bytes / `1A7C444A4DF068E2BBE62D72B6CE17EED7ADBAB40F51697A3619CC303E32A324`, MSI `225,888,664` bytes / `426F7A010C76AAA04C043C8E03644010C5A1317F5B254FD6F7B3C53E7386E774`, and portable ZIP `291,743,396` bytes / `6AAD7C293761939CF0C739F82EBB7D651B438994124A413322BD1437C3B118BA`.

## Current Browser interaction repair and expanded release gates (2026-08-12) — safe package pass; no UAC

The packaged startup-recovery smoke found a stable `3.07–3.09 s` delay before the first deliberate Browser-tab click became usable. The cause was a five-second guest-creation floor intended for background/prewarm demand being applied to an explicit visible-tab activation. `DESKTOP/src/ui/index.html` now bypasses that floor only when `ensureBrowserPanel({ activate: true })` represents a user-visible activation; background requests retain the memory/startup floor. The Browser guest continues to use a target-bound `persist:newmark-browser-<workspace/conversation>` partition, so the startup gate now checks the required prefix and target suffix instead of a stale fixed partition literal. The focused regression records the split behavior.

The latest rebuilt package passed safe black-box `28/28`, protected-install-shape and shared-root/restart GUI/TUI/CLI redirection, startup recovery (`startupMs=1046`, `browserOpenMs=45`), ZIP/MSI feature smokes, tray lifecycle, GUI↔CLI synchronization, context-compression/console-wrapper boundary stress, Flow/Subagent, Memory Lab, model settings, option feedback, Skills/MCP, queue, terminal, workspace/conversation, archive, and single-instance shared-backend checks. Source `test:full-release` completed through the GUI/TUI/CLI shared-backend lane (`21` provider requests); WSL was skipped only because local `Ubuntu-24.04` is unavailable. The current `_ref` APInebula probe was blocked by provider timeout/rate limiting and is not counted as a real-model pass. Full evidence: 本地归档（未纳入公开仓库）.

Current decision: `SAFE_TEMPORARY_SOURCE_GATE=PASS`; `REBUILT_WINDOWS_PACKAGE_GATE=PASS`; `SAFE_INSTALLED_SHAPE_GATE=PASS`; `EXPANDED_PACKAGED_GATE=PASS`; `LATEST_REBUILD_UAC=NOT_RUN`; `ACTUAL_PROGRAM_FILES_PACKAGE=STALE_AND_HOLD`.

## Current D1–D6 repair and release-gate record (2026-08-12)

The no-context installed-directory findings are now closed in the source and rebuilt candidate: top-level and command-level unknown/missing arguments reject before runtime startup; protected install paths are redirected to a user-root shadow while shared GUI/TUI restart uses the same safe root; a debounced `Work` watcher reloads workspace registries and broadcasts cross-entry changes; terminal errors remain terminal errors without synthetic completion; PTY commands use one carriage-return submission; and archive clicks remove rows immediately while parallel atomic archive persistence, target force-stop, duplicate single-flight, and coalesced list refresh preserve continuity. `DESKTOP/scripts/release-safe-shared-root-restart-stress.cjs` is the new protected-install shared-root/restart gate. The single-instance packaged shared-backend gate now tests forwarded second launches against one retained renderer/backend, matching the actual product contract.

Final source verification passed `1478/1478`, Context System V2 `1461/1461`, TUI `55/55`, SSH TUI with four restarts, CLI `46`, and shared GUI/TUI/CLI `21` provider requests. Expanded safe packaged gates passed Flow/Subagent, Memory Lab, model settings CRUD, option feedback, Skills/MCP, queue/Plan, fast conversation switching, workspace/conversation isolation, external workspace binding, archive concurrency/runtime, terminal takeover, context compression, console wrapper, startup recovery, ZIP, MSI, tray, GUI↔CLI synchronization, protected install shape, and shared-root restart. No UAC was performed. The `_ref` APInebula key was consumed only in a temporary environment for a one-round CLI probe; the app timed out and a direct provider probe observed rate limiting, so real-model acceptance remains `BLOCKED_PROVIDER` rather than a product pass.

## Latest no-context installed-directory audit (2026-08-11) — NO-GO

An independent tester used only the real installation directory, executable probes, and observed GUI/TUI/CLI behavior. It reproduced a P0 TUI crash: the machine-wide installation tried to create `C:\Program Files\Newmark Agent\conversations` and received `EACCES` on the first edit/send. It also found a P1 `validate-models` no-output/process-leak case, a P1 GUI close/process-cleanup delay, and a P2 invalid-model request that reached a real Provider instead of being rejected at the argument boundary. GUI chat, Plan/Goal/Flow, immediate archive, CLI discovery/exit contracts, and TUI startup passed; most TUI continuation and three-entry shared-backend pressure was blocked by the P0 or real-provider quota response. No UAC operation was performed. Full evidence: 本地归档（未纳入公开仓库）.

## Latest user-pressure fail-closed and post-build gate (2026-08-11) — pass

The no-provider and unavailable explicit-model paths now fail closed: the shared ConversationKernel rejects, persists an error work run, and emits no synthetic `done` or `final_response`; CLI converts the shared error to `[Error]` plus exit code `1`. The regression is covered in `DESKTOP/src/tests/normalChatRegressionVerify.ts`. Archive behavior remains immediate and destructive from the user's perspective: running targets can be archived, the row does not roll back, archive persistence is parallel/atomic, and the target runtime is force-stopped.

The final source gate passed after this repair. Additional packaged pressure passed safe black-box `28/28`, ZIP and MSI administrative-image smoke, active compression, queue/plan/Flow, rapid conversation switching, real-model packaged GUI/TUI/CLI, and two read-only real-model validation rounds. WSL TUI remains an environment skip because local `Ubuntu-24.04` is unavailable. The optional multi-window smoke was not counted: the current single-instance product focuses the existing window while that stale probe expects two renderers; the probe was restored without a source change. Full evidence is 本地归档（未纳入公开仓库）.

The older package fingerprints in this historical section are superseded by the 2026-08-12 rebuild recorded above.

## Latest user-pressure cache/root repair and final safe gates (2026-08-11) — pass; no UAC

`FileModelValidationCache` now supports read-only loading, so default CLI validation reuses fresh redacted seven-day records without config writes; only `--persist` saves metadata. An explicit CLI `send --model` is rejected before history/work-run/provider transport when unavailable, and unambiguous `provider/model` names are normalized. The new `DESKTOP/scripts/release-safe-installed-shape-stress.cjs` drove the final package's CLI state, TUI startup/exit, and GUI startup/cleanup with `--root C:\Program Files\Newmark Agent`; all three redirected to `C:\Users\12252\.Newmark\Roots\...`, and watched Program Files mutable paths stayed unchanged.

The final source/package gate passed. The package's own SSH TUI, CLI, context compression (`9` requests, `fallback:false`), wrapper boundary, safe black-box `28/28`, tray lifecycle, ZIP/MSI administrative-image smoke, and final real-model validation/cache-reuse gate passed. The final real APInebula `gpt-5.4-mini` validation took `73,893 ms` for the intentional persisted probe and `3,038 ms` for the subsequent read-only reuse, with unchanged config hash and zero process residue. A real-model TUI/CLI roundtrip was attempted but the provider returned HTTP `403 bad response 808`; all processes and temp roots were cleaned. Full evidence: 本地归档（未纳入公开仓库）.

## Current conversation-archive pressure repair (2026-08-11) — source and release gates pass

The archive path now treats a click as an immediate destructive lifecycle action. The GUI removes the conversation row before IPC settlement, leaves it removed even when a negative receipt is shown, and the active-archive settings action uses the same path. Archive controls remain clickable while a target is running, stopping, force-restarting, or holding an active prompt lease.

`DESKTOP/src/main.ts` now single-flights duplicate archive IPC calls per target, force-stops the target runtime through the Electron Utility or WSL pool, and uses asynchronous archive persistence. `DESKTOP/src/core/electronUtilityRuntimePool.ts` and `DESKTOP/src/core/wslAgentRuntimePool.ts` expose target-level hard-stop/eviction operations. `DESKTOP/src/core/agent.ts` writes unique archive names and atomically renames Markdown and conversation manifests; final deletion is performed against the latest lock-protected workspace state, so same-workspace archive payloads can run in parallel without losing sibling deletions. The renderer deliberately reports a failure without rollback, matching the click contract.

Archive pressure evidence: UI rapid-click/running-target regression `19` assertions; Electron/WSL force-stop and capacity regression `24` assertions; `48` same-workspace asynchronous archives produced `48` unique Markdown/manifest pairs, removed all `48` conversation ids, released the state lock, and completed in `2,182 ms` in the full gate run. The full source release gate passed after the repair; no MSI/UAC action was performed in this repair cycle.

Key repairs in this cycle:

- `DESKTOP/src/main.ts` binds Electron `userData` and `sessionData` below the resolved Newmark runtime root before Electron becomes ready, so GUI `--root` no longer writes Chromium state into the real legacy `%APPDATA%` profile.
- `DESKTOP/src/launcher.ts`, `DESKTOP/src/main.ts`, and `DESKTOP/src/cli-help.ts` terminate `--help`, `--version`, `-v`, and `-version` discovery before provider/runtime startup; packaged unknown top-level commands return exit `2`; invalid models fail closed and CLI work errors return exit `1`.
- `DESKTOP/scripts/newmark-console-wrapper.c` is a native console wrapper that injects an Electron `--` boundary, fixes colon-containing positional prompts, duplicates inheritable ConPTY standard handles, and starts `Newmark Console Runtime.exe`; `create-console-launcher.cjs` creates that console-subsystem runtime beside `Newmark.exe`.
- The packaged TUI sidecar preserves the terminal contract, and the MSI `afterPack` hook creates the wrapper/runtime before `msiProjectCreated`; `npm run dist:win` and `node scripts/dist-portable.cjs` therefore share one valid Windows artifact path.
- User-pressure fixes also cover empty Flow feedback, provisional `Esc` stop races, bounded large-stream rendering, provider timeout/abort cleanup, TUI per-conversation serialization, context-preparation serialization, and recursive compatibility redaction.
- `DESKTOP/src/core/config.ts`, `DESKTOP/src/core/agent.ts`, `DESKTOP/src/core/modelValidationStore.ts`, and `DESKTOP/src/cli-commands.ts` make default `validate-models` read-only with a durable evidence cache opened in no-save mode; explicit `--persist` retains intentional validation metadata writes. `DESKTOP/src/main.ts` and `DESKTOP/src/launcher.ts` pass the read-only boundary through first-run initialization.
- `DESKTOP/scripts/release-installed-readonly-validation-stress.cjs` is the final installed acceptance probe: it runs the real selected model repeatedly and asserts config hash, byte length, and mtime invariance after every round without printing provider secrets.

Release evidence:

- `npm.cmd run test:full-release` passed: source feature verification `1478/1478`, intelligence-tier capture `602` with per-protocol stress `300`, TUI `55/55`, launcher `25/25`, CLI contracts `46`, OpenAI/Anthropic contract `30`, computer-use contract `10/10`, and GUI/TUI/CLI shared backend `18` parallel isolated conversations plus a 3-surface roundtrip (`21` provider requests). SSH loopback PTY/resize/light-theme/clean-exit and four restart rounds passed. WSL was an explicit environment skip because local `Ubuntu-24.04` is unavailable.
- Independent post-build pressure passed automatic and active compression `34/34`, Context System V2 `1461/1461`, automation/Bash/PTY pressure with `108` concurrent context-switch requests and zero dropped messages, the packaged CLI compression tool lane (`9` requests, `fallback:false`), wrapper boundary stress, and the expanded packaged safe black-box matrix `28/28`.
- Current rebuilt artifacts: `release/win-unpacked/resources/app.asar` is `156,990,094` bytes, SHA-256 `20D38B17C54E083FA0E4EB0054CB52F418598698CF43AF66FD581E0D32DDCB79`; MSI is `225,876,376` bytes, SHA-256 `60D6A937B6479099847F9B7CD5888FABCF93536F80E3A7B7DFD82E38D3995BFD`; portable ZIP is `291,725,440` bytes, SHA-256 `AF5F0B3161F82DBE03636B8A2E1DC0D5FD4804E3A8E0127B2A07D69BFBC560A4`.
- Final installed payload matches the rebuilt package: GUI `D21F0988...`, console runtime `55A26A0F...`, wrapper `D558A5C1...`, and installed `app.asar` `20D38B17...`. The installed surface gate passed GUI↔CLI conversation synchronization, SSH/TUI PTY with four restarts, active compression (`9` requests), and two real `APInebula/gpt-5.4-mini` validation rounds with unchanged config hash/bytes/mtime.
- The real user config remains at SHA-256 `9A0B4A91A82CEFCAA3A8CFF90899F4296F4AB972FD5F1B9B4761A7F984E94C75`; no credentials or populated config contents were written to the evidence. The complete installation and installed gate record is 本地归档（未纳入公开仓库）.

Current verdict: `SAFE_TEMPORARY_PACKAGE_GATE=PASS`; `REBUILT_WINDOWS_PACKAGE_GATE=PASS`; `SAFE_INSTALLED_SHAPE_GATE=PASS`; `MSI_GLOBAL_UAC=PASS_PRIOR_GATE`; `LATEST_REBUILD_UAC=NOT_RUN`; `ACTUAL_PROGRAM_FILES_PACKAGE=STALE`; `INSTALLED_RELEASE_GATE=NO-GO_UNTIL_FINAL_MSI_RETEST`; `ARCHIVE_PRESSURE_GATE=PASS_IN_PORTABLE_AND_SOURCE`; `READONLY_VALIDATION_CACHE_GATE=PASS`; `REAL_MODEL_TUI_CLI_GATE=BLOCKED_BY_HTTP_403_BAD_RESPONSE_808`.

## Project structure and ownership

```text
Newmark Agent/
├─ DESKTOP/                 Electron desktop, shared runtime, CLI, packaging, and release gates
│  ├─ src/                  TypeScript main/preload/core/provider/tool/UI contracts and tests
│  ├─ scripts/              build, packaging, black-box, provider, TUI, ZIP/MSI, and performance probes
│  ├─ assets/               application icons and packaged static assets
│  ├─ dist/                 generated TypeScript/TUI/build outputs; never hand-edit
│  ├─ Flow/                 packaged/default workflow fixtures
│  ├─ package.json          version, build/test/release scripts, Electron Builder metadata
│  └─ newmark.bat            portable Windows GUI/TUI/CLI dispatch wrapper
├─ TUI/                     terminal renderer, state machine, adapters, demo tests, and TUI contract
├─ 本机私有归档（已从公开仓库排除）                 timestamped cold evidence, stress reports, screenshots, and operation records
├─ docs/context-system/     context-compression/history design notes and acceptance evidence
├─ SCRIPTS/                 repository-level historical release/helper scripts
├─ dist-harmonyos/          generated headless HarmonyOS/server bundle
├─ README.md                user-facing product, interfaces, configuration, build, and verification guide
├─ OVERVIEW.md              project status, architecture/file-tree routing, release decisions, and evidence index
├─ SETUP.ps1                local Windows setup/build entrypoint
├─ LICENSE                  project license shipped with packages
└─ THIRD_PARTY_NOTICES.md   third-party license notices shipped with packages
```

The durable business state belongs under `~/.Newmark` (or an explicitly writable isolated `--root`); installation directories and generated `release/` artifacts are not mutable configuration stores. 本地归档（未纳入公开仓库） is append-oriented evidence rather than runtime state. The GUI, TUI, and CLI enter the same target-bound conversation kernel and provider/tool adapters, while platform hosts (Electron utility, WSL, native Windows tools) remain explicit backend boundaries.

## Original independent no-context release audit (2026-08-11) — historical blocking input

The latest long-running independent tester started without conversation context and discovered Newmark only from `README.md` and real executable `--help`/version output. It exercised the current installed and portable GUI/TUI/CLI entrypoints with real models, plus deterministic shared-backend and compression gates. It did not modify product source, README, OVERVIEW, the Program Files installation, or run MSI/UAC.

The audit passes 72/72 public help/version probes, 26/26 safe black-box cases, 20 real CLI rounds, six GUI rounds, installed TUI/CLI Stop/recovery/restart, SSH PTY/resize/theme/restart, compression `34/34`, context-system assertions `1461`, and shared-backend `21` fixtures. WSL is an environment skip because local `Ubuntu-24.04`/`wsl.exe` is unavailable. The real `~/.Newmark/config.json` hash stayed `428F19B08ADE1B03DB61F6796D1012A62B02BE24E4926921663705F8FFC5DFC2`, and final Newmark/test Node process counts are zero.

The release is blocked by two P1 findings:

- A GUI started with `--root <temporary-root>` still launches Chromium children with `--user-data-dir=C:\Users\12252\AppData\Roaming\Newmark Agent`; `Preferences`, `DIPS`, `DIPS-wal`, `DevToolsActivePort`, `Session Storage`, and `blob_storage` received writes during the test window. The business/config root was temporary, but the Electron user-data root was not, so further GUI live pressure was stopped.
- The installed `C:\Program Files\Newmark Agent\resources\app.asar` is `156,956,772` bytes with SHA-256 `A49B64F961091A8EA36F5C8E0F406C8851AB4D0253FE297160BB2A3CF2EF8F3E`, while the current portable package is `156,968,282` bytes with SHA-256 `14FE1894F602A10466E3C586DBAA16D0A9819A454AE34605BF32679524CBC18A`. Same version is not treated as byte-identical release evidence.

Additional P2 findings are literal `-version` hanging in all four executables, an unknown top-level command not terminating within 45 seconds, GUI `Esc` not proven to interrupt a still-running request (the request naturally completed), and an invalid model deployment returning an error-like response with CLI exit `0`. GUI Plan/Flow and live simultaneous GUI/TUI/CLI pressure were skipped after the user-data isolation violation, not counted as passes. Full matrix, reproduction, severity, and repair acceptance conditions are in 本地归档（未纳入公开仓库）, with machine-readable evidence in 本地归档（未纳入公开仓库）.

Historical verdict at audit time: `BLOCK_MSI_UAC`.

## Previous dev-0.3.12 safe-temporary-root portable release gate (2026-08-11) — superseded for installation decisions

This preceding gate passed its safe portable package scope: a first-time-user black-box tester discovered the product only from `README.md` and terminating `--help` output, then exercised the final portable package from disposable temporary roots. Its positive results remain useful regression evidence, but the independent audit above supersedes its MSI/UAC decision because it found the Electron user-data isolation defect and the installed/portable package mismatch. The generated MSI was package-smoked but was not installed; no machine-wide UAC action was started.

The user-level repairs in this gate are CLI structured-error exit codes, explicit empty-Flow feedback, the GUI provisional-`Esc` stop race fix, and large-stream plain-text/throttled rendering. The earlier timeout/abort, TUI serialization, context-preparation, and compatibility-redaction repairs remain in the same source gate. `DESKTOP/scripts/release-safe-blackbox-gates.cjs` is the safe-root black-box matrix: it copies configuration data instead of hard-linking the real user inode, removes its temporary roots, and checks process/config cleanliness.

Acceptance evidence:

- `npm.cmd run test:full-release` exits `0`; source feature verification is `1465/1465`, performance is `12/12`, compression is `34/34`, provider-timeout recovery is `8/8`, TUI is `53/53`, launcher verification is `24/24`, the stop race is `2/2`, CLI contracts are `46`, and the GUI/TUI/CLI shared-backend lane passes 18 parallel isolated conversations plus a three-surface roundtrip (`21` provider requests). SSH TUI restart/PTY/resize/light-theme pressure passes. WSL TUI is an explicit environment skip because local `Ubuntu-24.04`/`wsl.exe` is unavailable.
- The safe packaged black-box matrix passes `26/26` help probes. Empty-provider CLI `send` returns exit `1` with `No LLM configured`. The real user config hash remains `428F19B08ADE1B03DB61F6796D1012A62B02BE24E4926921663705F8FFC5DFC2`, and the final Newmark process count is zero.
- The final package boundary is `release/win-unpacked/resources/app.asar` (`156,968,282` bytes, SHA-256 `14FE1894F602A10466E3C586DBAA16D0A9819A454AE34605BF32679524CBC18A`), `release/Newmark-Agent-0.3.12-x64.msi` (`225,843,509` bytes, SHA-256 `B309775E9FAE3CD753560100A74845BDF07170F0AC2F3C651D86CEA2DF3621D6`), and `release/Newmark-Agent-0.3.12-win-unpacked-x64.zip` (`291,710,303` bytes, SHA-256 `4453B33AA2B6584A952A227AFC69E84F63F31A14280E1FF7DAAD3A0B13B6DA06`).
- Real DeepSeek pressure passes `6/6` CLI rounds, `4/4` GUI rounds, two Goal continuations, queue drain, conversation isolation, and long context. Targeted GUI `Esc` stop passes for DeepSeek (`3618 ms`) and APInebula `gpt-5.4-mini` (`7279 ms`). Portable TUI/CLI real-model roundtrip, stop/recovery, restart startup, and restart request pass. One combined GUI run naturally completed before its interrupt point and is recorded as a non-interrupt observation, not counted as stop evidence; the dedicated targeted runs are the stop acceptance.
- The full 34-assertion compression pressure lane covers automatic threshold and active model-dispatched compression/history management, hot/cold 本地归档（未纳入公开仓库）, paged reads, idempotency, and byte-identical visible history. The complete record is 本地归档（未纳入公开仓库）.

Previous verdict: `SAFE_PORTABLE_RELEASE_GATE=PASS`; current installation verdict: `BLOCK_MSI_UAC`.

## Independent no-context black-box retest (2026-08-10) — release blocked

The long-running independent subAgent used only README.md, real installed --help/-h/--version output, and visible GUI/TUI behavior. It independently passed help termination, non-model management, real-model CLI Build 20/20, basic GUI Build/Goal/queue/button-Stop/conversation scenarios, sensitive-output scanning, and process cleanup. It did not complete TUI functional pressure or the full GUI-TUI-CLI shared-backend concurrency closure.

New blockers are recorded in 本地归档（未纳入公开仓库）: CLI send with an empty configuration returns a successful exit code despite No LLM configured; Plan/Goal fresh-root runs hit provider-timeout and sidecar-unavailable runtime failures; GUI Esc did not interrupt one long request while the Stop button did; Flow with no available workflow silently retained the prompt; and the isolated-root test used a hard link to the real config inode, after which the real config hash changed from the test-start record. The hard-link result is a test-isolation failure and is not by itself proof that ordinary copied-config roots mutate user state, but the missing original byte backup means the configuration boundary remains a release blocker. No source fix was made in this retest.

## Historical dev-0.3.12 user-level pressure repair and installed gate (2026-08-10)

This cycle entered `dev-0.3.12` from the installed first-time-user audit and closed the tester-facing defects found there. CLI top-level and subcommand help now exits before Agent/provider construction or live work; provider request timeouts are typed, bounded, and never cascaded from an aborted fetch into Node HTTP and PowerShell; stalled stream readers are cancelled; `agentKernelRunner.ts` carries an already-fired outer cancellation into a Native Kernel attached later; context preparation receives a boolean compression result instead of serializing the complete message list again; TUI sends are serialized per conversation; and compatibility metadata recursively redacts nested credentials, Bearer values, and query-string keys.

The release gate includes a dedicated `DESKTOP/scripts/compression-pressure-stress.cjs` lane. Its 34 assertions cover automatic threshold compression through a real Agent request, incremental-growth idempotency, model-dispatched `context_compress`, broker-provisioned model-dispatched `context_history_manage`, protected recent context, bounded hot-cache eviction, conversation-isolated cold JSONL archive, paged non-injecting reads, and hot/cold restore while `chatMessages` remains byte-identical. `context_history_manage` is intentionally risk-gated because it contains remove/restore actions; the pressure lane proves the actual `tool_provision -> context_history_manage -> Build continuation` path rather than calling an unexposed name directly.

Source and packaging evidence:

- `npm.cmd run test:full-release` exits `0`; performance optimization passes `12/12`, compression passes `34/34`, provider timeout recovery passes `8/8`, TUI demo passes `53/53`, the stop race passes `2/2`, CLI contracts pass `44`, and GUI/TUI/CLI shared-backend stress passes 21 provider-request fixtures. SSH TUI stress passes four restart rounds. WSL TUI stress is explicitly skipped because local `Ubuntu-24.04`/`wsl.exe` is unavailable and timed out.
- The final direct Windows packaging body `node scripts/dist-portable.cjs` exits `0` after 564.4 seconds. `release/win-unpacked/resources/app.asar` is 156,956,772 bytes with SHA-256 `A49B64F961091A8EA36F5C8E0F406C8851AB4D0253FE297160BB2A3CF2EF8F3E`; the MSI is 225,847,605 bytes with SHA-256 `2C965D100E970573924E5416DE8B0EAAC8DD9E93ACF0BE00168D381A54363283`; and the portable ZIP is 291,707,167 bytes with SHA-256 `2A2F687A534D671DAE8A04B191AC628059EC3DBD835B6D917FA874E98761E39E`. MSI administrative-image extraction contains the same `app.asar` hash.
- The final help matrix covers four installed/package GUI/console executables × 18 probes: `72/72` exit `0`, maximum observed latency `1,111.2 ms`, no provider work, and all Flow/Edit probes return command-specific help. Installed release CLI smoke covers state, tool, send, model validation, skills, Memory Lab, update, and fuzzy-provider lanes; installed `compat --target all` and `compat-tool --list` have no credential-shaped output and the known nested DeepSeek key is `[REDACTED]`.

The independent no-context subAgent's release-blocking finding was real and is now resolved. The old installed `C:\Program Files\Newmark Agent\Newmark.exe compat --target all` output exposed `plugins[13].rawManifest.provider.deepseek.options.apiKey`; after exact product removal and elevated installation of the final MSI, the installed command exits `0`, the nested value is `[REDACTED]`, and the installed/package hashes match. The same repair also closes the low-severity `flow --help`/`edit --help` discoverability defect. Details, including the original finding and repair trail, are appended to the release archive below.

Final real-model evidence is separated by surface. The final installed GUI passes six normal rounds, two Goal continuations, queue drain, conversation isolation, and long-context handling in `90.9 s` with `remaining=0` process cleanup. The final installed TUI/CLI pass covers a real-model TUI request, Esc stop, post-stop recovery, restart startup/request, and direct console CLI request. A separate final installed CLI sustained lane passes 8/8 rounds in `61.0 s` with process cleanup. The source full-release gate also proves shared GUI/TUI/CLI isolation and the context-compression/tool-dispatch paths. Earlier black-box live-provider runs still retain a probabilistic sustained risk: the 20-round CLI lane timed out at round 14 after a typed 90-second provider timeout, and a broader GUI lane had one provider/app timeout; these are not converted into passes. Full repair, package, model, cleanup, and remaining-risk evidence is in the archive above.

## dev-0.3.12 full-feature black-box retest (2026-08-10)

A fresh first-time-user pass used only `README.md` and the installed help family for discovery, then exercised the real `C:\Program Files\Newmark Agent` installation with APInebula `gpt-5.4-mini`. Help/version probes for all documented entrypoints and subcommands exited `0` without provider work. The complete scenario matrix is 本地归档（未纳入公开仓库）, and the result record is 本地归档（未纳入公开仓库）.

Targeted scenarios passed: GUI queue drain, conversation isolation, 8k automatic compression, and Goal continuation; TUI Esc stop/recovery/restart; CLI Plan/Goal/Flow modes; state, Memory Lab, skills, compatibility, fuzzy preview, update dry-run, help termination, secret hygiene, root isolation, and cleanup. The unqualified sustained-release claim is blocked by three live risks: GUI repeated UI prompts stalled on round 5 with backend `working` after `321.6 s`; a 20-round installed CLI lane timed out at `121.8 s`; and real `validate-models` timed out at `120.1 s`. These are classified as app/provider timeout or provider-latency risks rather than hidden or converted to passes. No installed process or temporary root remained and the real `~/.Newmark/config.json` hash was unchanged.

## Historical dev-0.3.11 installed black-box release pressure audit (2026-08-10)

The real `C:\Program Files\Newmark Agent` installation was tested as a first-time user using only README/help discovery. The deterministic `npm.cmd test` gate, packaged hash boundary, top-level help/version, APInebula `gpt-5.4-mini` GUI/CLI matrix, independent console `Newmark.exe` 20-round control, and TUI 10-round/restart control passed. The release is **not accepted for full-feature pressure release** because a real TUI long-task Stop/Esc recovery sequence stalled after two stop requests, and subcommand help is inconsistent: `validate-models --help` did not terminate within 30 seconds while `state --help` and `skills-market --help` performed live operations. WSL TUI stress remained unavailable because local `Ubuntu-24.04`/`wsl.exe` timed out. Full scenario matrix, failure reproduction, evidence and repair acceptance conditions: 本地归档（未纳入公开仓库）.

## dev-0.3.11 real-model pressure fixes and release (2026-08-10)

`DESKTOP/package.json` and `DESKTOP/package-lock.json` declare version `0.3.11`. This cycle repeated isolated temporary-root release testing against the packaged executable and repaired the tester-facing failures instead of treating them as provider noise. The full deterministic gate now passes `1465/1465` assertions. The final APInebula `gpt-5.4-mini` matrix passes 20 CLI rounds, 20 GUI rounds, three Goal continuations, queue drain, conversation isolation, and a 600-fragment long-context run; the packaged process cleanup result is `remaining=0`. Evidence: 本地归档（未纳入公开仓库）.

The release fixes have four groups:

- `DESKTOP/src/cli-help.ts`, `launcher.ts`, and `main.ts` share a terminating help/version contract, so first-time users can discover GUI, TUI, CLI, Flow, editor, and non-interactive commands without starting a runtime.
- `DESKTOP/src/core/electronUtilityAgentClient.ts` validates Windows process-tree identity and quarantines uncertain descendants; BrowserUse and utility shutdown regressions are covered by source and packaged Electron gates.
- `DESKTOP/src/core/conversationKernel.ts`, `agentKernelRunner.ts`, and `ui/index.html` close deferred Guide/Goal continuation, provider-empty-response retry, stale renderer-send-lock, and long-running work-block repaint gaps. A backend-idle authoritative snapshot clears only a stale local send lock; a genuinely running backend remains protected.
- BrowserUse is target-bound to the conversation's built-in browser/sidebar. ComputerUse is a conversation-bound toggle independent of Build lifetime, with a single process-wide lease and an explicit `computerUse occupied` response for competing conversations. Work-block rendering now frame-coalesces high-frequency public events without dropping durable events.

The final local Windows assets are:

- `release/Newmark-Agent-0.3.11-x64.msi`: 225,868,085 bytes, SHA-256 `E9BFB514B583556BFB64E8B35815EE8CD916CAC4FACC43EE0AC1FFD87D305817`.
- `release/Newmark-Agent-0.3.11-win-unpacked-x64.zip`: 291,695,654 bytes, SHA-256 `B8E287CDB393482EF1B3CEB9A91AB4BF86328C06AF8A13A80239DD4778ECFDFB`.

`.github/workflows/release-linux.yml` builds and smoke-tests Linux AppImage, Debian, and unpacked ZIP artifacts on Ubuntu, then emits a SHA-256 manifest. The remote workflow and re-download audit passed. The release is [dev-0.3.11](https://github.com/positer/Newmark-Agent/releases/tag/dev-0.3.11).

Remote Linux assets:

- `Newmark-Agent-0.3.11-x86_64.AppImage`: SHA-256 `CC3CB39D4F011E81330E4F097A5A1029E13CC00026E8799FCB7379AD8B008E0D`.
- `Newmark-Agent-0.3.11-amd64.deb`: SHA-256 `F4FE914FE8DA3BE65CF055C0F2E86DC44D4D078771D94009D4E6AB81496A2767`.
- `Newmark-Agent-0.3.11-linux-unpacked-x64.zip`: SHA-256 `3CDE1AAEFFBACA2E6B9F3E5AAB9FFE0C2899308716DDA83B6DD5C32868E3DAB2`.

## dev-0.3.10 Windows/Linux packaged prerelease (2026-08-09)

`DESKTOP/package.json` and `DESKTOP/package-lock.json` now declare version `0.3.10`. The Windows `npm.cmd run dist:windows-release` gate and the WSL/Linux `npm.cmd run dist:linux` gate both completed successfully, including the complete 1461-assertion desktop verification. The final package smokes passed for the Windows portable ZIP and MSI, and for Linux AppImage, Debian, and unpacked ZIP assets. The unsigned public prerelease is [dev-0.3.10](https://github.com/positer/Newmark-Agent/releases/tag/dev-0.3.10), created from commit `2ba14cc`.

The Windows packaged Browser-Use click lane initially exposed a deterministic webview guest-focus race: the native click receipt was successful but the built-in page did not receive the transition. `DESKTOP/src/core/electronBrowserUseHost.ts` now focuses the embedder and guest and yields between native mouse events. The rebuilt package passed the dev-0.0.8/dev-0.0.9/dev-0.1.0 compatibility lane, including the Browser-Use/editor/PDF checks.

Final artifacts:

- `release/Newmark-Agent-0.3.10-x64.msi`: 225,847,605 bytes, SHA-256 `472E1445F32484861D7779E4054EB7C918234B62A2EE2FA968006221AFA4D869`.
- `release/Newmark-Agent-0.3.10-win-unpacked-x64.zip`: 291,678,940 bytes, SHA-256 `DBD1745216220FFE11C035B4D43CE6258332C439B467FFF24ABE56035A657ACE`.
- `release/Newmark-Agent-0.3.10-x86_64.AppImage`: 175,786,564 bytes, SHA-256 `89CA21E673FEBDC494674D155E377CDF32B3BF312E42D26975867FB7554ADB08`.
- `release/Newmark-Agent-0.3.10-amd64.deb`: 135,458,768 bytes, SHA-256 `BC596453869FE5A542B7328A9261A780BD1C5A6569CE0B3EDA0621FD53A5320E`.
- `release/Newmark-Agent-0.3.10-linux-unpacked-x64.zip`: 171,911,069 bytes, SHA-256 `5A92E4BC8EB428CCE335FE50D81B4E51C7308842BA53BD6C63E232E73D2A6160`.

The Linux 20-run latency benchmark passed with hot first-event p95 `13.548 ms`, hot first-token p95 `10 ms`, cold local-before-provider `52.681 ms`, two tool-provider requests, and zero hot persistence writes. Package-only warnings were limited to the existing jsdom optional `xhr-sync-worker.js` resolution warning and electron-builder's Linux `desktopName` metadata warning; no real provider API was called by the deterministic smokes. The post-publication `npm.cmd run release:github-assets-verify -- --repo positer/Newmark-Agent --tag dev-0.3.10` audit re-downloaded all five assets, matched every local size and SHA-256, and reran the Windows and WSL/Linux package smokes. Full evidence is in 本地归档（未纳入公开仓库） and 本地归档（未纳入公开仓库）.

## dev-0.3.10 black-box real-model release stress (2026-08-09)

The packaged executable was tested as a new user would approach it: help was attempted first, then real-model pressure was applied through isolated packaged CLI/UI sessions. APInebula `gpt-5.4-mini` passed 20 cross-process CLI rounds, independent queue drain, conversation isolation, and a 600-fragment long-context run. The default model shown by CLI help, DeepSeek `deepseek-v4-flash`, passed six CLI and six UI rounds. All packaged process-cleanup checks returned zero remaining processes.

The release is not ready for real-model acceptance. Goal activation failed on a fresh process before the first provider call with `Electron utility runtime stop could not confirm child exit`; the same failure recurred after normal UI pressure and quarantined later runtime restarts. A 20-round same-window UI run also hit an intermittent round-5 `Guide · Rejected` state and timed out after 240 seconds, although two six-round APInebula runs and one six-round DeepSeek run passed. Direct `--help` and `--TUI --help` entered a desktop process tree instead of returning usage, while `--cli --help` returned only an interactive banner. Goal/Flow pause/resume, crash recovery, and live-backend timeout boundaries were therefore not claimed as passed. Full matrix and redacted evidence are in 本地归档（未纳入公开仓库） and the linked 本地归档（未纳入公开仓库） reports.

## dev-0.3.9 local Windows package and installation (2026-08-09)

The dev-0.3.9 source was packaged with `cd DESKTOP; npm.cmd run dist:windows-release`. The package metadata was `0.3.9`, so the generated installer reported version `0.3.9.0`. The complete release gate and a post-package `node dist/tests/verify.js` run passed 1461/1461; packaged CLI smoke and installed-target CLI smoke also passed.

Final artifacts:

- `release/Newmark-Agent-0.3.9-x64.msi`: 225,843,508 bytes, SHA-256 `65B1CCF339CF7E7087D55DAD71D6BE2E5E8B7624A1C15A150DBFF7572D5B5477`.
- `release/Newmark-Agent-0.3.9-win-unpacked-x64.zip`: 291,678,671 bytes, SHA-256 `02F5B464569041393D713B54A8D114E93899CC7702447865F10AF02205CABAFB`.

The elevated MSI installation completed with exit code 0 at `C:\Program Files\Newmark Agent`, product version `0.3.9.0`, product code `{3F8CD41B-5C7C-4E05-B1F6-A759012F8CE5}`. Installed `resources/app.asar` and packaged `app.asar` both hash to `B4192300457792D4439DBDFA7292C94299B3217C76C4801FF44F039AD1194A4C`. The real `~/.Newmark` root remained at 17,920 files and 283,767,519 bytes with unchanged `config.json` SHA-256 `22EBC1420C92AC656E9BF5F899C0188E9004EB17B6D79B1BED93F437EABF8247`; no installed Newmark process remained after smoke testing. The operation record is 本地归档（未纳入公开仓库）.

## dev-0.3.10 Goal/Build lifecycle hardening (2026-08-09)

The Build Block terminal path in `DESKTOP/src/core/agent.ts` now guarantees one durable `work_overview` entry for each declared terminal run, including short replies, terminal events emitted before the finalizer, and terminal state recovered during a later load. The overview is idempotent by `work-run-overview:<runId>` and contains the startup input, final public summary, event/Guide counts, terminal status, and one Goal completion audit. A tracked Goal completes only when the terminal Build is completed and its evidence matches; all other terminal paths leave the Goal explicitly paused unless the conversation kernel owns the next continuation.

`DESKTOP/src/core/conversationKernel.ts` pauses a running Goal on the first user Stop and preserves that pause through ordinary input. `DESKTOP/src/ui/index.html` no longer optimistically clears the pause flag on submission. Only the explicit Goal resume action changes the flag, and it immediately claims a Goal continuation and starts a Goal-driven Build, including when the target runtime must be cold-created by `DESKTOP/src/core/electronUtilityRuntimePool.ts` or `DESKTOP/src/core/wslAgentRuntimePool.ts`.

`DESKTOP/src/core/runtimeLifecycle.ts` writes owner-isolated role-scoped startup markers for `main`, `utility`, and `wsl` owners. The marker records PID liveness so a live backend is not confused with a previous crashed owner, and one Utility owner cannot clean or overwrite another owner. `DESKTOP/src/core/agent.ts` stores the owner identity on each active conversation and WorkRun: a cold load preserves a still-live backend run even when its frontend five-minute tracking timestamp is old, while a dead owner or an unexpected-exit marker converts orphaned runs to `interrupted`, pauses Goal/Flow on the first load, and writes the recovery overview. `DESKTOP/src/main.ts`, `DESKTOP/src/conversation-utility-host.ts`, and `DESKTOP/src/wsl-agent-host.ts` mark lifecycle state clean only when no unpaused Goal or active Flow remains, so forced/failed shutdowns are recoverable.

`DESKTOP/src/tests/guideWorkRunVerify.ts` adds executable assertions for short-Build overview durability, one-time terminal overview writes, Stop→pause, ordinary-input pause preservation, immediate Goal-driven resume, stale frontend tracking with a live backend owner, and main-role crash recovery for Goal and Flow. Verification passed `npm.cmd run typecheck`, `npm.cmd run build`, the focused guide/work-run suite, runtime isolation/context/UI/pool regressions, and the full `verify.js` gate with 1461/1461 assertions. The dated operation record is 本地归档（未纳入公开仓库）.

## dev-0.3.9 Prime Agent-informed durable context folding (2026-08-08)

Newmark's active context management now separates a bounded hot cache from complete cold history. When `context_compress`, automatic compression, model-switch compression, or `context_history_manage summarize` folds messages, the newest segments remain in the existing per-conversation `compressionCache`. If that cache exceeds `compression_cache_max`, `DESKTOP/src/core/compressionHistoryArchive.ts` appends the evicted segments to a conversation-isolated JSONL ledger under the mutable Newmark root at `.newmark-context-v2/compression-history/<scope-hash>.jsonl`; the ledger is never concatenated into a model request. This adopts the conservative part of Prime Agent's session/context design—keep the active prompt compact while retaining programmatic access to complete past information—without replacing Newmark's provider tools, agent kernel, compression thresholds, summaries, or visible conversation model.

`context_history_manage search` now searches both hot and cold folded segments, `read` pages one selected segment under explicit entry and character bounds, `restore` can reinsert a cold segment only when its summary marker is still present, and `status` reports hot cache and cold archive separately. Restore writes an append-only tombstone instead of rewriting history. Archive write failure keeps the would-be-evicted entry in the hot cache, preferring a temporarily oversized cache over irreversible loss. IDs remain monotonic across restarts and restore tombstones. `compression_archive_enabled` is the rollback switch and defaults to true. User-visible `chatMessages` remain byte-identical throughout these operations.

Verification: TypeScript typecheck passes; the built desktop verification gate passes 1461/1461 assertions. New coverage proves hot eviction remains searchable, bounded cold reads do not mutate active or displayed history, status distinguishes storage tiers, cold history survives restart, and cold restore appends a tombstone. The design reference is Prime Intellect's [Prime Agent: A self-improving RLM agent](https://www.primeintellect.ai/blog/prime-agent); the implementation record is 本地归档（未纳入公开仓库）.

## dev-0.3.9 local Windows package, installation, and stress audit (2026-08-08)

The Windows release pipeline rebuilt `Newmark-Agent-0.3.9-x64.msi` and `Newmark-Agent-0.3.9-win-unpacked-x64.zip` after the complete source release gate. ZIP extraction and MSI administrative-image smokes pass the dev-0.0.8, dev-0.0.9, and dev-0.1.0 compatibility lanes. The MSI upgraded the existing machine-wide 0.3.7.0 installation to 0.3.9.0 at `C:\Program Files\Newmark Agent`; the installed `resources/app.asar` is byte-identical to `release/win-unpacked/resources/app.asar`. The installation did not change the SHA-256, file count, or byte count under the real `~/.Newmark` root.

Package stress found and fixed a target-local force-stop defect in both `DESKTOP/src/core/electronUtilityRuntimePool.ts` and `DESKTOP/src/core/wslAgentRuntimePool.ts`: after giving a worker a bounded chance to persist its `force_interrupted` settlement, the second Stop now always terminates the target process/process group and leaves it down until the next prompt. The prior branch skipped process termination when the kernel acknowledged `action=force`, leaving `running` and `stopRequested` stuck. `runtimeIsolationVerify` now covers that acknowledgement path. Two package harnesses were also aligned with established contracts: the dev-0.0.8 mock recognizes stable human-readable peer names without requiring a UUID suffix, and dev-0.0.9 accepts the intentional `restarted=false` force-stop receipt. The large-input performance fixture receives a 45-second CDP control budget while all performance acceptance thresholds remain unchanged.

The final source release gate, package CLI/SSH smoke, ZIP smoke, MSI smoke, installed dev-0.0.8 and dev-0.1.0 feature smokes, installed startup recovery, and installed tray lifecycle pass. Installed startup reached interaction in 1,832 ms and opened Browser on demand in 1,102 ms. Two installed dev-0.0.9 repetitions passed force-stop/isolation but failed later Browser/UI work (one click-state miss and one CDP timeout), so that lane remains unstable. A formal 20-run performance set was stopped after a one-run diagnostic produced 584.53 MiB startup private memory against the 525 MiB absolute/522 MiB relative limit and 534.1 ms trusted input latency under 4× CPU throttling against the 150 ms limit. These failures are retained as release blockers rather than reported as a passing 20-run set. Full evidence and hashes are in 本地归档（未纳入公开仓库）.

## dev-0.2.6 pause-aware Flow Stop/Esc, force-stop, and per-conversation draft persistence (2026-08-03)

Flow Stop/Esc is now pause-aware. While a Flow is running, `DESKTOP/src/main.ts` `flow:stop` returns `{ action: 'stopping' }` on the first Stop/Esc and aborts the run with `controller.abort(new Error('Flow interrupted by user: …'))` plus `agent.abortActiveKernelRun()`; the `flow:run` catch then turns the user abort into the same persistent interrupted suspension used for system-level interruptions (`persistedFlowSuspensionRecord`, `agent.saveStoredFlowSuspension`), so the paused takeover renders and nothing is torn down. The second Stop/Esc sees `activeFlowSuspension`, calls `discardFlowSuspension()` (restoring the previous mode), force-stops the kernel/pool, and returns `{ action: 'force_stopped_pending' }` so the renderer tears down and returns to Build. A new Build/Plan/Goal/Flow instruction sent while paused calls `clearFlowSuspensionForNewWork()` (`DESKTOP/src/main.ts`, wired into `agent:send` and `flow:run`), which clears the suspension, `flow`, and `pendingOptions` without restoring the previous mode, so the new process owns the mode. `DESKTOP/src/ui/index.html` `stopFlowRun` early-returns on `'stopping'`, `exitPausedFlowForNewInstruction()` exits a paused takeover into new work, and a Force-stop button appears on the paused takeover; Esc routes to `stopFlowRun` while running.

Unsent input now persists per conversation. `DESKTOP/src/core/agent.ts` stores a `draft` on the conversation-store entry (`saveStoredConversationDraft`/`getStoredConversationDraft`), exposed to the renderer through `DESKTOP/src/preload.ts` `getConversationDraft`/`saveConversationDraft` IPC, so a draft survives conversation switches, workspace switches, and app restarts and is restored on return. Clearing a draft writes an explicit empty `draft: ''` sentinel so the conversation-state merge propagates the removal.

Verification: `DESKTOP/src/tests/verify.js` passes 1410/1410, including new runtime assertions that a saved draft survives an Agent restart, that clearing it removes it across another restart, and that a fresh draft can be written afterwards; the backend stress suite `DESKTOP/scripts/flow-pause-stop-draft-stress.cjs` covers first-stop cooperative abort → persisted interrupted suspension, second-stop force-stop, new-instruction-no-mode-restore, 40 draft round-trips, restart survival, 8 concurrent agents × 200 drafts, and 12 pause/stop churn cycles with no leaked flags; the jsdom UI suite `DESKTOP/scripts/flow-pause-stop-ui-stress.cjs` drives the same state machine in the renderer. The first stress run caught a real draft-clear persistence bug, which is fixed and regression-locked.

## dev-0.2.5 SubAgent work streams live into the GUI overlay and the TUI Agents view (2026-08-03)

SubAgent background work now reaches both user surfaces in real time instead of only after completion. `DESKTOP/src/core/agent.ts` emits each peer event (`subagent-send`, `subagent-result`, streamed text, tool calls, status, and completion) through `emitPeerWorkEvent`/`runSubagentJob`, which strips `runtimeKey`/`workspaceKey` and attaches the actor id so peers never leak runtime identity; `DESKTOP/src/core/conversationKernel.ts` forwards peer events through `emitPeerWorkEvent` broadcast without persisting them into the conversation store, and `runtime.unsubscribePeer()` stops delivery.

`DESKTOP/src/ui/index.html` adds the SubAgent work overlay: a draggable panel anchored to the subagents surface that renders each peer's task lifecycle, streamed text, tool calls, tool results, and completion with per-actor labels, zh UI text, and a `Esc`/chat-tab close path. Events are cached per actor with a 500-entry cap (oldest dropped first), so reopening a finished SubAgent replays its completed work instantly from the cache. `DESKTOP/src/main.ts` relays the events from the shared backend to every window; the TUI receives the same stream through its relay adapter, and the TUI Agents view now expands each SubAgent row (Enter) into its conversation history and final result, with the expansion collapsed again on a second Enter.

Tool provisioning keeps the subagent orchestration core (`task`, `subagent_list`, `subagent_read`, `subagent_send`, `subagent_result`, `subagent_close`) preloaded in every model surface: `DESKTOP/src/core/agentKernelRunner.ts` appends the core after the 8-schema intent slice in `routeToolSurface` and `ToolProvisionSession.reconcile` retains it unconditionally, so the tools promised by the orchestrator and peer sandbox prompts are never dropped by intent gating; broker-equivalent surfaces (skill + core + broker) keep the internal provision preface suppression intact.

Verification: `DESKTOP/src/tests/verify.js` passes 1402/1402; the dedicated streaming-relay stress (`DESKTOP/scripts/subagent-streaming-relay-stress.cjs`) covers single-child, 8-parallel-child, unsubscribe-after-delivery, and kernel-broadcast-without-persistence scenarios; the GUI overlay smoke (`DESKTOP/scripts/subagent-gui-overlay-smoke.cjs`) executes the full event lifecycle in jsdom with 27 checks; `toolProvisioningVerify` passes 64/64 tools through exact on-demand provisioning and the broker boundary; the full release gate (desktop, intelligence tier, TUI 53/53, SSH PTY, WSL Ubuntu 24.04 PTY, CLI, shared-backend stress) and both packaged Windows smokes (22 assertions each) pass, and the MSI/zip/AppImage/deb packaging is verified.

## dev-0.2.4 Flow plan confirmation pauses for the user, and interrupted Flows resume from a persistent paused takeover (2026-08-02)

Flow plan confirmation is a real pause. When the planner finishes a Plan component and asks "计划已完成，是否执行此计划？", `DESKTOP/src/core/flow-runner.ts` no longer filters the question as an automatic follow-up; the run ends in the pending-question state, `DESKTOP/src/main.ts` delivers the pending options to the chat, and the Flow genuinely waits for the user's choice. The regression test drives an Agent that returns that exact question in `pendingOptions` and asserts the run is completed with `FlowQuestionPendingError` (componentId 5) and the question rendered.

System-level interruptions now pause the Flow instead of killing it. If a component raises a provider/network failure (`FlowBuildExecutionError` with `componentId` and `completedResults`), `flow-runner.ts` records the full suspension — workflow name, component id, input, completed results, previous mode, and the `interrupted` reason with the failure message — and `DESKTOP/src/core/agent.ts` persists it in the `StoredConversationState.flowSuspension` field through the normal conversation-store write path. On `flow:run`/`flow:resume` catch, `DESKTOP/src/main.ts` routes the error through `isUserFlowAbort`: user-initiated aborts keep their existing direct exit (no pause, no persistence), while system interruptions become the takeover.

The takeover bubble is interactive and durable. `DESKTOP/src/ui/index.html` renders `renderFlowTakeover(active, name, options)` in the interrupted context with the "Flow 已暂停接管" label and the failure reason; clicking the bubble calls `window.resumeInterruptedFlow()`, which rebuilds the provisional `_flowRuntimeLease` and calls `resumeFlowWith('', true)` so `flow:resume` restarts the component at `startPc = componentId` with the saved input, the completed results, and an empty resume prompt. `refreshRightStatus` restores the suspended flow after any rerender, and the pause survives restarts (main.ts `ensureStartupAgent` restores `activeFlowSuspension` with `previousFlow = null`, `previousPc = 0`), conversation switches, and workspace switches. A new Flow, a new message, or a stop calls `discardFlowSuspension()` to clear it.

Verification: `DESKTOP/src/tests/verify.js` passes 1388/1388, including the plan-confirm pause, the interruption-suspension-resume regression (two runs, `FlowBuildExecutionError` componentId 9, `completedResults` component 7, paused takeover persisted), and static source assertions for `persistedFlowSuspensionRecord`, `discardFlowSuspension`, `restoreStoredFlowSuspension`, the three discard guards, `flowSuspension` exposure, and the UI takeover contracts. The Windows release gate and the native-WSL Linux release gate both pass end-to-end, including packaging, with a 20-run hot benchmark `{"runs":20,"hotFirstEventP95Ms":18.17,"hotFirstTokenP95Ms":16,"passed":true}`.

## dev-0.2.3 conversation-bound drafts, scroll anchoring, Ultra, and balance-safe provider failures (2026-08-02)

Input drafts are now bound to the selected Conversation. `DESKTOP/src/ui/index.html` keeps an unsent draft per Conversation target in the renderer (`state.conversationDrafts` keyed by the active target), saves the current draft before a switch, restores the matching draft after switching, and clears it on send, so nothing typed is lost when moving between Conversations and no draft leaks into another Conversation.

Transcript rerenders preserve the user's scroll position. The renderer records whether the view was anchored at the bottom before a destructive redraw (`chatWasAtBottom`), then reapplies `scrollTop` after rendering and only scrolls to the bottom when the view was already there. Live updates therefore keep following the newest content while the user reads older history without being yanked down.

Ultra is a real sixth request tier. `DESKTOP/src/core/config.ts` persists it like the other tiers; `DESKTOP/src/core/agent.ts` maps Ultra to `max` reasoning effort at the provider boundary and extends the system prompt so the primary Agent acts as an orchestrator that actively dispatches specialized SubAgents and coordinates the team. `DESKTOP/src/tests/intelligenceTierVerify.ts` asserts the full `low/medium/high/xhigh/max/ultra` ladder across OpenAI Chat Completions and Responses request shapes.

Provider balance failures are safe and actionable. `DESKTOP/src/core/autoRouter.ts` classifies 402/insufficient-balance responses as `balance_exhausted`; `agent.ts` detects them in the provider result path (including the kernel streaming path via `agentKernelRunner.ts`) and records a bounded cooldown per deployment (`providerBalanceBlockedUntilByDeployment` keyed by providerId+modelId). The `process()` entry guard rejects further requests only on the deployment that actually failed with a clear `Provider balance exhausted (HTTP 402) for providerId/modelId` error, and Auto routing excludes cooldown-locked deployments from its candidates, so switching provider or model resumes immediately while the failed deployment stays paused until its cooldown expires. A 402 is never streamed through as ordinary Agent prose. The subagent reviewer-* failure seen in testing was that same 402 surfacing through the subagent path; the balance guard now stops the repeat. Tool provisioning keeps its broker available even when no task-specific schema is preloaded.

Verification: `DESKTOP/src/tests/verify.js` passes 1378/1378; the dev-0.2.3 balance stress (`DESKTOP/scripts/dev023-balance-stress.cjs`) confirms a blocked follow-up makes zero additional provider calls and that switching to another provider's model resumes immediately (`{"ok":true,"calls":2,"blockedFollowUp":true,"switchedProviderUnblocked":true,"cooldownMs":300000}`); the intelligence tier gate captures 602 requests across six tiers and both protocols; TUI 53/53, launcher 19/19, SSH/WSL PTY stress, CLI contracts, and the GUI/TUI/CLI shared-backend stress all pass, and the packaged-release gate exits 0.

## dev-0.2.2 Flow live Build and Conversation state (2026-08-02)

Flow component execution now publishes through the same public work-event boundary used by direct user Builds. `DESKTOP/src/core/flow-runner.ts` creates and announces each component-owned Build before provider setup, keeps dialog activity fully visible, keeps logic evaluation result-only, and converts structured provider failures into bounded status/message errors. `DESKTOP/src/main.ts` temporarily relays the primary Flow Agent's events to every desktop window with the owning workspace, Conversation, and runtime identity; the relay is always removed when run/resume settles.

`DESKTOP/src/ui/index.html` immediately leases the Conversation running state when an idle Flow takes over, preserves an already-running Build until it settles, and keeps the Flow lease active between component Blocks. Live-created Blocks default expanded unless the user explicitly changes them, so elapsed time, public reasoning/progress, and tool events appear as they arrive. The shared send button follows the actual Flow action: empty input is Stop while takeover is active, and typed Guide/Next input is Send. Completed/error events reconcile the Conversation marker and working chrome without leaving a stale runtime.

Flow provider errors belong to the failing Build. Nested provider JSON is reduced to its useful HTTP status and message, the renderer records that the Build error was already surfaced, and the Flow top-level catch only creates a notification when no Block error reached the UI. This removes the duplicate raw `[Flow error] [LLM Error: ...]` Agent bubble while retaining actionable failure detail. The display contract is intentionally public-event-only: hidden or encrypted model chain-of-thought is never exposed.

Ownership and evidence: `DESKTOP/src/tests/verify.ts` covers live boundary publication, relay wiring, immediate runtime/button state, 402 error condensation, and no duplicate Agent bubble; `DESKTOP/scripts/dev018-mode-ui-smoke.cjs` now also exercises a running Flow Block in real Electron and accepts an explicit evidence screenshot path. The accepted screenshot is 本地归档（未纳入公开仓库）, and the implementation/verification record is 本地归档（未纳入公开仓库）. The final unified `npm.cmd test` gate exits 0 across DESKTOP, the five-tier request gate, native TUI, real loopback SSH PTY, Ubuntu WSL PTY, CLI contracts, and the 18-conversation GUI/TUI/CLI shared-backend stress.

## dev-0.2.1 shared intelligence tiers (2026-08-01)

The former uneven intelligence presets are replaced by one explicit shared contract: `low`, `medium`, `high`, `xhigh`, and `max`. TUI Model presents the five reasoning-effort rows before deployment selection; the GUI Models surface owns the corresponding selector. Both write `models.default_intelligence` through the shared user configuration, update resident conversation runners immediately, and restore the selected tier on a fresh Agent process.

The Agent kernel now forwards the selected tier into the provider request boundary. OpenAI-compatible Chat Completions use `reasoning_effort`; Responses uses `reasoning.effort` with `summary: auto`. Reasoning-incompatible models omit these fields. Because the public OpenAI contract currently tops out at `xhigh`, an exact official OpenAI endpoint maps Newmark's compatibility tier `max` to `xhigh`; custom compatible gateways retain literal `max`. A fetch-capturing stress gate checks all five tiers across both protocols for 50 rounds each, persistence across fresh Agents, incompatible-model omission, and official-endpoint normalization: 502 requests passed. The full source gate now passes TUI 53/53, launcher 19/19, SSH/WSL PTY, CLI contracts, and GUI/TUI/CLI shared-backend stress.

The final Windows MSI is installed at `C:\Program Files\Newmark Agent`, version `0.2.1.0`. Windows Installer returned 0; installed and packaged `resources/app.asar` share SHA-256 `4E7BEE37652FA7DF6DF1361FF8B50878500748697BEE996E9D3B8D5DFB010D28`; the user config hash remained unchanged. The globally installed npm tarball command resolves `Newmark --GUI` to that machine installation and produced a responsive isolated-root window.

## dev-0.2.1 Crawl4AI-informed Browser Use, validation progress, and input-mode durability (2026-08-01)

The official Crawl4AI repository was pulled into the ignored local reference tree at `_ref/Crawl4AI`, branch `main`, commit `7e801521428ee12509994d39151006f64055ebe3`. Newmark already retained one host-owned page per runtime target, so the implementation did not duplicate Crawl4AI's Python page/session pool. The applied concepts are its phased page readiness/content retrieval boundaries: Browser Use `wait` now checks normal page readiness and then polls a fixed, isolated-world DOM fingerprint until repeated stable snapshots or the caller's bounded timeout. Static pages return early; cancellation and per-physical-page serialization remain intact. No caller-provided JavaScript or real selector crosses the model boundary.

Browser observations now cache computed visibility for each ancestor during one extraction, stop walking once the requested text budget is filled, omit script/style/template/SVG text, and prefer a substantial `main`, `article`, or `[role=main]` region over surrounding navigation noise. The observation reports `contentSource` as `main` or `body`; interactive refs are still collected from the visible viewport and remain opaque. Focused verification passes 80 Browser Use assertions, including main-content selection, hidden/editable-value exclusion, and stable wait. The real Electron gate confirms a stable DOM returns before its full timeout and that an in-flight wait is abortable; its first run hit an unrelated process-tree timing assertion, while the immediate unchanged rerun exited 0.

Model validation now exposes a determinate per-check ledger. Every selected model owns eleven progress slots covering catalog, health, text, streaming, strict JSON, four tool checks, vision, and image output; cached, unsupported, or health-skipped checks still settle explicit slots. Electron IPC and the local web bridge expose completed/total checks, completed/total models, percent, current model, and current check. The Models window polls this state every 150 ms and renders a bilingual accessible progress bar while validation continues in the background.

Guide/Next is now explicitly a user-level preference. `general.default_input` joins the workspace-override exclusion set, preventing a copied or stale workspace `config.json` from replacing `~/.Newmark/config.json`. Regression coverage saves `Next`, activates a workspace whose template still says `Guide`, constructs a new full Agent process, and confirms the restarted application remains in `Next`. The complete source release gate passes with exit 0, TUI 53/53, launcher 19/19, real OpenSSH and WSL PTY gates, CLI contracts, the five-tier request stress, and the 18-conversation shared-backend stress.

## dev-0.2.1 Agent image display and TUI viewer (2026-08-01)

The 2026-08-02 follow-up removes the standalone Memory Lab SVG implementation from `main.ts`. A TUI-opened Overview now loads the GUI `index.html` in an isolated viewer mode, removes the application shell before display, and invokes the exact GUI `buildMemoryLabOverviewGraph`, `renderMemoryLabOverview`, and `initMemoryLabOverview` pipeline. Anchor, root tags, components, edges, physics, camera, focus modes, drag, zoom, reset, accessibility attributes, and styling consequently have one owner. The real Electron stress asserts the Anchor and every fixture root/component node while continuing to reject Detail, Editor, Conversations, Settings, and main-shell DOM.

`image_display` is a protected, mode-scoped Agent tool accepting a workspace-contained PNG/JPEG path and optional caption. `core/displayImages.ts` validates real paths, decoded MIME, 10 MiB bounds and workspace containment, then writes a content-addressed asset below `~/.Newmark/conversation-media/display-images`. Work events persist only the reference and hydrate bytes for live/restarted GUI and TUI snapshots; model-visible results never contain base64 image bytes.

When the active deployment has passed vision-input validation, `handleImageDisplayWithDescription` sends the hydrated image through that same provider to generate a short content-grounded title before the public tool result is emitted. The optional caption is a prompt hint and failure/non-vision fallback. Successful descriptions are cached by provider, model, and image SHA-256, bounded to 128 entries; timeouts or provider failures preserve normal image display with the fallback title.

Large image-return runs avoid serializing accumulated base64 payloads back through HTML on every tool event. The renderer emits stable image shells, hydrates their `src` properties after structure creation, and frame-coalesces tool-call/result repaint requests once a Build reaches 12 public events. The real-Electron `release-ui-image-display-stress.cjs` gate injects 120 generated PNG results through the public Work-event path, asserts expanded/collapsed counts, uniqueness and exact order, records long tasks/update latency/payload/DOM metrics, and captures normal plus overview screenshots.

The GUI merges the completed tool result back into its matching public call and renders the image immediately after that call. Completed/collapsed Build Blocks retain their display images, in event order, at the start of the collapsed summary. The TUI emits selectable `[示意图]` rows in the same order in expanded and collapsed layouts. Unfocused rows reveal neither title nor action; the cursor-owned row reserves enough terminal width and extends with the generated/fallback image description plus `Enter 打开`. History Up/Down traverses Build headers and image rows, while Enter on an image opens the new standalone viewer. Memory Lab column one now starts with a real `Overview · 示意图` item. Enter opens a small graph-only window generated from the already-loaded visualization snapshot, with no main GUI navigation, editor, detail panel, or unrelated component.

The standalone viewer is an explicit Electron `--newmark-viewer` mode backed by a one-use request beneath the mutable runtime root. Packaged TUI sidecars relaunch the owning Electron executable without Node mode; repository TUI runs resolve the bundled Electron runtime. The focused display-image persistence gate passes, the TUI suite now passes 53/53 plus launcher 19/19, and the final unified `npm.cmd test` gate exits 0 across DESKTOP, SSH, WSL, CLI, and GUI/TUI/CLI shared-backend stress. Final packaged stress covers 120 ordered GUI images (2.90 ms update P95, zero heap delta) and 30 isolated TUI viewer windows (zero failures, 1581.5 ms startup P95).

## dev-0.2.1 TUI search, model identity, and render scheduling (2026-08-01)

The terminal client now enters the current Conversation directly. The fabricated Overview metrics, standalone ROOT/Conversations row, inactive Memory Lab Overview/Detail/Search/Reindex labels, generic mock Details modal, and other non-functional action copy were removed. Workspace children and Operations are the only sidebar navigation layers.

Memory Lab uses `/` as an explicit tag-search mode. Input filters the already-loaded visualization snapshot case-insensitively, updates the selected tag and component detail without disk access, supports Up/Down result movement, follows the selection with Enter, and clears with Esc. Conversation headers now render the persisted deployment display name or `Auto · <resolved model>` beside the title; the real Core adapter adds its current resolved model identity to each TUI snapshot.

The TTY writer now coalesces same-turn render requests with `setImmediate`, skips byte-identical frames, and reduces spinner cadence from roughly 6-8 FPS to 4 FPS. This follows the event-driven/debounced status approach documented by Claude Code, the bounded status/reflow configuration in Codex CLI, and the fully owned viewport/session-title pattern in OpenCode. The focused TUI suite is 53/53, including live tag filtering, model-title identity, five-tier switching, burst coalescing, identical-frame suppression, Unicode layout, and real isolated Core persistence. The final unified `DESKTOP/npm.cmd test` gate exits 0 across DESKTOP, TUI, SSH, WSL, CLI, and GUI/TUI/CLI shared-backend stress.

## dev-0.2.0 Conversation-aware TUI and Shared-backend Stress (2026-07-29)

`Newmark --TUI` now starts a real terminal client from any folder, selecting or registering that folder as a Workspace while keeping mutable state under the normal `~/.Newmark` root. The TUI uses one target-owned Core runner per active Conversation, so changing focus does not abort background work. Running rows expose a `\ → — → / → —` marker, background completions never steal foreground focus, and `Esc` remains a target-bound graceful-stop/second-press force-stop contract. Selecting a Conversation and pressing Enter enters editing immediately; Tab returns to Conversation selection without discarding the draft, while Shift+Tab cycles Build, Plan, Goal, and Flow. Flow entry requires an explicit workflow choice before editing continues.

Workspace children are dynamic and Conversation-bound. Conversations and Model are always available; Plan, Goal, and Subagents appear only when the last-entered Conversation contains them; Flow Bar, Flow List, and Flow Task appear only after that Conversation has a selected Flow. `ConversationFlowSelection` is now part of the Core persisted snapshot/state, and per-Conversation model selection uses the existing qualified deployment identity. T toggles pinning only while the Conversation list owns the cursor and follows the same Conversation ID after reordering. Operations remain flat and now include a complete Help view.

The light terminal theme sets readable foreground/background colors and renders exactly the full terminal row count, preventing uncovered black host rows. Unicode display-width partitioning remains enforced. Post-release source verification now passes 48/48 TUI checks. Operations remain flat while the new WorkFlow content view manages and creates FlowEngine definitions and Automations exposes a real create form. Long side menus auto-scroll with selection; conversation history uses the remaining terminal height while preserving a two-row input viewport. Up from the first input visual row enters a Build Block cursor, whose upward movement scrolls only after crossing the visible history top. Downward history scrolling remains bound to Down beyond the final input row. The TUI now mirrors the GUI's atomic WorkRun order: primary input, a collapsible Build Block with always-visible duration, deduplicated Guides, and its always-visible final summary stay strictly adjacent by `runId`. Expansion hides only public progress/tool details and persists through the existing `setWorkRunExpanded` backend. Settings / General opens a Guide/Next picker for the default Enter behavior; confirmation is target-bound, updates an already-created Core runner, and persists to Newmark's shared `general.default_input` configuration. The released full DESKTOP suite passed 1365/1365 main assertions plus every specialized gate. The shared-backend stress passes 18 parallel GUI-backend/TUI/CLI isolated Conversations, a three-surface same-Conversation roundtrip, per-Conversation model isolation, and 21 local Mock Provider requests without cross-Conversation leakage.

The final Windows package carries separate GUI and console-subsystem executables over one `app.asar`. MSI installs `Newmark.exe` and registers its directory in the user PATH, while `Newmark --TUI` hands off to Electron's Node terminal mode and the existing Core launcher. Product `{88B7FEB5-E1C6-44C9-999D-D143B777BEDD}` is installed machine-wide at `C:\Program Files\Newmark Agent`, version `0.2.0.0`. Installed `app.asar`, console launcher, and GUI executable match the final package byte-for-byte; the GUI is responsive, and a repository-external global TUI launch selects its invoking folder as the Workspace. `~/.Newmark/config.json` remained byte-identical across the replacement.

## Global TUI Launcher and Terminal Partitioning (2026-07-29)

`Newmark --TUI` is now a first-class Node, packaged Electron, portable batch, and npm-bin entry. The launcher resolves the normal mutable root, preserves the invoking `process.cwd()`, and passes both to the bundled TUI. The TUI uses the existing `Agent`, `WorkspaceManager`, `MemoryLabManager`, `AutomationManager`, and Config persistence rather than a second backend format. A normal DESKTOP build runs `scripts/build-tui.cjs` after TypeScript and runtime-host generation, copying the TUI runtime into `dist/tui`; the existing `dist/**/*` package rule includes it.

Terminal layout now measures display columns rather than JavaScript character count. CJK/full-width/emoji characters reserve two columns, combining characters reserve zero, message paragraphs wrap explicitly within the Conversation detail pane, continuation rows retain the role-column indent, and blank sidebar rows are padded before the fixed separator. A long Chinese response therefore cannot trigger terminal-owned continuation at column zero.

Acceptance now includes the current TUI 48/48 suite, launcher source/artifact checks, a compiled-launcher ConPTY run, a literal PowerShell `Newmark --TUI` ConPTY run from a new temporary project, shared-backend stress, and the complete DESKTOP suite with exit code 0. The current MSI installs `Newmark.exe` under `C:\Program Files\Newmark Agent` and exposes it through the user PATH; the temporary source npm link and obsolete per-user installation were removed. Detailed evidence is in 本地归档（未纳入公开仓库）, 本地归档（未纳入公开仓库）, and 本地归档（未纳入公开仓库）.

## dev-0.1.12 One-shot Memory Lab Visualization and Release (2026-07-28)

The current source, packaged prerelease, and validated current-user installation are `dev-0.1.12`; the local executable is under `%LOCALAPPDATA%\Programs\Newmark Agent 0.1.12`. `memoryLab:visualization` returns one index, all component core Markdown, a stable relationship version, and the load timestamp. The renderer calls it only when the Memory Lab visualization opens, Reset is requested, or a successful reindex completes. It increments a generation token so stale asynchronous results cannot replace a newer snapshot. Component selection, Detail navigation, tag search, drag, and zoom use `memoryLabComponentContents` and the already-built graph; none calls `memoryLabRead`, recomputes relationships, or reloads the panel.

`MemoryLab` retains the normalized index in-process and maintains a version-keyed, size-bounded component-content cache. Repeated `memory_lab_query` calls reuse both caches instead of reading and normalizing every component file. Explicit component reads and visualization refreshes force current disk contents once, preserving Reset/open semantics and external-edit visibility. Updates, deletes, and reindexing update or prune the cache consistently.

The overview renderer now owns one dirty-frame scheduler guarded by `memoryLabOverviewFrameRunning`. Physics and paint are separate phases; pending work coalesces into one next animation frame. Bounded rotating repulsion samples at most 24 peers per node instead of running an all-pairs loop. SVG paths and node elements are created once and retained, then only coordinates/classes are updated. The stage uses strict containment and one compositor transform for drag, preventing overlapping layout/paint pipelines and per-frame DOM reconstruction.

The accepted disposable-root stress created and archived 120 conversations in a zero-interval packaged Electron burst with no missing IDs, receipts, or pending operations; P95 interaction latency was `11.8 ms` for creation and `13.5 ms` for archive. Its 300-component × 600-query lane returned the relevant memory first in all 600 cases, produced no budget violations, achieved P50 `7.184 ms`, P95 `10.857 ms`, and maximum `14.827 ms`, and loaded the complete visualization snapshot once in `426.6 ms`. A 40-contender stale-write race accepted exactly one update and rejected 39; restart recovery passed; the unique `%TEMP%` root was deleted.

Windows MSI/portable and Linux AppImage/deb/portable packages passed version, CLI, GUI, terminal isolation, and exit-lifecycle smoke. The full Windows suite passed with 1365 core assertions plus all specialized gates; Memory Policy now has 22 focused assertions. Linux repeated the full source suite and reported hot first-event P95 `19.621 ms`. Production audit found zero vulnerabilities and lint found zero errors. Asset hashes and complete evidence are recorded in 本地归档（未纳入公开仓库）.

## dev-0.1.11 Observable Memory Policy (2026-07-28)

The current source and latest validated, locally installed Windows package are `dev-0.1.11`. The verified current-user installation is under `%LOCALAPPDATA%\Programs\Newmark Agent 0.1.11`; its `resources/app.asar` matches the release payload and its main window was responsive. The older machine-wide copy remains unchanged because administrator elevation was cancelled. This iteration applies the control-layer lessons from Bilibili `BV15L3F6pEFN`, “从零构建生产级 Agent Memory【第三集：记错了比忘了更危险】.” The source was checked against the official seven chapter markers and key frames, plus an approximate local transcription of the 298-second audio.

Memory Lab now exposes a full Policy action surface instead of only read/update/reindex. `memory_lab_query` performs deterministic name/tag/description/content scoring, caps each scanned component at 64,000 characters, enforces a 1,000–48,000-character output budget, limits results to 1–12 components, and stops when remaining scores fall below 35% of the strongest result. English-like terms and Chinese bigrams support bounded multilingual retrieval. Plan mode permits this read-only query while continuing to block mutation.

`memory_lab_update` records explicit ADD or UPDATE decisions, advances per-component revisions, checks an optional `expectedUpdatedAt` read token, archives the previous core Markdown before replacement, and records content hashes without copying memory content into the Policy log. `memory_lab_delete` requires the model-facing contract to be backed by an explicit user forget/remove request, rejects stale deletion, archives the final revision, removes the active component, deterministically rebuilds the tag DAG, and returns a verified completion receipt. `Memory Lab/policy.jsonl` is append-only and records action, target, reason, source, revision, timestamps, and archive location for replay. `Memory Lab/archive` retains recovery material.

`DESKTOP/src/tests/memoryPolicyVerify.ts` provides 18 focused assertions for ADD/UPDATE/DELETE ordering, revision history, stale update/delete rejection, bounded relevance ranking, unrelated-memory filtering, explanatory match fields, recovery archives, completion receipts, and Plan-mode policy enforcement. Detailed evidence is recorded in 本地归档（未纳入公开仓库）.

The packaged temporary-root stress gate then created and archived 120 conversations in one zero-interval burst with no lost IDs or IPC receipts; per-interaction P95 was `14.7 ms` for creation and `14.2 ms` for archive. The existing long-context stress completed 18 model-window switch cycles, 108 concurrent compression requests, 400 provider segments, and 57 injected failures with zero dropped messages. Memory Policy correctness passed with 300 components, bounded relevance remained correct, and a 40-contender stale-write race accepted exactly one update. Sustained retrieval remains a measured bottleneck: 600 consecutive queries over 300 components exceeded three minutes because each query synchronously rereads every component core file. Full measurements and cleanup evidence are in 本地归档（未纳入公开仓库）.

## dev-0.1.10 Low-Latency Parallel Conversation Lifecycle (2026-07-28)

The current source is `dev-0.1.10`; the latest packaged prerelease remains `dev-0.1.9`. `DESKTOP/src/ui/index.html` assigns collision-resistant IDs to rapid new conversations, paints the activation snapshot directly, and avoids the redundant `getState` call that could start a cold runtime. Archive clicks synchronously remove the exact selected row and dispatch independent IPC requests; no quiet window or batch-settlement barrier delays the interaction. Successful completions only schedule a coalesced background archive-list refresh, while `{ ok: false }` receipts and exceptions restore only their own row.

`DESKTOP/src/core/agent.ts` archives only the requested conversation ID; equal-content conversations remain independent. `electronUtilityRuntimePool.ts` and `wslAgentRuntimePool.ts` claim and mark an entry under the capacity lock, then perform the slow process shutdown outside that global lock, allowing unrelated conversations to stop concurrently. `conversationArchiveConcurrencyVerify.ts` reports 16 renderer assertions, including sub-30 ms local removal, one coalesced background replacement sync, and independent rollback; `runtimePoolCapacityVerify.ts` reports 20 assertions and directly proves two delayed shutdowns overlap. Detailed evidence is recorded in 本地归档（未纳入公开仓库）.

## dev-0.1.9 Windows and Linux Packaged Prerelease (2026-07-27)

The latest packaged prerelease is `dev-0.1.9`. Windows x64 MSI and portable ZIP, plus Linux x64 AppImage, deb, and portable ZIP, are built from the same validated source snapshot. Memory Lab uses a dedicated, viewport-bounded landscape `4:3` sub-window instead of inheriting the narrow generic dialog width; packaged UI validation measures this geometry directly. The full Windows suite passed with 1365 core assertions and all specialized gates; the isolated Ubuntu-24.04 build repeats the source suite and latency benchmark before packaging. Windows ZIP/MSI and Linux WSLg GUI, exit-lifecycle, AppImage, deb, and unpacked-ZIP smokes are release gates. Production dependency audit reports zero vulnerabilities, lint reports zero errors, and the final Linux hot first-event P95 is 15.547 ms.

The MSI upgraded the machine-wide installation at `C:\Program Files\Newmark Agent` to `0.1.9.0`. The installed `resources/app.asar` SHA-256 matches the release payload, a responsive main window was observed, and no file under `~/.Newmark` was modified during the installation interval. All generated automation/Bash test roots and the upstream inspection clone were deleted after validation under the user's explicit cleanup authorization. Asset hashes and the complete local release audit are recorded in 本地归档（未纳入公开仓库）.

When a conversation switches from a long-context model to a shorter target whose safe budget cannot hold the current history, model selection now immediately runs segmented compression before the conversation runtime is reset. Historical messages are split into target-sized consecutive segments, summarized serially by the selected short model, and the generated summaries are merged through repeated compression rounds until the prompt fits below 70% of the target window. The latest user turn remains verbatim. If pathological segment summaries still cannot converge, the runtime discards only the oldest retained turns/summaries until the target budget is safe instead of failing the next request.

## dev-0.1.9 Automation and Bash Temporary-Root Stress Gate (2026-07-27)

`DESKTOP/src/tests/automationBashStressVerify.ts` is a repeatable integration/stress gate that creates its entire runtime, workspaces, conversation state, Bash files, and report under a unique OS temporary directory. It drives `AutomationManager` through both simulated schedule advancement and its real `setInterval` timer, executes each trigger through `ConversationKernel.prompt()` and a real Agent work-run lifecycle, and audits workspace binding, `new`/`existing` conversation strategy, unique Build IDs, durable completed work runs, and non-reentrancy under overlapping ticks. Its context lane performs repeated long-to-short model switches across 64000, 8000, 4000, 2000, and 1200-token windows, injects summary failures, issues concurrent duplicate compression requests, and verifies bounded multi-round convergence, latest-turn retention, and persisted recovery. Its terminal lane concurrently exercises persistent `NativeBashSession` instances, parallel native one-shots, cancellation, Git host fallback, and Windows `node-pty`/ConPTY round trips.

The accepted run produced 34 schedules, 56 triggers, 56 unique and durable completed Build runs, 32 new conversations, 24 existing-conversation triggers, eight wall-clock timer triggers, and one start under 40 overlapping tick attempts. Bash acceptance covered 16 persistent sessions, 320 session commands, 64 parallel one-shots, 12 cooperative cancellations, one host fallback, and four real PTY sessions in 13.851 seconds. The evidence was audited and then its temporary root was deleted under the user's explicit cleanup authorization; detailed interpretation is in 本地归档（未纳入公开仓库）.

## dev-0.1.9 Native TypeScript Bash and Terminal Runtime (2026-07-27)

`DESKTOP/src/core/nativeBash.ts` is the shared workspace shell boundary. It embeds `just-bash` 3.2.0 through `ReadWriteFs`, blocks symlink traversal outside the selected workspace, limits source/output/runtime budgets, supports cooperative cancellation, retains per-tab virtual `cwd`, and uses the upstream AST command collector to choose the native interpreter only when every invoked command is supported. Agent one-shot Bash calls may fall back to the existing platform host shell for external programs such as Git/npm; the bottom-bar Bash tab stays pure native and reports unsupported commands instead of partially executing and replaying a script.

`DESKTOP/src/tools/index.ts`, `DESKTOP/src/main.ts`, and `DESKTOP/src/server.ts` route their Bash surfaces through that shared boundary. Non-Bash bottom tabs use the exported `spawnTakeoverPty` implementation from `DESKTOP/src/tools/terminalTakeover.ts`, replacing redirected `child_process` streams with real PTYs. `DESKTOP/src/ui/index.html` keeps the existing lightweight transcript but removes OSC/CSI control sequences and escapes ampersands before HTML insertion. `DESKTOP/src/tests/nativeBashVerify.ts` covers command planning, pipes, redirects, real workspace writes, persistent directory state, unsupported commands, and cancellation. The package is recorded in `THIRD_PARTY_NOTICES.md`; single-file WSL/Utility hosts load no just-bash bundle and retain host-shell fallback. Evidence is recorded in 本地归档（未纳入公开仓库）.

## dev-0.1.9 Memory Lab Tag Motion Damping (2026-07-27)

Source and packaged development is now `dev-0.1.9`. Memory Lab's overview force simulation now retains 72% of tag velocity per step instead of 86%, doubling the per-step damping from 14% to 28%. A structural graph signature reuses live node positions whenever index topology is unchanged, tag selection updates focus in place, and Reset updates the existing camera instead of rebuilding the panel. Wheel zoom uses a gentler pointer-anchored curve and renders an interaction-only frame immediately; pointer drag applies its compositor transform synchronously and no longer continues drifting at the viewport edge. Regression assertions cover damping, graph reuse, in-place selection, immediate interaction rendering, and removal of edge acceleration. Evidence is recorded in 本地归档（未纳入公开仓库）.

## dev-0.1.9 Workspace-bound Automation Builds (2026-07-27)

Every automation now persists an explicit workspace and a conversation strategy. `new` creates a fresh conversation for every trigger; `existing` requires and reuses one selected conversation. Desktop scheduling resolves the stored workspace, waits for an already-running target conversation to settle, and invokes `ConversationKernel.prompt()` in Build mode so each trigger owns a new Build run instead of mutating whichever conversation happens to be active. The form exposes workspace and conversation selectors, list rows show the target, Agent tool schemas require the target fields, and the Server fallback preserves the same target semantics. Evidence is recorded in 本地归档（未纳入公开仓库）.

## dev-0.1.8 Packaged Prerelease (2026-07-26)

The current source and packaged prerelease is `dev-0.1.8`. Windows x64 MSI/unpacked ZIP and Linux x64 AppImage/deb/unpacked ZIP were produced from the validated source. Windows and isolated Ubuntu-24.04 full suites passed; packaged CLI, Windows ZIP/MSI, Flow/SubAgent UI, Linux WSLg GUI, Bash/sh isolation, clean exit/single-instance relaunch, AppImage, deb extraction, and Linux ZIP smokes passed. The directly used runtime `glob` dependency was upgraded from unsupported v7 to v13 with `brace-expansion` 5.0.8, leaving the production dependency audit at zero vulnerabilities. Asset hashes and the complete release audit are recorded in 本地归档（未纳入公开仓库）.

## dev-0.1.8 Mode Execution Contracts (2026-07-26)

Source development is now `dev-0.1.8`. The renderer separates the user-selected mode from the mode used for one execution, so sending no longer rewrites Plan, Goal, or Flow to Build. Plan keeps the visible `Plan` label and selector and runs with proactive Build-style initiative under the existing read-only tool policy. Its prompt hard-requires an early `linked_plan get` and a revision-checked `linked_plan update`: the Linked Plan is a durable conversation-scoped, user-editable Markdown document, never a one-turn response summary. Only an actual revision change permits the execute-or-supplement handoff. Pending question cards are deduplicated by live DOM presence, restored after transcript redraws, and remain unanswered until a real user selection; the question receipt explicitly states that no choice has yet been made. General Settings question strength applies uniformly to Build, Plan, Goal, Flow, and SubAgent prompts and question-tool permission. A terminating question preserves its pre-question mode while pending and resumes only after a real user click. The Flow takeover bubble, Goal/Flow bars, option cards, and option buttons have explicit light-theme surfaces and contrast; the shared floating stack keeps scroll-to-bottom clear of those elements in both themes.

Goal Guide and Next declarations both update the conversation Goal bar. Goal uses the normal Build work surface and completion summary, while automatic hidden continuation consults the conversation kernel only after the preceding Build has completed and flushed persistence, then creates a distinct Build with a new run ID. It yields whenever Guide, Next, or root-agent queue work exists, judges only the active Goal bar objective without reviving or independently evaluating historical unfinished work, and records its synthetic instruction only as hidden history rather than visible chat or a Build primary prompt. The Goal bar controls are edit, pause/resume, then delete on the right; deletion immediately clears Goal state without interrupting the Build already running. Editing Goal from another mode temporarily selects Goal for the send and restores the prior mode afterward. Automatic continuation has no renderer-owned send promise, so terminal work events refresh the owning target snapshot; a completed Goal therefore clears the visible bar and restores Build as soon as its persisted completion lands. Newly added models default to a 128000-token context window.

Flow Next automatically acquires takeover and pauses the queue whether the queue was active, empty, or already paused; it records the original pause state, expands `{#prompt#}` through the selected workflow, and creates only the workflow-defined Build blocks. Idle Guide is treated as Next, including Flow Guide when no Build is active. The Next that launches Flow is not a queue item: its original text is held by a dedicated Flow-prompt bar in the Goal-bar layer for the lifetime of takeover. During takeover, later Next input remains in the paused queue; manually resuming the queue exits Flow and resumes normal Build queue processing. Normal Flow completion restores the exact pre-Flow pause state. A pointer-free Newmark glass takeover bubble is absolutely positioned above the input without changing input height, and the shared floating stack orders scroll-to-bottom above the bubble and persistent Todo/Queue/Flow-prompt/Goal bars with 8 px collision gaps. Flow exit hides the Flow-prompt bar and Flow configuration selector, then explicitly restores and enables Next. Local queue draining uses one per-target atomic claim: the head is removed before Build handoff, restored at its original position if the send is rejected, and cannot be consumed twice by overlapping completion/drain callbacks.

SubAgent queue recovery no longer pre-appends unread persisted mailbox content before the scheduler consumes it, preventing duplicate directives after restart. Accepted work stays `queued` when an executor has not yet bound and is pumped exactly once when it becomes available; this removes the previous fake-`working` dead state. Root and agent-only runtimes both bind the conversation executor, headless children use the parent's explicit root boundary, inherited duplicate-name models retain an exact provider deployment, fallback releases a stale forced provider, closing an active peer aborts it, failed child output becomes an error, and timed-out settlement waiters clean up their timers and registrations. `dev018ModeSubagentStressVerify.ts` exercises 64 restored peers, 48 late-bound peers, Build/Plan/Goal/Flow state, concurrent execution and isolated failures, queued close cancellation, and 256 ordered root-inbox messages. The real Electron smoke runs 40 complete mode-transition cycles and verifies Next restoration plus measured floating-stack geometry. Detailed evidence is in 本地归档（未纳入公开仓库）.

Memory Lab overview selection no longer calls `memoryLabRead` or reconstructs the panel when a component node is clicked. It updates the existing graph focus and camera in place, preserving ambient motion and DOM identity; Detail mode performs a preserve-panel content read. The renderer no longer exposes the Instructions/说明 disclosure that printed local Memory Lab root, index, and component paths. Source and packaged Memory Lab smokes assert stable stage identity, no loading reload, no path/instruction text, and normal Detail Markdown retrieval. Evidence is in 本地归档（未纳入公开仓库）.

## dev-0.1.8 Academic Scanned-PDF Fallback (2026-07-26)

`pdf_read` and Browser-Use share a strict recognition ladder: bounded embedded/DOM text first; a rendered screenshot to the selected validated vision model second; bundled local OCR only after vision is unavailable or has explicitly failed. The PDF path checks a bounded text layer before opening a selected scanned page through the existing Electron Browser guest. Visually sparse Browser observations capture a bounded JPEG so a vision model can identify unlabeled buttons; non-vision providers automatically receive the final local OCR fallback.

The offline implementation lazily loads Tesseract.js 6 with only the SIMD WebAssembly core selected by its Node worker and compact `best_int` Simplified-Chinese plus English language data. Packaging excludes full language packs, unused cores, maps, examples, browser-only compression/cache helpers, and rejects the complete OCR-specific payload when it exceeds 10 MiB. OCR evidence is deliberately marked approximate. Its attached Agent repair contract permits conservative contextual repair of Chinese/English substitutions, spacing, line breaks, mathematical operators, variables, superscripts, subscripts, and grouping, while forbidding invented unsupported text. Tests use a real mixed Chinese/English/formula raster, assert formula-token recall, enforce vision-before-OCR, and prove that readable PDF text bypasses both visual paths.

## dev-0.1.7 Runtime Queue Local Installation (2026-07-25)

The final Windows x64 MSI/portable ZIP and Linux AppImage/deb/unpacked ZIP include runtime-branch queue binding, Queue pause/resume, and automatic queue pause on explicit Stop/Force Stop. Full Windows and isolated WSL Linux source tests, latency benchmark, Windows package smokes, Linux WSLg GUI/package smokes, and packaged branch/UI smoke passed. The Windows MSI was installed with administrator elevation to `C:\Program Files\Newmark Agent`; executable version is `0.1.7.0`, and mutable state under `~/.Newmark` remains present. Detailed artifact hashes and installation evidence are in 本地归档（未纳入公开仓库）.

## dev-0.1.7 Branch Tree Stability Hardening (2026-07-25)

Conversation persistence now treats branching as a validated version 2 tree rather than a linear transcript with page metadata. Stable message/Guide/Build/node IDs, complete viewed paths, per-page anchors, and a full node index directory drive edits, rendering, runtime event routing, cold reload, archive, and restore. Guide edits clone their owning Build prefix to a new `runId`; read-only branch inspection persists the viewed path without switching the runtime branch.

The final gate includes a regression canary that fails against historical commit `b85b6d2`, a 76-node branch stress run with a 31-page sibling group and 45 nested levels, random inspection/reload/archive cycles, and cloned-Guide-Build completion persistence. Full source tests, packaged Electron branch UI smoke, Windows ZIP smoke, and MSI smoke pass. Final artifact hashes and detailed evidence are in 本地归档（未纳入公开仓库）.

## dev-0.1.7 Consumer Stability Follow-up (2026-07-25)

Windows launch failures were traced to a missing installed `resources/app.asar`, stale Start menu shortcuts that targeted removed temporary builds, and a config-refresh reload that retained the one-shot startup-prewarm query. The repaired desktop removes that query after promotion, bounds runtime cleanup during config reload, recovers a crashed renderer, and routes second-instance recovery through the existing window lifecycle. Running Build headers also expose a compact unique-file and line-change badge.

The rebuilt machine-wide package is installed at `C:\Program Files\Newmark Agent`. Five packaged cold-start/config-refresh cycles and five installed desktop-shortcut launches passed, with installed shortcut visibility in 0.997-1.605 seconds. The installed `app.asar` matches the packaged SHA-256 `D36089BE1323632B6AEE3DF6C9813BE2A39FBBDC7411DBA9E379E7559A35B2BE`. Full evidence is in 本地归档（未纳入公开仓库）.

## dev-0.1.7 Branch Pagination and UI Fix (2026-07-24)

Source version advanced to `dev-0.1.7`. Conversation branch navigation now uses compact inline arrow text with mouse and keyboard activation, and edited historical messages hide the original Build behind page navigation instead of appending it below the active branch. Submitting an edit stops only the targeted conversation/run, enters the new page, and runs the edited instruction. Guide rows expose Copy/Edit; Guide edits copy their owning Build only through the events before that Guide. Branch switching replaces cached WorkRuns, while persistence treats `branchReset` as replacement rather than merge. Guide/Next is a user-wide preference rather than a conversation-local value. Recently persisted running Builds are restored across conversation switches, queue and Goal rows are hidden while their content is edited in the main input, context-compression completion is represented inside the owning Build, and completed Builds plus inline file details use corrected disclosure defaults.

The final local Windows package passed a real packaged Electron geometry/interaction smoke plus MSI and ZIP smokes. Edited-file and terminal activity rows now use the same icon and text columns and the same UI font; the first attempted CSS correction had been overridden by a later general file-summary rule. The final MSI is installed machine-wide at `C:\Program Files\Newmark Agent`, and the temporary current-user installation has been removed. Final artifact hashes, root causes, and state-preservation evidence are recorded in 本地归档（未纳入公开仓库） and 本地归档（未纳入公开仓库）.

## dev-0.1.6 Local Windows Installation (2026-07-24)

The published Windows x64 MSI was installed machine-wide at `C:\Program Files\Newmark Agent` after administrator approval. Windows Installer returned status `0`, the registered and executable version is `0.1.6.0`, and the installed `resources/app.asar` SHA-256 exactly matches the validated unpacked release payload (`62E363A9C62673EE9C38474F53DF6F8E6278315820F04140BD8750C747C616DB`). The installed application starts with a responsive `Newmark Agent` main window while retaining the existing mutable state under `~/.Newmark`. Detailed installer output is stored in 本地归档（未纳入公开仓库）.

## dev-0.1.6 Release Candidate (2026-07-24)

The Windows x64 MSI and portable ZIP were rebuilt from the current source and passed the packaged MSI/ZIP smoke checks. The release assets are `release/Newmark-Agent-0.1.6-x64.msi` (SHA-256 `AC008F0BF351F25092CDD215950E3F2973C6396D745AA6DCD54FE3CC96DC8A26`) and `release/Newmark-Agent-0.1.6-win-unpacked-x64.zip` (SHA-256 `7F280D0ED600C79D673AD8B772A241CB80A8648E3224872829972AAE3F226990`). Commit `72501e8` was pushed from `master`, and the annotated `dev-0.1.6` tag plus GitHub prerelease is published at https://github.com/positer/Newmark-Agent/releases/tag/dev-0.1.6.

The Linux x64 AppImage, Debian package, and unpacked portable ZIP were subsequently built in an isolated Ubuntu 24.04 WSL filesystem. The full source suite and Linux latency benchmark passed before packaging. Each package then passed its Linux GUI smoke, including application startup, version identity, Bash/sh terminal round trips, process isolation, and clean termination. The release now also contains `Newmark-Agent-0.1.6-x86_64.AppImage` (SHA-256 `AC8A5E2033D66DCDA97F1949DF2AB6C2806E1FA6614883E0AC95CE1F6FDFEB6F`), `Newmark-Agent-0.1.6-amd64.deb` (SHA-256 `35FE64695906F95CA6CE86C933EF624477896DFA1BA6AFDF1FE09DBB8BFA6BA9`), and `Newmark-Agent-0.1.6-linux-unpacked-x64.zip` (SHA-256 `B7CA1150F995F0CF51E586857550893238EDD33BFA572BA35501C041D3CF54E1`).

## dev-0.1.6 Goal/Flow/Subagent and UI Performance Follow-up (2026-07-24)

Goal state is persisted per conversation, including unfinished/paused/verified status; the Goal bar appears only when a real objective is active. Queue rows are read-only until Edit returns text and image attachments to the input. Next Goal declarations are retained for the next Build, while Guide Goal declarations target the active Build. User-message edits create durable conversation branches with page navigation instead of destroying the original transcript.

Flow logic components now run through a read-only Build boundary (Plan tool policy) and accept only an explicit `FLOW_DECISION=true|false` result. Subagents preserve validated `build/plan/goal/flow` mode, Goal objective, Flow name, and Flow program counter across queueing, mailbox wakeups, and restart. Settings and Memory Lab initial rendering is deferred to later frames; hidden Memory Lab animation and timer work is skipped without stopping any backend process.

## dev-0.1.6 Default Expand Tools and Lazy Settings (2026-07-24)

The source version is now `0.1.6`. General Settings includes a new "Default expand tool usage" toggle. When enabled (default), tool calls in build blocks are expanded by default. When disabled, they start collapsed. Build blocks auto-expand while the agent works and auto-collapse when work completes — but after the user manually toggles a block, the run records a `userToggled` flag, and auto-management stops for that run. The `expand_tools` setting persists through the standard `agent:saveSetting` IPC and loads from `config.json` on startup.

Settings tabs (Models, Tools, Archive, Updates) now render lazily: only the active General tab renders on first open; other tabs render on first click. This cuts the initial settings-window paint time when providers or tools are large. Memory Lab panels also receive a brief fade-in animation to mask the loading-to-content transition. Evidence is pending the packaged acceptance smoke.

## dev-0.1.5 Machine-wide Windows Upgrade (2026-07-23)

The verified `0.1.5` MSI was accepted through UAC and upgraded the sole installation at `C:\Program Files\Newmark Agent`. The previously created current-user fallback directory remains absent, the installed `app.asar` matches the release payload, one responsive machine-install main window was launched, and mutable user state under `~/.Newmark` remains present. Exact verification evidence is recorded in 本地归档（未纳入公开仓库）.

The public `dev-0.1.5` candidate also pins the patched transitive build dependency `fast-uri` `3.1.4`, clearing the high-severity advisory reported against `3.1.3`. The complete Windows source suite, MSI/ZIP packaged smokes, and WSL Linux AppImage/deb/unpacked-ZIP GUI smokes pass against the final lock file. The five platform assets are published together so the release tag, package metadata, and downloadable binaries remain aligned.

## dev-0.1.5 Build Disclosure and Input Mode Persistence Repair (2026-07-23)

Build transcript content now shares one right-side safety lane: the top status/chevron, nested activity chevrons, and long wrapped responses all stop before the user-input timeline rail. Nested command/tool groups such as "Ran command" and "Ran multiple commands" start collapsed to keep long runs compact; if the user opens one, the existing activity-key restoration keeps it open through live refreshes.

Guide/Next changes now carry the explicit workspace/conversation target through preload and main-process IPC. The target conversation is persisted immediately and any already-resident Utility or WSL isolated runtime receives the same mode, preventing its later checkpoint from restoring a stale value during shutdown. Unit and runtime-isolation checks cover target routing, and the real Electron layout smoke now closes and relaunches against the same data root before accepting the persisted mode. Evidence is recorded in 本地归档（未纳入公开仓库）.

## dev-0.1.5 Select Popup Regression Repair (2026-07-23)

The initial generic select surface incorrectly allowed hidden-menu measurement and focus scrolling to disturb the input toolbar. The repaired implementation uses the model selector's actual `tool-select`, `model-select-button`, `model-select-menu`, group, and option classes. Model and ordinary selects share one fixed top-layer Popover positioner: it compares space above and below, limits only popup height, and never changes document-flow geometry. Compact wrappers reserve a stable readable width from their widest option, so toolbar labels and Chinese Flow selectors remain complete; repeated trigger clicks close both wrapper state and the actual top-layer Popover.

The terminal shell selector is explicitly enhanced through the same path and therefore uses the same rounded glass closed control and directional popup. Right-panel file-tree and Flow disclosure indicators consistently point right when collapsed and down when expanded. A real Electron regression records toolbar and trigger rectangles before and after opening, requires exact stability, checks fixed positioning/width/direction and repeated-click closure for generic, dynamic Chinese, and model menus, verifies terminal glass styling, and captures 本地归档（未纳入公开仓库）. Detailed evidence is in 本地归档（未纳入公开仓库）.

## dev-0.1.5 Windows Package and Local Installation (2026-07-23)

The verified Windows `0.1.5` MSI and portable ZIP were rebuilt from the current source, including the final readable-select, repeated-click Popover, and disclosure-indicator repair. Package resource/identity checks, CLI smoke, isolated ZIP smoke, and isolated MSI administrative-image smoke pass. Two earlier machine-wide UAC requests were cancelled and temporarily led to a current-user fallback installation; that fallback was later removed, and the accepted machine-wide upgrade now leaves the sole installation at `C:\Program Files\Newmark Agent`. Exact build and installation evidence is recorded under 本地归档（未纳入公开仓库）.

## dev-0.1.5 Cold Loading and Select Surface Follow-up (2026-07-23)

Workspace selection now restores the destination workspace's own persisted active conversation and returns its local snapshot in the selection response. The renderer paints that snapshot directly instead of waiting for a second activation/state waterfall. A cold conversation activation likewise returns persisted history without starting its isolated Utility or WSL runtime; runtime hydration continues through one deferred state refresh. Resident conversations still return one live snapshot and avoid a duplicate refresh.

All ordinary single-choice selects now share a renderer-owned Newmark listbox layer derived from the model selector: rounded opaque popup, grouped and disabled options, selected-row highlight, bounded scrolling, fixed positioning above clipped settings/dialog surfaces, keyboard navigation, accessible labels, dynamic-dialog enhancement, and native `change` compatibility. The underlying selects remain the state authority, so existing settings, GitHub, workspace, mode, Flow, and intelligence handlers keep their original contracts. `newmarkSelectVerify.ts` owns executable static/dynamic enhancement and native-change regression coverage; `workspaceMenuVerify.ts` also proves the cold workspace snapshot is forwarded directly into the renderer. Evidence is recorded in 本地归档（未纳入公开仓库）.

## dev-0.1.5 Build and Memory Lab Interaction Follow-up (2026-07-23)

The source version is now `0.1.5`. Build headers reserve right-side inset space so the status label and expansion chevron do not collide with the conversation's user-side timeline rail.

Memory Lab overview relationships are indexed once when the graph is built. Parent and child adjacency maps support cached focus projections without rescanning every edge on each ambient frame. While the user drags the overview, force simulation and normal node/link reconstruction are paused; the already-rendered SVG and node layer move together through one GPU-friendly `translate3d` transform at the display refresh rate. Pointer release commits the camera position through one full frame and resumes the normal throttled ambient layout. This keeps the graph visually attached to the pointer without changing node relationships during the open overview session. Verification evidence is recorded in 本地归档（未纳入公开仓库）.

## dev-0.1.4 UI and Runtime Follow-up (2026-07-22)

The latest maintenance follow-up makes title-bar minimize an ordinary operating-system taskbar minimize; only the configured close behavior may hide the application to the tray. Build tool groups now place each edited file directly at its chronological tool row, where the filename itself expands its red/green line diff, and exact Skill or MCP targets are named in the same Build activity stream. Subagent calls render as status-aware Build chips; clicking one refreshes the owning conversation snapshot and opens that peer's work history. Peer agents no longer inherit an independent hard-coded two-minute execution cutoff: they remain under the parent run's cooperative cancellation boundary.

Renderer surfaces now use theme-aware notice tokens in both dark and light modes, while the bottom model selector uses an accessible rounded Newmark listbox rather than the square native Windows popup. Memory Lab overview selection is toggleable, pointer-captured drags accumulate relative movement and continuously auto-pan while held at a canvas edge, manual camera movement suspends selected-node auto-centering, and a time-driven layout remains visibly active at a throttled 30 FPS instead of stopping after a fixed frame budget or converging to a static equilibrium. Dragging still ends through ordinary pointer lifecycle events and does not use Pointer Lock. Wheel zoom has no user-facing limit, and sufficiently distant nodes collapse into colored dots whose tag or component name appears in an immediate Newmark tooltip on hover or keyboard focus. The desktop Memory Lab update IPC now also preserves `tagPaths` instead of flattening hierarchy metadata. Verification and release evidence is recorded in 本地归档（未纳入公开仓库）.

## Current UI and Validation Maintenance (2026-07-22)

The global `Agent.md` editor now uses Newmark's semantic glass/control, border, radius, typography, placeholder, hover, and focus-glow tokens instead of Chromium's unstyled white textarea. The model-validation progress note is registered in English and Chinese. Validation is a single shared Agent task: repeated UI clicks reopen the progress surface and await the existing promise rather than starting duplicate provider probes. Force-stopped Build blocks retain user-controlled collapse state across runtime and snapshot terminal updates.

Model availability now treats persisted successful text evidence as authoritative over a transient `unavailable` aggregate, while authentication and explicit invalid-configuration failures remain blocking. Non-exact but non-empty nonce output is degraded compatibility evidence, not proof that the endpoint is unusable. This effective status is shared by fixed selection, default candidate selection, and Auto routing, repairing records such as DeepSeek v4 where `text_input/text_output=true` coexisted with an `unavailable` aggregate. Evidence is in 本地归档（未纳入公开仓库）.

## Current dev-0.1.4 Release (2026-07-21)

The `dev-0.1.4` maintenance slice adds user-facing global configuration and prompt editing. General settings now opens `~/.Newmark/config.json` through the OS default application and provides an adjacent refresh action that reparses the file, reapplies the active workspace overrides, stops idle isolated runtimes, and reloads the renderer. The Models & Providers page ends with a debounced live editor for `~/.Newmark/agent.md`; both global and workspace prompt saves invalidate the system-prompt cache immediately. Prompt construction normalizes BOM/line endings, trims empty layers, skips exact global/workspace/custom duplicates, and documents the authoritative order as intrinsic safety/runtime policy, user-global baseline, workspace-specific refinement, custom settings prompt, then the current user message.

The same slice fixes model-validation false negatives. A successful base text path now establishes model availability; unsupported optional streaming, strict-JSON, tool, vision, or image-output probes retain their per-capability failure evidence but degrade the model instead of marking it globally unavailable. Fresh legacy cache records that previously combined usable health/text evidence with an `invalid_config` or `unavailable` aggregate are repaired to `degraded` without duplicate provider traffic. The settings UI renders `verified` and `degraded` as usable, with degraded labeled as partially capability-limited.

Linux explicit exit is also hardened. Tray Exit and renderer-triggered exit share one shutdown path that first performs normal cleanup, then forces `app.exit(0)` after a bounded deadline if a worker, terminal, or Electron resource refuses to settle. A packaged WSLg lifecycle smoke verifies the first process exits, leaves no matching descendants, releases the single-instance lock, and allows an immediate same-root relaunch. The Linux build writes latency evidence to a version-specific archive path so a new release cannot overwrite historical benchmark records. Detailed evidence is in 本地归档（未纳入公开仓库）.

Final release acceptance passes the complete Windows and isolated Linux suites, Windows MSI/ZIP smokes, Linux unpacked/AppImage/deb/ZIP GUI smokes, model-settings packaged CRUD validation, zero-vulnerability npm audit, and current-user installation startup. The installed `app.asar` matches the packaged hash while `~/.Newmark/config.json` remains byte-identical. The administrator MSI transaction was cancelled, so the actual verified installation is the current-user payload and the old machine-wide `0.1.2` registration remains a display-only cleanup item.

Local startup was recovered on 2026-07-21 after the machine-wide installation became internally inconsistent: `C:\Program Files\Newmark Agent\Newmark Agent.exe` remained registered as `0.1.2.0`, but its required `resources/app.asar` was missing after two Windows Installer transactions for `0.1.3.0`. UAC elevation for a machine-wide repair was cancelled, so the verified `release/win-unpacked` tree was installed at `%LOCALAPPDATA%\Programs\Newmark Agent` without changing `~/.Newmark`. The restored executable reports `0.1.3.0`, its `app.asar` matches the release hash, and a responsive main window was verified. Detailed evidence is in 本地归档（未纳入公开仓库）.

The current worktree contains an in-progress maintenance slice and is not a release candidate. The renderer's Next-queue handoff now carries active-send, scheduled-drain, and in-flight-drain locks across runtime-key alias promotion; duplicate sends are rejected at the target lock, completion clears both provisional and canonical locks, and scheduled microtasks delete only the schedule they still own. `queueAttachmentIsolationVerify.ts` adds regression coverage for lock migration. These queue changes have been inspected but have not yet been verified by a successful focused test or complete suite in this slice.

The same worktree contains a broader model-validation experiment. It adds an early no-model/no-provider-probe return, a phased `modelValidationPipeline.ts`, provider HTTP health checks, cached validation reuse, hello/vision receipts, optional model-judgment and metadata phases, richer result fields, and renderer feedback/manual status controls. This pipeline remains provisional: it has not been accepted by typecheck or regression tests, and the newly added source contains encoding damage that must be corrected before integration can be considered complete. It must not be treated as shipped behavior.

Small renderer fixes in the current diff remove the dark left-edge shadow from the open right sidebar in light mode and refresh sibling Plugins/MCP/Skills/GitHub tabs in place instead of adding redundant parent-window stack entries. Their static assertions are present in `verify.ts`, but no current successful build or packaged visual verification has been recorded.

Detailed worktree inventory and verification boundaries are recorded in 本地归档（未纳入公开仓库）.

## dev-0.1.2 Kernel Study Status (2026-07-19)

Implementation follow-up completed on 2026-07-20. The source version is `0.1.2`, with the `dev-0.1.2` prerelease prepared from the verified cross-platform candidate. The study's remaining gaps are implemented as four additive, rollback-friendly boundaries: metrics-only request/cache diagnostics; measurable tool-provision schema cost and discovery coverage; deterministic compression-fidelity scoring; and unified Kernel/work-run trajectory audits. The published `dev-0.1.1` commit remains the behavioral baseline, including its recovery and 80/20 compression improvements.

`agentKernelDiagnostics.ts` owns the opt-in diagnostics contract. It fingerprints stable serialized request context, counts messages/tools, estimates their token footprint, normalizes cache usage from OpenAI Chat, OpenAI Responses and Anthropic, and emits no request content. `compressionFidelity.ts` scores required retention, forbidden stale-work leakage and compression ratio. `responseTrajectory.ts` audits tool launch/receipt completeness, mixed failures, one Kernel end, Guide settlement, one terminal work-run boundary and final-result uniqueness. `ToolProvisionSession.metrics()` quantifies full catalog, compact broker and active schema surfaces without changing policy or provider-visible tool semantics.

The new focused gate is `npm.cmd run test:dev012`. The complete source tree also includes the new diagnostics, compression-fidelity and response-trajectory tests in `npm.cmd test`. The final Windows verification also isolates advisory Computer Use UI/window probes from explicit action lanes, prevents timeout replay and stale-worker rejection races, and expands the latency gate to 20 desktop plus 20 application samples with P95, hard-maximum and event-loop-gap limits.

The request-scoped task focus now includes an authoritative conversation Build ledger derived from persisted `ConversationWorkRun` records. It lists historical Build Blocks newest-to-oldest while exposing only `{ user input, final summary, completion status }`; a separate non-completed queue defines the only candidates for explicit continuation in newest-to-oldest order. Concrete public activities, Guide records, timestamps and run identity are withheld from the default prompt and loaded on demand through the read-only `build_history_query` tool. Status/history questions are read-only, unqualified previous/last-task references resolve historical Build number one, and old user prompts remain untrusted data rather than promoted instructions. This prevents an older unrelated interrupted task from replacing the most recent completed task when the user asks whether the previous task finished. Evidence is recorded in 本地归档（未纳入公开仓库）.

The same request boundary now uses a mixed `Build Context Bootstrap`: it appears only on the first provider request of a new Build and the first provider request after compression. It supplies the current or compacted context boundary, the latest 10 Build summary triples, explicit unfinished state, every callable tool's brief capability, and the names of necessary full schemas already present in the provider-native tools field. Full schemas are not copied into system text, subsequent broker/tool turns retain only the lightweight request focus, the removed pre-compression transcript is never reintroduced, and bootstrap metadata is excluded from persisted history and later compression input.

Local release acceptance completed on 2026-07-20. `release/Newmark-Agent-0.1.2-x64.msi` and `release/Newmark-Agent-0.1.2-win-unpacked-x64.zip` were rebuilt from the final kernel, passed packaged CLI/MSI/UI Agent/startup/Computer Use checks, and the MSI upgraded the per-machine installation after UAC elevation. The installed executable is `C:\Program Files\Newmark Agent\Newmark Agent.exe`, reports `0.1.2.0`, and exposes a responsive `Newmark Agent` window. The visual-tool transport now converts ephemeral captures into standard Kernel image content, projects OpenAI-compatible tool output as legal text plus an adjacent visual observation, deletes the temporary capture once, and never writes it into durable conversation history. Installation did not add or delete files under `~/.Newmark`; the observed byte delta is exactly the existing `startup.log` appended by packaged UI validation. Publication remains intentionally pending.

The 2026-07-20 conversation-display follow-up fixes the user-visible case where persisted Build blocks remained but their user inputs and final answers disappeared after switching conversations. `renderChatMessages` no longer consumes work runs by assistant-message position: normalized runs retain `primaryPrompt`, every persisted user/final row binds by exact `runId`, and missing legacy rows recover from the Build snapshot. Background send completion and refresh callbacks merge conversation metadata while preserving the actual foreground conversation, and a stale `newConversation` completion cannot clear a newer selection. `guideUiReconcileVerify.ts` covers two consecutive completed Builds, Guide interleaving, unique final answers, and snapshot-only recovery. The packaged fast-switch smoke now uses stable workspace IDs, an isolated Electron profile, explicit multi-instance mode, current-workspace conversation indices, and DOM ownership assertions for user -> Build -> final ordering across out-of-order responses, rapid switching, and restart. Current final artifacts are MSI SHA-256 `28FA8EF4FD7C2DC58946C976CA8E3132A02997DA9493123FB85465CCDE76B3A0` and ZIP SHA-256 `CB922DE39E7FC560E0682587A3EC9BB5D7473BED520C4B5104A73D88FBD0162E`; detailed conversation evidence is in 本地归档（未纳入公开仓库）.

The same maintenance line now includes live MCP management and non-blocking GitHub repository status. `mcpManager.ts` owns atomic user-root persistence at `MCP.json`, validates stdio/HTTP registrations, and redacts environment/header values from all list responses while retaining their key names. The Plugins secondary window defaults to MCP Management, ordered before Skills Management, and also exposes read-only MCP metadata discovered from Codex, Claude Code, Newmark and OpenCode plugin manifests. GitHub overview replaces `spawnSync('gh')` with bounded asynchronous child processes: account and repository/current-context discovery run concurrently, followed by parallel repository detail, Issue and PR requests. The repository detail includes `viewerHasStarred`, `stargazerCount`, `forkCount`, `isFork`, `parent`, `viewerPermission` and `viewerSubscription`. Final real packaged acceptance observed 324 renderer timer ticks during an 8.143-second GitHub refresh, then verified the Star/Fork badges and MCP CRUD/secret-redaction paths. Evidence is in 本地归档（未纳入公开仓库）.

The final GitHub/MCP candidate was installed locally on 2026-07-20. The elevated MSI completed with exit code `0`; installed `app.asar` matches the validated package hash `554EDEF834F6B0F169EB0454F8D983B74F5D3A4A0AA59ED7CF1301A14BA4058F`. The `~/.Newmark` baseline remained exactly 17,593 files and 261,930,502 bytes. The Program Files `0.1.2.0` window recovered from an observed startup initialization transient and finished `Responding=true`; detailed installation evidence is in 本地归档（未纳入公开仓库）.

The completed-conversation durability follow-up closes a cross-runtime persistence race that could retain a completed Build while erasing its `chatMessages` and `history`. `agent.ts` now makes terminal writes supersede scheduled snapshots, resolves duplicate run records by sequence and terminal-state rank, and rejects an empty incoming transcript when a non-empty transcript is already durable. `conversationKernel.ts` binds cold target conversations with `setConversationFromStorage` and then explicitly ensures only the target entry, preventing transitional state from being saved over a sibling conversation. `guideWorkRunVerify.ts` covers both deferred same-runtime writes and a later cross-runtime empty write; `release-ui-fast-conversation-switch-smoke.cjs` verifies A and B directly in `state.json`, rapid/out-of-order switching, archive, and restart. The final MSI/ZIP hashes are `38E30C6EBD6232578E53051D1D5392300B2BD676A0316426C76DE6E37B0A73BA` and `DDCB80097C1C588751E8984B1C5DDAC45016A4A7F2728503096F405AE28052F3`. UAC was cancelled twice during the final same-version per-machine reinstall, so the validated build is currently running from `%LOCALAPPDATA%\Programs\Newmark Agent` with matching `app.asar` hash `DF68D82337C8D1A9B97C5382CF61AA106FABDCD95AC6319BED1248178309AF39`; the older Program Files copy remains installed. Detailed evidence is in 本地归档（未纳入公开仓库）.

The later new-conversation display investigation found a separate root cause: `ensureConversation` durably created the empty record but intentionally did not change the state file's top-level `activeConversationId`, while the renderer treated its local selection as complete. Restart therefore reopened the previous conversation. The final boundary adds target-scoped `agent:activateConversation`; `persistActiveConversationSelection` updates only the explicit foreground selection under the existing state lock, and `window.newConversation()` now returns and awaits that activation before loading/rendering. Read-only snapshots, background completions, and startup prewarm remain unable to change foreground selection. Source regression passed 1211 assertions, packaged fast-switch/restart passed, and the installed Program Files build passed a real external-workspace empty-conversation forced-restart check with cleanup and original-active restoration. Evidence is in 本地归档（未纳入公开仓库）.

The screenshot-driven immediate-send investigation found one final renderer race: while the explicit activation write was pending, an older backend list response could omit the just-created row, replace the local list, and make an immediate send target the previous conversation. The observed `回复我一个1` prompt and its 401 Build were therefore durable, but under `conv-1784347720191` instead of the visually new chat. `applyBackendConversations` now retains a held foreground row missing from a stale response; `newConversation` installs the new backend target and a 30-second activation hold synchronously, and reports activation failure without silently reverting. The packaged regression delays activation by 900 ms, sends immediately into a deterministic 401, verifies disk ownership, switches away and back, and restarts. Typecheck, build, lint (0 errors), 1212 source assertions, and the packaged smoke pass. Final package hashes are `C9B45F981DF762430FB0AC5E1D5EABEA6F12592A71406EB0D33640A67A66BE81` for `app.asar` and `74F8A7D6EA04B880F1E920F56060FE98747FD7FC12CE02F29BB532C8676967C6` for MSI. UAC cancellation left Program Files on the prior package; no publication action resumed. Evidence is in 本地归档（未纳入公开仓库）.

The 2026-07-21 compression screenshot exposed a presentation defect rather than new provider failures: two distinct failed runs from `2026-07-20 23:58:27` and `23:58:50` were restored with the renderer's current `00:30:48` clock, making them look newly replayed after compression. `addMsg` now accepts persisted timestamps, ordinary chat restoration forwards each message timestamp, and synthetic Build-boundary recovery uses `startedAt` or the final-event timestamp plus a historical-record marker. The installed Program Files DOM was inspected through CDP and shows the two original times exactly; the later `00:29` and `00:33` runs remain successful. Typecheck, build, focused reconciliation, and 1213 source assertions pass. Installed `app.asar` is `63BC458AF7CE9986795B342323E70D49DB2F1F6A57D9B014536BCD063D1FB1E4`. Evidence is in 本地归档（未纳入公开仓库）.

The subsequent completed-reply disappearance report found that the final response remained durable and present in `api.getState`, but terminal redraw appended every orphaned historical Build after the entire chat transcript. Old 401 runs therefore became the visual bottom of the conversation, while the newest final response was left above them and appeared to vanish. `renderChatMessages` now indexes persisted run order and restores orphan runs immediately before the next run that owns a persisted message. Focused reconciliation and 1214 source assertions pass; the rebuilt unpacked UI was opened on the real conversation and its final DOM rows end with the newest user input, completed Build, and final response. The diagnostic run was removed afterward. The latest MSI is SHA-256 `FFE6C8528CC1198F989858D88750493C64AE6174835448EF3B2E20C1ACB3986C`, but UAC cancellation prevented Program Files replacement. Evidence is in 本地归档（未纳入公开仓库）.

Final release acceptance installed the same candidate into Program Files and confirmed installed/package `app.asar` SHA-256 `081882BBB302195C49CAC4BD5CA7ED86E7E7623D365863EBF7BECC59B93E63C4`. Windows MSI and unpacked-ZIP smokes pass; Linux AppImage, deb, and unpacked-ZIP GUI smokes pass inside Ubuntu 24.04; the Linux isolated build also reran the complete test suite and 20-run Agent latency benchmark. The five release assets and digests are recorded in 本地归档（未纳入公开仓库）.

The first `dev-0.1.2` slice is complete as a source and experiment audit; it intentionally makes no Agent-kernel or public-interface change. The full `bojieli/ai-agent-book` repository is cloned as an independent ignored repository at `_ref/ai-agent-book`, detached at `fb2afa9f9473ecadf59522adb38def72c0124fe3`, with `git fsck` passing, tracked status empty, and `_ref/` confirmed against `.gitignore:6`. The Apache-2.0 source remains local reference material and is excluded from Newmark tracking and packaging.

Reference-tree responsibilities:

```text
_ref/
└── ai-agent-book/                  # ignored, independent upstream study repository
    ├── book/                       # Chinese source chapters 1-10 and compiled book assets
    ├── chapter1/                   # Agent/context foundations and ReAct experiments
    ├── chapter2/                   # context, KV cache, Skills and compression experiments
    ├── chapter3/                   # memory, RAG and structured knowledge experiments
    ├── chapter4/                   # tools, active selection and asynchronous runtime experiments
    ├── chapter5/                   # production-style Coding Agent and code-as-tool experiments
    ├── chapter6/                   # Agent evaluation guides and benchmark integrations
    ├── chapter7/                   # post-training and tool-learning reproduction guides
    ├── chapter8/                   # experience learning, discovery and self-evolving tools
    ├── chapter9/                   # speech, Computer Use and embodied interaction
    └── chapter10/                  # staged roles, handoff and multi-Agent coordination
```

The focused comparison covers Chapters 1, 2, 4, 5, 8 and 10. Newmark already has stable system-prompt caching, a request-scoped current-instruction contract, atomic compression replacement with same-run continuation, progressive tool-schema provisioning, parallel tool batches with an all-receipts barrier, durable Guide/Next ownership, and a stronger completion boundary than the upstream teaching loops. The actionable gaps are measurement gaps: provider cache/prefix observability, a scored compression-retention fixture, a combined tool-provision token/success workload, and one consolidated response trajectory for interruption, queue recovery, receipt completeness and final-answer uniqueness.

Offline upstream experiments were reproduced locally. Four simulated independent tools measured `4.53 s` serial versus `1.52 s` parallel (`2.98x`); interruption cancelled three partial tasks and the same runtime completed a replacement task; checkpoint restore retained three trajectory events and two task progress values. With 126 tools across eight scripted tasks, active discovery injected `7,796` total tokens and completed `8/8`, compared with `93,040` and `8/8` for full injection; one-shot prefiltering injected `8,236` but completed only `4/8`. These are mechanism results from an offline mock, not production-model quality claims. Windows execution requires `PYTHONUTF8=1` because the upstream demo prints characters unsupported by the default GBK console.

The complete source map, gap matrix, commands, limitations and next-candidate acceptance gates are recorded in 本地归档（未纳入公开仓库）. No version bump, tag or release publication is part of this slice.

Verification is complete: `typecheck` passed; lint passed with zero errors and 31 existing warnings; the focused normal-chat, 59/59 tool-provision, Guide/work-run and runtime-isolation baselines passed; `npm.cmd test` passed its main assertions and every chained suite; and `npm.cmd run test:dev010` passed. The only repeated build warning is the existing jsdom `xhr-sync-worker.js` externalization notice.

## dev-0.1.1 Maintenance Status (2026-07-19)

The `dev-0.1.1` source maintenance slice is implemented and verified. The preceding public `dev-0.1.0` upload is complete. The final Windows MSI/ZIP release build is installed under `C:\Program Files\Newmark Agent` for user acceptance; remote prerelease publication remains intentionally paused.

Implemented boundaries:

- Build transcript final replies persist `runId`, deduplicate by run/event identity, and render immediately after the owning Build block.
- Every normally completed Build run persists exactly one final result; failed and interrupted runs do not synthesize a completion summary.
- Skills expose bounded metadata first and load exact bodies through a read-only `skill` query/name tool; frontmatter cache fingerprints include SHA-256 content digests.
- Archive IPC peeks without allocating a cold runtime, stops resident writers before deletion, returns structured receipts, and lets the host Agent own current-workspace deletion so stale writer caches cannot resurrect a conversation.
- Memory Lab index v2 stores independent tag names plus separate multi-parent paths, migrates legacy `#A/B/C` and direction-word paths deterministically, preserves hyphens inside tag names, and rejects or warns on cycles.
- Reindex applies slash migration to legacy tag keys, aliases, component `tags`, and each node inside `tagPaths`, then verifies that the rebuilt tag graph and component metadata contain no slash-bearing tag result.
- High-confidence multilingual tag synonyms share one node and remain as aliases; reindex selects the primary name from the current user language and changes it when the language setting changes.
- The Memory Lab animated gradient border is state-bound to an active reindex request, disables duplicate rebuild clicks, exposes `aria-busy`, and clears in the Promise `finally` path; ordinary loading and idle graph display have no activity border.
- Provider cards use semantic Lucide icon buttons with localized labels, confirmation for permanent delete, and temporary enable/disable state; disabled providers are excluded from model selection and routing candidates.
- Conversation model selection persists Auto intent or a qualified provider/model deployment, temporarily falls back when unavailable, and restores the original preference after re-enabling the provider.
- Guide/Next input mode persists independently for every conversation and is restored on conversation switch, runtime recreation, and application restart.
- Context compression remains inside the owning Build as a completed activity. Compression-side Kernel cancellation resumes the same `runId` using the compression summary, Build primary prompt, latest Guide, and current activity snapshot, then completes the normal final-result boundary.
- Compression context transforms return separate request and durable message sets. The native loop atomically replaces its live context and Kernel state with the durable compacted set, while the detailed continuation prompt appears only in the immediate post-compression provider request; consecutive tool subturns therefore cannot recompress the same pre-compression history.
- Startup loading migrates orphaned persisted `running` work runs to `interrupted` with a frozen persisted end boundary, while ordinary in-memory conversation switching leaves live runs untouched. Compression also records its compacted baseline and suppresses same-context retries until meaningful growth; continuation prompts and compression summaries order applicable unfinished tasks newest-to-oldest.
- The active compression budget is model-token-only: `80%` of the current deployment `max_tokens` triggers compaction and the target is `20%`; the former fixed character threshold is retained only as a migrated setting and cannot trigger early compression.
- Model validation inspects the selected model's raw provider catalog response for explicit context-window fields such as `context_window`, `context_length`, `max_context_tokens`, and `input_token_limit`. Valid response values replace the deployment `max_tokens`; output-only limits remain ignored.
- Guide presentation uses the persisted work-event sequence as its only ordering source. Every Guide is a right-aligned user message; collapsed Builds list Guides after the primary submission, and expanded Builds place each Guide between the exact Build phases it separated.
- Provider tool-call batches execute concurrently. A batch-level `Promise.all` barrier waits for every success or failure receipt before the next provider step, while preserving each failed call as an ordinary tool failure receipt instead of rejecting the whole batch.
- `terminal_takeover.start`, `computer_use.takeover_start`, and successful Browser-Use actions publish launch receipts that allow the Build to continue immediately; persistent session/window/overlay closure is a later lifecycle action and never gates the current Build step.

Verification completed on Windows:

- `npm.cmd test`: passed, including the full runtime, UI, archive, model-routing, tool provisioning, and computer-use suite.
- Main feature verification: `1204/1204` assertions passed.
- Electron/CDP host gate: `BROWSER_USE_ELECTRON_HOST_OK assertions=61`.
- Installed Memory Lab CDP state gate: `idle=true`, `running=true`, `complete=true`; installed and unpacked executables match.
- GitHub repository About now includes a concise product description, the Releases homepage, and ten capability topics. No `dev-0.1.1` release asset was uploaded during this step.
- Official boundary review: OpenAI Codex Skills documentation confirms bounded initial metadata and progressive disclosure; OpenCode documentation confirms on-demand loading through a native skill tool.

Final cross-platform release validation completed on 2026-07-20. Windows MSI/ZIP passed resource verification and all release CLI smoke checks. WSL Linux passed its complete suite, the 20-run latency benchmark, AppImage/deb/unpacked ZIP packaging, and real GUI Bash/sh round-trip smoke. The `dev-0.1.1` tag and prerelease are ready for publication with all five assets.

## Current dev-0.1.0 Release Line

The working release line is `dev-0.1.0`. The agent request path now emits opt-in segmented latency diagnostics, coalesces high-frequency conversation persistence behind an in-memory cache and single writer, and caches stable prompt/tool definitions with precise invalidation. Windows-to-WSL launches copy the host bundle by content hash into the Linux cache and reuse single-flight runtime startup promises; the UI becomes interactive before WSL detection, update checks, or prewarming finish. A 20-run local streaming benchmark is archived at 本地归档（未纳入公开仓库） and currently passes the hot first-event, hot first-token, and cold local-overhead gates.

The current Agent harness adds a request-scoped focus contract on every provider and tool subturn. The latest real user-role message remains the authoritative current instruction without being copied into the system role; explicit active Goal and unfinished plan counts are continuity anchors only when the current instruction continues or depends on earlier work. Historical compression no longer pins the conversation's first user task forever. It summarizes the entire old prefix, keeps a complete recent user turn, and requires the compression model to separate active/unfinished work from completed, superseded, abandoned, or unrelated background. Immediately after replacement it adds exactly one generic continuation anchor that tells the next provider turn to continue the latest retained user-role task; the anchor does not duplicate or elevate user-authored text. The local fallback uses the same state headings. This design follows the public Codex boundary that reinjects canonical current context around compaction, OpenCode's structured Goal/Instructions/Discoveries/Accomplished compaction record plus explicit continuation marker, and Claude Code's documented separation of persistent project instructions from selectively loaded task context; Claude Code's private core harness is not treated as public source. The Windows-to-WSL Linux packaging path runs the complete source suite and 20-run latency benchmark inside the isolated Linux filesystem before electron-builder is allowed to create assets, and copies the benchmark evidence back to the repository archive.

Renderer work also includes terminal-event-driven automatic Next queue draining with target isolation and deduplication. Idle Next submissions now enter Build immediately, while active-run queue promotion uses a microtask after the terminal event instead of fixed 250 ms and 80 ms timers. Workspace and conversation pin controls occupy the rightmost action slot. The GitHub CLI panel queries the authenticated account, account-owned repositories, issues, and pull requests as structured data and renders cards/lists instead of raw command output. Language-aware fenced Markdown code highlighting preserves inline code behavior, and transparent light-mode modal glass uses an explicit luminous shadow/border treatment. The complete release asset set is Windows MSI/ZIP plus Linux AppImage/deb/unpacked ZIP; hashes are filled after the GitHub download audit.

Memory Lab update/reindex is a hard Agent completion boundary. The update path organizes the component with the current model, writes it, performs deterministic index rebuild, reads the index back, verifies the component core file, and returns a structured `rebuildReceipt` to the provider tool-result turn. The outer Agent process refuses to publish `done` while a Memory Lab rebuild is pending or failed, so a later model completion sentence cannot conceal a missing receipt. Explicit Memory Lab intent receives schema-preload priority over generic words such as `update`. The renderer groups the successful tool receipt inside its owning Build block as `更新了记忆` / `Updated memory` and does not create a separate completion row.

Next queue handoff uses a target-scoped send-finalization lock and an explicit synchronous start acknowledgement. Completion events may request an immediate drain, but the queued record stays durable until the next Build has actually claimed the same workspace/conversation runtime; a racing backend snapshot therefore delays the handoff instead of consuming or duplicating it.

WSL Agent launch forwards explicit proxy environment variables into the isolated Linux host while leaving distro networking untouched. Windows utility cleanup validates both creation and exit FILETIME values, so an exited-but-not-yet-reaped process remains only a parent witness and is never emitted as a live process-tree row.

New conversation archives also write a private structured restore manifest beside the readable Markdown export. Workspace and global archive views expose Restore only when this manifest is present. Restore is bound to the original workspace and conversation ID, refuses to overwrite an existing conversation, reloads structured history/plans/work runs/attachments, and consumes the manifest after success while retaining the Markdown record. Older Markdown-only archives remain readable but are not presented as fully restorable.

Editor Copilot prediction uses a 180 ms idle trigger, bounded cursor-local context, a 192-token completion budget, and per-renderer cancellation of superseded requests. A configured GitHub Models/Copilot deployment is preferred for prediction, with the selected conversation model retained as fallback. The collapsed workspace rail explicitly releases the hidden pin control's auto margin so workspace thumbnails remain centered.

## Project Goal

Newmark Agent is a local-first desktop coding-agent environment. The project combines an Electron desktop UI, a shared TypeScript Agent/CLI core, portable workspace state, Flow workflows, skills, archiving, automation, and model/provider configuration. The practical goal is a self-contained agent app that can be carried offline, recover its required companion files on startup, and expose real user-facing controls for workspaces, modes, prompts, tools, skills, Flow, subagents, archives, and automation without maintaining a second legacy runtime.

## Current Validation Status

Current dev-0.0.11 source implementation reduces model-context overhead without hiding capability boundaries. Every turn receives a compact catalog describing every callable tool, while only a bounded set of task-relevant schemas is initially attached. The model can request exact additional schemas through the local `tool_provision` broker; grants remain subject to the same mode, platform, Native Tools, workspace, Utility/WSL/Electron host, and side-effect policies. Broker traffic is not persisted as conversation content, provider fallback rebuilds the model-specific catalog, and regression coverage proves all 57 callable tool schemas can reach a provider subturn without eagerly attaching the full registry. Ordinary chat now resolves an empty default model before the first request, preserves meaningful provider errors without persisting an empty assistant turn, and refreshes context plus capabilities after fallback. Conversation rewind is bound to the exact persisted user-message identity across direct, Utility, and WSL runtimes instead of relying on an assistant-side or stale index.

The 0.0.11 renderer exposes a visible localized **Guide** action on each editable renderer-owned queue row. Active-run delivery preserves the original composite target, structured images, and unrelated prompt draft. Explicitly rejected receipts restore the item with a fresh `clientMessageId` so a cached rejection cannot replay forever; transport failures or missing receipts restore it with the same idempotency key so a lost acknowledgement cannot duplicate delivery. A run that settles between click and IPC restores the item instead of starting an unintended replacement turn. Backend queue snapshots remain read-only mirrors until an atomic promotion API exists. Settings actions, focus rings, disabled states, hover states, and the terminal timeout number stepper now use separate semantic dark/light tokens and native `color-scheme` integration. The single opacity control still owns complementary transparency and glass width.

Workspace and conversation selection now refresh from persisted storage at the ownership boundary, preventing an older in-memory snapshot from overwriting the newly selected built-in workspace or conversation. The native editor participates in the same theme switch as the rest of the renderer: background, gutter, code text, syntax classes, caret, selection, inline prediction, and completion surfaces use separate dark/light semantic tokens. Packaged CDP validation measures readable contrast in both themes and confirms the editor retains stable geometry while switching.

Current dev-0.0.10 source implementation: Auto is a persistent `ModelSelection` intent, while each user turn records one resolved `DeploymentRef { providerId, modelId, logicalModelGroupId? }`. The deterministic local router constructs global or provider-scoped candidate pools, applies subset/preview/context/modality/tool/JSON/privacy/budget/region/protocol hard constraints, then applies explicit Quality/Balanced/Cost/Speed quality-loss bands before cost, latency, reliability, cache-affinity, and bounded learned-preference scoring. Equal model names at different providers remain distinct; every attempt resolves its URL, credential, protocol, and adapter from the selected deployment. Five-minute affinity, endpoint health/circuits, retry classification, and an at-most-three-attempt scope-safe fallback chain produce a redacted `RouteDecision` with policy version, catalog hash, exclusions, ranking components, and attempt status but no prompt, key, tool arguments, or file content.

The dev-0.0.9 composite runtime remains the execution substrate: runtime identity is a normalized `ConversationTarget { workspaceId, conversationId }` with deterministic `workspaceKey` and `runtimeKey`. Windows native execution uses one Electron `utilityProcess` per active target, and WSL execution uses one target-owned WSL Node process group; each pool preserves background work across workspace switches and can cooperatively stop or force-restart only the selected runtime. dev-0.0.10 adds a shared two-active-runtime LRU capacity policy with five-minute idle retirement; a busy target is never evicted to admit a third runtime.

Current 2026-07-15 follow-up: the renderer's repeated-current-workspace branch remains a backend no-op but now explicitly reopens the left conversation-management pane, so clicking the workspace that owns Focus does not strand the secondary menu closed or change the active conversation. User-submitted PNG/JPEG images are durable `ConversationImageAttachment` records backed by SHA-256 content-addressed assets under `conversation-media/user-images/`; bounded validation, PNG IHDR preflight before bitmap allocation, restart hydration, stable attachment IDs, Guide/queue/edit reconciliation, and archive-side copies keep intentional user media revisitable. Image-only Guide receipts/continuations carry the same durable attachment identity through checkpoint and cold reload, apply once to chat/history/work-run state, and are consumed before another reload can replay them. Renderer-owned Next requests keep their structured images plus composite target until a delayed drain revalidates target and idle state; **Guide now** performs one immediate target-bound Guide delivery and leaves unrelated draft text/images intact. Backend queue snapshots are maintained separately per `runtimeKey` as occurrence-preserving, read-only mirrors; they cannot be edited, deleted, dragged, converted to Guide, or drained into a duplicate turn, and an empty owner snapshot removes only that owner's mirror rows. Persisted work-run targets and runtime keys cannot establish aliases: the renderer trusts only the outer snapshot/event identity, while kernel `snapshot`, `runtimeState`, and result boundaries clone and rebind every public run/event/Guide to their normalized target. Computer Use visual frames have the opposite lifecycle: `observe`/`app_observe` accept bounded aspect-preserving capture sizes, only trusted vision runtime context can retain a frame long enough to prepare current-turn model input, and direct/utility/WSL paths delete or discard it without adding paths or data URLs to visible tool output, chat, snapshots, work runs, or archives. Direct in-memory tool images are removed after the first provider serialization so subsequent tool rounds cannot replay them; durable user-role images remain reusable. Optional application background and UI-font preferences are validated centrally, stored as user-level `ui.background_color` / `ui.font_family`, applied through semantic renderer tokens, and leave code/terminal typography monospaced.

Conversation state is v3 and atomically replaced under a workspace lock. It retains revisioned Linked Plan state, durable flat Subagent coordination, Guide accepted/applied/deferred/rejected lifecycle, continuation records, and `ConversationWorkRun` entries containing ordered public work events. Filtered streamed natural-language `text` may enter that public record; tool events retain only display name and running/completed status. Hidden reasoning/thinking and tool arguments, call IDs, commands, paths, or results are rejected before IPC, snapshots, or state persistence. Running work stays expanded; completed work defaults to an elapsed-time fold and retains the user's later expand/collapse choice. ToolPolicy still classifies required, mode-scoped, and configurable tools, and host-side Browser-Use routing now rechecks Plan mode instead of trusting a worker-provided schema path. The retired C# CLI remains removed; the TypeScript Electron/CLI/utility/WSL source is the only maintained implementation.

Current dev-0.0.10 validation and CLI contract: the shared Validation Service publishes `discovered/basic/standard/extended`, six operational statuses, seven-day capability evidence, two stable samples with a third only on a split, a hard concurrency limit of two, deterministic strict-JSON/tool/tool-result/vision probes, and byte/MIME/dimension image-output checks. Catalog/docs evidence is hypothesis-only; Auto requires fresh Standard or Extended evidence. Every ToolExecutor call parses a JSON object and checks the host-visible tool's recursively closed JSON Schema before policy, workspace checks, or dispatch. `--mode` applies to tools and sends; pure CLI hides Electron Browser and Linux/WSL hides Windows ComputerUse. Electron utility and WSL bridge layers repeat policy/Native Tools checks before native effects. CLI output is `{ ok, tool, result?, error?, route? }` with exit `0` success, `2` argument/schema/unknown tool, `3` policy or unavailable capability, `4` execution/semantic failure, and `130` abort. A fixed 1280 x 720 WinForms/UIA gate passes 10/10 exact targets, 100% schema accuracy, zero false triggers, and 100% observe-before-act. The completed OpenAI-Hub native Anthropic smoke used exactly three authorized POSTs and returned 200 for streamed marker, strict closed-schema `tool_use`, and matching `tool_result`; ordinary tests must not rerun it.

Final dev-0.0.9 acceptance covers runtime target isolation, Guide/work-run persistence and UI reconciliation, cold completed-run folding after worker eviction, editor lifecycle, PDF capability security and real PDFium rendering, native Browser-Use with the actual prewarmed Electron Browser guest, actual utility/WSL processes, cooperative/forced stop, and error-storm deduplication. Cold Browser-Use has no hidden-window fallback and textarea/contenteditable content is excluded from observations and extraction. Windows force restart snapshots PID/parent/creation identity with Win32 Toolhelp, uses identity-matched handles for termination, rescans anchored late descendants until stable empty, and keeps uncertainty in a sticky target/generation quarantine. The complete source suite passes 1,084 assertions; focused gates pass 27 dev-0.0.9 contracts, 79 Browser-Use checks, 21 asynchronous-process checks, 59 real-Electron Browser-Use/utility checks, and 41 startup-prewarm checks. Windows MSI/unpacked ZIP, Windows Native/WSL packaged operation, and Linux AppImage/deb/unpacked GUI startup all pass. The five unsigned artifacts are published as the non-draft GitHub prerelease `dev-0.0.9`; clean remote downloads match the local hashes and pass their platform startup smokes.

The acceptance paragraph above records the already-published dev-0.0.9 cross-platform package baseline, which remains the current Linux line. The later 2026-07-15 follow-up passes a fresh full suite with 1,101 core assertions, 27 dev-0.0.9 contracts, 79 Browser-Use checks, 21 asynchronous-process checks, 41 startup-prewarm checks, and 59 real-Electron Browser-Use/utility checks. Real Electron/CDP inspection verifies Focus-menu reopening, application icons, durable user-image rendering, and persisted background/font controls. A real source Electron + Ubuntu WSL Computer Use run reports `visionRequests=2`, `visionImages=1`, and `tempResidue=0`; the final host temporary-directory audit is also zero. These changes are included in the validated dev-0.0.10 Windows artifacts; exact evidence is recorded in 本地归档（未纳入公开仓库）.

Current dev-0.0.10 startup implementation: Electron creates one visible `BrowserWindow` and immediately loads the final `index.html?startupPrewarm=1`. A fixed cover inside that renderer remains visible until the same `webContents` completes and main accepts the `state/rendered` readiness handshake; startup does not create a hidden candidate or separate prewarm popup. If the attempt-one waiter is absent during the blank commit phase or matching `index.html`, main restores only the same-`webContents`, same-attempt waiter and never initiates a duplicate load. The critical barrier initializes configuration/Agent and core services, validates the local/persisted current-conversation snapshot, then performs one task yield and layout read rather than creating a Utility/WSL conversation runtime or waiting on animation frames. A required failure loads the static `startup.html` retry surface in that same window; retry navigates the same window back to `index.html`. File tree and right status load only when their tabs/sidebar are explicitly opened, Flow loads on entry to Flow-facing UI, and terminal starts on expand/focus/send demand. Main-process warning-only work is delayed after promotion: automation 0.5 seconds, WSL discovery 12 seconds, update discovery 15 seconds, conversation-runtime prewarm 30 seconds, and the non-interactive sidecar 60 seconds. Browser contributes no startup guest: the first tab/tool demand creates one target-bound `persist:newmark-browser-<workspace/conversation>` WebView after the five-second floor for background demand, while an explicit visible-tab activation bypasses that floor; repeated demand reuses it, and sixty seconds off-tab destroys it while retaining its URL; a pre-`dom-ready` navigation is retained and replayed exactly once. `release-ui-startup-recovery-smoke.cjs` requires one application page/CDP target, locks the minimal readiness contract, verifies no pre-demand guest and exactly one target-bound demand-created guest, and enforces the eight-second per-run interaction ceiling; the twenty-run benchmark owns the P50/P95 budgets.

Current dev-0.0.10 local hotfix: the collapsed bottom terminal retains a 34 px header so its reopen control cannot disappear. Windows main is now the sole owner of `Work/Local.json`, `External.json`, and `State.json`; the WSL host and every conversation runner use a detached workspace registry and receive an explicit target instead of normalizing shared files. Host-aware migration repairs `/mnt/<drive>` aliases and previously repeated mixed Windows/WSL paths. Real source and installed-Program-Files validation under the Ubuntu-24.04 backend switched `Code -> Test`, measured terminal geometry at `34/200 px`, and proved the registry stayed Windows-native after WSL shutdown. Evidence and installed hashes are in 本地归档（未纳入公开仓库）; the published GitHub dev-0.0.10 assets were not replaced.

Current native-select contrast hotfix: on 2026-07-16, every renderer `<select>` gained separate opaque dark/light popup palettes plus a matching native `color-scheme`, so Windows no longer combines a system-light popup with dark-theme pale text. Ordinary options, provider `optgroup` labels, selected options, and disabled options use semantic select tokens instead of translucent glass colors. `visualPreferencesVerify.ts` parses both palettes and enforces WCAG AA contrast, while `release-ui-model-auto-context-smoke.cjs` measures the real packaged model selector and provider groups under both themes. Packaged results were dark `16.02/10.07/5.71` and light `15.28/6.77/6.57` for ordinary/group/selected contrast respectively. The rebuilt MSI and unpacked ZIP passed packaging and release UI smoke; the Program Files overlay was not applied because its UAC request was cancelled, so the verified `release/win-unpacked` build remains the current local test artifact. Evidence and hashes are in 本地归档（未纳入公开仓库）; published dev-0.0.10 release assets were not replaced.

Current focused dev-0.0.10 source gates pass Auto Router 35/35, Agent Auto integration 24, explicit route rating 14, provider identity 10/10, Validation Service 63 plus Agent integration 13, max-two runtime-pool capacity 16, startup/prewarm 73, CLI tool contract 32, offline OpenAI-Hub Anthropic contract 30 with `real_api_called:false`, and ComputerUse 10/10 with 100% schema validity, zero false triggers, and 100% observe-before-act. The complete `npm test` and `test:dev010` gates pass, and the real Electron BrowserUse/utility-process gate passes all 61 checks.

Current formal dev-0.0.10 performance acceptance: the required 20-run benchmark completed with `acceptancePassed=true`. Interaction P50/P95/max was `2360/3820/4066 ms`, first Browser open was `256/450/818 ms`, and four-times-CPU input latency was `77.5/111.3/115.1 ms`. Startup-before-Browser private bytes were `423.59/498.74/545.31 MiB`; Browser-on-demand totals were `488.21/554.75/587.88 MiB`; same-run deltas were `86.23/150.60/158.79 MiB`. All 20 first-five-second lifecycle monitors saw zero Browser guests, and demand produced exactly one guest. The authoritative samples, process classifications, and gate headroom are in 本地归档（未纳入公开仓库）. Windows package acceptance is also complete: ZIP SHA256 `A7A2A31861AB7D49BDDE70881DB568702689B603C46381576EDB92C4010BEF35` and MSI SHA256 `BC16757E1AA9E70E40B2AA21A800426FBFA24735C84532E4062D7F3409A5BD01`; the prerelease is published and its MSI is installed locally with state-preservation and same-window startup verification. The dev-0.0.10 prerelease has no Linux assets; Linux remains on dev-0.0.9.

Current safe file-open routing: file-tree rows, work-review rows, conversation file buttons, and Markdown local-file links converge on `openWorkspaceFile` instead of reading every target directly into the renderer. `DESKTOP/src/core/workspaceFileRouter.ts` validates lexical and real paths against the active workspace, reads at most a 64 KiB header before classification, distinguishes UTF-8/UTF-16 text, PDF/HTML, executables/installers/shortcuts, scripts, and other binary data, and admits at most 5 MiB into the editor. Small text scripts such as `.bat`, `.cmd`, `.ps1`, and `.sh` are editable but never executed; oversized/non-text scripts and executable-like files are reveal-only, while other binary or oversized ordinary text files use the operating-system default application. HTML retains the tokenized `newmark-preview://` sandbox. PDF now returns a transport-neutral capability that `PdfPreviewServer` exposes only through an owner-bound, expiring `127.0.0.1:<ephemeral>` URL with strict Host/method/path/token/TTL checks and single-range responses, avoiding Chromium PDFium's external-protocol handling. Editor replacement and close go through one serialized Save/Discard/Cancel transition; stale asynchronous open generations and revoked edit tokens cannot replace the current surface.

Current Windows hang root cause and correction: the 0.0.7 UI freeze was reproduced only after the active workspace file-tree result reached the renderer. Configuration-only roots stayed responsive, removing conversation state did not help, disabling GPU did not help, and full file-tree IPC fetches without DOM construction stayed responsive. Commit `a61da6f` changed the default tree root from the small runtime root to the active workspace while retaining the original fully recursive scanner and renderer. On `C:\Users\12252\Desktop\Files\Code`, that produced 84,769 nodes, a 15.91 MiB serialized tree, and an estimated 347,285 DOM elements; startup requested the tree twice. A/B probes showed 48 ms response after 35 seconds with the request disabled and 28 ms with full fetch but no DOM construction, while recursive rendering locked the renderer. `DESKTOP/src/main.ts` now performs asynchronous single-level directory reads with lexical and real-path active-workspace boundary checks. `DESKTOP/src/ui/index.html` renders only the root level, loads a directory once on expansion, uses branch-local DOM references, skips hidden sidebar scans, and removes the duplicate init load. `ConfigManager` also treats the four panel layout keys as user-level state so stale workspace config cannot force the right sidebar open and retrigger hidden work. Validation passes 987 assertions and three consecutive `release:ui-runtime-layout-smoke` runs; the real workspace stayed responsive for 60 seconds at 7 ms, then expanded `Newmark Agent -> DESKTOP -> src` to 196 total rows and accepted input in 4 ms. A separate intermittent smoke failure was traced to source-mode DevTools docking, which reduced `innerWidth` from 1280 to 725 while `outerWidth` remained 1280; source smokes now pass `--no-devtools`, without changing packaged behavior.

Current installed editor highlight correction: runtime inspection of the apparently blank `_decode_title.py` editor proved that the textarea contained 1,039 characters and the highlighter produced 1,040 visible-text characters with token spans. The defect was the separate Copilot ghost `<pre>`: it had an opaque editor background and `z-index: 1`, so it covered the normal highlight layer after `renderEditorGhostText` cleared its content; the input textarea above both layers intentionally uses transparent text and therefore showed only the caret. `.editor-ghost` now defaults to `display:none`, `renderEditorGhostText` adds `visible` only for a valid anchored prediction, and all invalidation paths remove it. Final source validation passes 991 assertions and the final packaged native-editor smoke validates normal highlight/prediction/caret-reset/Tab/save behavior. The current local `Program Files` installation remains the separately verified 0.0.7 runtime package with `app.asar` SHA-256 `692BB4B0D5CA2CE19351FDB32444BEF3DB7D3AD73D1E11AF07DC308EE12F0AFF`; it contains the editor and titlebar runtime corrections, while the final GitHub release package additionally carries the completed release-script and smoke-test changes. Pixel inspection of the installed UI confirmed visible Python syntax colors while the empty ghost layer remained hidden.

Current installation-independent settings-root acceptance: desktop and CLI startup resolve normal mutable state from `~/.Newmark` regardless of where the executable is installed or unpacked. If a launcher or shortcut passes the executable directory, or a child path inside it, as `--root`, both entrypoints normalize that installation path back to `~/.Newmark` instead of writing beside the executable or creating an installation-specific `Roots/<hash>` state tree. Explicit roots outside the installation tree remain available for isolated tests and temporary validation.

Current local installation acceptance: the rebuilt unpacked package was elevated and mirrored into `C:\Program Files\Newmark Agent`. Installed `app.asar` matches the tested source package, existing `~/.Newmark` core file hashes were preserved, the installed CLI normalizes an install-directory `--root` back to `C:\Users\12252\.Newmark`, and it loads the existing 2 providers and 28 models. No install-local `config.json` exists. The installed desktop process now remains on the full packaged `index.html` renderer for manual testing.

Current post-release conflict diagnosis: the inert/black window regression was introduced after the working `dev-0.0.6` baseline by calling `webContents.stop()` immediately before `loadFile(index.html)` during the startup-shell transition. That abort created a renderer/navigation race; the BrowserWindow could retain a frame after its renderer exited. The navigation and compositor code has been returned to the proven `a61da6f` behavior while keeping the independent `~/.Newmark` install-root normalization and requested previous-version icon assets.

Current work-review and bottom-bar acceptance: completed Agent turns now retain their file diffs in conversation-scoped renderer state and render one review card after the final transcript refresh. The card aggregates changed-line additions/deletions by path, shows three rows by default, expands remaining files, and opens a file-detail review window. Transcript rerenders preserve the owning conversation's pending review instead of erasing it, and background conversation completion cannot inject a card into the active conversation. Task, Queue, and Goal are compact 30/30/31 px control bands with the existing click, drag, edit, pause, and resume behavior intact. `npm.cmd test` passes 982 assertions; `release:ui-work-review-bars-smoke` verifies five visible expanded rows, a working review subwindow, non-overlapping geometry, and records 本地归档（未纳入公开仓库）.

Current titlebar theme-icon acceptance: the renderer resolves the custom titlebar icon from `state.theme`. Explicit dark mode uses the supplied black finished icon `app-icon-dark.png`, explicit light mode uses the supplied white finished icon `app-icon-light.png`, and only `system` mode consults and subscribes to `prefers-color-scheme`. The icon image supplies its own rounded black/white surface; CSS only retains the independently configured animated marquee border and does not draw a replacement icon background. `release:ui-runtime-layout-smoke` exercises all four effective states, final source validation passes 991 assertions, and `release:ui-icon-smoke` verifies both PNG SHA-256 values inside the packaged `app.asar`. The `Program Files` installation was force-overlaid from the verified `win-unpacked` package after same-version MSI repair completed without replacing the unversioned `app.asar`; installed dark/light CDP checks decoded the expected 1024 x 1024 images and screenshot inspection confirmed the black/white finished surfaces. Native BrowserWindow, taskbar, and tray icons continue to follow Electron `nativeTheme` independently.

As of 2026-07-17, Windows packages also register `scripts/after-pack-win-icon.cjs` as an Electron Builder `afterPack` hook. Every Windows directory/package build now patches the Newmark executable metadata and ICO resources and verifies the extracted 32 px associated-icon hash before MSI assembly. A clean uninstall/reinstall was required for local `0.1.0` validation because Windows Installer does not reliably replace unchanged-version files during a same-version repair; the installed `app.asar` then matched `win-unpacked`, the installed executable icon verified, and the application launched successfully.

Current Linux release-build isolation: `dist:linux` no longer invokes Linux build tooling from the Windows-backed workspace with Windows-native `node_modules`. On Windows it creates an ephemeral build root on the selected WSL distribution's ext4 filesystem, rsyncs source while excluding dependencies/generated tests, copies required root notices, runs `npm ci` for Linux-native optional packages, builds all three Linux formats, and synchronizes only the AppImage, deb, unpacked ZIP, and unpacked directory back to the repository release folder. The temporary root is removed on success or failure, preserving the Windows install tree and `~/.Newmark` runtime state. Final WSLg acceptance passed direct unpacked launch, clean ZIP extraction, deb extraction with desktop-entry validation, and AppImage extract-and-run; all four selected Bash and rendered the full responsive UI.

Current startup-owned WSL detection: Windows starts one asynchronous `wsl.exe --list --quiet` probe immediately after creating the startup window and caches the decoded distribution list. The first Agent state request awaits that same probe, so the runtime selector and terminal shell list receive one authoritative backend result without blocking the renderer or re-running detection from Settings. The manual WSL test button and generic renderer `wsl:detect` bridge were removed; the backend status/test IPC remains available for automated diagnostics and active WSL runtime validation.

Current Windows startup-race correction: installed 0.0.7 field logs showed `ui-load-started` preceding `startup-shell-loaded`, followed by a missing renderer process and Windows `AppHangTransient`. The startup shell and full renderer were being navigated concurrently. Startup now awaits the shell load promise before initializing the Agent and navigating to `index.html`; it does not abort `webContents`. Empty Task and Queue bands are hidden in static HTML and become visible only through state-driven render functions, removing their startup flash. Source validation passes 983 assertions plus runtime-layout and work-review Electron smokes.

Current dev-0.0.6 release acceptance: the final source suite passes 979 assertions. Windows produced `Newmark-Agent-0.0.6-x64.msi` and `Newmark-Agent-0.0.6-win-unpacked-x64.zip`; packaged CLI, native editor, option feedback, conversation queue/isolation, WSL backend, tray lifecycle, Computer Use vision, adaptive icon, and narrow-layout gates pass. A real APInebula vision run used a 6000 x 4000 text-and-geometry fixture, proved `source_info` plus pixel crop/magnification calls, and recognized all required text, shapes, colors, positions, and the small crop code. Real WSL Chat and Responses requests both returned from Linux PID 10. Ubuntu 24.04 produced AppImage, deb, and unpacked ZIP assets; direct, clean ZIP extraction, and clean deb extraction WSLg tests pass with Bash connected, and packaged Linux CLI/UI requests pass against the real configured model. Artifact hashes and package names are recorded in README and the release archive. Validation used only repository and temporary roots; the Program Files installation was intentionally left unchanged.

Current active-image-inspection acceptance: `image_inspect` is available in Build and Plan only when the selected model has validated vision input. It indexes images from the latest submitted user message, reports source dimensions, validates exact pixel crop bounds, magnifies 1-4x with a 2048-pixel side cap, and returns a PNG as structured vision content. The current implementation uses compact pure-JavaScript PNG/JPEG codecs plus an original bounded bilinear RGBA scaler, so the same bundled code runs in Windows, Linux, and WSL without platform-native image binaries. Tests verify exact 100x80 source metadata, a 20x10 crop enlarged to 60x30, out-of-bounds rejection, same-turn model continuation, base64 redaction, and non-persistence of derived crops. The full suite passes 977 assertions; the rebuilt WSL bundle answered a real Ubuntu 24.04 ping in about 2.0 seconds.

Current adaptive-icon acceptance: the supplied 1024 x 1024 dark and light PNGs are used without background processing and retain alpha ranges of 0-255. The main process selects the contrasting transparent asset from Electron `nativeTheme`, updates every live window and the persistent tray when the OS theme changes, and the titlebar follows the same system preference through a live media-query listener. A startup temporal-dead-zone regression caused by tray creation calling an uninitialized refresher was corrected by using a hoisted function declaration. TypeScript build, isolated Electron/CDP startup and dark/light switching, and the complete suite pass with 969 assertions. Windows Explorer and Task Manager executable-details views continue to use the embedded static multi-size ICO because Windows does not provide runtime theme switching for the executable resource.

Current 2026-07-12 runtime-layout acceptance: the Windows native/WSL control is a localized `Agent runtime environment` select list, the input toolbar permits animated submit pixels outside the fixed button box, and the file-tree IPC defaults to the active workspace path instead of `~/.Newmark`. Source validation passes 967 assertions. An isolated Electron CDP smoke opened the real settings renderer, verified `windows,wsl` options, measured 16 px submit-button right clearance with visible overflow, and confirmed the default file-tree root omitted `Roots` and `config.json`.

Current editor-anchor acceptance: source validation passes 968 assertions. The isolated Electron smoke opened a Markdown file and measured a 15 x 15 Preview glyph fully contained by its 30 x 30 toolbar button. It then created a caret-anchored inline candidate, moved the selection from offset 2 to 5, and verified that completion text, ghost content, and anchor were cleared immediately while a fresh 500 ms request timer was active.

Current dev-0.0.6 multimodal/editor/interaction acceptance: source validation passes 964 assertions. Packaged Windows tests confirm fixed 30 px icon-only editor controls, default active Copilot prediction, 500 ms inline ghost completion, file-aware highlighting, and clipboard attachment deduplication. Real APInebula `gpt-5.4-mini` validation receives a generated 640x360 PNG containing `NEWMARK 42`, a blue circle, green square, and red triangle, and correctly reports text, geometry, color, and left/center/right positions. Option feedback keeps pending questions in the owning conversation runtime, waits for all simultaneous answers, and synchronizes live setting changes into existing runners. Cross-location single-instance validation starts the unpacked executable, launches the same-named Program Files executable, and confirms the second process exits while one renderer page remains.

Current dev-0.0.6 Windows WSL backend acceptance: on 2026-07-11, package version `0.0.6` passed 957 assertions and produced `Newmark-Agent-0.0.6-x64.msi` plus `release/win-unpacked`. The Windows UI exposes a restart-required native/WSL backend selector only when WSL distributions are present. The active mode is locked from config during startup; changing the setting does not hot-switch a running Agent. A persistent `wsl.exe` transport starts a bundled Linux Node host from the read-only installed resources, reserves stdout for JSONL RPC, reports the real Linux Agent PID, maps Windows drive paths to `/mnt/<drive>`, and invalidates cached WSL runtimes after workspace, archive, rewind, and Plan mutations. Packaged CDP validation switched native to WSL across a real restart, sent a model request to a provider running inside Ubuntu 24.04, executed a write tool into a separate Windows external workspace, and confirmed a second conversation did not inherit the first response.

Current real-model WSL acceptance: the packaged Windows 0.0.6 UI was launched against temporary copies of the configured real provider state with WSL mode enabled. Ubuntu 24.04 reported Linux Agent PID 10. APInebula `gpt-5.4-mini` completed a Chat Completions unique-marker request in 4.873 seconds and a Responses unique-marker request in 5.702 seconds. Each run verified the selected API mode from UI state and persisted its result under the exact requested conversation id without exposing the configured credential. The source configuration and normal `~/.Newmark` state were not modified.

Current dev-0.0.5 published Windows acceptance: on 2026-07-11, package version `0.0.5` passed 948 assertions and produced `Newmark-Agent-0.0.5-x64.msi` plus `release/win-unpacked`. Packaged validation passed tray continuity/direct-close cleanup, native editor highlighting/Vim/inline completion Tab acceptance, rapid same-workspace conversation switching with out-of-order state responses, archive restart persistence, narrow-window toolbar geometry, pasted images, Markdown tables/formulas/editor preview, and startup recovery in 2.48 seconds. External validation passed real APInebula CLI/UI sends and real `GitHub Copilot/openai/gpt-4.1` inline prediction with a 17-character candidate rendered at `rgba(205, 211, 222, 0.48)`, accepted by a real `Tab` event, and saved. For protected-root validation, the previous MSI was uninstalled and `0.0.5` installed; Windows registered only version `0.0.5.0`, installed and unpacked `app.asar` hashes matched, settings persisted under `~/.Newmark` with no Program Files config, and Program Files tray/Copilot smokes passed.

Current version line: the active source/documentation and latest published development-preview line is `dev-0.0.10`. It is an unsigned Windows-only GitHub prerelease with MSI and unpacked ZIP assets. The latest published Linux package line remains `dev-0.0.9`, with AppImage, deb, and unpacked ZIP assets; those files are not dev-0.0.10 artifacts.

Current remote development tag migration: GitHub tags and prereleases formerly named `dev-1.0.0` through `dev-1.0.4` were migrated to `dev-0.0.0` through `dev-0.0.4`. Each historical tag retains its original commit, existing Release assets were renamed in place from `Newmark-Agent-1.0.x-*` to `Newmark-Agent-0.0.x-*`, and old `dev-1.0.x` references were removed. The latest published Windows development preview is `dev-0.0.10`; the latest published cross-platform and Linux package baseline remains `dev-0.0.9`.

Current dev-0.0.5 Linux acceptance: Ubuntu 24.04 under WSL2 passed 936 Linux assertions and produced `Newmark-Agent-0.0.5-x86_64.AppImage`, `Newmark-Agent-0.0.5-amd64.deb`, and `Newmark-Agent-0.0.5-linux-unpacked-x64.zip`. The deb metadata reports package `newmark-agent`, version `0.0.5`, architecture `amd64`. WSLg GUI validation passed from `release/linux-unpacked`, from a clean temporary extraction of the published upgrade zip with executable permissions and `resources/app.asar` checked, and from a clean `dpkg-deb --extract` installation layout with the desktop entry verified to target `/opt/Newmark Agent/Newmark Agent`. All three paths selected bash as the Linux default terminal and rendered a connected Bash terminal. Mutable state remains external under `~/.Newmark`, so direct-run, deb installation, and unpacked replacement do not overwrite user configuration.

Current editor prediction presentation: on 2026-07-11, the native editor replaced its detached completion popup with a scroll-synchronized inline ghost layer. The layer reproduces the text before and after the caret as transparent layout content and paints only the candidate in subdued gray, preserving exact line wrapping and insertion position. The editor keydown path gives an available completion priority over Vim and indentation handling, so a real `Tab` event inserts the candidate and clears the ghost text; `Esc` dismisses it. Source verification passed 948 assertions, and the rebuilt packaged native-editor CDP smoke validated inline rendering, absence of the old popup, real Tab insertion, persistence through save, highlighting, and Vim behavior.

Current tray lifecycle: on 2026-07-11, the desktop tray changed from an on-demand hide-only object to an application-lifetime object created alongside the first desktop window. Showing or restoring the main window no longer destroys the tray. The title-bar minimize action now follows `ui.minimize_to_tray`, independently from the close button's `general.close_behavior`; direct close still terminates the process and destroys the tray during `will-quit`. Source verification passed 948 assertions. A rebuilt Windows packaged smoke confirmed the tray is active while the window is open, minimize-to-tray hides the window while retaining the process and tray, and direct close exits without process or tray residue.

Current near-limit context compression and provider normalization: on 2026-07-11, automatic compression was changed from a fixed 80,000-character-only trigger to a selected-model context budget. Newmark reserves up to 12% for output, triggers around 78% of the remaining usable window, targets around 55% after compression, bounds summary request/output size, compacts oversized summaries while retaining both head and tail evidence, and chooses the retained suffix from a complete user turn. The fixed character threshold remains an additional early trigger for large-context models. OpenAI Chat Completions, legacy choices text, Responses output blocks, streaming content arrays, and Anthropic text blocks now share the same recursive native text extractor. Regression tests use a 1,000-token model to prove compression happens before 80,000 characters, falls below the target token budget, retains a user-turn boundary, records exact message counts, and uses local fallback for empty/error summaries. `npm.cmd test` passed 945 assertions.

Current Copilot startup and editor-model binding fix: on 2026-07-11, the model selector stopped emitting empty provider groups and now recovers both empty and validated-unavailable saved selections to the first selectable model, persisting that concrete selection to the backend. Editor completion no longer uses a forced `preferCopilot` override; all editor prediction and Agent assistance resolves through the model selected in the active conversation toolbar. Real UI validation against `~/.Newmark` displayed 21 usable GitHub Copilot models plus 7 APInebula models, initialized both renderer and backend to `openai/gpt-4.1`, returned `APInebula/codex-auto-review` when APInebula was selected, and returned `GitHub Copilot/openai/gpt-4.1` after switching to Copilot.

Current Windows installer scope correction: the MSI configuration now uses `perMachine: true`, making Windows Installer target Program Files and request elevation for installation/update while leaving mutable `~/.Newmark` state untouched. The previous `perMachine: false` setting installed successfully under `%LOCALAPPDATA%\Programs`, which contradicted the documented managed-install target and could not update an existing Program Files copy.

The rebuilt per-machine MSI was inspected through Windows Installer logging and correctly reports `ALLUSERS=1`, `ProgramFiles64Folder`, and `APPLICATIONFOLDER=C:\Program Files\Newmark Agent`. A non-elevated install correctly failed with Error 1925 instead of partially writing protected files. Two explicit UAC elevation prompts were canceled, so the existing Program Files installation remains on its prior `app.asar`; no installed-copy validation is claimed. The rebuilt unpacked package and real GitHub Copilot editor smoke passed independently.

Current OpenAI response compatibility and compression hardening: on 2026-07-11, provider response text extraction was unified across Chat Completions and Responses. Newmark accepts normal message strings, content-part arrays, legacy `choices[0].text`, top-level `output_text`, nested Responses message blocks, compatibility-gateway `text.value`, and refusal text. Non-stream tool fallback uses the same extraction. Context compression now rejects empty and controlled `[LLM Error]` results and records a local fallback summary instead of incorrectly marking an empty provider result as successful model compression. Regression coverage includes each response shape and compression fallback behavior.

Current conversation copy/edit actions: on 2026-07-11, the workflow timeline gained compact Copy controls for user and Agent messages and an Edit control for persisted user nodes. Edit is implemented as a backend conversation rewind rather than a renderer-only text replacement: Newmark maps the selected displayed user-message ordinal to the matching model-history user entry, atomically truncates both histories before that node, drops the cached conversation runner/events/queues, persists the retained prefix, and restores the removed prompt text into the input. Running conversations reject rewind to avoid racing an active Agent turn. Verification passed `npm.cmd test` with 933 assertions, including restart persistence and invalid assistant-node rejection.

Current file-tree empty-directory polish: on 2026-07-11, `renderTreeNodes` was changed to render the localized empty label only when the root tree has no entries. Empty nested directories retain their folder row and expansion state but do not append a redundant placeholder child row.

Current native editor integration: on 2026-07-11, the right sidebar editor was rebuilt as a Newmark-owned text/code editor rather than embedding a third-party runtime. It provides line numbers, escaped token highlighting for common code/data/markup formats, a compact Vim normal/insert/visual command state, undo/redo, dirty/save status, Agent review assistance, and an editor-only Markdown preview toggle. Opt-in Copilot prediction waits 700 ms after input, invalidates stale requests, prefers a validated GitHub Copilot model, accepts with `Tab`, and dismisses with `Esc`. Architecture and licensing were screened against Ace, CodeMirror, Monaco Editor, Neovim, and CodeMirror Vim; no implementation source or editor package was copied or added. Verification passed `npm.cmd test` with 927 assertions, packaged native-editor and media/Markdown CDP smokes, and a real external GitHub Copilot completion through `openai/gpt-4.1`. The local Program Files copy was not updated because the UAC request was not approved; the tested artifact is the rebuilt `release/win-unpacked` package using the normal `~/.Newmark` state.

Current self-contained model dual-validation fix: on 2026-07-11, model capability validation stopped treating name inference as proof. Newmark's own `validateModels` now reads structured provider `/models` or GitHub catalog metadata, runs the built-in DuckDuckGo/Bing `web_search` against the provider's official domain for capability candidates, and then submits real text, 64x64 red-square visual recognition, and dedicated image-generation tasks. Only task success persists `vision_input` or `image_output`; search/catalog/name evidence only triggers probes. Newly imported models remain capability-unvalidated, and the toolbar model selector includes only `available` or `unvalidated` statuses. Verification passed `npm.cmd test` with 924 assertions. Real Newmark CLI validation confirmed APInebula `gpt-5.5` as text+vision available and image-output unclaimed, while GitHub Models `microsoft/phi-4` passed text but correctly failed vision with the provider's image-model error. The installed Program Files UI contained 28 selectable models, zero validated-unavailable/error entries, zero missing available/unvalidated entries, and retained `gpt-5.5`.

Current 本地归档（未纳入公开仓库） and narrow-input fix: on 2026-07-11, the conversation archive action was found to create a Markdown file without deleting the source conversation, after which the renderer refreshed it back into the active list. `Agent.archiveConversation` now archives a requested id without switching the shared host, removes that id from disk and memory, removes exact non-empty duplicate transcript registrations, and preserves different conversations that merely share the same title. The renderer also rejects duplicate ids and adds a short id suffix for same-title distinct conversations. Input-toolbar flex and responsive rules now retain at least 72px of model information, keep the send action inside the input area, and temporarily hide sidebars below 720px without mutating saved sidebar state. Verification passed `npm.cmd test` with 920 assertions and packaged `release:ui-fast-conversation-switch-smoke`; real geometry measured a 209px model field at 560px and 100px at 430px with the send button inside the input boundary, while archived conversation removal persisted across a packaged app restart.

Current same-workspace conversation isolation fix: on 2026-07-11, packaged UI testing reproduced a severe mapping failure where `agent:getState(B)` returned conversation id B but then overwrote B's scoped snapshot with the shared host's `agent.chatMessages` from A. The fix removes that global overwrite, makes persisted target state authoritative for scoped snapshots, keeps snapshot/ensure reads free of implicit saves, merges runner completion directly into the target key, synchronizes host memory only when that target is actually active, and rejects delayed `ensureConversation`/`getState` chains after a workspace or conversation switch. Verification passed `npm.cmd test` with 912 assertions, packaged `release:ui-fast-conversation-switch-smoke` including an intentionally delayed A response and 20 rapid A/B switches, `release:ui-multi-window-shared-backend-smoke`, and `release:ui-workspace-conversation-isolation-smoke`.

Current protected-root and installer follow-up: on 2026-07-10, Newmark separated immutable program installation from mutable user state and moved the Windows release layout to MSI installer plus `win-unpacked` update pack. `DESKTOP/src/main.ts` and `DESKTOP/src/launcher.ts` now default configuration/state roots to `~/.Newmark` for desktop and CLI startup, while installed executable files can remain under protected locations such as Windows `Program Files` or Linux `/opt`. The first run copies legacy Electron user-data state into the new root when missing, and `WorkspaceManager` normalizes migrated internal workspace paths under the current runtime root so old `AppData\Roaming\Newmark Agent\Roots` absolute paths do not survive inside `.Newmark`. Explicit `--root` remains available for isolated/test runs; protected or unwritable explicit roots are remapped below `~/.Newmark/Roots/<source>-<hash>`. This prevents settings saves, workspace registry writes, conversation persistence, and archive creation from failing without requiring the runtime to run as administrator. The packaged update helper reconstructs space-containing `--source`, `--target`, and `--target-file` paths when invoked through PowerShell `Start-Process`, selects the GitHub `win-unpacked` zip update pack, and preflights target writability so protected targets such as `C:\Program Files\Newmark Agent` fail before partial copy unless the MSI or an elevated update process is used.

Current GitHub Models catalog fix: on 2026-07-10, a real Program Files test found that GitHub login could save a token while the Models settings remained empty. The root cause was workspace `config.json` files containing an empty `models.providers` override, which hid the user-level provider written under `~/.Newmark`. `ConfigManager` now treats provider credentials and catalogs as user-level state, ignores workspace overrides for `models.providers`, and makes provider/model mutations operate on the global configuration. Login imports the live GitHub Models catalog, reports the actual catalog count separately from fallback state, and redraws the open Models panel after backend refresh. Verification passed 905 source assertions plus a real external catalog request returning 37 models and a real `openai/gpt-4.1-mini` inference marker.

Current dev-0.0.4 Linux publication: the WSL-native build passed 893 Linux assertions and packaged WSLg GUI smoke, then produced `Newmark-Agent-0.0.4-x86_64.AppImage`, `Newmark-Agent-0.0.4-amd64.deb`, and `Newmark-Agent-0.0.4-linux-unpacked-x64.zip`. The Linux unpacked zip is generated from the same `linux-unpacked` directory as the AppImage/deb build and is intended for no-loss updates that preserve mutable `~/.Newmark` state.

The desktop Electron UI is the primary acceptance surface. CLI and tests are useful regression gates, but a feature is not considered complete when the packaged desktop UI fails visually or behaviorally. Recent validation work has focused on package/runtime differences, especially UI text, keyboard behavior, right sidebar panels, skills UI, Guide/Next, open-source SVG icons, message media, and conversation state isolation. The current conversation surface renders as a workflow timeline rather than chat bubbles. Packaged UI validation confirmed backend conversation switching restores only the active workspace/conversation messages, each send is bound to the initiating conversation ID, queued input drains into the next Build turn, Markdown images render inline, conversation file links open the right-side Editor directly, and restart continuation restores the same workspace/conversation through `Work/State.json` plus workspace-local `conversations/state.json`; this has now been verified both with a deterministic mock provider and with the real APInebula `gpt-5.4-mini` model over two packaged desktop launches. The packaged UI now also validates current-conversation Plan management in the right sidebar: add/edit/status-cycle controls persist under the active workspace and conversation, new conversations start with an empty plan, switching back restores the previous plan, and restart recovery preserves the active conversation plan without cross-conversation leakage. The packaged UI also validates language switching through `general.language`: fresh roots start in `auto`, Settings can switch to `zh` or `en`, the renderer updates `document.lang`, prompt placeholders, and right-sidebar Plan labels, `config.json` persists the selection, and a restart restores the selected language. Secondary language coverage now includes active rendered titles and status text for fuzzy injection, plugins, Flow, new conversation, workspace-required gates, archives, file tree, terminal, editor, subagents, conversation isolation, and model settings; packaged CDP validation now verifies `auto -> en -> zh -> en` switching for primary sidebar labels, workspace secondary controls, right close/editor close controls, sub-window close controls, Chinese secondary-window titles, dynamic context compression and Next queue labels, model Auto labels, model validation status chips, provider/model edit labels, file-tree empty states, terminal connection status, and persisted config. Source regression also parses `NEWMARK_I18N` and requires English / Chinese dictionaries to have identical non-empty key sets. The Agent prompt now also localizes the visible reply contract itself: `en` selects `What changed / Verification / Files / Issues/Next`, `zh` selects `做了什么 / 验证 / 文件 / 问题/下一步`, and `auto` follows the user's dominant input language while preserving code, commands, paths, JSON keys, model/provider/tool names, quoted source text, and user-provided literals. The non-interactive CLI now exposes `language` in `state` and accepts `send --language auto|en|zh`; packaged CLI smoke verifies `state --language zh` and that `send --language en` injects `general.language=en` into the outgoing Agent prompt. Provider state returned to the renderer and HTTP state API is now sanitized (`api_key: ""`, `has_api_key: true/false`), while provider saves merge existing secrets so UI edits do not clear keys. The packaged Models settings UI now has deterministic release CDP coverage for provider/model add, edit, and delete, including key redaction in renderer state and key-preserving provider rename/edit persisted to config. Closed subagents remain available as retained read-only history after their active occupancy is released, the current packaged Agent can actively execute `write -> bash(timeout_ms=10000) -> edit -> read` through the real renderer input path with Agent-selected bash timeout while the terminal timeout cap remains `0`; this is now covered by repeatable `release:ui-agent-smoke` CDP validation that records exact tool order, file effects, hidden hover mode/model metadata, and screenshot evidence. The packaged Agent can drive embedded Browser tools through `browser_open -> browser_snapshot -> browser_type -> browser_click -> browser_eval`, can call `gh_auth_status`, and can create/list persisted automations through `automation_create` and `automation_list` in one real renderer `window.sendMessage()` turn; this is covered by `release:ui-integration-smoke` with screenshot evidence. The packaged UI now also validates external workspace creation through the New Workspace UI path, runtime PC host binding persistence in `Work/External.json`, external workspace archive isolation, and hiding/filtering after a saved host-binding mismatch; this is covered by `release:ui-external-workspace-smoke` with screenshot evidence. The packaged UI now validates option-feedback behavior across `default`, `ask_more`, `ask_less`, and `fully_autonomous`, structured option rendering in the workflow timeline and right Status panel, and visible `outside_readonly` + `ask_user` permission blocking through `release:ui-option-feedback-smoke`. The packaged desktop automation timer has also been validated end to end: a one-shot automation created through the real preload API executed through `Agent.process`, persisted `runCount: 1`, stored `lastResult`, and completed without leaving Newmark processes or scheduled-task residue. The packaged `--automation-wake` entrypoint now runs due automations once in headless mode, persists the result, resyncs wake scheduling, and exits before sidecar/window setup. The current packaged release has also passed low-cost real-provider smoke tests against APInebula `gpt-5.4-mini` through both release CLI `send` and the real desktop renderer input path, selected real model validation for `APInebula/gpt-5.4-mini` through both release CLI `validate-models` and the real desktop Models UI, deterministic unavailable-model fallback through both release CLI `send` and the real desktop Models UI, Anthropic-compatible fuzzy injection through both packaged CLI and real packaged Models UI using mock `/models` and `/messages` endpoints, Claude/Anthropic env-file fuzzy injection through packaged CLI plus real packaged Models UI with a space-containing env-file path, and a one-shot real `Claude code.txt` import that persisted `DeepSeekAnthropic` while reporting unavailable DeepSeek models without leaking keys. Fuzzy-inject failure warnings now include imported candidate validation statuses plus discovery context. Agent-initiated Flow design/trigger and subagent retained history are now covered by `release:ui-flow-subagent-smoke`, which drives `flow_save`/`flow_list`/`flow_run` and `task`/`subagent_send`/`subagent_result`/`subagent_close` through the real packaged renderer/Agent path. 本地归档（未纳入公开仓库） is the current requirement-to-evidence checkpoint for the active goal; after the Flow/subagent smoke, the remaining high-value gap is targeted opt-in real-provider reruns when spending is acceptable.

Current real-provider update: on 2026-06-28, `release:real-provider-smoke` reran the APInebula `gpt-5.4-mini` baseline through packaged CLI `state`/`send` and the real release UI renderer prompt path. Broad model validation remains targeted opt-in to conserve balance. `release:real-claude-env-preview-smoke` now covers the real `Claude code.txt` path in no-spend preview mode, proving env-file parsing, protocol inference, candidate model extraction, and secret redaction without validating DeepSeek models.

Current UTF-8 real-provider update: on 2026-06-28, `release:real-provider-smoke` gained `NEWMARK_REAL_UTF8=1` and was run against APInebula `gpt-5.4-mini`. It verified a Chinese packaged CLI `send --language zh` path and a Chinese real packaged desktop UI `window.sendMessage()` path through Electron CDP without leaking API keys. DeepSeek was not called.

Current real-provider stress update: on 2026-06-28, `release:real-provider-stress` was added and run against the available Anthropic-compatible provider configuration through the real packaged release executable. It verified 8 packaged CLI sends, 6 packaged desktop UI sends through Electron CDP, 3 Goal continuation rounds, queued prompt drain, separate-conversation marker isolation, long-context send, secret redaction, archive reporting, and final release process cleanup with verdict `release-usable`.

Current real-provider follow-up: on 2026-07-02, the refreshed packaged v1.1.0 build passed APInebula `release:real-provider-smoke` with real model validation and UTF-8 enabled, covering packaged CLI send, packaged CLI UTF-8 send, real `validate-models`, packaged UI send, packaged UI UTF-8 send, screenshot evidence, and key-leak guards. The refreshed build also passed `release:real-apinebula-memory-switch-smoke`, covering real model validation, real-model Memory Lab read/update tool use, component readback, tag graph repair, and unavailable-model fallback to `gpt-5.4-mini`. A separate `release:real-provider-stress` run against the currently available `ANTHROPIC_*` configuration did not pass because the provider returned `402 Insufficient Balance` for CLI rounds and Goal continuation timed out after that provider failure; the same run still passed UI rounds, queue drain, conversation isolation, long-context send, and release process cleanup. The current stress report is 本地归档（未纳入公开仓库）.

Current multi-window shared-backend validation: on 2026-07-05, Codex Computer Control and packaged CDP validation reproduced and then closed the multi-window active-conversation spillover risk. The desktop app now uses one backend main process for repeated launches, creates additional renderer windows through the single-instance path, lets windows request read-only/scoped conversation snapshots with `ensureConversation`, and preserves each window's active conversation by id during workspace and conversation list refresh. Validation passed `npm.cmd test` with 874 assertions, `dist:portable`, `release:ui-multi-window-shared-backend-smoke`, and Computer Control visual switching where window B created `新对话 2` while window A stayed on its original default welcome view. Evidence is recorded in 本地归档（未纳入公开仓库）; Computer Control screenshots were not archived.

Current Responses/active-input follow-up: on 2026-07-09, direct OpenAI-compatible Responses API failures were normalized to controlled `[LLM Error]` text instead of thrown exceptions, matching the tool-streaming Responses path and preventing repeated error surfacing when a remote Push-Lite root enables Responses mode against an incompatible endpoint/model. `LLMProvider.validate()` now treats that controlled error text as unavailable rather than a successful non-empty response. The direct Responses input converter also now emits prior assistant `function_call` items before matching `function_call_output` tool results, fixing APInebula/OpenAI-compatible second tool rounds that rejected tool outputs with `No tool call found for function call output`. The desktop input action now reflects the current window's active conversation state: running plus empty prompt shows a Newmark marquee-bordered Stop button bound to `Esc` and `agent:abortConversation`, running plus non-empty prompt shows a marquee-bordered Send button for steering/queueing, and idle state restores the normal Send button. Verification passed `npm.cmd test` with 891 assertions, a live Electron CDP smoke that checked Stop/Send/idle button class, title, and icon transitions, and a real APInebula `gpt-5.4-mini` Responses tool-result probe that returned `REAL_RESPONSES_TOOL_RESULT_OK`.

Current Lite responsiveness follow-up: on 2026-07-09, the native Agent bridge removed redundant per-round work while preserving behavior. `agentKernelRunner.ts` now builds Newmark tool definitions once per Agent turn and reuses them for provider streaming and kernel tool execution, so multi-tool turns do not rebuild the full schema on each model/tool round. Context transform returns immediately when `context.auto_compress` is disabled, avoiding unnecessary conversion and JSON comparison. High-frequency tool workflow rows are still emitted live and appended to the transcript, but they defer full `conversations/state.json` persistence until existing message-end/final-turn save points, reducing synchronous disk churn on Lite or remote-backed roots. A local probe measured raw tool-schema construction at about `0.7 ms` per build, and `npm.cmd test` passed with 895 assertions. Evidence is recorded in 本地归档（未纳入公开仓库）.

Current real-provider release validation update: on 2026-07-02, the packaged v1.1.0 build was retested with the local APInebula key file. `release:real-provider-smoke` passed real packaged CLI send, CLI UTF-8 send, real model validation, packaged UI send, packaged UI UTF-8 send, screenshot evidence, and secret redaction. `release:real-apinebula-memory-switch-smoke` passed real model validation, real-model Memory Lab read/create tool use, tag graph repair, component readback, and unavailable-model fallback. `release:real-provider-stress` was forced to explicit `NEWMARK_REAL_STRESS_*` APInebula OpenAI-compatible settings, avoiding stale `ANTHROPIC_*` machine configuration, and now passes CLI rounds, UI rounds, Goal continuation, real renderer input queue drain, conversation isolation, long-context send, and release process cleanup. The queue stress harness now uses the actual UI input queue instead of treating concurrent preload `sendMessage` calls as separate final-turn promises. A visible packaged UI user-test window is open against `_local/real-ui-user-test`, with backend state confirming APInebula `gpt-5.4-mini`, `chat_stream`, key presence, and workspace `2026-07-02_0957`.

Current real-provider audit follow-up: later on 2026-07-02, the APInebula key file path was reused without printing the key, `release:real-provider-smoke`, `release:real-apinebula-memory-switch-smoke`, and explicit APInebula `release:real-provider-stress` all passed again, and the full source regression suite passed with 755 assertions. `_local/` is now ignored by Git so the real-model user-test root stays local-only. Requirement-level closure evidence is recorded in 本地归档（未纳入公开仓库）.

Current conversation-control update: on 2026-07-02, same-conversation input and background tracking were tightened. Guide now steers the active kernel turn directly and no longer enters the visible queue; Next remains the editable future queue. Running conversation archive actions call the native abort path and then archive immediately, but ordinary foreground/background switching never aborts background work. When a background conversation is foregrounded, the renderer immediately reloads backend messages and work-event snapshots, holds that foreground selection against backend snapback for a short interval, and keeps a five-minute event-tracking window after switching away before falling back to backend snapshot reload on the next activation. Visible work-event text now uses natural status phrasing, and the collapsed queue pill is vertically centered. Verification passed `npm.cmd test` with 758 assertions.

Current real-provider validation follow-up: after the conversation-control update, the packaged APInebula gates were rerun. `release:real-provider-smoke` passed packaged CLI send, CLI UTF-8 send, packaged UI send, UI UTF-8 send, screenshot evidence, and secret redaction. `release:real-apinebula-memory-switch-smoke` passed real model validation, Memory Lab read/create tool use, component readback, tag graph repair, and unavailable-model fallback. Full `release:real-provider-stress` passed CLI rounds, UI rounds, Goal continuation, real UI queue drain, conversation isolation, long-context send, secret guards, and release process cleanup using APInebula `gpt-5.4-mini`; the harness now normalizes the observed unstable `api.apinebula.com/v1` alias to the release-validated `apinebula.com/v1` endpoint.

Current v1.1.1 real-release visual validation: on 2026-07-03, `release:real-provider-smoke` was rerun against the real packaged v1.1.1 release with APInebula `gpt-5.4-mini`, `NEWMARK_REAL_VALIDATE_MODELS=1`, and `NEWMARK_REAL_UTF8=1`. It passed real packaged CLI send, CLI UTF-8 send, real `validate-models`, real packaged UI send, UI UTF-8 send, screenshot capture, and key redaction. Follow-up validation then passed `release:real-ui-copilot-computeruse-smoke` against `_local/real-ui-user-test`, proving the real UI loads APInebula `gpt-5.4-mini`, GitHub Copilot login imports a `github_models` provider at `https://models.github.ai`, and no GitHub token leaks to renderer results. Packaged `computer_use takeover_start` also returned a single `single-click-through-virtual-screen-overlay` using shared gradient colors, speed, and width. The refreshed visual audit inspected 本地归档（未纳入公开仓库）, 本地归档（未纳入公开仓库）, 本地归档（未纳入公开仓库）, 本地归档（未纳入公开仓库）, and 本地归档（未纳入公开仓库） to confirm visible UI state for real-provider replies, Markdown tables/formulas, GitHub Models exact-login UI, bottom-terminal Agent takeover marquee border, real Copilot import, and packaged language/workspace UI. Evidence is recorded in 本地归档（未纳入公开仓库） and 本地归档（未纳入公开仓库）.

Current config recovery update: on 2026-07-03, `DESKTOP/config.example.json` was added as a safe template containing no real API key, and package verification now requires it inside `app.asar`. `ConfigManager` backs up invalid JSON or invalid provider/model shapes as `config.broken-*.json` and recovers damaged configs from `config.example.json` when available, falling back to compiled defaults if the template is unavailable. Missing config on normal first run still uses provider-empty defaults. Desktop and CLI first-run paths now call the shared recovery path, and CLI stdout/stderr writes are EPIPE-tolerant at both write and stream-error levels so closed pipes do not produce Electron main-process error dialogs. Follow-up release validation also hardened `--root` parsing for paths with spaces by choosing the longest existing Windows argv fragment join, then confirmed the packaged app loads the real APInebula `gpt-5.4-mini` UI test root. Verification passed `npm.cmd test` with 843 assertions, `npm.cmd run dist:portable`, packaged invalid-config recovery, a closed-stdout pipeline check, packaged real-root state validation, and the real UI Copilot/ComputerUse follow-up smoke; evidence is stored in 本地归档（未纳入公开仓库）, 本地归档（未纳入公开仓库）, and 本地归档（未纳入公开仓库）.

Current duplicate-reply release fix: on 2026-07-03, the real-model UI double final reply path was traced to the renderer receiving streamed assistant text through `agent:workEvent` and then receiving the same final token text from `window.sendMessage()` after the native kernel completed. `DESKTOP/src/ui/index.html` now records the completed streamed assistant node and reuses it when returned tokens match the same conversation, so the final response is updated in place instead of duplicated. `release-real-provider-smoke.cjs` now checks exact single marker counts for CLI and UI paths and captures assistant DOM/backend message summaries when a marker wait fails. The preload bridge also exposes `filePathForFile`, and the renderer prompt paste/drop handlers insert copied or dropped local file paths into the input box for file-to-dialog workflows. Verification passed `npm.cmd test` with 762 assertions, `dist:portable`, APInebula `release:real-provider-smoke` with UTF-8/model validation, `release:real-apinebula-memory-switch-smoke`, and explicit APInebula `release:real-provider-stress`. Current v1.1.0 artifact SHA256 values are `EE3131753A09BC6F37BFFD41BA94545AF389C834112BE3ED2E0424A93C41FE07` for `Newmark-Agent-1.1.0-portable-x64.exe` and `767E5B6E733A64400F6F7671A46DB308AC8A226C034657E103CBCFC68BCDBD55` for `Newmark-Agent-1.1.0-win-unpacked-x64.zip`.

Current file/GitHub audit update: on 2026-07-03, `file_audit` was added as a native read-only tool for local and GitHub-backed file change auditing. It reports local filesystem timestamps/hash data, local Git tracking/status/last-commit/base-diff data, and, when a GitHub remote is detected and remote audit is enabled, repository, branch, contents, and commits-by-path metadata through `gh api` using GitHub REST-shaped endpoints. `git_branch` covers local branch current/list/create/switch operations, `gh_fork` covers fork status and explicit fork creation, and `gh_pr_create` covers explicit PR creation. New git/GitHub flows use argument-array `spawnSync` rather than shell string concatenation, and CLI JSON argument files strip UTF-8 BOMs for Windows PowerShell compatibility. Verification passed `npm.cmd test` with 769 assertions and live read-only checks for `file_audit`, `gh_repo_view`, `git_branch current`, and `gh_fork status` against public `positer/Newmark-Agent`. Evidence is stored in 本地归档（未纳入公开仓库）.

Current remote repository security review update: on 2026-07-03, `repo_security_audit` was added as a read-only Build/Plan tool for remote-backed workspaces. It reports local Git/GitHub remote detection, public/private repository metadata when available, working-tree status, base diff names, likely secret-like tracked or changed lines, ignored release-excluded local files, and concrete recommendations for avoiding privacy exposure. The Agent prompt now proactively requires repository safety review for remote-backed paths before push, PR, release packaging, public reporting, or cloud-side audit, and `git_push` / `gh_pr_create` prepend a compact security preflight summary when a remote exists.

Current terminal takeover and GitHub Models update: on 2026-07-03, `terminal_takeover` was added as an Agent tool independent from the one-shot `bash` tool. It maintains named persistent shell sessions across `start`, `write`, `read`, `stop`, and `list`, so both desktop and CLI Agent turns can keep cwd/env/process context inside the same terminal environment. Desktop Electron subscribes to takeover events, mirrors active sessions into the bottom terminal tab strip, lets manual bottom-terminal input write into the same takeover session, and applies the existing Newmark dynamic gradient marquee border to active takeover tabs/panes using the `ui.gradient_colors`, `ui.gradient_speed`, and `ui.gradient_width` settings. The model layer also gained a `github_models` provider protocol for GitHub Copilot/Models-style setup: GitHub/Copilot provider names infer `https://models.github.ai`, model discovery uses GitHub Models catalog, chat uses GitHub Models inference chat completions, and requests carry GitHub token plus API-version headers. GitHub/Copilot is exact-login only: the desktop Models settings bridge uses GitHub CLI login/refresh with `models:read`; already-authenticated sessions use `gh auth refresh --scopes models:read` because current GitHub CLI rejects `refresh --web`, unauthenticated sessions use `gh auth login --web --scopes models:read`, and Electron opens `https://github.com/login` if CLI token acquisition still fails. Agent, server, and CLI fuzzy injection reject GitHub/Copilot candidates and remain limited to OpenAI-compatible or Anthropic-compatible imports. Verification passed `npm.cmd test` with 842 assertions and `npm.cmd run dist:portable`; exact-login hardening is tracked in 本地归档（未纳入公开仓库） and 本地归档（未纳入公开仓库）.

Current Computer Use and release 1.1.1 validation update: on 2026-07-03, native `computer_use` was added for Windows observe/move/click/scroll/type/key/wait actions and then extended with visible desktop takeover and application-scoped workflows. It builds UI Automation semantic objects with stable `target_id`, `stable_key`, normalized bounding boxes, allowed actions, risk hints, object priorities, and high-priority scene summaries, and lets `move`/`click`/`scroll` target the latest observed semantic object instead of brittle raw coordinates. `takeover_start` and mutating actions show a virtual-desktop dynamic gradient edge indicator; `takeover_stop` clears it. `app_list`, `app_observe`, `app_activate`, `app_click`, `app_scroll`, `app_type`, and `app_key` scope screenshots and operations to visible taskbar application windows by title, process name, PID, or native handle. Computer Use screenshots are ephemeral only and must never be stored under 本地归档（未纳入公开仓库） or the workspace: when the active model has `vision: true`, the native Agent kernel sends the screenshot image data URL and the UI Automation JSON text together in the same tool-result context, then deletes the temporary PNG immediately after preparing the provider request; when the model lacks vision or `computer_use observe`/`app_observe` is called directly, the screenshot is deleted before the tool result returns and no real path is exposed. Enikk and `JucieOvo/ezcomputerctrl-mcp` were used only as public architecture references for capture/parse/decide/act, semantic-object control, stable object IDs, and concise public object summaries; no detector/OCR/source code was copied into Newmark. Settings now has a dedicated Tools page backed by `DESKTOP/src/tools/nativeTools.ts` and persisted `tools.enabled`; disabled native tools are hidden from model-visible definitions and blocked if an older turn calls them directly. Release 1.1.1 was rebuilt and validated with `npm.cmd test` at 834 assertions, packaged `release:cli-smoke`, packaged `release:111-cli-smoke`, and packaged `release:computer-use-vision-smoke`. The Computer Use release gate verifies vision models receive UI Automation text plus a screenshot data URL, text-only models receive UI Automation text without image input, model-visible requests do not leak `vision_image_path` or `%TEMP%\newmark-computer-use\*.png`, no `observe-*.png` residue remains, and takeover-stop plus application-scoped controls are present in the packaged release. The latest v1.1.1 artifact hashes are tracked in the maintenance workflow section; evidence is stored in 本地归档（未纳入公开仓库）, 本地归档（未纳入公开仓库）, 本地归档（未纳入公开仓库）, 本地归档（未纳入公开仓库）, and 本地归档（未纳入公开仓库）.

Current OpenSSH workspace update: on 2026-07-03, native OpenSSH connection management was added for desktop and CLI/Agent paths. `Work/SSH.json` stores redacted connection metadata only, while `ssh_workspace` and the New Workspace dialog can create/edit connections, validate links through system `ssh` with argument-array invocation, create remote workspace directories, read/create remote `PC_Hash.config`, and link remote workspaces as SSH external workspace records with local shadow directories under `Work/.ssh/` for conversation state. Existing local external workspace host-binding filtering remains unchanged; SSH workspaces are preserved by `remotePcHash` and are relinked when a validated connection reports the same remote PC hash. Real VM validation is available in the packaged `release:111-cli-smoke` through `NEWMARK_RELEASE_SSH_HOST`, `NEWMARK_RELEASE_SSH_USER`, optional `NEWMARK_RELEASE_SSH_PORT`, `NEWMARK_RELEASE_SSH_KEY`, and `NEWMARK_RELEASE_SSH_ROOT`.

Current Computer Use collaboration-boundary update: on 2026-07-03, Computer Use desktop takeover now has a visible whole-desktop dynamic gradient edge indicator. `computer_use takeover_start` creates topmost border strips around the virtual desktop and `takeover_stop` clears them; mutating desktop actions also pulse the indicator so human collaborators can see when the Agent is actively controlling the desktop. Computer Use also now supports taskbar/visible-application scoped workflows: `app_list` enumerates visible application windows, `app_observe` captures a one-time cropped application screenshot plus in-window UI Automation objects, and `app_activate/app_click/app_scroll/app_type/app_key` scope actions to a window by title, process name, PID, or native window handle. Application screenshots obey the same ephemeral-only policy as full desktop screenshots.

Current Computer Use concurrency update: on 2026-07-04, `DESKTOP/src/tools/index.ts` added a process-wide Computer Use ownership lock keyed by Agent conversation ID. The native Agent kernel now passes `activeConversationId` into tool execution, so parallel desktop conversations cannot both drive Computer Use at the same time; the owner conversation can continue observe/action sequences until it calls `takeover_stop`, a different conversation receives a structured occupied response with `lock_owner` and `requested_owner`, and direct CLI/tool calls use a stable workspace-derived owner with a stale-lock TTL. Verification passed `npm.cmd test` with 849 assertions, including direct two-conversation lock acquisition/block/release tests; refreshed packaged `release:cli-smoke` and `release:111-cli-smoke` also passed after rebuilding the v1.1.1 artifacts. Evidence is stored in 本地归档（未纳入公开仓库）.

Current conversation live-feedback update: on 2026-07-04, the renderer live workflow state was scoped by conversation ID so streamed assistant text, folded tool batches, and completed-stream dedupe no longer share a global singleton across parallel conversations. `DESKTOP/src/ui/index.html` now uses `agentWorkUiByConversation`, `conversationWorkUiState(conversationId)`, and conversation-bound event replay; it also defines `currentLang()` for packaged folded tool summaries. `DESKTOP/src/core/agentKernelRunner.ts` now persists native-kernel tool results as folded workflow messages in addition to live work events, so switching back after completion shows the tool result instead of a permanently running tool row. `release-ui-conversation-queue-plan-smoke.cjs` now validates live text while A and B run concurrently, B foreground not showing A text/results, A replaying its own live text when reopened, persisted folded tool results, queue drain, and post-drain isolation. Verification passed `npm.cmd test` with 851 assertions, `npm.cmd run dist:portable`, and packaged `release:ui-conversation-queue-plan-smoke` after rebuilding; current v1.1.1 hashes are `D587DBBF4D19DB01BF3F6036E7FD629B6D064717924D042D8FCD9253CAD70EAB` for the portable exe and `9F4818E2502131A5696874EA0A22435512BBB9BD457FF05EFC217B0AB15458E7` for the win-unpacked zip. Evidence is stored in 本地归档（未纳入公开仓库）.

Current fast conversation switch visual validation: on 2026-07-04, `release-ui-fast-conversation-switch-smoke.cjs` was added to exercise packaged Electron conversation switching at visual speed. It creates A/B conversations with unique prompt/reply markers, switches between them twenty times by persisted conversation ID, checks the backend active conversation, scopes leakage checks to the current visible `#chat-area`, verifies exactly one left conversation item is active, and captures final A/B screenshots. Verification passed `npm.cmd test` with 855 assertions and packaged `release:ui-fast-conversation-switch-smoke`; evidence is stored in 本地归档（未纳入公开仓库）, 本地归档（未纳入公开仓库）, and 本地归档（未纳入公开仓库）.

Current OpenCode-style shared backend and queue UI follow-up: on 2026-07-05, conversation/window state was tightened around a shared-backend model inspired by OpenCode V2. The Electron main process now owns one conversation-kernel event subscription and broadcasts `agent:workEvent` to every desktop window, while `agent:getState`, conversation Plan IPC, and renderer refreshes can request explicit conversation IDs. Workspace switching now clears stale chat, Plan, and queue state before reloading the workspace-bound backend conversation. The queue UI regression was traced to the Next branch still writing legacy `[Next queued]` and `[Queue]` rows into `#chat-area`; Next now only expands the bottom editable queue and renders the queued prompt in `#queue-list .queue-edit`. Verification passed `npm.cmd test` with 869 assertions, `npm.cmd run dist:portable`, packaged `release:ui-conversation-queue-plan-smoke`, packaged `release:ui-fast-conversation-switch-smoke`, and packaged `release:ui-workspace-conversation-isolation-smoke`. Evidence is stored in 本地归档（未纳入公开仓库）, 本地归档（未纳入公开仓库）, and 本地归档（未纳入公开仓库）.

Current real-model ComputerUse desktop validation: on 2026-07-04, the rebuilt v1.1.1 packaged release was rechecked against APInebula `gpt-5.4-mini` and Codex desktop Computer Use. `release:cli-smoke` passed the base packaged CLI surface, `release:111-cli-smoke` passed file/GitHub audit, remote security audit, ComputerUse dry-run/scroll/target guard, OpenSSH availability, and CLI Agent terminal takeover, and `release:111-ui-smoke` passed GitHub Models exact-login UI, fuzzy exclusion, and bottom-terminal takeover mirror with marquee border. `release:real-provider-smoke` passed real packaged CLI send, CLI UTF-8 send, real `validate-models`, real packaged UI UTF-8 send, real packaged UI send, screenshot capture, and key redaction. `release:real-ui-copilot-computeruse-smoke` passed against `_local/real-ui-user-test`, confirming the real UI root loads APInebula `gpt-5.4-mini` and imports GitHub Copilot as a `github_models` provider without token leakage. `release:computer-use-vision-smoke` passed packaged vision/non-vision ComputerUse behavior with UI Automation text, screenshot image only for the vision model, no temp path leaks, and no retained screenshots. `release:ui-icon-smoke` passed titlebar/runtime icon and adjustable animated border validation, and `release:ui-conversation-queue-plan-smoke` passed conversation-bound live streaming text, persisted folded tool results, queue drain, and isolation. A direct real-model packaged send then instructed `gpt-5.4-mini` to call `computer_use observe` exactly once; it exited `0`, produced marker `REAL_COMPUTER_USE_OBSERVE_OK_20260704`, recorded `computer_use`/`observe` in conversation state, reported UI text plus screenshot context, and left `%TEMP%\newmark-computer-use` without `observe-*.png` residue. Codex desktop Computer Use inspected the visible packaged Newmark window and confirmed the UI showed `APInebula / gpt-5.4-mini`, Build mode, Guide input mode, bottom PowerShell terminal, titlebar/icon, and sidebar controls. Evidence is stored in 本地归档（未纳入公开仓库）.

Current Linux/WSL GUI and real-model compatibility update: on 2026-07-06, the desktop stack was made Linux-buildable and validated inside `Ubuntu-24.04` on WSL2 with WSLg. The built-in bottom terminal and Agent `terminal_takeover` no longer assume PowerShell: runtime state exposes platform, available shells, configured default shell, and runtime default shell; Windows defaults to PowerShell while Linux defaults to bash; one-shot shell execution uses platform-specific command arguments; and PTY startup no longer injects Windows carriage returns into POSIX shells. `terminal.default_shell` defaults by platform, the Agent prompt/tool description states the active platform syntax, `clean` is cross-platform, Linux packaging has PNG icon plus deb metadata, and non-interactive CLI `state` now exposes platform-aware terminal shell fields. Validation passed Windows `npm.cmd test` with 878 assertions, WSL Linux `npm test` with 866 assertions, WSL `npm run dist:linux` producing AppImage/deb/linux-unpacked artifacts, WSLg packaged GUI smoke via `release:linux-gui-smoke`, and WSLg packaged real-model smoke via `release:linux-real-provider-smoke` against local APInebula `gpt-5.4-mini`. The real-model gate confirmed Linux packaged CLI marker `LINUX_REAL_CLI_OK_20260706`, Linux packaged GUI marker `LINUX_REAL_UI_OK_20260706`, renderer `platform=linux`, selected shell `bash`, visible `Terminal connected (bash)`, no API-key leakage, and screenshot evidence at 本地归档（未纳入公开仓库）. Computer Use native desktop control remains Windows-only and returns explicit unsupported results on Linux rather than crashing.

Current Computer Use takeover border regression fix: on 2026-07-05, the disappearing fullscreen ComputerUse border was traced to the generated PowerShell overlay script compiling inline WinForms C# without explicit `System.Windows.Forms`/`System.Drawing` references. The overlay now passes `Add-Type -ReferencedAssemblies`, checks that the created overlay process survives startup, uses duration-bound lifecycle for timed CLI invocations, keeps desktop Agent overlays owner-process-bound, and sets the region `GraphicsPath` fill mode to `Winding` so the four corner overlaps are not cut out. Verification passed `npm.cmd test` with 874 assertions, `npm.cmd run dist:portable`, packaged asar inspection, and packaged CLI `computer_use takeover_start`/`takeover_stop` with live PID survival. Evidence is stored in 本地归档（未纳入公开仓库）; Computer Use screenshots were not archived.

Current dev-0.0.1 release update: on 2026-07-05, public release metadata was advanced from dev-0.0.0 to dev-0.0.1 after the Computer Use takeover overlay regression fix. `DESKTOP/package.json` and `DESKTOP/package-lock.json` now carry version `0.0.1`; README download/update examples point to `Newmark-Agent-0.0.1-*` assets and describe the filled-corner, startup-checked takeover overlay. The release target is GitHub tag `dev-0.0.1`, with portable asset `Newmark-Agent-0.0.1-portable-x64.exe` SHA256 `43F0ADC95A9BB66B900C0E793D15C0D0B6C0AA6A2FB9BB594DE42791CA99596A` and zip asset `Newmark-Agent-0.0.1-win-unpacked-x64.zip` SHA256 `DF0BCA913D9C0382401F069853237BFBC465AD31EF580154F5302AF9FC8133B9`.

Current dev-0.0.2 release target: on 2026-07-07, public release metadata is being advanced from dev-0.0.1 to dev-0.0.2 so the GitHub release includes Linux assets in addition to the Windows portable and unpacked zip. `DESKTOP/package.json` and `DESKTOP/package-lock.json` now carry version `0.0.2`; README download/update examples point to `Newmark-Agent-0.0.2-*` assets. The intended release target is GitHub tag `dev-0.0.2`, with Windows portable/zip plus Linux AppImage/deb assets. Validation passed Windows `npm.cmd test` with 878 assertions, Windows `dist:portable` with embedded release CLI smoke, WSL Linux `npm test` with 866 assertions, WSL Linux `dist:linux`, WSLg GUI smoke, and WSLg real-provider smoke against the local APInebula `gpt-5.4-mini` config without printing API keys. Artifact SHA256 values are `8E9D0BD8091F048009EEE69953A0D5510564FAFC413279AB55C7E8939CA0AF7D` for `Newmark-Agent-0.0.2-portable-x64.exe`, `599AD4BA3BD981B152375FD83461C1D02755717A8A61B94D34E1C13AF391E93B` for `Newmark-Agent-0.0.2-win-unpacked-x64.zip`, `6D54E1436812EAEFEFF30AA3BF3A02CF7A20C177E5490A94BB24C63EF2FB584B` for `Newmark-Agent-0.0.2-x86_64.AppImage`, and `062A721098120D32E1958238B32B8ECF7CEA0B98C9319B0AE2C6CFF563F3A679` for `Newmark-Agent-0.0.2-amd64.deb`. The final GitHub release URL is recorded in 本地归档（未纳入公开仓库）.

Current model validation multimodal fix: on 2026-07-03, model validation was corrected so imported or stale metadata for frontier model identities such as `gpt-5.5` and compact `gpt5.5` no longer leaves them marked as non-vision. `DESKTOP/src/core/config.ts` now exposes shared model vision inference and initializes known multimodal families with `vision: true`; desktop `Agent.validateModels()` and CLI `validate-models` both report inferred `vision_input`, persist it back to model config, and refresh generated `multimodal=` descriptions instead of preserving stale `text-only` metadata. Verification passed `npm.cmd test` with 824 assertions, `npm.cmd run dist:portable`, embedded packaged `release:cli-smoke` with `ReleaseCliMock/gpt-5.5` persistence checks, and packaged `release:111-cli-smoke` on the rebuilt v1.1.1 artifacts. Later release slices added Computer Use takeover/app-scope and conversation Markdown rendering; the latest v1.1.1 artifact hashes are tracked in the maintenance workflow section. Evidence is stored in 本地归档（未纳入公开仓库）, 本地归档（未纳入公开仓库）, 本地归档（未纳入公开仓库）, and 本地归档（未纳入公开仓库）.

Current layout/pinning/archive scope update: on 2026-07-03, the desktop renderer gained last-open layout memory for sidebar expanded/collapsed state only. It persists left, left-secondary, right, and bottom panel booleans through `ui.left_panel_collapsed`, `ui.secondary_panel_collapsed`, `ui.right_panel_collapsed`, and `ui.bottom_panel_collapsed`, without restoring concrete page, tab, file, browser, or archive content. Workspaces now carry optional `pinned`/`pinnedAt` fields in `Work/Local.json` and `Work/External.json`, and conversations carry matching metadata in each workspace's `conversations/state.json`; both lists sort pinned entries first and expose compact pin buttons in the UI. Archive management is scoped: the right sidebar requests only active-workspace archives, while Settings > Archive requests all known root/workspace archives using stable internal archive IDs. Verification passed `npm.cmd test` with 815 assertions; evidence is stored in 本地归档（未纳入公开仓库）.

Current full-function release update: on 2026-06-28, release validation found and fixed an internal workspace lifecycle root cause. Internal workspace deletion now updates `Work/Local.json` and `Work/State.json` only after the `Work/<workspace>/` directory is actually removed, with contained-path checks, retry handling, and read-only bit clearing. The workspace manager UI now refreshes backend workspace state before rendering, CDP helpers clear successful response timers so completed release smoke/stress runs exit cleanly, `release:ui-smoke` now has an OS screenshot fallback for CDP capture timeouts, and real-provider stress now checks same-workspace conversation histories for cross-conversation marker leakage while omitting provider host/private URL from the report. Verification passed `npm.cmd test` with 586 tests, `dist:portable`, `release:ui-workspace-lifecycle-smoke`, `release:ui-smoke`, and `release:real-provider-stress`; the archive verdict is `release-usable`.

Current icon release update: on 2026-07-02, the `win-unpacked` Windows executable icon path was hardened after `release/win-unpacked/Newmark Agent.exe` still showed the default Electron association. `DESKTOP/scripts/patch-win-exe-icon.cjs` now patches the unpacked executable resource table directly through Win32 `BeginUpdateResource` / `UpdateResource` / `EndUpdateResource`, generating uncompressed DIB icon resources from `DESKTOP/assets/app-icon-dark.png` so Windows associated-icon extraction is stable. `dist:portable` patches and verifies `release/win-unpacked/Newmark Agent.exe` before zip creation, and `release:ui-icon-smoke` now validates the unpacked executable association in addition to `app.asar` icon assets, packaged renderer DOM presence, decoded image dimensions, `app-icon-border-spin` animation, native runtime window icon capture, screenshot evidence, and final release process cleanup. Current v1.1.0 artifact SHA256 values are `EFCC774B0D38C73CD1C9C948FA092B91F597C26E7D4DBDDC2C74409F27687B2F` for `Newmark-Agent-1.1.0-portable-x64.exe` and `8C1A72C054D16C37BC2FE4CB100A7F74F82255D026A5D762940280570E3901DF` for `Newmark-Agent-1.1.0-win-unpacked-x64.zip`.

Current repository branding update: on 2026-06-28, `SCRIPTS/assets/newmark-agent-social-preview.png` was added as the 1280x640 GitHub Social preview source image derived from the final app icon. GitHub does not expose a public REST field for directly setting the repository Social preview, so the asset is committed for manual upload through repository Settings. On 2026-07-05, the Social preview was regenerated without release/version text because it is a long-lived repository branding image; release numbers belong in README badges and GitHub Releases, not in the bitmap. Evidence is stored in 本地归档（未纳入公开仓库）.

Current fuzzy-injection update: on 2026-06-29, fuzzy provider injection gained a no-guide-model fallback. `DESKTOP/src/core/fuzzy.ts` now tokenizes raw text or env-file content into provider endpoint/API key fields, derives provider names from endpoint core domains, normalizes terminal API paths, and probes model-list plus OpenAI/Anthropic-compatible chat suffixes before falling back to heuristic model candidates. Both desktop `Agent.fuzzyInject` and CLI `fuzzy-inject` use the shared tokenizer/prober. A live local mock injection found and fixed local-address naming so `127.0.0.1` maps to `LocalProvider` and `localhost` maps to `Localhost`. Verification passed `npm.cmd test` with 598 assertions.

Current agent-compatibility update: on 2026-07-01, `DESKTOP/src/core/compat.ts` added canonical tool/result/plugin/agent-preset interfaces and emitters for OpenAI Chat Completions, OpenAI Responses, and Anthropic tool schema shapes. The CLI now has `compat --target all|tools|plugins|marketplaces|skills|agents|subagents` for non-visual debugging of normalized interfaces and `compat-tool --list|--name` for explicit OpenCode custom tool debugging. Skills discovery now includes `.agents/skills`, `.claude/skills`, user-level Codex/Claude/OpenCode skill folders, and plugin-packaged skills. Read-only plugin manifest discovery normalizes Codex `.codex-plugin/plugin.json`, Claude Code `.claude-plugin/plugin.json`, Newmark-native `.newmark-plugin/plugin.json`, OpenCode local tool/plugin files, OpenCode `opencode.json` package-plugin entries, plugin marketplace/catalog metadata, and MCP/LSP component metadata. Hook, MCP, LSP, and package-plugin components are reported with warnings and are not auto-executed or auto-started. Agent preset discovery normalizes Codex TOML agents and Claude/OpenCode markdown-frontmatter agents into a shared preset shape, and `task` can now use `preset` or `agent` to map those preset instructions/model/mode/input-mode metadata into a Newmark subagent. OpenCode local JavaScript custom tools can be executed only by explicit CLI request, while TypeScript tool files remain metadata-only unless a transpilation step is added. Subagents now expose structured records/envelopes with lifecycle timestamps and errors while preserving the existing model-visible transcript output. Verification passed `npm.cmd test` with 639 assertions plus CLI smoke checks for `compat --target all`, `compat --target marketplaces`, and `compat-tool --list`.

Current skills-market source update: on 2026-07-01, Skills Market gained user-managed market sources. `DESKTOP/src/core/skills.ts` persists user sources in local `skills/.market-sources.json`, keeps built-in sources read-only, supports `json`, `skill-url`, and `local-dir` source types, validates third-party catalog boundaries, and annotates discovered skills with source id/name metadata. CLI `skills-market` can now list, add, remove, enable, and disable sources while preserving query behavior, and the desktop Plugins > Skills Market panel exposes the same controls through Electron IPC and preload. Verification passed `npm.cmd test` with 651 assertions plus a `skills-market --sources` CLI smoke.

Current Memory Lab update: on 2026-07-01, Newmark added a root-level local persistent memory store at `Memory Lab/`. The Agent prompt only discloses the existence of Memory Lab in one line; index paths, usage instructions, tag graph, and memory markdown are returned only through the `memory_lab_read` tool. `memory_lab_update` accepts name, description, hierarchical tags, component content, and optional file/folder kind, then uses the current working model as a MemoryLabIndexAgent organizer before deterministic tag graph repair. CLI, Electron IPC, and Agent tool writes now share this Agent organizer path. The desktop left toolbar now opens a switchable Memory Lab viewer. Overview adapts the `WEB/index_overview.html` graph concept to real Memory Lab index data with draggable/zoomable tag and component nodes, focus modes, reset/clear controls, and Newmark-styled list menus. Detail centers the selected tag, places parent tags on the left, child tags on the right, and places attached memory components plus core markdown below. When the centered tag is a root tag, the left column shows all root tags instead of an empty parent column. The Detail graph intentionally has no connector lines; parent/child navigation re-centers with smooth directional animation, and tag search jumps directly to matching tags. CLI `memory-lab` exposes read/update/reindex commands, and packaged release CLI/UI smoke covers the Memory Lab paths.

Current real APInebula Memory Lab/model-switch update: on 2026-07-01, `release:real-apinebula-memory-switch-smoke` was added as an opt-in packaged release gate. It writes an isolated APInebula config from `NEWMARK_APINEBULA_KEY` or `NEWMARK_REAL_API_KEY`, validates the selected real model, prompts the real model to call `memory_lab_read` and `memory_lab_update`, verifies the created memory component and hierarchical tag graph through packaged `memory-lab`, and checks `fallback_on_unavailable` by starting from a pre-marked unavailable model and confirming a switch to the available APInebula model.

Current OpenAI Responses / Auto model update: on 2026-07-01, the TypeScript Agent kernel gained selectable OpenAI-compatible transport modes for streaming Chat Completions, non-stream Chat Completions, and direct Responses API calls while preserving Anthropic-compatible provider handling. Autonomous switching is now strictly bound to selecting `auto`: disabled mode hides/refuses Auto, Full Auto may choose across providers, and Provider Auto stays within the anchored provider. Model validation and import-generated descriptions include capability, speed, cost, and multimodal metadata; switching decisions use those descriptions/evaluations, reject candidates without enough context, and can switch to a vision-capable model for multimodal input. The desktop toolbar now renders the context-token budget as a small ring beside the model selector, with hover details for used/max tokens and percentage. Desktop Agent sends now use per-conversation runner Agents, so one conversation can continue working while the user switches to and starts another; same-conversation input still queues and drains in order. The renderer subscribes to `agent:workEvent` and displays live work events for visible text deltas, tool calls, tool argument summaries, and tool results while keeping hidden reasoning sanitized. `release:ui-model-auto-context-smoke` covers the packaged Models UI controls and context ring placement/tooltip, `release:cli-smoke` verifies CLI state includes Auto scope, OpenAI API mode, and context window fields, and `release:ui-conversation-queue-plan-smoke` now validates packaged multi-conversation parallel execution plus isolation. Current v1.1.0 user-test configuration points to `APInebula/gpt-5.4-mini`; packaged CLI `validate-models` reports it available, packaged `send` over `chat_stream` returned `NEWMARK_REAL_STREAM_READY_20260701`, and packaged Electron/CDP inspection confirmed the main model selector plus Models settings page show the APInebula model as available with `ctx 128000`.

Current native Agent kernel update: on 2026-07-01, the conversation/Agent runtime moved from the older monolithic `Agent.process` loop to a project-native TypeScript kernel under `DESKTOP/src/core/agentKernel/`. The implementation follows pi-agent-core style concepts for agent loop lifecycle, steering/follow-up queues, tool execution events, and streaming message events, but is now native Newmark code, not an external npm dependency and not a vendored runtime. `DESKTOP/src/core/agentKernelRunner.ts` adapts Newmark providers, tools, Memory Lab, Flow, automation, subagents, model fallback, and Goal continuation to the native kernel. `DESKTOP/src/core/conversationKernel.ts` manages one runner per conversation, mirrors completed background transcripts into the host conversation store without contaminating the active foreground view, and keeps same-conversation queued input ordered. Verification passed 747 unit/integration assertions, packaged long-running parallel conversation smoke with foreground/background work-event replay, packaged Goal continuation smoke, no external `@earendil-works/pi-*` runtime dependencies, and absent root/DESKTOP source `vendor/` folders.

Current foreground/background queue update: on 2026-07-02, the native `conversationKernel.ts` adopted the useful pi AgentSession/TUI pattern of treating session queue state as backend-owned runtime state rather than UI-only state. Each conversation runtime now exposes steering/follow-up queue snapshots, sends `queue_update` work events with payloads, returns queue state from desktop IPC, and clears backend queue state when the native kernel emits user `message_start` or when fallback next-turn work drains. The Electron main process now creates conversation kernels through one event-subscribed helper, refuses to discard a running conversation kernel during toolbar mode/model synchronization, and `agent:getState` returns the active conversation's cached work-event snapshot. The renderer caches backend queue updates and merges backend work-event snapshots when foregrounding a conversation, so background Agent text/tool/queue events remain inspectable without changing the visible layout. Verification passed `npm.cmd test` with 747 assertions, refreshed the v1.1.0 portable/zip release artifacts, confirmed built `dist/core` files contain the queue payload and `message_start` wiring, and passed packaged `release:ui-conversation-queue-plan-smoke` for parallel conversations, foreground/background work-event replay, queue drain, and isolation.

Current Agent work timeline update: on 2026-07-02, the renderer stopped showing internal workflow status rows such as preparing, executing, and raw tool-result messages. The chat surface now streams assistant text directly into the assistant response while tool activity is grouped into a single folded batch per turn. The batch summary reports editing/tool counts in the active UI language, including `正在编辑 x 个文件，正在使用 x 个工具` during execution and `已编辑 x 个文件，已使用 x 个工具` after completion; expanding the batch reveals nested folded entries for each tool's arguments and result. Backend status events are no longer persisted as workflow chat messages, tool-call IDs are carried through work events for stable grouping, ordinary tool results no longer become final assistant text, and terminating tool results for Flow, Memory Lab, automation, subagent management, and questions remain visible. Verification passed `npm.cmd test` with 760 assertions.

Current Build activity expansion fix: running Build blocks retain the user's nested tool-detail expansion across live event reconciliation, while the one-second duration tick updates only the title text instead of rebuilding the event DOM. Stable activity keys restore an open detail after a genuine event refresh; completed blocks remain manually expandable. The release UI smoke covers both a tool-result refresh and a subsequent timer tick.

Current CLI mode update: on 2026-07-01, packaged CLI behavior now distinguishes workspace conversation mode from explicit pure Agent mode. Normal CLI sends still use the selected workspace and persist conversation transcripts that the desktop UI can read and continue. `--agent-only` runs the Agent without auto-creating or requiring a workspace, does not write workspace conversation state, and is the intended no-workspace base for one-shot Agent calls, model validation, fuzzy injection, and subagent-style execution. `install-update` provides a CLI-agentable portable update path with version checks, dry-run output, GitHub Release check/download support for compiled zip packs, and default preservation for local state such as `config.json`, `Work/`, `skills/`, `Memory Lab/`, and 本地归档（未纳入公开仓库）. The desktop Settings window exposes an Updates tab that calls the same GitHub/local dry-run update APIs. `release:cli-ui-conversation-sync-smoke` proves CLI/UI conversation sync, and `release:cli-smoke` covers packaged install-update behavior.

Current local-model update: on 2026-06-29, the built-in Gemma download entry was removed from the desktop Models settings UI, preload bridge, and Electron main IPC. Newmark no longer shells out to `ollama pull` or auto-creates an Ollama/Gemma provider. Users can still install Gemma or other local models themselves through Ollama or another runtime and add them as normal OpenAI-compatible providers/models, including through fuzzy injection against a local endpoint. Verification passed `npm.cmd test` with 598 assertions.

Current copyright update: on 2026-06-29, project copyright and third-party notice posture was declared. Root `LICENSE` now states that first-party Newmark Agent code, documentation, design, and project-specific assets are proprietary/all-rights-reserved unless future written release metadata grants otherwise. `THIRD_PARTY_NOTICES.md` records detected npm, Lucide, branding-asset, ignored-reference, and release obligations. Electron packaging includes both files through `DESKTOP/package.json` and `DESKTOP/electron-builder.config.ts`. Verification passed dependency/license metadata scans and `npm.cmd test` with 598 assertions.

Current reference-material update: on 2026-06-29, open-source reference material was audited separately from bundled dependencies. `THIRD_PARTY_NOTICES.md` now declares OpenCode and OpenCode goal plugin as MIT reference/vendor material, Liquid Glass React and Liquid Glass Studio as MIT visual/reference material, liquid-dom as partially/unclearly licensed reference-only material, Apple Liquid Glass as a documentation/design-concept reference rather than bundled code, and Codex/OpenCode CLI as optional external tool integrations governed by upstream terms. `_vendor/`, `_ref/`, and `skills/` must be reviewed before public distribution if they are ever included. Verification passed source/reference scans and `npm.cmd test` with 598 assertions.

Current README update: on 2026-06-29, the public README was visually reorganized for GitHub presentation. It now opens with the repository social-preview image, centered title/badge block, an at-a-glance capability table, a contents table, and a status-oriented Highlights table while preserving setup, provider, release, hygiene, and license content. Verification passed `npm.cmd test` with 598 assertions before push.

Current ignore update: on 2026-06-29, `skills/` was moved into the ignored local project state category. `.gitignore` now ignores `skills/`, README repository hygiene lists it with other excluded local/runtime records, and the tracked skill files should be removed from Git's index with `git rm --cached -r skills` while preserving the local folder.

Current GitHub release update: on 2026-06-28, `v1.0.1` was published from the release documentation commit on `master`; the application code baseline before release-documentation updates was `9ad066d1ba0005d4cd5bb5bcc777f7f7868676bc`. The public asset is `release/Newmark-Agent-0.0.1-portable-x64.exe` (SHA256 `8D84F5984CD969A03D8F435BF0E19D6EF2AE765DC2B1D590B0FB88E75CEC5D65`). Final pre-release gates passed `npm.cmd test` with 586 tests, `dist:portable` producing the verified portable executable after the child process completed beyond the local wrapper timeout, `release:ui-smoke`, and final release process cleanup count `0`. The publish judgment is `release-usable-with-operational-risks`: Newmark is a publishable Agent terminal by packaged-path evidence, with remaining risk in large-scale telemetry, installer distribution, code signing, and field monitoring.

Current media/Markdown update: on 2026-07-03, the conversation page renderer now uses the same safe Markdown rendering path as the right-side Markdown viewer. `DESKTOP/src/ui/index.html` renders escaped Markdown blocks for headings, paragraphs, lists, blockquotes, fenced code, tables, image links, file links, normal links, inline code, emphasis, and TeX-style inline/block formulas without executing raw HTML. `release:ui-media-md-smoke` now drives the real packaged Electron UI and verifies a conversation message containing a heading, data image, workspace file link, Markdown table, inline formula, and block formula, then verifies the file link opens the right Editor, Markdown files still open in the MD viewer, and the file tree lists both smoke files.

Current skills update: on 2026-07-01, the unit/CLI/UI-source regression layer covers Plugins > Skills Market search, deterministic local `SKILL.md` install, runtime skills refresh without restart, installed skill disable/enable/removal, and user-managed market sources. The older `release:ui-skills-smoke` packaged evidence still covers the search/install/refresh/enable/disable/remove path; source-management UI has source-code and IPC regression coverage and should receive packaged CDP coverage before release.

Current conversation continuation update: on 2026-06-28, the renderer default conversation ID was aligned with the Agent backend `default` conversation ID. `release:ui-conversation-queue-plan-smoke` now provides real packaged UI evidence for right-sidebar Plan isolation across conversations, active-turn conversation switch locking, queued input while a turn is running, automatic queued prompt drain into the next Build turn, and chat isolation after the queued continuation.

Current startup recovery update: on 2026-06-28, `release:ui-startup-recovery-smoke` added fresh destructive packaged UI evidence for startup companion recovery. It launches the real release exe with a temporary root after deleting `skills/`, `Work/`, `Flow/`, 本地归档（未纳入公开仓库）, `config.json`, `agent.md`, and `PC_Hash.config`, then verifies `Flow/Flow.md`, `Work/Local.json`, `Work/External.json`, `Work/State.json`, default timestamp internal workspace creation, renderer workspace state, screenshot capture, and process cleanup.

Current Goal update: on 2026-06-28, `release:ui-goal-continuation-smoke` added real packaged UI evidence for autonomous Goal continuation without a max-depth stop. It drives the real renderer/preload/Agent path with a local mock provider, observes three Goal model calls before `[Goal Complete]`, verifies no max-depth warning in result or renderer state, captures screenshot evidence, and cleans up release processes.

## Root Layout

```text
Newmark Agent/
  README.md                 Product description, quick start, and maintenance log.
  LICENSE                   First-party proprietary/all-rights-reserved project copyright declaration.
  THIRD_PARTY_NOTICES.md    Dependency, asset, and release notice audit summary.
  OVERVIEW.md               This project map and operational guide.
  Design.md                 Product/design notes and feature design material.
  config.json               Global annotated Newmark configuration.
  agent.md                  Global prompt appended to agent sessions.
  PC_Hash.config            Local host binding/fingerprint data.
  SETUP.ps1 / setup.sh      Setup entrypoints for Windows and shell environments.
  run_flow.js               Root helper for Flow execution experiments.
  本机私有归档（已从公开仓库排除）                  Dated validation reports and screenshot evidence.
  conversation-media/       Runtime-created, content-addressed user conversation attachments; never Computer Use frames.
  Work/                     Root internal/external workspace registries and internal workspace data.
  Flow/                     Root Flow workflow definitions and Flow.md schema guidance.
  skills/                   Installed or vendored skills for offline use; release-time license review required if published.
  DESKTOP/                  Electron desktop implementation and TypeScript core.
  WEB/                      Static web/demo entrypoint.
  SCRIPTS/                  Release/publish helper scripts.
  _ref/                     Reference material used during implementation research; not automatically distributable.
  _vendor/                  Vendored third-party references or downloaded examples; not automatically distributable.
  _attic/                   Older experiments and migration leftovers.
  release*/                 Generated packaged builds and verification outputs.
```

## Important Root Files

- `README.md`: public-facing product and setup document. Every work slice should update the Maintenance Log with the date, scope, verification, and archive link.
- `LICENSE`: root first-party copyright declaration. Current posture is proprietary/all-rights-reserved unless a future explicit release license grants more rights.
- `THIRD_PARTY_NOTICES.md`: current third-party license audit summary for npm, icons, project-specific assets, ignored reference/vendor material, and release obligations.
- `OVERVIEW.md`: operational map for future maintainers. Keep it current when directories, major files, or ownership boundaries change.
- `config.json`: global settings schema and active defaults. Workspace-specific differences should live in each workspace root `config.json`.
- `agent.md`: global prompt layer used in prompt construction.
- `PC_Hash.config`: machine binding record for external workspace access checks.
- `Design.md`: product/design reference for the large Newmark feature plan.
- `run_flow.js`: root-level Flow runner helper, separate from the TypeScript desktop Flow runtime.

## `SCRIPTS/`

`SCRIPTS/` stores release notes and public release/branding helper assets. `release-notes-dev-0.0.10.md` is the publication-ready Windows prerelease body and records changes, migration, gates, sizes, checksums, the unsigned boundary, and the explicit dev-0.0.9 Linux fallback. `SCRIPTS/assets/newmark-agent-social-preview.png` is the repository Social preview source image intended for GitHub Settings upload. It must stay version-free and release-agnostic; do not embed package filenames, release numbers, or temporary release status inside this bitmap.

## 本地归档（未纳入公开仓库）

本地归档（未纳入公开仓库） stores dated maintenance records and visual evidence. Each substantial work slice should add one Markdown file named `YYYY-MM-DD-<slug>.md` with:

- request and scope
- failure symptoms
- root cause
- files changed
- verification commands
- desktop-control evidence paths
- remaining risk

Visual UI regression screenshots are stored here beside the Markdown record. Computer Use desktop screenshots are explicitly excluded from this rule: they are one-time model inputs only and must be deleted immediately after request preparation or before non-vision/direct tool results return.

For dev-0.0.9, `2026-07-14-dev-0.0.9-acceptance.md` is the requirement-by-requirement acceptance ledger, `2026-07-14-0934-dev-0.0.9-final-hardening.md` is the final red-team/package-matrix addendum, and the curated tracked `2026-07-14-dev-0.0.9-release.md` records public publication plus remote-download verification. The corresponding prewarm, work-run, and PDF/Browser-Use PNG files are ordinary CDP UI evidence and intentionally keep the original 2026-07-13 slice names.

The dev-0.0.10 records separate industrial-routing research, focused source implementation, formal performance evidence, and final acceptance. `2026-07-15-dev-0010-cli-tool-anthropic.md` is the authoritative redacted record for the already-completed three-call OpenAI-Hub test; do not repeat that real-provider run during ordinary closure. `2026-07-15-dev-0.0.10-performance.json` is the authoritative completed 20-run benchmark record and reports `acceptancePassed=true`; performance values must be read from that artifact rather than invented from source inspection. `2026-07-15-dev-0.0.10-integration-acceptance.md` is the final local source/package acceptance ledger, including artifact sizes/hashes, exact smoke outcomes, and the non-publication boundary.

## `conversation-media/`

`conversation-media/` is runtime-created local user data beneath the selected Newmark state root, normally `~/.Newmark`; it is not source or release content. `conversation-media/user-images/<sha-prefix>/<sha256>.png|jpg` stores validated user-submitted conversation images by decoded-byte SHA-256 so reload/restart and stable attachment IDs do not depend on a temporary clipboard data URL. The storage boundary accepts at most six PNG/JPEG images per submission, 10 MiB per image and 30 MiB in aggregate, verifies decoded MIME and canonical hash paths, and writes atomically. Conversation archives receive their own 本地归档（未纳入公开仓库） copies. Computer Use observation frames must never enter this folder: they remain temporary current-turn inputs and are deleted or discarded by the Computer Use bridge.

## `Work/`

`Work/` stores workspace registries and internal workspaces:

- `Work/Local.json`: internal workspace list.
- `Work/External.json`: external workspace list and host-binding fields.
- `Work/State.json`: active workspace selection used during restart recovery.
- `Work/<workspace>/`: internal workspace data, prompt/config overrides, archives, and working files.

The intended model is that conversations and archives are scoped to the selected workspace. If no workspace is selected, Newmark should create an internal timestamp workspace by default. Conversation state is additionally partitioned by conversation ID inside the active workspace; renderer conversation changes must call the backend conversation switch API and then reload `chatMessages` from `agent:getState`.

`Work/State.json` stores the active workspace selection (`name`, `path`, and `isInternal`) so a restarted packaged app restores the same workspace before loading conversation state. When this state file is missing, the workspace manager falls back to the latest known internal/external workspace instead of creating a new timestamp workspace.

Per-workspace conversation state is persisted under `<workspace>/conversations/state.json`. Schema v3 stores a generated state key, public conversation ID, summary title, chat messages, model/tool history, current Plan/Linked Plan, Subagent state, public `workRuns`, Guide/continuation records, and update timestamp; v1/v2 load with empty new collections instead of destructive rewrites. Empty conversations may initially use the conversation ID as a generated title, but the first real user message replaces that generated title with a local summary. New desktop calls should carry an explicit composite target; legacy conversation-id-only wrappers bind to the current workspace for compatibility.

## `Flow/`

`Flow/` stores workflow definitions:

- `Flow/Flow.md`: offline guidance for `*.Flow.json` format.
- `Flow/*.Flow.json`: executable workflow definitions.
- `Flow/FlowEditor.html`: earlier or standalone Flow editor reference.

Flow workflows consist of Dialog components and Logic components. Dialog components run Build/Plan/Goal prompts. Logic components evaluate implementation state and jump by address.

## `skills/`

`skills/` is the project-local offline skill store. It currently includes UI/design skills such as:

- `skills/design-taste-frontend/`
- `skills/ui-ux-pro-max/`
- `skills/Flow/`

Skill content should be usable offline once installed. Skill management is exposed from the desktop Plugins UI. Plugins > Skills Market includes local client-side search over skill name, description, source, path, and URL, with filtered/total count and no-match feedback. The Electron IPC layer exposes `skills:refresh`; install/download/toggle/remove operations rebuild the runtime `SkillsManager` so prompt injection can use changed skills without restarting the app.

## `DESKTOP/`

`DESKTOP/` is the active Electron app.

```text
DESKTOP/
  package.json              npm scripts, dependencies, and electron-builder config.
  package-lock.json         Locked npm dependency graph.
  tsconfig.json             TypeScript compiler settings.
  config.json               Desktop-local config used by packaged/dev runs.
  agent.md                  Desktop-local prompt file.
  PC_Hash.config            Desktop-local host binding data.
  electron-builder.config.ts Additional builder config reference.
  scripts/                  Build helper scripts.
  src/                      TypeScript source and UI shell.
  Flow/                     Desktop-packaged Flow files.
  Work/                     Desktop-local workspace registry.
  dist/                     Generated build output.
  node_modules/             Installed npm dependencies.
```

### `DESKTOP/scripts/`

- `build-windows-process-tree-helper.cjs` and `windows-process-tree-helper.cs`: compile the Windows process-tree identity/termination helper ahead of time into `dist/windows-process-tree-helper.dll`, validate its PE header, and avoid runtime C# compilation on the normal packaged path. Non-Windows builds skip this Windows-only output.
- `build-typebox-compile.cjs`: bundles `typebox/compile` as Electron Node 20-compatible CommonJS in `dist/typebox-compile.bundle.cjs`, so schema compilation does not depend on loading the package's source module layout from inside `app.asar`.
- `build-ui-icons.cjs`: builds `dist/ui/index.html` from `src/ui/index.html`, copies the static failure/retry `src/ui/startup.html` into `dist/ui`, intersects source string references with the installed Lucide catalogue, embeds the 72 reachable open-source symbols, rewrites icon references to local `href="#icon"`, and writes the same trimmed `lucide-sprite.svg` for compatibility. This preserves Electron/asar icon reliability without injecting the complete 1,700+ symbol catalogue into the renderer DOM.
- `build-conversation-utility-host.cjs`: bundles `src/conversation-utility-host.ts` into the Node-targeted `dist/conversation-utility-host.bundle.cjs` loaded by Electron `utilityProcess.fork`; `node-pty` stays external so packaged native bindings resolve from the application runtime.
- `build-wsl-agent-host.cjs`: bundles `src/wsl-agent-host.ts` into `dist/wsl-agent-host.bundle.cjs` for the target-owned WSL Node process. Stdout remains reserved for JSONL RPC and diagnostics use stderr.
- `release-dev009-features-smoke.cjs`: packaged dev-0.0.9 CDP acceptance harness for composite runtime status, workspace/background behavior, target-scoped optimistic Guide reconciliation across snapshot redraws, deduplicated workspace/stop failures, public-natural-language and tool-name/status work-run privacy, persistent folding, editor/Markdown transitions, cold Browser-Use against the same prewarmed embedded guest before the Browser tab is opened, real loopback PDFium rendering with pixel gates, and target stop/restart behavior. It passed against both the final Windows package and an independently extracted update ZIP.
- `release-dev010-features-smoke.cjs`: executable-selected 19-check packaged gate (`NEWMARK_TEST_EXE`) that inspects the exact artifact's `app.asar` for Auto/validation/glass/lazy-WebView contracts, then verifies persisted Auto intent/scope and packaged CLI envelope/exit behavior under an isolated root without calling a real provider. Final ZIP/MSI runs pass with `real_api_called:false`.
- `release-ui-model-auto-context-smoke.cjs`: packaged Electron/CDP model-routing UI gate. In addition to Auto scope and context-ring behavior, it switches the real grouped model selector between dark and light themes, reads computed select/option/optgroup/selected colors, composites transparent control backgrounds, enforces WCAG AA contrast, and terminates only the spawned process tree so `NEWMARK_TEST_EXE` can safely target either `release/win-unpacked` or Program Files.
- `benchmark-dev010-startup-memory.cjs`: conservative Windows twenty-run process-cold benchmark using fresh runtime/profile roots. It measures interactive P50/P95/max, four-times-CPU input latency, no startup guest in the first five seconds, first Browser demand, and recursive process private bytes before and after Browser creation. Startup memory accepts P95 `<=525 MiB` or a reduction of at least 25% from the configured 696 MiB baseline. Browser-on-demand acceptance separately requires total P95 `<=696 MiB` and same-run incremental P95 `<=300 MiB`. The JSON output preserves both sample sets, deltas, process classifications, gate limits, and headroom, and is written only through an explicit output path.
- `release-cli-smoke.cjs`: runs the executable selected by `NEWMARK_TEST_EXE` (or `release/win-unpacked/Newmark Agent.exe`) through redirected PowerShell `Start-Process` calls and validates `state`, unified direct-tool JSON, sends, Standard health/strict-JSON/tool/tool-result/vision probes, `skills-market`, Anthropic fuzzy injection, env-file injection, and redacted failure warnings. Its deterministic local mock implements both OpenAI and Anthropic Standard probe shapes.
- `release-ui-smoke.cjs`: launches the real packaged `release/win-unpacked/Newmark Agent.exe` with Electron remote debugging and validates the renderer through CDP. Current coverage switches language `en -> zh -> en`, verifies document language, prompt placeholder, primary and secondary sidebar labels, right/editor/sub-window close labels, persisted `config.json`, secondary-window titles for fuzzy injection/plugins/Flow/new conversation/workspace-required, screenshot capture with OS fallback, temporary-root cleanup, and process cleanup.
- `release-ui-agent-smoke.cjs`: launches the real packaged desktop UI with a temporary root and local streaming mock provider, sends through the renderer `#prompt` plus `window.sendMessage()`, and verifies `write -> bash(timeout_ms=10000) -> edit -> read -> final`, workspace file effects, terminal timeout cap `0`, hidden hover mode/model metadata, screenshot capture, temporary-root cleanup, and process cleanup.
- `release-gui-no-model-smoke.cjs`: launches the rebuilt packaged GUI with an empty-provider temporary root, submits through the real renderer `#prompt`/`window.sendMessage()` path, and asserts the IPC result, renderer runtime, WorkRun, visible diagnostic, idle backend, and no-`done`/no-`final_response` contract. It is included in `release-safe-blackbox-gates.cjs`.
- `release-ui-acceptance-smoke.cjs`: launches the real packaged desktop UI with a temporary root and local streaming mock provider, then validates a broader user-level path: internal workspace creation, Build workspace file write, Plan write blocking, Goal pause/resume, Flow save/run, workspace-local archive creation, screenshot capture, app restart, and restoration of the active workspace/conversation/archive state.
- `release-ui-integration-smoke.cjs`: launches the real packaged desktop UI with a temporary root and local streaming mock provider, drives the renderer `#prompt` plus `window.sendMessage()`, and verifies Browser tools, `gh_auth_status`, `automation_create`, `automation_list`, automation config persistence, screenshot capture, temporary-root cleanup, and process cleanup.
- `release-ui-external-workspace-smoke.cjs`: launches the real packaged desktop UI with a temporary root, creates an external workspace through the New Workspace UI path, verifies runtime host binding persistence in `Work/External.json`, verifies `Work/State.json` selection, creates a workspace-local archive under the external workspace, mutates the saved external host binding to simulate another PC, relaunches, and verifies the external workspace is hidden/filtered.
- `release-ui-option-feedback-smoke.cjs`: launches the real packaged desktop UI with a temporary root and local streaming mock provider, validates all four option-feedback levels, verifies structured options render into the workflow timeline and right Status panel, verifies `fully_autonomous` disables the `question` path, verifies `outside_readonly` + `ask_user` reports `User approval required` without writing the outside file, and captures screenshot evidence.
- `release-ui-model-settings-smoke.cjs`: launches the real packaged desktop UI with a temporary root, drives Settings > Models through Electron CDP, and verifies provider/model add/edit/delete, renderer API-key redaction, key-preserving provider rename/edit, annotated config schema reads, screenshot capture, temporary-root cleanup, and process cleanup.
- `release-ui-gemma-removal-smoke.cjs`: launches the real packaged desktop UI with a temporary root, opens Settings > Models through Electron CDP, verifies the packaged preload no longer exposes `downloadGemma`, verifies Gemma/Ollama download wording is absent, verifies fuzzy injection and manual provider/model controls remain visible, persists a manual local OpenAI-compatible provider at `http://127.0.0.1:11434/v1`, persists a manual local model, captures 本地归档（未纳入公开仓库）, and cleans up packaged release processes.
- `release-ui-flow-subagent-smoke.cjs`: launches the real packaged desktop UI with a temporary root and local streaming mock provider, drives real renderer `window.sendMessage()`, verifies Agent-initiated `flow_save`/`flow_list`/`flow_run`, confirms the saved Flow preserves `{#prompt#}`, verifies `task`/`subagent_send`/`subagent_result`/`subagent_close`, and opens the right Subagents panel to prove closed subagents remain as retained read-only history.
- `release-ui-media-md-smoke.cjs`: launches the real packaged desktop UI with a temporary root, creates a workspace through the preload API, writes text and Markdown files, injects a conversation message containing a heading, data image, local file link, Markdown table, inline formula, and block formula, verifies the rendered `.md-table` and `.md-math-*` nodes, clicks the file link to open the right Editor, switches a Markdown file to the integrated preview view, verifies the file tree lists both files, captures screenshot evidence, and cleans up release processes.
- `release-ui-native-editor-smoke.cjs`: validates the packaged native editor through CDP, including TypeScript token highlighting, line numbers, Vim delete/undo, opt-in debounced prediction display, completion acceptance, file save, and Markdown-preview visibility rules.
- `release-real-editor-copilot-smoke.cjs`: uses the rebuilt packaged application with the normal user config to request a real editor completion and reports only provider, model, and returned character count so credentials and generated source are not printed.
- `release-ui-skills-smoke.cjs`: launches the real packaged desktop UI with a temporary root, opens Plugins > Skills Market, verifies searchable no-match behavior, installs a deterministic local `SKILL.md` through the real preload API, refreshes the skills runtime without restart, verifies installed skill disable/enable/remove behavior in the Plugins UI, captures screenshot evidence, and cleans up release processes.
- `release-ui-conversation-queue-plan-smoke.cjs`: launches the real packaged desktop UI with a temporary root and local mock provider, verifies current-conversation Plan isolation in the right sidebar, parallel conversation execution, conversation-bound live streaming text, foreground/background work-event replay, persisted folded tool results, same-conversation queue drain, the bottom editable queue UI instead of legacy chat queue rows, post-drain chat isolation, screenshot evidence, and release process cleanup.
- `release-ui-fast-conversation-switch-smoke.cjs`: launches the real packaged desktop UI with a temporary root and local mock provider, creates A/B conversations with unique markers, rapidly switches by conversation ID, verifies visible `#chat-area` isolation and a single active conversation list item, captures final A/B screenshots, and cleans release process residue.
- `release-ui-workspace-conversation-isolation-smoke.cjs`: launches the real packaged desktop UI with a temporary root and local mock provider, creates workspace alpha/beta conversations with unique markers, rapidly switches workspaces and conversations, verifies `#chat-area` and scoped backend snapshots only show the active workspace's markers, captures final alpha/beta screenshots, and cleans release process residue.
- `release-linux-gui-smoke.cjs`: Linux-only packaged GUI smoke. It launches `release/linux-unpacked/newmark-agent` under WSLg or another Linux display server with Electron CDP, verifies renderer platform/default terminal shell state, checks the visible bottom terminal is connected to bash, captures 本地归档（未纳入公开仓库）, and kills the Electron process group after validation.
- `release-linux-real-provider-smoke.cjs`: Linux-only packaged real-provider smoke. It copies a local real-provider config into a temporary Linux root, runs packaged CLI `state` and real `send`, launches the packaged WSLg GUI through CDP, sends a real model prompt, verifies CLI/UI markers exactly once, checks platform/default shell state and secret redaction, captures 本地归档（未纳入公开仓库）, and removes the temporary root.
- `release-ui-startup-recovery-smoke.cjs`: launches the `NEWMARK_TEST_EXE` packaged desktop with a destructive isolated root, requires one application page/CDP target for the in-page startup cover and final desktop, waits for minimal `state/rendered` promotion, measures startup immediately at that boundary, enforces an eight-second single-run ceiling, proves no Browser guest exists before demand, then requires exactly one target-bound `persist:newmark-browser-<workspace/conversation>` guest after opening Browser. It also validates companion-file/default-workspace recovery and process cleanup without attaching a second startup inspector that could perturb same-target navigation timing.
- `release-ui-work-review-bars-smoke.cjs`: uses an OS-assigned CDP port plus bounded HTTP/WebSocket discovery to validate the packaged work/review bar geometry without fixed-port collisions or unbounded discovery hangs.
- `release-ui-image-display-stress.cjs`: drives 120 sequential `image_display` call/result pairs through a real Electron renderer, checks exact expanded/collapsed ordering and uniqueness, writes a JSON performance report, and captures expanded, collapsed, and zoomed-overview evidence.
- `release-image-insertion-position-stress.cjs`: interleaves 24 `image_display` results with Bash and progress events, validates each GUI image against its owning tool row plus the collapsed Build gallery position across 20 fold cycles, and runs the equivalent TUI event-order/terminal-geometry assertions with combined visual evidence.
- `release-tui-viewer-stress.cjs`: launches real standalone `--newmark-viewer` Electron processes in five concurrent waves, validates image and Memory Lab graph-only DOM isolation, one-use request consumption, process cleanup and startup latency, and captures both viewer surfaces.
- `release-ui-runtime-layout-smoke.cjs`: real Electron/CDP regression for runtime/layout behavior. The 2026-07-15 extension re-clicks the active workspace after closing the secondary pane, proves the pane reopens without changing the focused conversation, applies and reloads custom background/font preferences, renders a durable user-image card, and captures only ordinary UI evidence; it never stores a Computer Use capture.
- `cdp-main-ui-ready.js`: shared release-CDP promotion gate. It polls the attached final target until the document is visible and complete with the preload API and prompt mounted; all 40 main-renderer connections across the 38 `/json/list` release scripts await it immediately after socket readiness and before enable/bring-to-front/evaluate/input work. The startup-recovery splash-icon probe is the sole explicit non-main-target exception.
- `release-ui-workspace-lifecycle-smoke.cjs`: launches the real packaged desktop UI with a temporary root, creates/selects/deletes internal workspaces through the real preload/workspace path, verifies `Work/Local.json`, `Work/State.json`, workspace directory removal including nested conversation state, async workspace-manager backend refresh, screenshot evidence, CDP timer cleanup, and release process cleanup.
- `release-ui-goal-continuation-smoke.cjs`: launches the real packaged desktop UI with a temporary root and local mock provider, sets a Goal through the preload API, sends one Goal prompt, verifies repeated autonomous continuation through at least three model calls, rejects max-depth warnings, captures screenshot evidence, and cleans up release processes.
- `release-real-provider-smoke.cjs`: opt-in real-provider smoke. It is skipped by default unless `NEWMARK_APINEBULA_KEY` or `NEWMARK_REAL_API_KEY` is set, then writes an isolated temporary APInebula config, runs real packaged CLI `state`/`send`, runs real packaged CLI `validate-models` when `NEWMARK_REAL_VALIDATE_MODELS=1`, runs a real packaged UI `window.sendMessage()` path through CDP, waits for assistant-scoped marker rendering plus backend `idle` state, asserts CLI/UI marker counts are exactly one to catch duplicate final replies, captures assistant/backend debug summaries on marker wait failures, captures a screenshot, and guards against key leakage. `NEWMARK_REAL_UTF8=1` additionally verifies Chinese packaged CLI and real UI send paths. Claude env-file fuzzy injection remains behind `NEWMARK_REAL_INCLUDE_CLAUDE_ENV=1`.
- `release-real-apinebula-memory-switch-smoke.cjs`: opt-in real APInebula release gate for Memory Lab and model switching. It validates the selected APInebula model, asks the real model to call Memory Lab read/update tools, verifies the created component and tag graph through packaged CLI, checks unavailable-model fallback to the available APInebula model, and redacts API keys from failures.
- `release-temp-context-conversation-stress.cjs`: disposable-root packaged stress gate for zero-interval conversation creation/archive, long-context switching, sustained 300-component Memory Lab queries, one-shot visualization preload, optimistic-concurrency races, restart recovery, latency budgets, and cleanup.
- `release-ui-memory-lab-smoke.cjs`: packaged Electron/CDP gate for the Memory Lab one-shot lifecycle. It proves visualization load counts advance only on open, Reset, and successful reindex while component click, Detail, tag navigation, drag, and zoom stay on the retained in-memory graph and content snapshot.
- `release-real-provider-stress.cjs`: opt-in real-provider stress gate for the packaged release. It reads `NEWMARK_REAL_STRESS_BASE_URL`, `NEWMARK_REAL_STRESS_KEY`, `NEWMARK_REAL_STRESS_MODEL`, and `NEWMARK_REAL_STRESS_PROTOCOL=openai|anthropic`, falling back to existing `ANTHROPIC_*` or APInebula variables when available. It runs repeated packaged CLI sends, repeated desktop UI sends through Electron CDP, Goal continuation, queued prompt drain, same-workspace conversation isolation, long-context send, secret-leak guards, final release process cleanup, and writes a dated 本地归档（未纳入公开仓库） verdict report.
- `release-safe-shared-root-restart-stress.cjs`: runs the rebuilt Windows GUI/TUI/CLI entrypoints from a protected-install-shaped working directory with a spaced temporary root, restarts the shared GUI state, verifies root redirection and no Program Files mutation, and cleans the owned process tree.
- `release-installed-readonly-validation-stress.cjs`: runs the actual selected installation in read-only validation mode and checks config hash/size/mtime invariance across repeated model-validation rounds.
- `compression-pressure-stress.cjs`: deterministic release pressure gate for automatic threshold compression, incremental idempotency, model-dispatched `context_compress`, broker-provisioned `context_history_manage`, protected-tail policy, bounded hot cache, append-only cold archive, paged non-injecting reads, and hot/cold restoration. It runs against built `dist/core` and uses only isolated fixture roots and providers.
- `release-installed-real-model-tui-cli-stress.cjs`: installed-directory real-provider PTY/CLI gate. It exercises the installed console launcher, TUI long output, target-bound Esc stop/force-stop, post-stop recovery, restart startup/request, same-workspace direct CLI, redacted credentials, and exact-path cleanup for both `Newmark.exe` and `Newmark Agent.exe`.
- `real-openai-hub-anthropic-smoke.cjs`: explicitly guarded, at-most-three-POST native Anthropic compatibility probe. The required real run is already complete; normal tests inspect its safety contract and must not invoke it again.
- `release-real-claude-env-preview-smoke.cjs`: runs the packaged executable against the real `Claude code.txt` env-file path through environment-variable indirection and `fuzzy-inject --preview-only`, verifies DeepSeek/Anthropic metadata and candidate models, rejects secret leakage, avoids provider calls, avoids persistence, and cleans up release processes.
- `release-computer-use-vision-smoke.cjs`: launches the real packaged CLI release against a local mock OpenAI-compatible provider, runs `computer_use observe` through a vision-capable model and a text-only model, verifies the vision request contains UI Automation text plus an image data URL, verifies the text-only request contains UI Automation text without image input, rejects `vision_image_path` / temporary PNG path leaks, and checks `%TEMP%\newmark-computer-use` for no retained `observe-*.png` screenshots.
- `release-dev008-features-smoke.cjs`: drives the packaged renderer against a deterministic local provider and verifies the read-only Linked Plan reader, immediate parallel Peer creation, `subagent_read`, durable mailbox reactivation, root result feedback without duplicate delivery, and safe text/script/PDF/HTML/binary file routing.
- `release-windows-package-smoke-lib.cjs`, `release-windows-zip-smoke.cjs`, and `release-windows-msi-smoke.cjs`: validate packaged Windows CLI/UI version and startup from clean ZIP extraction or isolated MSI administrative extraction. The final ZIP passes dev-0.0.8, dev-0.0.9, and dev-0.0.10 feature gates; the final MSI passes the 19-check offline dev-0.0.10 artifact gate against the executable in its administrative image.
- `release-linux-package-smoke-lib.cjs`, `release-linux-appimage-smoke.cjs`, `release-linux-deb-smoke.cjs`, and `release-linux-unpacked-zip-smoke.cjs`: validate Linux package version, CLI behavior, executable layout, clean extraction, and WSLg/Electron startup for each supported Linux asset.
- `verify-github-release-assets.cjs`: enforces the exact five-asset prerelease contract, downloads every published asset again, compares local and remote SHA256 values, and dispatches the platform-specific startup smoke gates.

### `DESKTOP/src/`

- `main.ts`: Electron main process, window creation, IPC wiring, startup prewarm/hydration barrier, localized post-promotion update prompt, target-bound runtime-pool selection, host-tool routing, workspace selection coordination, work-event broadcast, conversation snapshots/checkpoints/Guide/stop APIs, Browser-Use host ownership, HTML protocol registration, PDF capability-server startup/shutdown, dirty-editor dialogs, safe workspace-file dispatch, user-level visual-preference state/save wiring, packaged headless `--automation-wake`, and the standalone graph/image-only `--newmark-viewer` mode. Runtime completion receives the original target/workspace snapshot explicitly instead of consulting the later foreground workspace. For WSL Computer Use vision, main accepts only canonical files inside the dedicated temporary capture directory, checks type/size/symlink boundaries, converts one frame to in-memory image data, and deletes the Windows file immediately.
- `cli-discovery.ts`: shared strict top-level argument classifier used before GUI/TUI/CLI runtime initialization; it rejects unknown flags and missing values while preserving documented aliases and boolean launch switches.
- `preload.ts`: safe renderer API bridge. It exposes startup status/retry/UI-ready handshakes, target-bound send/Guide/snapshot/checkpoint/stop/work-run-folding APIs with current-workspace compatibility wrappers, dedicated image/Memory Overview viewer calls, token-bound `openWorkspaceFile` / `saveWorkspaceFile` / close-token methods, dirty-editor decisions, conversation Plan methods, and Electron `webUtils.getPathForFile` as `filePathForFile`. It intentionally does not expose arbitrary renderer filesystem access or a built-in Gemma downloader.
- `server.ts`: local HTTP/API server bridge for desktop/dev behavior, including the same shared background-color/font normalization and user-level persistence contract as Electron IPC.
- `launcher.ts`: source launch routing for GUI, the TypeScript CLI, server/Flow, and non-interactive commands.
- `cli-commands.ts`: shared TypeScript non-interactive command adapter for `state`, `tool`, `send`, `validate-models`, `fuzzy-inject`, `skills-market`, `memory-lab`, `install-update`, `compat`, and `compat-tool`. It is used by both source launcher and packaged Electron main so release exe behavior stays testable without the GUI. `state` exposes the active language, Auto-switch state/scope/anchor, selected OpenAI-compatible API mode, current context-window estimate, and whether the CLI is running in `agentOnly` mode. `send` accepts `--language auto|en|zh` so scripted calls can select the same reply-language contract as the desktop UI, and `--agent-only` so a one-shot CLI Agent call can run without workspace conversation persistence. Packaged `tool` can receive JSON arguments through `--args-file path` to avoid fragile Windows argv key/value handling. Packaged `send` can receive long prompts through `--input-env ENV` or `--input-file path` to avoid Windows argv quoting/splitting failures. Packaged fuzzy injection should pass endpoint/key through `--endpoint-env` and `--key-env` instead of raw URL argv values when adding a new provider; existing providers can omit those arguments and reuse saved endpoint/API key. CLI fuzzy injection can infer the provider name from the endpoint core domain when `--name` is omitted and uses the shared tokenizer/suffix prober when no guide model is configured. Claude/Anthropic PowerShell or dotenv env files can be imported with `--env-file-env ENV_WITH_PATH`, which avoids packaged Electron path splitting when the file path contains spaces. `skills-market` preserves query output and additionally supports `--sources`, `--add-source`, `--remove-source`, `--enable-source`, and `--disable-source` for user-managed Skills Market catalogs. `install-update` supports `--version`, `--check-github`, `--from-github`, `--dry-run`, `--expected-version`, and preserved-data portable updates from a file, unpacked directory source, or GitHub Release zip asset. `compat --target all|tools|plugins|marketplaces|skills|agents|subagents` emits normalized compatibility data for OpenAI/Codex, Claude Code, OpenCode, skills, plugin marketplace entries, agent presets, and subagent return contracts without opening the UI. `compat-tool --list|--name` provides explicit CLI debugging for local OpenCode JavaScript custom tools.
- `cli.ts`, `cli-editor.ts`, `sidecar.ts`: the maintained interactive TypeScript CLI, terminal editor, and sidecar entrypoints. The packaged executable and source launcher share these TypeScript paths as the single maintained CLI implementation.
- `conversation-utility-host.ts`: isolated Windows-native conversation worker entrypoint. It owns a target-checked `Agent` plus `ConversationKernel`, accepts utility parent-port RPC, emits target-stamped work events, persists Guide/checkpoint/work-run state, and forwards only allowlisted desktop capabilities through the host-tool bridge.
- `wsl-agent-host.ts`: Linux/WSL conversation worker entrypoint. It keeps stdout JSONL-only, applies the requested workspace and composite target, runs the same conversation kernel semantics, forwards allowlisted Windows host tools, and sends diagnostics to stderr.

### `DESKTOP/src/core/`

- `agent.ts本地归档（未纳入公开仓库）agent.model` as the user's selection intent, resolves one deployment per turn, persists redacted decisions/feedback/health under the selected Newmark root, re-resolves the provider on every retry/fallback, and never crosses provider scope. `validateModels()` adapts real provider operations to the shared Validation Service and persists structured level/status/capability/error summaries; legacy evaluation metadata alone cannot grant Auto eligibility.
- `compressionHistoryArchive.ts`: conversation-isolated append-only JSONL cold storage for folded context evicted from the bounded hot cache. It replays fold/restore events, tolerates malformed individual lines, preserves monotonic cache IDs across restarts, and never injects archived content into prompts.
- `autoRouter.ts`: provider/model-stable Auto types and deterministic router. It owns policy normalization/migration, hard candidate filters, local task classification, Beta quality/reliability estimates, quality-loss bands, cost/latency/throughput/tool-validity/cache/preference components, five-minute affinity, 15% switch threshold, thirty-day preference decay, endpoint circuits, retry classification/budgets, scope-safe fallback planning, and content-redacted `RouteDecision` records.
- `modelValidation.ts`: provider-neutral four-level validation state machine, six statuses, seven-day TTL, two-of-three sampling, concurrency-two scheduler, health/capability separation, Standard text/stream/strict-JSON/tool/tool-result/declared-vision probes, Extended image-output validation, tool-error taxonomy, and audit redaction.
- `modelValidationStore.ts`: root-scoped JSON persistence adapter for validation records. It returns cloned records and uses the selected test/user root rather than the installation directory.
- `toolArgumentValidator.ts`: recursively closed JSON Schema registration/validation used by model-authored and direct CLI tool calls before policy or execution.
- Conversation persistence in `agent.ts` stores workspace-local `conversations/state.json`, saves conversation Plan items and user-image attachment metadata with each conversation, hydrates the content-addressed assets on reload, sanitizes visible assistant output, persists the first-user-message title-gate identity and formal-response-started state, exposes read-only snapshots by explicit conversation ID, and supports visible switching while another conversation continues through its own runner. Conversation archiving writes attachment copies under 本地归档（未纳入公开仓库） and links them from the archived Markdown.
- Conversation-title boundary: PC and Android local conversations replace direct first-message clipping and completed-Build-derived naming with one separately persisted, tool-free provider probe that must succeed and apply its title before the first formal Agent request starts. Android remote conversations remain PC-owned. Failure or timeout starts zero formal provider requests; a later ordinary send retries the gate from the same first persisted user message rather than the newer text. Workspace/conversation/first-message identity and default-title state protect against stale results and preserve manual renames. The probe also verifies the frozen provider/model selected for the formal turn, while its messages, errors and output never enter Agent history or the main request prefix.

Mobile local-provider recovery now gates usable connectivity on both `NET_CAPABILITY_INTERNET` and `NET_CAPABILITY_VALIDATED`. A transport abort before provider activity safely retries the original request. An abort after public thought/text preserves bounded progress and sends a continuation request after validated recovery, capped at three continuation attempts and explicitly forbidden from repeating visible text. The combined response remains the durable assistant result. Repeated failure is normalized to a controlled progress-preserved message instead of surfacing the raw socket exception. Foreground-service ownership, CPU/Wi-Fi locks, remote SSE leases and old-connection eviction remain unchanged.

Android first-turn model identity is frozen before the gate runs: the independent title probe and the later local Agent loop use the same `ApiConfig`, `ModelConfig`, intelligence and thinking-tier snapshot. Per-conversation identity prevents the second send or a restart from replacing the first title source. A failed probe leaves `firstAgentResponseStarted=false`, returns a controlled error, and allows the next send in the same conversation to retry the same persisted first message; only a successful probe sets the formal-response-started marker immediately before provider execution.

Forward compatibility distinguishes an actual failed pre-response gate from an old established conversation: when legacy state omits the new marker, existing Assistant messages, model history or persisted WorkRuns migrate the conversation to started. Only a state with no formal-response evidence remains gated, so upgrading does not force old conversations through a new first-turn probe.
- `agentKernel/`: native Newmark TypeScript agent-loop package. `agent.ts` owns the queue-capable Agent facade, `agent-loop.ts` owns turn lifecycle/tool execution/steering and follow-up draining, `event-stream.ts` and `stream-types.ts` normalize provider stream events, and `types.ts` defines kernel message/model/tool/event contracts. This folder is source code, not vendor material.
- `agentKernelRunner.ts`: bridge from the Newmark `Agent` facade into the native kernel. It converts Newmark conversation history into kernel messages, maps provider streaming/tool-call output into kernel events, executes Newmark tools, records visible work events, notifies the conversation runtime when queued user messages actually start, handles tool results, model fallback, Memory Lab/Flow/automation/subagent routing, context compression, and Goal continuation. Compression returns a request message set plus an optional durable replacement set so one-time continuation instructions do not become permanent context. The active run `AbortSignal` reaches ordinary and special tools. For Computer Use, it accepts only trusted one-use `vision_image_path` or WSL `vision_image_data_url` payloads, prepares structured current-turn model input, strips both transport fields from visible/persisted text, and deletes filesystem captures after preparation or abort. Tool definitions are built once per Agent turn and reused by provider streaming plus kernel execution; context conversion is skipped when auto compression is off; high-frequency tool workflow rows defer full state writes to existing persistence points.
- `conversationKernel.ts`: target-aware conversation orchestrator inside each worker. It manages `runId` state, safe-boundary Guide delivery, continuation, checkpoint/snapshot, graceful stop, public work-run events, queue snapshots, completed runner persistence, and work-run expansion state for the worker's bound conversation. Guide acceptance prepares durable user-image attachments immediately; accepted/deferred receipts and empty-text continuations retain stable attachment references through checkpoint, then exactly-once application consumes the continuation and reconciles one chat/history row under its `clientMessageId`. A cold fold update creates a transient target-bound runner only for atomic state mutation and never registers it as an active runtime, so completed runs remain toggleable after worker eviction without cross-workspace leakage.
- `conversationAttachments.ts`: durable user-submitted image boundary. It accepts only decoded PNG/JPEG data URLs, enforces six-image, 10 MiB-per-image, and 30 MiB-total limits, verifies MIME/content and SHA-256 integrity, writes atomically to canonical `conversation-media/user-images/<prefix>/<hash>.<ext>` assets, hydrates legacy/current attachment records, sanitizes display names, and copies content-addressed assets into conversation archives. These assets are intentional user content and are not used for Computer Use frames.
- `displayImages.ts`: Agent-presented image boundary. It accepts one workspace-contained PNG/JPEG, resolves real paths against symlink escape, validates decoded MIME and the 10 MiB bound, writes an atomic SHA-256 asset under `conversation-media/display-images`, strips bytes from durable Work state, and hydrates a validated data URL only for GUI/TUI presentation.
- `conversationTarget.ts`: canonical composite-target boundary. It normalizes workspace identity/path plus safe conversation id, derives stable `workspaceKey`/`runtimeKey`, and prevents two workspaces whose public conversation id is `default` from sharing runtime or cache identity.
- `electronUtilityRuntimePool.ts`: Windows-native target runtime manager. It owns one `ElectronUtilityAgentClient` per active `runtimeKey`, forwards target-stamped work events, retains background workers with bounded idle cleanup, escalates a second stop on the same stopping `runId` through one target-only single-flight force transaction, and uses cleanup-only retries for quarantined clients instead of evicting them and accidentally spawning replacements.
- `runtimePoolCapacity.ts`: shared two-active-runtime LRU/idle-capacity primitive. Idle generations retire after five minutes, a least-recently-used idle runtime may be evicted for a new target, and a third target is rejected when both existing runtimes are busy.
- `electronUtilityAgentClient.ts`: one `utilityProcess.fork` client with `startPromise + readyGeneration`, generation-stamped request correlation, ping/snapshot validation, pending timeout cleanup, host-tool AbortControllers, immediate stale-generation invalidation, and sticky restart quarantine. Windows Toolhelp snapshots record PID, parent PID, and creation FILETIME; termination first opens and validates identity-matched handles, then performs bounded anchored rescans for late descendants and requires three stable empty observations before replacement. Helper processes are owned by `runtimeKey + generation`, retained handles can be retried only for cleanup, and any identity/snapshot/survivor uncertainty rejects pending work, makes the old generation inert, and blocks automatic replacement.
- `runtimeShutdown.ts`: strict backend shutdown barrier. It awaits all utility/WSL runtime stop operations with `Promise.allSettled`, preserves every failure, and only then freezes and drains Windows process-query/termination helpers so application exit cannot race helper teardown.
- `utilityAgentProtocol.ts`: typed parent/utility RPC contract for prompt, snapshot, Guide, checkpoint, stop, setting updates, work-run folding, host-tool requests/results, target identity, and work events.
- `utilityHostToolBridge.ts`: worker-side allowlisted request bridge. It overwrites caller workspace/conversation/runtime context from the trusted target provider, correlates time-bounded replies, cancels the exact host request on abort or timeout, and rejects every pending request on disconnect.
- `utilityHostToolRouter.ts`: Electron-main host-capability router for Browser Control, native Browser-Use, Automation, Terminal Takeover, and Computer Use. It rechecks target/context and ToolPolicy, preserves global Computer Use ownership, propagates worker cancellation, and clears only the force-restarted runtime's host actions. Computer Use frame retention is authorized only by trusted execution context, never model-authored arguments; retained temporary paths are bounded and deleted on runtime cancellation/cleanup. CU mouse mode is read from the authoritative runtime session and injected into actions after `takeover_start`.
- `wslAgentRuntimePool.ts`: WSL target runtime manager with the same public prompt/snapshot/Guide/checkpoint/stop/fold contract as the utility pool. Each active composite target receives a separate WSL host/process group so force restart cannot kill another workspace's work.
- `wslAgentClient.ts`: Windows-to-WSL JSONL process client. It maps workspace paths, tracks process generation/PID and pending requests, forwards target-bound host-tool calls with AbortSignals, rejects stale replies, and restarts only its owned process group.
- `wslAgentProtocol.ts`: WSL JSONL request/response and host-tool type contract, including composite target, execution mode, Guide/work-run lifecycle, terminal events, Browser-Use, trusted ephemeral-vision permission, and stop results. Electron converts an allowlisted Windows temporary Computer Use frame to one-use in-memory image data for WSL and deletes the Windows file before returning the host-tool result.
- `wslHostToolBridge.ts`: WSL-worker reverse host-tool bridge with request correlation, exact request-id cancellation on abort/timeout, disconnect rejection, and the same allowlisted tool vocabulary as the utility worker.
- `workspaceSelectionCoordinator.ts`: renderer-workspace selection coordinator implementing repeated-current no-op, single-flight duplicate sharing, latest-wins pending selection, stale-result suppression, and per-target error circuit breaking without resetting background runtimes.
- `browserUse.ts`: Newmark-native Browser-Use engine and public protocol. It owns opaque observations/refs, page generations, per-target exactly-once action ids, target cancellation, safe URL normalization, ordered scope queues, and a strict rendered-text/public-attribute allowlist that removes hidden reasoning, form secrets, and internal locator data.
- `browserUsePageAdapter.ts`: fixed-program observe/action adapter. It never accepts caller JavaScript; it observes rendered `innerText` and visible option labels rather than hidden DOM text or control values, performs identity/ref TOCTOU checks, and wraps each complete observe or identity-before/probe/input/identity-after action in the physical page serializer.
- `electronBrowserUseHost.ts`: Electron `WebContents` host for isolated-world fixed programs and native input. It tracks document identity, serializes all runtimes sharing one physical `WebContents`, keeps popup/download denial attached for the runtime binding (including delayed effects), stops aborted navigation, and restores ordinary user behavior when that runtime is released without cancelling a different queued runtime.
- `pdfPreviewServer.ts`: loopback-only PDF capability server. It validates the exact numeric Host, process secret, owner-bound token/name/TTL, canonical workspace resolution, GET/HEAD method, and one bounded/open/suffix Range before streaming inline PDF with no-store/no-sniff headers.
- `config.ts`: config defaults, persistence/migration, stable provider IDs, model validation summaries, capability inference, UI/user-level settings, provider-state redaction, and secret-preserving merges. Auto configuration includes mode/scope/anchor, privacy/budget/preview/subset policy, optional data-region and required-protocol-parameter constraints, model route preference/data regions/supported parameters, and OpenAI transport mode. Same-name providers/endpoints remain distinct identities and missing/duplicate legacy IDs migrate deterministically.
- `uiPreferences.ts`: shared appearance-input normalization for Electron and HTTP paths. It canonicalizes dark/light/system theme values, accepts only six-digit hexadecimal background colors, and constrains the optional local font family to one bounded non-injectable name before it reaches persisted config or renderer CSS.
- `fuzzy.ts`: shared fuzzy provider tokenizer and endpoint discovery logic. It extracts URL/API-key tokens from raw text, normalizes base URLs, names providers from endpoint core domains, owns the suffix dictionaries for `/models`, `/chat/completions`, `/completions`, `/responses`, and `/messages`, probes OpenAI-compatible and Anthropic-compatible routes, and supplies heuristic candidate model names.
- `workspace.ts`: workspace creation, selection, deletion, pinning, access checks, prompt/config layering, and SSH external workspace metadata. Internal workspace deletion is intentionally registry-last: it verifies the target stays under `Work/`, retries directory removal, clears read-only bits when needed, and updates `Work/Local.json` / `Work/State.json` only after the directory is gone. Local external workspaces still require matching local `PC_Hash.config`; SSH external workspaces are preserved and relinked by remote `PC_Hash.config`. Exact folder binding is unique across local workspace records after canonical path normalization, and SSH workspaces are unique by exact `sshConnectionId + remotePath`; parent and child folders remain valid separate workspaces.
- `workspaceFileRouter.ts`: active-workspace file inspection and opening boundary. It performs lexical/realpath confinement, bounded header reads, UTF-8/UTF-16 and magic classification, the 5 MiB editor limit, never-execute script/executable routing, sandboxed HTML preview resolution, transport-neutral owner/TTL-bound PDF capabilities, capability revocation, and renderer/revision/file-identity-bound editor saves.
- `toolPolicy.ts`: unified required/mode-scoped/configurable tool policy used for model-visible schemas, runtime denial, Plan read-only enforcement, and settings visibility.
- `asyncProcess.ts`: bounded asynchronous child-process runner used by long-running tools. It limits output, supports timeout and `AbortSignal`, terminates Windows process trees or POSIX process groups, and safely resolves npm-style Windows `.cmd` launchers to a Node entrypoint without shell interpolation.
- `ssh.ts`: native OpenSSH connection manager. It persists `Work/SSH.json`, avoids password storage, invokes the system `ssh` executable asynchronously with argv arrays, cancellation, and noninteractive options, validates remote connectivity by reading/creating `PC_Hash.config`, and supports remote workspace directory creation before local shadow-workspace linkage.
- `flow.ts`: Flow schema, validation, save/load, sequence generation.
- `flow-runner.ts`: Flow execution support with cancellation checks between and after steps.
- `compat.ts`: canonical compatibility interfaces for tools, tool results, plugin manifests, plugin marketplace entries, agent presets, and schema emitters. It normalizes legacy Newmark tool definitions into OpenAI Chat, OpenAI Responses, and Anthropic tool shapes, wraps string tool outputs into structured envelopes, discovers Codex, Claude Code, OpenCode, and Newmark-native plugin metadata in read-only form, records MCP/LSP/hooks/package-plugin metadata without starting or executing it, reads plugin marketplace/catalog entries, normalizes Codex TOML / Claude markdown agent presets for subagent preset wiring, and explicitly executes local OpenCode JavaScript custom tools when requested through CLI.
- `memoryLab.ts`: root-level persistent memory manager for `Memory Lab/index.json` and `Memory Lab/components/`. It stores hierarchical tag graph dictionaries, memory component metadata, single-file or folder-backed core markdown, deterministic reindexing, path containment checks, and tool-facing usage instructions. Its normalized index cache and size-bounded versioned content cache serve sustained queries without repeated disk scans; explicit reads and one-shot visualization snapshots force current disk contents.
- `installUpdate.ts`: update helper used by CLI `install-update`, desktop Settings > Updates, and the startup probe. It copies update files from an unpacked directory into a target installation, supports dry-run and expected-version checks, scans bounded GitHub release lists including prereleases while ignoring drafts, normalizes `dev-`/`v` semantic tags and reports only strictly newer versions, selects compiled `win-unpacked` zip assets, downloads/extracts zip packs, writes `.newmark-install.json`, preserves user state paths by default, and preflights target writability before copying so protected install directories do not receive partial updates.
- `startupPrewarm.ts`: deterministic all-settled critical startup barrier, per-stage timeout wrapper, required-failure aggregation, progress emission, localized newer-version prompt content, and a cancellable post-promotion task scheduler whose failures settle as warnings without rejecting first-frame readiness.
- `subagent.ts`: subagent lifecycle and transcript/result state. It now exposes stable structured subagent records and tool-result envelopes with `id`, `name`, `status`, `active`, `model`, `mode`, `inputMode`, `prompt`, `result`, `messages`, `error`, `startedAt`, `completedAt`, `closedAt`, and `metadata`; `task` can attach normalized agent-preset metadata when launched through `preset` or `agent`. Abort pauses and persists scheduling before active peers settle, preventing queued peers from starting until the next explicit run resumes them.
- `skills.ts`: local skill discovery, install, enable/disable, user-managed Skills Market source persistence, and `SKILL.md` metadata/heading/body-summary extraction for market search. Discovery covers project `skills/`, Codex-style `.agents/skills`, Claude-style `.claude/skills`, user-level skill folders, OpenCode skill folders, plugin-packaged skills, and user market sources from local `skills/.market-sources.json`. Supported market source types are JSON catalogs, direct remote `SKILL.md` URLs, and local skill directories; third-party catalog entries are treated as untrusted metadata until the user explicitly installs a skill.
- `automation.ts`: automation schedule model and runner. Regression coverage includes once/loop scheduling, wake sync, runner failure handling, and protection against concurrent tick re-entry for the same schedule.
- `automationWake.ts`: Windows scheduled-task wake integration. Scheduled tasks launch the packaged app with `--automation-wake`; the main process now handles that as a one-shot headless run rather than a hidden long-lived desktop session.
- `types.ts`: shared TypeScript types, including `ConversationTarget`, target-stamped `AgentWorkEvent`, `ConversationInputEnvelope`, `GuideReceipt`, public `ConversationWorkRun`, durable `ConversationImageAttachment`, continuation, run status, and v3 snapshot fields.

### `DESKTOP/src/tools/`

- `index.ts`: tool executor and tool definitions for file, shell, git, web, question, task/subagent, Flow, automation, SSH, and GitHub CLI tools. `file_audit` combines local filesystem metadata, local Git status/history, and GitHub remote repository/branch/path metadata when a GitHub remote is present. `repo_security_audit` performs read-only remote repository safety review for privacy exposure, likely tracked secrets, public/private GitHub metadata, dirty files, changed files, and local-only release-excluded paths; `git_push` and `gh_pr_create` prepend this safety summary when a remote repository exists. `ssh_workspace` manages native OpenSSH connections and remote external workspace linkage by remote `PC_Hash`. `computer_use` includes whole-desktop takeover indicator actions, application-scoped observation/action parameters, a process-wide single-conversation ownership lock released by `takeover_stop`, and `capture_max_width` / `capture_max_height` for bounded visual assistance. The model schema cannot grant its own screenshot-retention permission. `image_inspect` accepts a durable user attachment ID as well as latest-message index selection; derived crops still remain current-turn-only. `git_branch`, `gh_fork`, and `gh_pr_create` expose explicit branch/fork/PR workflows while keeping remote writes separate from audit. The `bash` tool accepts a per-call `timeout_ms` chosen by the Agent. `terminal_takeover` is a separate persistent-shell Agent tool for continuous terminal control across desktop and CLI Agent turns; it does not reuse `bash` semantics. `terminal.interrupt_timeout_ms` is a nonzero upper cap for Agent bash timeout and terminal forced interruption; the default `0` means no cap/no forced timeout. Agent automation tools include `automation_list`, `automation_create`, `automation_update`, `automation_toggle`, and `automation_delete`; desktop/server runtimes inject the live `AutomationManager` into `Agent` so these calls persist schedules through the real scheduler.
- `computerUse.ts`: native Windows Computer Use implementation. It captures ephemeral full-desktop or application-cropped screenshots, combines them with UI Automation semantic objects, supports stable target IDs and move/click/drag/scroll/type/key actions, exposes `takeover_start/takeover_stop`, and scopes application workflows through `app_list/app_observe/app_activate/app_click/app_drag/app_scroll/app_type/app_key`. The session can choose `real` or `virtual`: real mode uses DPI-aware randomized 50 ms paths and shares a 350 ms minimum action interval between clicks and drags; virtual mode keeps a per-owner cursor and posts down/held-move/up messages to a bound HWND without foreground activation. Real drag releases a pressed button on failure, virtual drag attempts release after any queued press, and the asynchronous receipt does not claim target-app completion. Virtual mode uses `PrintWindow` for occluded-window presentation capture. Window messages are app-dependent; minimized windows and non-client areas are unsupported. `observe` and `app_observe` default to a `1280 x 960` capture budget, clamp requested bounds to `320 x 240` through `2048 x 2048`, preserve aspect ratio, and never upscale. Non-vision paths delete before tool return; trusted vision paths retain exactly one frame until structured model input preparation, with normal/error/cancellation cleanup. The takeover indicator is a click-through Region-cut overlay that draws the whole closed perimeter into an offscreen bitmap each frame, including the residual final segment, so the visible gradient remains a continuous head-tail-connected clockwise loop rather than a lap that clears and redraws.
- `computerUsePowerShellHost.ts`: application-lifetime JSONL PowerShell worker pool for action, UI Automation, window discovery, and isolated `window_capture` lanes, with asynchronous request correlation, bounded timeouts, and cleanup/restart support. Native input helpers include the DPI-aware smooth physical path and virtual HWND drag gesture; a timed-out `PrintWindow` worker is terminated independently from Electron's UI thread.
- `terminalTakeover.ts`: process registry for Agent-controlled persistent shell sessions. It owns named session lifecycle, stdin writes, bounded output buffers, event listeners, and desktop broadcast snapshots used by the bottom terminal takeover UI.
- `index.ts` also defines `memory_lab_read`, `memory_lab_update`, and `memory_lab_reindex`. Plan mode allows only `memory_lab_read`; model-assisted update/reindex is routed through the Agent runtime so the current working model can organize Memory Lab changes.
- `index.ts` exposes legacy expert browser-control tools plus native `browser_use`. Browser-Use offers observe/click/type/select/scroll/key/navigate/wait/extract over opaque refs and fixed host programs; its model schema contains no owner/runtime identity. Utility and WSL workers call the dedicated target-bound host RPC. The host binds only the renderer-prewarmed built-in Browser guest and can request bounded cold initialization of that same guest; no hidden BrowserWindow is created. Observation/probe/extraction share the same public-text walker and exclude password inputs, textarea values, contenteditable content, hidden DOM text, and internal option values. Plan exposes only observe/navigate/wait/extract, and Electron main re-evaluates that policy so a worker cannot forge a mutating Plan request. Legacy selector/eval/CDP tools remain separate expert paths.
- `flow-cli.ts`: Flow CLI helper.

### `DESKTOP/src/llm/`

Current Responses transport contract: tool-capable `/responses` requests use `stream: true` and `Accept: text/event-stream`; output text is published from deltas, function arguments are assembled until the output item completes, and a successful stream must reach `response.completed` with an explicit case-insensitive embedded `response.status=completed`. Missing, blank, unknown, or non-completed status remains a controlled failure. Context compression captures one concrete provider/model deployment snapshot before summarization and records that actual model ID.

- `provider.ts`: OpenAI/Anthropic/GitHub-Models provider abstraction, intelligence settings, model listing, validation, and HTTP fallback transport. JSON GET/POST calls use abort guards so model discovery can fall back instead of hanging indefinitely in packaged Electron. OpenAI-compatible calls can use streaming Chat Completions, non-stream Chat Completions, or direct Responses API mode; chat-completions calls also fall back to `/responses` for matching 4xx model/API errors and map `instructions`, `max_output_tokens`, text output, and function-call tools. Direct Responses failures return controlled `[LLM Error]` text instead of throwing through UI/validation loops, model validation treats that text as unavailable, and Responses tool-result turns preserve the prior `function_call` item before `function_call_output`. `github_models` uses GitHub Models catalog and inference chat-completions endpoints with GitHub token/API-version headers for GitHub Copilot/Models-style provider setup; acquisition of that token is an explicit browser-login flow rather than fuzzy injection. On Windows, the PowerShell HTTP fallback passes request and response bodies through explicit UTF-8 temporary files so non-ASCII provider output does not cross the console stdout encoding path.

### `DESKTOP/src/ui/`

Current Agent work presentation: running Build blocks are default-expanded but remain collapsible, terminal transitions auto-fold, tool completion updates the original activity row, and consecutive commands/file edits/searches/image inspections are grouped beneath the public reply narrative. Raw tool arguments, call IDs, commands, paths, results, and hidden reasoning remain outside this public renderer.

Current review presentation: work-review surfaces use semantic theme variables rather than dark-only colors. Review payloads retain the changed old/new fragments; selecting a file opens the real token-bound editor, renders removed lines in a separate red read-only layer, marks added lines green in the editable overlay, and keeps normal save/revision checks for user edits to additions.

Current compression and GitHub UI correction: context token estimation serializes structured message content instead of treating arrays as `[object Object]`, and compression strips historical base64 images unless they belong to the immediately active user turn. The GitHub CLI page renders populated and empty Issues/PRs with the shared Newmark list surface, uses a rounded themed repository selector with a Lucide chevron, caches its structured overview signature, displays `Communicating` only for the first load, and skips DOM replacement when account/repository/issue/PR data is unchanged. Repository selections made during an in-flight read are queued and resolved immediately afterward, while the renderer and main process both normalize the selected repository against the returned account-owned list so the visible dropdown and repository details card cannot diverge.

Current Build transcript contract: every completed API assistant message contributes one durable `response` event containing the complete sanitized public non-tool text. Streaming deltas remain live-only, hidden reasoning/thinking fields and `<think>` content remain excluded, and tool facts keep their reduced public summaries. The renderer avoids duplicate standalone Assistant messages when a response belongs to a work run. Build blocks are borderless and use a continuous left ownership line plus indentation; Guide receipts render inside their run. Completed, errored, and interrupted runs remain expanded by default so the full public transcript stays visible, while retaining manual folding. User-input metadata, content, node, and vertical connector are right-aligned, producing a distinct right-side user timeline without interrupting the left-side Build ownership path.

Build tool activity now uses one ordered expandable group for each contiguous tool phase. Its summary combines file-edit and command facts, the expanded list preserves invocation order with compact `Ran ...` command rows and `已编辑 filename +added -deleted` file rows, and an `已编辑的文件` subsection aggregates repeated edits by path. Each file expands to a bounded red-deletion/green-addition line diff derived from the already-sanitized public edit arguments. Outer activity, file-section, and individual-file disclosure states survive live work-run rerenders.

The 2026-07-21 local-install verification built the Windows MSI and unpacked ZIP from the current dirty worktree and passed the packaged CLI smoke. Windows Installer same-version maintenance mode initially returned success without replacing the installed `app.asar`, so the stale machine-wide `0.1.2.0` installation was uninstalled while preserving `~/.Newmark`. A temporary per-user unpacked installation was later removed at the user's request. The newly built MSI was then installed cleanly under `C:\Program Files\Newmark Agent`; its installed `app.asar` SHA-256 exactly matches the release build, the application starts with a nonzero main-window handle, the machine-wide uninstall registration is present, the user-level install directory is absent, and the user-state config hash remains unchanged.

As of 2026-07-18, completed provider messages are classified by boundary: messages that select tools remain durable Build-process `response` events, while the terminal no-tool message becomes `final_response` and is displayed once as the ordinary Agent answer below the Build block. Responses-capable reasoning models request `reasoning.summary=auto`; only readable `response.reasoning_summary_text.*` summaries are retained as public process status, while encrypted content and hidden reasoning remain opaque and excluded. The system prompt also requests concise public progress commentary before the first tool and between materially different tool phases. Tool activity no longer creates duplicate workflow chat messages. Group summaries expand in place to sanitized command/path/argument rows without nested card borders; raw results, secrets, private call IDs, and hidden reasoning fields are removed. Guide lifecycle events with the same `clientMessageId` and state replace the existing event instead of appending a second optimistic/backend `accepted` row.

Memory Lab tool continuation now repairs cross-transport, compressed, and migrated-history edge cases in both OpenAI Chat Completions and Responses. Each converter tracks prior call IDs; if a tool result such as `memory_lab_read` has no corresponding assistant call envelope, it inserts a minimal same-ID/name call immediately before the output. Chat normalization also repairs partially persisted multi-call groups: existing real results are moved beside their assistant call, while each missing result receives an explicit unavailable-result placeholder before any later user or assistant message. This preserves Chat Completions' one-result-per-call protocol without discarding valid stored results. Chat payload normalization also removes Newmark-only history fields before transport. Memory Lab read/update/reindex no longer terminate the native Agent loop after the first tool, so one Build can inspect the index, update a component, read it back, and then produce a final answer. Packaged APInebula `chat_stream` and `/responses` real-API gates cover the complete chain plus a same-conversation follow-up that rejects any orphan tool-result error. Provider errors from Windows PowerShell fallback remain normalized into concise public diagnostics instead of rendering the full `Invoke-WebRequest` stack and request script location.

Current Linux terminal package acceptance extends beyond startup: because terminal sessions are created on demand, the packaged GUI smoke explicitly starts independent Bash and sh sessions through the real preload/main terminal IPC, performs marker command round trips, reads both buffers, proves cross-session output isolation, and stops both processes. It does not require a terminal to exist before the first user action. The existing terminal takeover verification separately covers interactive PTY geometry, write/read, detach, clean exit, application shutdown, bounded persisted tails, and restart restoration as inactive records.

The Windows-to-WSL backend smoke launches isolated source/package test windows with `--allow-multiple-instances`. That flag now skips `requestSingleInstanceLock()` entirely, because requesting and then ignoring a failed lock still activates Electron's second-instance coordination and can leave the diagnostic window hidden. Production continues to request and enforce the normal single-instance lock. Because the smoke intentionally disables automatic workspace creation and drives the backend API directly, it accepts a visible hydrated UI with a disabled prompt before selecting its explicit target workspace. Ordinary interactive startup smokes retain the stricter prompt-enabled promotion gate; renderer workspace activation remains covered by the dedicated workspace lifecycle smokes.

- `index.html`: main renderer UI, including layout, modes, sidebars, settings, plugins, Flow editor, Memory Lab graph viewer, browser panel, terminal panel, right-sidebar current conversation Plan panel, native text/code editor, workflow timeline conversation rendering, workspace-bound new conversation UI, Chinese/English/Auto language switching, and dynamic renderers. Ordinary single-choice controls use a shared renderer-owned Newmark listbox with model-selector geometry, scrolling, groups, keyboard navigation, fixed popup placement, and native `change` compatibility; this covers static toolbar controls and dynamically built settings/GitHub/workspace dialogs. The native editor owns line numbers, escaped token highlighting for common code/data/markup formats, a compact Vim normal/insert/visual command state, undo/redo, dirty/save status, Agent review assistance, and opt-in debounced Copilot prediction without a third-party editor runtime. The Models settings pane exposes Off / Full Auto / Provider Auto switching plus OpenAI-compatible Chat streaming, Chat, and Responses API mode selection. General settings expose accessible, localized background-color and local-font controls; the renderer validates them again, applies the background through `--app-bg`, updates the UI font stack without replacing `--font-mono`, and hydrates them before startup-ready attestation. The input toolbar shows a compact context-token ring beside the model selector and a hover tooltip for used/max tokens and percentage. The Plugins > Skills Market panel supports skill search/install and user market-source add/enable/disable/remove controls for JSON catalogs, direct skill URLs, and local directories. Memory Lab renders switchable Overview and Detail views: Overview is a real-index draggable/zoomable graph with focus modes and Newmark-styled list controls, while Detail is a centered parent/child tag graph without connector lines, with root-tag overview at root nodes, tag search jump navigation, directional smooth tag navigation, attached component selection, and core markdown preview. Runtime language application updates primary left toolbar labels, workspace secondary controls, right sidebar labels, editor close controls, sub-window controls, prompt placeholders, settings panes, active secondary windows, file-tree refresh/empty states, terminal status, context compression pills, context token ring, Next queue badges, model Auto labels, and rebuilt dynamic panels. Conversation messages support safe Markdown rendering for headings, lists, blockquotes, fenced code, tables, image/file/HTTP links, inline code, emphasis, and TeX-style inline/block formulas; durable user-image attachments render as explicit accessible cards and survive loaded snapshots, optimistic Guide reconciliation, edit/rewind restoration, and structured Next queues. Renderer-owned Next entries are composite-target-bound, keep their structured attachment objects, and revalidate target/idle state at delayed drain time. Backend follow-up snapshots use a separate target-keyed, read-only mirror cache, so background or stale same-conversation-id events cannot become editable foreground work or be drained twice. File links open the right-side Editor tab. Prompt paste and drag/drop convert local files into inserted filesystem paths. Pending option-feedback questions render into the workflow timeline with structured labels/descriptions and also appear correctly in the right Status panel. Markdown files opened from the file tree stay in the editor and expose a Preview toggle that uses the same safe renderer. The send path queues input typed during an active Agent turn, default conversation IDs match the backend `default` ID, foreground/background conversation switching remains available while individual same-conversation sends stay ordered, active/background work events are cached per conversation and can be reloaded from backend snapshots, streamed assistant responses are reused when final returned tokens match to prevent duplicate final rows, multi-window renderer refresh preserves each window's active conversation by id instead of inheriting another window's backend active state, and the current input action switches between Newmark marquee Stop and Send based on active conversation running state plus prompt text. Workspace selection paints the returned persisted active-conversation snapshot before deferred runtime hydration, and cold conversation activation does the same with disk history. Re-clicking the already-active workspace reopens the conversation-management secondary pane locally without a backend selection call or Focus change. Right sidebar resize stores expanded width in `--right-width`; collapse clears any inline width so the central workspace can reclaim the space.
- dev-0.0.9 renderer lifecycle in `index.html`: workspace/conversation lists display target runtime status; target-scoped Guide optimistic rows reconcile by `clientMessageId` and survive snapshot redraws until exactly-once application, including image-only accepted/deferred/applied cards whose durable attachment identity survives destructive redraw. Local Next rows are actionable owner-bound requests; backend queue rows are explicitly provenance-marked display mirrors and reject edit/delete/drag/Guide/drain actions. Repeated workspace-selection and stop errors are deduplicated outside chat history. Active work runs remain expanded with a live timer, completed runs auto-fold to `已处理 <duration>` and persist later toggles. Expanded work blocks render filtered public streamed natural language, Guide lifecycle, and tool name/status only—never arguments, call IDs, commands, paths, results, or hidden reasoning. `resetEditorSurface` is the single Markdown/text reset path, `requestEditorTransition` serializes Save/Discard/Cancel decisions, and `editorOpenGeneration` rejects stale opens while revoking their edit tokens. PDF capabilities open in the built-in Browser through loopback HTTP, while HTML keeps the custom preview scheme.
- dev-0.0.10 startup renderer hydration in `index.html`: the sole visible `BrowserWindow` loads this final page immediately with `startupPrewarm=1`; a fixed in-page cover remains until main acknowledges the same renderer's `state/rendered` payload. Readiness yields one task and forces a layout read, with no hidden candidate, animation-frame dependency, Flow/PTY/file-tree/status hydration queue, or Browser guest. File tree/status/Flow/terminal are explicit-demand paths. The first Browser tab or Browser tool request creates one target-bound `persist:newmark-browser-<workspace/conversation>` guest after a five-second floor for background demand; an explicit visible-tab activation bypasses that floor, replays the latest pre-`dom-ready` navigation exactly once, and sixty seconds off-tab destroys it while retaining the URL.
- `startup.html`: small static same-window failure/retry surface with the packaged Newmark icon, progress/status text, and preload-backed retry action. It is not a second startup window and is not used on the successful first-run hot path; main loads it only after a required startup failure, then reuses that window for retry.
- `test.html`: UI test/reference page.

The source UI keeps icon markup readable. The packaged `dist/ui/index.html` is generated by `DESKTOP/scripts/build-ui-icons.cjs` and includes the embedded Lucide sprite.

### `DESKTOP/src/tests/`

Conversation persistence uses a version 4 tree model. `tree.nodes` owns page-local transcript and Build snapshots, while `tree.branchGroups` owns the ordered sibling pages for each edit point. Pagination and restore address a page with both group and node identity. Structured conversation archives retain and restore this complete tree rather than flattening it into one transcript.

- `verify.ts`: regression test suite. Current coverage includes UI script parsing, release UI smoke script coverage, durable branch-tree replacement, read-only branch inspection versus explicit activation on send, sibling-branch live-event isolation, Guide edit/copy branching, release UI startup-recovery smoke coverage, release UI Agent tool-chain smoke coverage, release UI acceptance-smoke coverage, release UI option-feedback smoke coverage, release UI model-settings CRUD smoke coverage, release UI model Auto/context packaged smoke coverage, release UI Gemma-removal packaged smoke coverage, release UI Flow/subagent smoke coverage, release UI Memory Lab smoke coverage, release UI workspace/conversation isolation smoke coverage, release UI multi-window shared-backend smoke coverage, safe workspace-file classification/token tests and file-tree/Markdown-link route locks, message Markdown image/file-link/table/formula rendering, file paste/drop path insertion, input queueing, runtime skills refresh, Skills Market source management, Agent bash `timeout_ms` and terminal timeout cap semantics, layout collapsed-state memory, workspace/conversation pinning, scoped archive management, config recovery from `config.example.json`, CLI closed-pipe EPIPE suppression, tools, workspace manager, subagents, skills, automation, Flow, modes, Goal, Guide/Next, archive, context compression, model validation, Auto switching, fuzzy injection, provider modes, native Agent kernel queue/event behavior, Computer Use, terminal takeover, GitHub flows, packaged startup, and Windows update checks.
- `conversationArchiveConcurrencyVerify.ts`: executable renderer coordinator regression for rapid multi-row archive clicks, sub-frame optimistic removal, immediate parallel dispatch, out-of-order completion, coalesced background list refresh, and independent negative-receipt rollback.
- `conversationArchiveRuntimeVerify.ts`: exercises 48 concurrent archive writes, unique Markdown/manifest receipts, state deletion, cross-process lazy-shard materialization and cleanup, and real settle/occupancy-release waiting semantics.
- `conversationArchiveResponsivenessVerify.ts`: locks the state file from a child process to exercise async Flow flush and archive finalization without blocking the event loop; also tests aged live-owner locks, dead-owner recovery, and a 1,000-message / ~8 MiB archive.
- `memoryPolicyVerify.ts`: executable policy/cache regression for bounded multilingual retrieval, ADD/UPDATE/DELETE audit order, stale-write rejection, recovery archives, visualization content preload, stable relationship versions, and cache invalidation after deletion.
- `dev008-subagent.ts`: focused v2 conversation-state, flat four-way FIFO Peer, mailbox/read/reactivation/root-feedback, ToolPolicy, Linked Plan revision, and real Peer context-compression checks.
- `dev009Verify.ts`: 30-check static compatibility gate for the composite target APIs, v3 work-run/Guide fields, runtime pools, workspace selection coordinator, two-stage stop surface, editor/PDF bridge, latest-on-`dom-ready` Browser navigation, and the packaged Windows process-tree/TypeBox helper path.
- `normalChatRegressionVerify.ts`: focused first-turn deployment resolution, non-empty redacted provider failure, failed-assistant persistence, and provider-fallback context/tool-surface regression gate.
- `tuiStopRaceVerify.ts`: focused two-assertion regression for a stop received before the Native Kernel is attached, including propagation into the delayed runtime and no post-cancel provider request.
- `performanceOptimizationVerify.ts`: source/runtime gate for compression mutation booleans and the hot-path guard against repeated full-history serialization, alongside measured latency and persistence-write checks.
- `toolProvisioningVerify.ts`: all-callable-tool catalog/schema reachability gate; it verifies exact original JSON schemas for 57/57 tools, provider-subturn reachability behind `tool_provision`, and broker-to-original-tool execution in one user run without executing side-effect tools.
- `runtimeIsolationVerify.ts`: executable two-workspace/same-`default` runtime isolation, event/snapshot/Guide ownership, latest-wins workspace selection, utility/WSL per-target pool lifecycle, graceful/force stop escalation, generation cleanup, and background completion persistence tests.
- `guideWorkRunVerify.ts`: provider/tool/final-boundary Guide delivery races, exactly-once chat/history reconciliation, deferred same-run continuation, v3 migration/restart, public-event ordering/redaction, persisted work-run fold preference, and an image-only checkpoint -> cold reload -> applied -> second-reload-no-replay lifecycle with stable attachment identity.
- `guideUiReconcileVerify.ts`: renderer regression harness for optimistic accepted/deferred/rejected Guide rows, composite-target isolation, destructive snapshot redraw survival, image attachment card preservation, and exactly-once applied reconciliation by `clientMessageId`.
- `editorLifecycleVerify.ts`: executable renderer lifecycle harness for Markdown-to-text/browser/close reset, dirty Save/Discard/Cancel behavior, save conflict/failure retention, stale open generations, assist invalidation, and token/capability revocation.
- `pdfPreviewServerVerify.ts`: real loopback HTTP GET/HEAD/range/416, Host/secret/token/name/owner/path/TTL validation, explicit revoke, and owner teardown tests.
- `browserUseVerify.ts`: 79-check native engine/adapter/protocol regression suite for nine actions, opaque refs, stale-page TOCTOU, exact-once queues, physical-page transaction use, hidden-data stripping including textarea/contenteditable redaction, target rebinding, utility/WSL bridges, Plan host-policy checks, and cancellation.
- `browserUseElectronVerify.ts`: 61-check real `BrowserWindow` plus actual `utilityProcess` smoke for isolated-world programs, native input, popup/download guards, target binding, physical-WebContents cross-runtime serialization, packaged-helper compatibility, and Windows lifecycle hardening. Its real worker -> Node branch -> Node leaf cases verify identity-bound cleanup, late descendants, known-anchor rescans, helper ownership isolation, concurrent single-flight force stop, replacement readiness, sticky quarantine, retained-handle cleanup, output limits, and strict exit ordering while another target remains alive. `browserUseUtilityFixture.ts` is its target-spoofing worker fixture; `utilityProcessDescendantFixture.ts` creates the descendant process evidence.
- `toolProcessVerify.ts`: 21-check asynchronous process and cancellation regression gate covering event-loop responsiveness, literal `.cmd` metacharacters, SSH/provider abort, ordinary/special tool signal wiring, a 500 ms cooperative settlement watchdog, asynchronous Windows `/T /F` background tree cleanup, delayed-close fixtures, and real descendant termination.
- `startupPrewarmVerify.ts`: 74-check startup contract covering minimal required stages, cancellable warning-only main-process work, required retry, timeouts/update selection, single-`BrowserWindow` direct `index.html` load, first-attempt waiter recovery without duplicate navigation, in-page cover acknowledgement, static same-window failure fallback, explicit-demand Flow/PTY/file-tree/status behavior, `state/rendered` renderer attestation, absence of a pre-demand Browser guest, demand creation/idle destruction wiring, canonical no-workspace startup, one-target packaged CDP promotion, and separate startup-before-Browser/on-demand-Browser memory-budget source contracts.
- `terminalTakeoverVerify.ts`: native Windows and WSL PTY start/write/read/detach/reattach/stop, owner isolation, ended-record, and output-tail verification.
- `workspaceFileRouterVerify.ts`: header-first encoding/magic/size/script/executable/preview/token/revision/path-boundary fixtures.
- `workspaceMenuVerify.ts`: renderer regression that evaluates the real `switchToWorkspace` function and proves a repeated click on the Focus-owning workspace opens the left secondary pane, does not invoke backend workspace selection, and preserves the focused conversation.
- `newmarkSelectVerify.ts`: JSDOM renderer regression that evaluates the real generic select enhancer, verifies accessible model-style replacement for static and dynamically inserted selects, and proves option activation updates the hidden native control with exactly one `change` event.
- `userImagePersistenceVerify.ts`: durable submitted-image regression covering strict PNG validation, stable content-addressed identity, restart hydration, inspection by attachment ID, archive copy/link survival after conversation removal, invalid-image rejection, and absence of Computer Use paths from conversation state.
- `displayImageVerify.ts`: Agent display-image regression covering the callable schema, workspace scoping, PNG decode/dimensions, durable reference/no-base64 state boundary, hydrated Work snapshots, and GUI expanded/collapsed renderer hooks.
- `queueAttachmentIsolationVerify.ts`: executable renderer harness for two workspaces sharing conversation id `default`; it covers target-bound image Next requests, atomic head claim/removal, single-consumption under overlapping drains, rejection rollback, delayed-drain busy/switch races, queue pause without data loss, atomic whole-queue runtime-branch rebinding, interleaved drag identity, stale background snapshot isolation, same-text occurrence multiplicity, read-only backend mirrors, visible localized Queue Guide controls, explicit-rejection fresh IDs, transport/missing-receipt same-ID retry, run-settled restoration, and single-row optimistic UI reconciliation.
- `visualPreferencesVerify.ts`: shared appearance-normalizer/config/UI contract gate covering default/reset values, user-level persistence, workspace override rejection, safe color/font validation, localized controls, exact glass opacity/transparency/three-level blur anchors, valid-zero hydration, explicit Electron/HTTP `glassAlpha` mapping, theme-safe CSS variables, dark/light native-select palettes and WCAG contrast, semantic action/hover/focus/disabled colors, themed native number steppers, trimmed Lucide generation, batched lists, and rAF input wiring.
- `computerUsePerformanceVerify.ts`: persistent-helper dispatch, bounded ControlView DFS, desktop/application observe p95, event-loop delay, result-size, bounded variable screenshot dimensions, no-upscale/retention cleanup, and guarded three-step sequence acceptance gate. The final bounded-DFS samples are `881/874/874 ms` for desktop observation and `332/341/329 ms` for application observation.
- `autoRouterVerify.ts`: 35-check deterministic global/provider scope, hard filters, four quality bands, unknown-cost handling, affinity/switch thresholds, task classification, catalog hashes, preference decay, endpoint health/circuit/retry classification, and scope-safe fallback gate.
- `autoAgentIntegrationVerify.ts`: 24-check Agent-level persistent Auto intent, provider/model identity, per-attempt provider resolution, audit/fallback behavior, empty-response handling, same-name collision safety, and fixed-selection regression gate.
- `autoRouteRatingVerify.ts`: 14-check explicit route-rating path from renderer/API through target-bound utility/WSL runtime protocols into preference feedback, including target isolation and no-prompt-content persistence.
- `providerIdentityVerify.ts`: 10-check deterministic provider-ID migration, duplicate repair, equal-model account isolation, secret merge, provider-scoped Auto, and validation write-target identity gate.
- `modelValidationVerify.ts`: 63-check four-level/six-status state machine, TTL/cache, sampling, concurrency, probe orchestration, health separation, image bytes/MIME/dimensions, tool taxonomy, and audit redaction gate.
- `modelValidationAgentIntegrationVerify.ts`: 13-check common Agent/CLI validation adapter and persistence contract, including real protocol shapes, Standard Auto eligibility, validation cache reuse, and legacy-basic exclusion.
- `runtimePoolCapacityVerify.ts`: 16-check shared max-two LRU/idle/busy capacity behavior for Utility and WSL pools.
- `cliToolContractVerify.ts`, `cliComputerUseAccuracyVerify.ts`, and `openAIHubAnthropicSmokeContractVerify.ts`: respectively cover 32 unified CLI/schema/policy assertions, 19 deterministic Windows ComputerUse scenarios driven by `DESKTOP/scripts/fixtures/computer-use-1280x720.ps1` (including real global/app drag and occluded virtual/app drag) with 100% schema validity, zero false triggers, confirmed drop state and unchanged physical cursor/foreground in virtual mode, and 30 zero-network Anthropic SSE/tool/tool-result assertions with `real_api_called:false`.

## Generated Build Directories

- `DESKTOP/dist/`: generated TypeScript/UI output, bundled `tui/`, and four runtime artifacts rebuilt by the normal build: `windows-process-tree-helper.dll`, `typebox-compile.bundle.cjs`, `wsl-agent-host.bundle.cjs`, and `conversation-utility-host.bundle.cjs`. `scripts/build-tui.cjs` copies the reviewed TUI source into `dist/tui`; packaging carries it through the existing `dist/**/*` rule. Packaging carries the DLL and TypeBox bundle through `asarUnpack`, includes the two worker bundles, and verifies all four before accepting `win-unpacked`; do not hand-edit generated files.
- `release/`: default packaged output. The dev-0.0.10 publication set contains only the validated Windows MSI and unpacked ZIP, alongside the extracted `win-unpacked/` smoke target. The published dev-0.0.9 set remains the Linux package source for AppImage, deb, unpacked ZIP, and `linux-unpacked/`; no dev-0.0.9 Linux file may be relabeled as dev-0.0.10. Other generated directory contents remain local build evidence. The directory may be locked while a packaged app is running.
- dev-0.0.10 is published as an unsigned Windows prerelease. `Newmark-Agent-0.0.10-win-unpacked-x64.zip` is 141729309 bytes / 135.16 MiB with SHA256 `A7A2A31861AB7D49BDDE70881DB568702689B603C46381576EDB92C4010BEF35`; `Newmark-Agent-0.0.10-x64.msi` is 110623345 bytes / 105.50 MiB with SHA256 `BC16757E1AA9E70E40B2AA21A800426FBFA24735C84532E4062D7F3409A5BD01`. GitHub reports matching server-side digests for both assets. The local MSI upgrade to 0.0.10 preserved every `~/.Newmark` file and started with one same-window prewarm page; detailed evidence is in 本地归档（未纳入公开仓库）.
- `release-icon-verify*/`: temporary verification outputs used for packaged UI validation.
- `release.locked-*`: historical locked release backup/output directories.

Generated release folders should not be treated as source, but they are useful for real UI acceptance testing.

## Maintenance Workflow

Before each implementation slice:

1. Read `README.md`.
2. Read `OVERVIEW.md` when present.
3. Read the latest relevant 本地归档（未纳入公开仓库） records.
4. Identify whether the requested behavior must be validated in the packaged desktop UI.

After each implementation slice:

1. Run focused source scans and syntax checks.
2. Run `cd DESKTOP && npm.cmd test`.
3. Build or package enough to exercise the real Electron UI.
4. Use desktop control for visual validation when the change is user-facing.
5. Save ordinary UI verification screenshots under 本地归档（未纳入公开仓库）; never save Computer Use desktop screenshots, which are one-time inputs only.
6. Add a dated archive report.
7. Update the `README.md` Maintenance Log.
8. Update this `OVERVIEW.md` when structure, build flow, or ownership changes.

## Current Known Operational Notes

- The machine-wide dev-0.3.9 installation has now passed opt-in real-model stress through APInebula `gpt-5.4-mini`: installed CLI/UI routing, two-call Goal continuation, queued input drain, conversation isolation, model-backed long-context compression, and exact executable cleanup were exercised against an isolated temporary root. `DESKTOP/scripts/release-real-provider-stress.cjs` accepts `NEWMARK_TEST_EXE` for installed-build targeting, `NEWMARK_REAL_STRESS_SCENARIOS` for bounded targeted retests, and tagged independent reports. The test waits for asynchronously persisted Goal completion and derives compression load from the model window rather than assuming a character count crossed the token trigger. Evidence and interpretation are in 本地归档（未纳入公开仓库）.
- The verified Windows `dev-0.2.2` package is installed machine-wide at `C:\Program Files\Newmark Agent` as MSI product `0.2.2.0` / `{F952A163-41BE-4AB2-B26E-7A950512F732}`. The installed executable and `app.asar` exactly match the locally built package, the installed release CLI smoke passes, and no current-user application copy remains. Audited mutable state under `~/.Newmark` was unchanged; artifact hashes and installation evidence are recorded in 本地归档（未纳入公开仓库）.
- dev-0.2.1 adds an explicit npm/global GUI route in `DESKTOP/src/launcher.ts`: `Newmark --GUI` first resolves a configured or installed native desktop executable, then falls back to the npm Electron runtime. `Newmark --TUI` remains the shared terminal route. The npm publication surface is restricted by the top-level `DESKTOP/package.json#files` allowlist to compiled `dist`, UI assets, Flow templates, and the example config; tests, source maps, build caches, logs, and temporary output must never enter the tarball.
- The standalone viewer in `DESKTOP/src/main.ts` is a deliberately separate Electron mode. Image windows use their content-derived image title for BrowserWindow, document, and visible header titles. Memory Lab Overview windows use a graph-only document. Neither viewer hydrates `dist/ui/index.html`; `startupPrewarmVerify.ts` therefore audits main-UI CDP scripts separately from the explicit `--newmark-viewer` isolation stress.
- `DESKTOP/scripts/dist-linux.cjs` copies both `DESKTOP/` and sibling `TUI/` into its isolated WSL/Linux repository. Windows OpenSSH loopback stress runs only on Windows; the Windows release gate separately runs the real Ubuntu WSL PTY stress before Linux packaging.

- The dev-0.1.7 renderer now preserves branch pager metadata across Build completion and partial state refreshes. Complete responses hydrate the latest page-local anchor IDs before destructive transcript redraw, while partial responses merge only branch fields they actually contain. Packaged regression evidence is recorded in 本地归档（未纳入公开仓库）.

- Conversation persistence uses the v4 node tree and exposes all branch groups along the selected ancestry. Nested edits such as Build-start followed by Guide editing therefore retain independent pagers and earlier path data instead of replacing a single flat branch list. Final dev-0.1.7 nested-pagination evidence and artifact hashes are recorded in 本地归档（未纳入公开仓库）.

- On Windows PowerShell, `npm.ps1` can be blocked by execution policy. Use `npm.cmd` for repeatable commands.
- Running packaged Electron windows lock `release/` and `app.asar`. Close or stop only the matching Newmark packaged processes before rebuilding.
- `DESKTOP/scripts/dist-portable.cjs` is the compatibility entrypoint for the Windows release build. It now runs electron-builder `dir`, patches `release/win-unpacked/Newmark Agent.exe` with the Newmark Windows version resources and resource icon, verifies `win-unpacked`, `app.asar`, all four generated runtime artifacts (`windows-process-tree-helper.dll`, `typebox-compile.bundle.cjs`, `wsl-agent-host.bundle.cjs`, and `conversation-utility-host.bundle.cjs`), the unpacked executable associated icon, embedded Lucide UI assets, `ProductName`, `FileDescription`, and `OriginalFilename`, builds `Newmark-Agent-<version>-x64.msi` from the patched prepackaged directory, creates and verifies `Newmark-Agent-<version>-win-unpacked-x64.zip`, and then runs packaged release CLI smoke. `DESKTOP/package.json` intentionally keeps Windows `signAndEditExecutable: false` because electron-builder's resource-editing path can require extracting `winCodeSign` symlinks on Windows; the local `resedit` post-package patch avoids that clean-machine permission dependency. Use a long timeout and close matching release processes before rebuilding.
- Clean Windows startup hotfix on 2026-07-08 deferred automation wake scheduling until after the first desktop window is shown and bounded `schtasks.exe` calls to 5 seconds. Follow-up Program Files startup hardening first fell back to `app.getPath('userData')`; on 2026-07-10 the final policy moved mutable runtime state to `~/.Newmark` while leaving program files under protected install roots such as `C:\Program Files\Newmark Agent`; first-run initialization failures are logged to `startup.log`, retried once in user data when no explicit `--root` was provided, and then surfaced instead of leaving a silent no-window process. Startup initialization also avoids rewriting unchanged `config.json`, `PC_Hash.config`, valid Memory Lab indexes, and unchanged `External.json`. On 2026-07-09, packaged startup was hardened again with a lightweight startup shell that paints before Agent/workspace/skills initialization, then switches all open windows to the full UI after IPC and backend runtime readiness. The rebuilt dev-0.0.2 `win-unpacked` package was verified with CDP target creation, nonzero `MainWindowHandle`, process name `Newmark Agent`, no-root packaged startup in 1.422 seconds, startup-recovery full renderer readiness in 2.687 seconds, and an SSH-configured root in 1.405 seconds without startup SSH validation. Artifact hashes are `80E77602F299AC0650D0403D93866DB66B838B91DFF172DC566259B32BD6B461` for the portable executable and `9A7C2589B481BF06C8F76CEAEFEEAA1C6D29AFF0B5EA979E14936CD8CD513C92` for the win-unpacked zip. Evidence is in 本地归档（未纳入公开仓库）, 本地归档（未纳入公开仓库）, and 本地归档（未纳入公开仓库）.
- dev-0.0.0 release reset on 2026-07-05 keeps the latest source behavior while resetting public package metadata and release presentation to a clean development baseline. The baseline includes duplicate-reply reconciliation, Markdown formula rendering, rootless pasted-image prompt attachments, shared-backend multi-window conversation isolation, the double-buffered closed-loop Computer Use takeover border, strict overlay cleanup, exact local/SSH workspace uniqueness, renderer workspace upsert behavior, and structured `gh_fork status` fallback when GitHub CLI returns non-JSON transport errors. Validation passed `npm.cmd test` with 874 assertions, `dist:portable`, packaged `release:ui-multi-window-shared-backend-smoke`, and Computer Control visual switching. The dev-0.0.0 artifact hashes are `C83A284CE8AA46178F05D663A24AAEC5CE4D35FEFFC3C3899950EB03C1FA76E0` for `release/Newmark-Agent-0.0.0-portable-x64.exe` and `1A414C099116601FBF4A83BC120DD094BBE6D5E5CBAE3D8541CD4240E16E004B` for `release/Newmark-Agent-0.0.0-win-unpacked-x64.zip`. Release publication should delete previous GitHub release entries only after local validation and push succeed, then republish GitHub release tag `dev-0.0.0`. Computer Use desktop screenshots remain one-time inputs only and must not be archived.
- Latest v1.0.2 portable release was rebuilt on 2026-06-29 at `release/Newmark-Agent-0.0.2-portable-x64.exe` with SHA256 `C687C8DE21AE66DA3982B0E8EA82F07E8CEFEA61132A64259C3A0EA7A42026F5`. The Gemma-download removal was visually verified in the final packaged runtime with screenshot evidence at 本地归档（未纳入公开仓库）.
- External SVG sprite references can fail or render invisibly in the packaged Electron/asar context. The current build embeds Lucide symbols into `dist/ui/index.html` to keep icons reliable.
- Public/package release work must keep `LICENSE` and `THIRD_PARTY_NOTICES.md` included and refresh the dependency license inventory when lock files, package references, `_vendor/`, `_ref/`, or `skills/` change.
- Kernel-facing features still need real packaged-release verification when they affect runtime behavior. Prefer `release/win-unpacked/Newmark Agent.exe state|tool|send ...` for CLI/core checks and desktop control against the packaged window for UI/preload/Electron checks.
- Packaged UI can be validated through Electron CDP by launching `release/win-unpacked/Newmark Agent.exe --remote-debugging-port=<port>` and connecting Playwright over CDP. This is the current repeatable route for checking real renderer DOM, screenshots, and message/media/editor interactions.

## dev-0.2.3 input binding, Ultra orchestration, and provider-error hardening (2026-08-02)

The current source advances to dev-0.2.3. `DESKTOP/src/ui/index.html` stores unsent prompt drafts by workspace/conversation runtime key, restores them after switching conversations, and preserves the chat scroll anchor during transcript rerenders. `DESKTOP/src/core/agent.ts`, `DESKTOP/src/core/config.ts`, and `DESKTOP/src/llm/provider.ts` expose Ultra as a persistent highest intelligence tier whose provider request uses max reasoning effort. `DESKTOP/src/core/agentKernelRunner.ts` withholds provider error tokens such as HTTP 402 from normal streaming text and retains the tool-provision broker when task-specific tools are initially empty. Regression assertions live in `DESKTOP/src/tests/verify.ts` and `DESKTOP/src/tests/intelligenceTierVerify.ts`; the dated audit is 本地归档（未纳入公开仓库）.

## dev-0.3.13 cross-scenario black-box gate (2026-08-13)

The executable cross-scenario pressure plan is in `tasks/plan.md` and the execution checklist is in `tasks/todo.md`. Two fresh-context `gpt-5.6-luna/max` black-box runs used only real installed-directory probes and isolated Windows Temp roots. The observed Program Files package is still `0.3.12`, so it is not evidence for the `dev-0.3.13` source candidate. Raw GUI input/session screenshots, CLI help/state/failure outputs, and TUI PTY matrices were captured, but Flow, archive interruption, context compression/cache thresholds, GUI/TUI/CLI concurrent backend, Copilot, and sustained long-pressure cases were not completed. Both agents stalled during report aggregation and were shut down after product-process cleanup; the audited result is `INCOMPLETE/HOLD` in 本地归档（未纳入公开仓库）. No UAC or global installation was requested or performed.

The 2026-08-13 continuation rebuilt the real `0.3.13` Windows candidate and repaired stale `0.3.12` version assertions in both packaged release-gate scripts. The safe packaged black-box matrix passed 28 cases; packaged CLI/context-compression, shared-root restart, Flow pause/resume/running-archive, startup recovery, native editor, rapid conversation switching, queue/plan, multi-window shared backend, and 30-window TUI viewer stress also passed. The Flow archive probe removed the target in 133 ms and all three duplicate archive receipts succeeded. Three fresh-context GUI/TUI/context black-box batches reached their hard deadlines without structured final reports, and the real Copilot latency lane was blocked because no selectable GitHub Copilot model was available; these remain coverage gaps, so the verdict stays `INCOMPLETE/HOLD`. No UAC, MSI installation, Program Files mutation, or user-config write was performed. Full evidence and candidate hashes are in 本地归档（未纳入公开仓库）.

The 2026-08-13 full cross-scenario design rebuilt the matrix as five interacting layers—entry transport, work state, context/model, persistence action, and lifecycle/resources—and selected X01–X12 instead of claiming a Cartesian-product run. The design was dispatched as four fresh-context `gpt-5.6-luna/max` black-box batches: GUI persistence, TUI/CLI/shared backend, context/cache/prompt/Copilot, and fixed-event endurance/replay. All four reached their hard deadlines without structured final reports and are recorded as `INCOMPLETE`; candidate processes were cleaned, but the Temp roots remain as raw evidence. The design and dispatch audit are 本地归档（未纳入公开仓库） and 本地归档（未纳入公开仓库）. Overall release status remains `INCOMPLETE/HOLD`; no UAC is authorized.

## dev-0.3.13 help/root boundary repair and natural black-box continuation (2026-08-13)

The first completed long GUI black-box report found `D-HELP-001` (command help could enter GUI/runtime) and `D-ROOT-001` (some GUI/Wrapper probes observed Chromium state under the canonical user runtime when only `--root` was supplied). The repair is in `DESKTOP/src/launcher.ts`, `DESKTOP/src/main.ts`, and `DESKTOP/src/cli-commands.ts`: command help exits before initialization; explicit roots bind Electron `userData`, `sessionData`, and Chromium `--user-data-dir`; startup failure logging follows the resolved runtime root. Regression coverage includes both help argument orders, spaced roots, GUI direct launch, Console Wrapper forwarding, child command lines, profile files, and cleanup. Source verification is `1501/1501`; the rebuilt real Windows package passed Builder SSH/TUI/CLI/context compression/MSI/ZIP and the independent `28`-case safe black-box gate. Full evidence is 本地归档（未纳入公开仓库）.

The black-box execution rule was corrected after the historical incomplete dispatch: fresh-context `gpt-5.6-luna/max` testers must run naturally with no artificial hard deadline. They may end only on natural completion, an explicit failure, or safe cleanup of an actually uncontrolled process; a missing outer report is not a Clear result. The current Nash batch is still running against safe Temp roots. Release remains `INCOMPLETE/HOLD`; no UAC/global MSI installation is authorized.

## dev-0.3.13 official DSH Plugin and MCP discovery compatibility (2026-08-13)

Current status: the working-tree source candidate adds an independent `DSH Plugin` menu and restructures MCP management/discovery around reviewable metadata. DSH remains an official **developer preview** integration; `@deepseek-ai/dsh` follows the non-pinned `latest` update channel, so Newmark tolerates compatible schema growth instead of treating today's preview shape as a frozen protocol. The discovery boundary is read-only and permissive: it may inspect local CLI/package/profile/bundle configuration, retain and report unknown keys, and derive review candidates, but it must not execute or import DSH/plugin code, invoke package managers, install/update DSH, or rewrite DSH-owned files. This is not a `deepseek_harness` model-provider protocol. MCP candidates require explicit user review, only pre-fill the editor, and remain disabled when saved until the user separately enables them. **Verification state: source build, `1504/1504` verify, focused DSH/MCP gates, complete built desktop suite, rebuilt `win-unpacked`, and real Electron/CDP UI smoke passed. No MSI/ZIP build or release publication was performed.**

### Related file tree and ownership

```text
Newmark Agent/
├─ DESKTOP/
│  ├─ package.json
│  ├─ scripts/
│  │  └─ release-ui-skills-smoke.cjs
│  └─ src/
│     ├─ core/
│     │  ├─ dshCompatibility.ts
│     │  └─ mcpManager.ts
│     ├─ main.ts
│     ├─ preload.ts
│     ├─ ui/
│     │  └─ index.html
│     └─ tests/
│        ├─ dshCompatibilityVerify.ts
│        ├─ mcpManagerVerify.ts
│        └─ verify.ts
├─ README.md
├─ OVERVIEW.md
└─ 本机私有归档（已从公开仓库排除）
   ├─ 20260813-dsh-plugin-mcp-discovery-compatibility.md
   ├─ 20260813-gui-keyboard-dsh-inspired-optimization.md
   ├─ 20260813-release-ui-keyboard-command-palette-smoke.png
   ├─ 20260813-release-ui-dsh-plugin-smoke.png
   ├─ 20260813-release-ui-mcp-management-smoke.png
   └─ 20260813-release-ui-skills-smoke.png
```

- `DESKTOP/src/core/dshCompatibility.ts` owns tolerant, read-only discovery of the official DSH CLI/package and DSH-owned profile, bundle, and patch metadata. It normalizes display-safe facts, retains unknown configuration keys for forward-compatible review, and derives MCP candidates without loading plugin JavaScript or mutating any discovered file.
- `DESKTOP/src/tests/dshCompatibilityVerify.ts` is the focused deterministic contract gate for discovery fixtures: official bundle/profile shapes, schema growth and unknown keys, malformed or partial input, MCP candidate normalization, secret-safe output, and the no-execution/no-rewrite boundary. It passes in both focused and complete built-suite runs.
- `DESKTOP/src/core/mcpManager.ts` owns the persistent user MCP registry. It validates stdio/HTTP definitions, keeps credentials out of public list output, preserves corrupt source data before recovery, treats duplicate imports idempotently, and defaults newly reviewed definitions to disabled.
- `DESKTOP/src/tests/mcpManagerVerify.ts` covers disabled-by-default persistence, credential preservation/redaction/clearing, transport changes, duplicate handling, input hardening, URL safety, and corrupt-registry recovery. It passes in both focused and complete built-suite runs.
- `DESKTOP/src/main.ts` owns the main-process `dsh:discover` and `mcp:*` IPC handlers plus allowlisted external-link opening. It is the trust boundary between renderer requests, read-only discovery, and persistent MCP mutations.
- `DESKTOP/src/preload.ts` exposes only the narrow DSH discovery, MCP list/upsert/enable/remove, and safe external-link bridge required by the renderer; it does not expose filesystem or process execution primitives.
- `DESKTOP/src/ui/index.html` owns the persistent Plugins shell and its keyboard/focus semantics, the independent DSH developer-preview tab, rescan/loading/error/empty states, official-resource links, unknown-key and candidate presentation, and the MCP search/filter/review/edit workflow. Reviewing a DSH candidate only pre-fills the MCP form; saving does not auto-enable or launch it. It also owns the unified GUI command registry, searchable palette/help dialog, chord router, focus-region navigation, ARIA composite behavior, and semantic Newmark visual tokens.
- `DESKTOP/src/tests/verify.ts` carries source-level wiring and UI contract assertions for tab order, IPC/preload exposure, read-only wording, candidate review semantics, default-disabled behavior, keyboard registry/search semantics, and registration of the focused and packaged gates. Its current complete result is `1504/1504`.
- `DESKTOP/package.json` registers the focused DSH compatibility verifier in the built desktop suite and retains the packaged UI smoke entrypoint. The complete registered built suite passed after the final change.
- `DESKTOP/scripts/release-ui-skills-smoke.cjs` is the real packaged Electron/CDP path for exercising Plugins navigation, DSH/MCP rendering and refresh, candidate review, disabled-by-default persistence, secret-safe listing, MCP CRUD, command search, F1 help, focus, and IME safety. It passed against the rebuilt `win-unpacked` candidate.
- `README.md` records the user-facing maintenance state and explicitly distinguishes the source candidate from verified release evidence.
- `OVERVIEW.md` records the current architecture, file ownership, safety boundary, and verification status.
- The four `20260813-release-ui-*-smoke.png` files are visual evidence from the final passing real packaged Electron run.

The executed source sequence was `cd DESKTOP`, `npm.cmd run build`, the focused built verifiers, and `npm.cmd run test:desktop:built`. The candidate was then rebuilt with electron-builder `--win dir` and driven through `npm.cmd run release:ui-skills-smoke` against that exact artifact via Electron CDP. The tested `app.asar` SHA-256 is `0DCE6242BDA0639BD7F414616CFA47CD756A875FC81329C681F262305409D7D0`; full hashes and screenshots are in the dated archive record.

## dev-0.3.13 keyboard reachability and DSH-inspired interaction system (2026-08-13)

Newmark GUI now treats keyboard access as a command system rather than scattered `keydown` handlers. `DESKTOP/src/ui/index.html` defines 65 command records whose ids, categories, availability, context scopes, bindings, and actions drive both the runtime router and a stable FNV-1a manifest used by tests. The primary discovery paths are `Ctrl/Cmd+Shift+P` for the command palette and `F1` for the complete shortcut help. `F6` and `Shift+F6` traverse the primary regions; `Ctrl/Cmd+K` chords reach new conversation, workspace management, Plugins, DSH, Memory Lab, Automation, Flow, settings, and the primary input. Common layout, editor, terminal, and browser commands remain context-scoped so text editing, IME composition, browser navigation, terminal input, OS-reserved shortcuts, and assistive technology conventions are not captured accidentally.

The interaction layer uses modal focus trapping, initial focus and focus return, inert background content, visible `:focus-visible` rings, roving tabs, arrow/Home/End navigation, list/listitem current-state semantics, keyboard-resizable separators, tree and disclosure controls, terminal-tab `Delete`, and a reduced-motion fallback. Browser WebViews forward only F1 and command-palette discovery to the host; Electron OS-global shortcut registration is intentionally absent. Camel-case command identifiers are split before filtering, preventing a query such as `DSH` from accidentally matching `keyboardShortcuts`.

The DSH-Harness study influenced structure rather than branding or runtime coupling. Newmark adopts explicit state/ownership layers, lazy searchable inventories, static configuration versus live runtime state, semantic tokens instead of component-local colors, and dense no-soft-wrap terminal/transcript surfaces. It does not embed Cordis, claim DSH fiber phases, deep-merge Cordis patches, evaluate `!!js`/import/plugin nodes, pin preview versions, or copy DeepSeek colors. The DSH developer-preview boundary stays dynamically discoverable and read-only, allowing upstream package/profile/bundle schema growth to remain visible without giving it execution authority.

Verification includes the complete built desktop suite, the `1504/1504` source contract, and real packaged CDP checks for a 65-command conflict-free manifest, unique DSH search, Enter activation, F1/Escape, focus placement, IME Enter suppression, Plugins tab order, DSH/MCP/Skills behavior, and screenshot evidence. Details are in 本地归档（未纳入公开仓库）.
## 移动模型菜单滚动与图片二维码配对（2026-08-17）

`AnchorMenu` 统一限制弹窗最大高度为安全可用高度的 56%，并封顶 `320dp`。模型选择页显式启用 `rememberScrollState` 与自绘滚动条，长 provider/model 列表可上下滚动且不遮挡菜单项。设置页图片选择器通过 ZXing 解码二维码，成功后调用 `DesktopLinkViewModel.pairFromUrl` 完成桌面端配对；失败时通过 `reportPairingError` 告知用户原因。

## 移动边栏窗口级背景模糊与远程模型兼容（2026-08-18）

- `android/app/src/main/java/com/newmark/mobile/ui/NewmarkApp.kt` 将 `32.dp` 模糊仅施加到边栏后方的 `ChatScreen`。竖屏左栏由 `drawerState.isOpen` 驱动，右栏由连续的 `rightSidebarProgress` 驱动；平板/折叠屏的二级左栏和右栏采用相同规则。边栏在模糊层之后绘制，因此图标、文字和控件保持清晰；Popup/Dialog 不参与窗口级模糊。
- `android/app/src/main/java/com/newmark/mobile/ui/components/AnchorMenu.kt` 对 `UpStart` 菜单只约束顶部安全区，不再用通用 `maxY` 把菜单反复钳回高位。输入复合菜单的实际底边因此稳定在输入框顶边上方约 `6dp`，同时保留限宽、限高和溢出滚动。
- `android/app/src/main/java/com/newmark/mobile/data/MobileApiClient.kt` 与 `android/app/src/main/java/com/newmark/mobile/vm/DesktopLinkViewModel.kt` 为旧桌面安装增加同一配对目标内的 `/api/state.providers` 兼容读取。新桌面仍以 `/api/mobile/state.providers` 为主；兼容目录只接收脱敏 provider/model 元数据，并生成 provider 隔离的 deployment 标识。
- 现场证据为 本地归档（未纳入公开仓库）、本地归档（未纳入公开仓库） 与 本地归档（未纳入公开仓库）。模拟器二级菜单实际显示 DeepSeek/APInebula 多模型并可滚动，版本为 `0.4.40` / `440`。

### 0.4.41 模糊进度连续化

`NewmarkApp.kt` 不再用 `drawerState.isOpen` 或 `hasSecondary` 的布尔状态直接切换 `32.dp` 模糊。竖屏左栏从 Material3 `DrawerState.currentOffset` 与当前抽屉宽度计算 `0..1` 实际展开比例；右栏沿用 `rightSidebarProgress`；平板/折叠屏二级左栏使用与宽度展开相同的 `400ms PcEaseOutExpo` 动画。最终模糊半径为 `32.dp × max(左栏进度, 右栏进度)`，所以拖动、打开和关闭全过程平滑，并且双栏同时存在时不会因另一侧收起而突然减弱。
# 2026-08-19 mobile runtime update

- `android/app/src/main/java/com/newmark/mobile/ui/BrowserSession.kt` owns conversation-scoped browser state and lazy activation.
- `android/app/src/main/java/com/newmark/mobile/ui/RightSidebar.kt` keeps an activated conversation browser mounted independently from right-sidebar visibility and keys WebView lifetime by session.
- `android/app/src/main/java/com/newmark/mobile/ui/NewmarkApp.kt` binds local Agent browser calls to the active local conversation without mutating sidebar presentation state.
- `android/app/src/test/java/com/newmark/mobile/ui/BrowserSessionRegistryTest.kt` guards same-conversation identity and cross-conversation isolation.

## 2026-08-19 PC GUI/TUI remote service runtime gate

- `DESKTOP/scripts/release-pc-gui-tui-remote-service-stress.cjs` owns the installed Windows black-box gate for hosted port `47890`: guarded existing-instance handling, isolated roots, GUI CDP state inspection, TUI PTY/CLI comparison, token/CORS/SSE checks, IPv4 reachability, concurrent core reads, alternating restart, port release, and user-GUI restoration.
- `DESKTOP/package.json` exposes the gate as `release:pc-gui-tui-remote-service-stress`.
- Result: three GUI↔TUI cycles passed with 100% pressure-read success, stable per-interface hashes, clean port release, GUI renderer/HTTP parity, TUI CLI/HTTP parity, and standalone GUI-only mutation 409 fail-closed. Detected IPv4 addresses were reachable; IPv6 `::1` was refused as expected under the current IPv4-only bind contract. `npm.cmd run build` and `mobileWorkspaceApiVerify` 43/43 also passed.
## 2026-08-19 mobile transcript floating-bar clearance

- `android/app/src/main/java/com/newmark/mobile/ui/ChatScreen.kt` keeps a final stable 190dp scroll item, equal to ten 19dp transcript body lines, so the latest message can be scrolled clear of Queue/Goal/Flow overlays without moving or resizing those overlays.
- `android/app/src/test/java/com/newmark/mobile/ui/TranscriptLayoutContractTest.kt` locks the ten-line/190dp geometry contract.
# 2026-08-19 移动 Queue 拖动排序状态

- `android/app/src/main/java/com/newmark/mobile/ui/ChatScreen.kt`：Queue 拖动改为源/目标索引驱动的占位动画；手势中不改写队列，结束后按稳定 id 一次提交，取消仅复位。
- `android/app/src/test/java/com/newmark/mobile/ui/QueueDragAnimationContractTest.kt`：验证半行目标阈值、列表边界和双向相邻行位移。

## 2026-08-19 Build 收尾 Guide 重新激活

- `DESKTOP/src/core/conversationKernel.ts`：conversation supervisor 在 `activePromise` 刚释放、但当前 `runId` 仍持有 finalization barrier 所有权时接受 Guide；Guide 以 deferred continuation 持久化并更新队列状态，再通过既有 continuation scheduler 恢复同一 WorkRun，执行完成后重新进入正常收尾。
- `DESKTOP/src/main.ts`：移动/远端 `conversation_guide` 与 `goal_guide` 不再用可能滞后一拍的 `runtime.running=false` 提前否决；它保留目标 `runId` 并把最终的可恢复/过期判断交给 conversation kernel。
- `DESKTOP/src/tests/guideWorkRunVerify.ts`：覆盖跨两层异步任务边界到达的单次 Guide，以及连续 12 次“completed → Guide → resume → completed”压力；锁定同一 Build/runId、Guide exactly-once、完整后续响应和最终安静收尾。

## 2026-08-20 移动端到 PC 工作区文件上传

本轮把移动聊天输入框左侧 `+` 与 PC 工作区固定 `/Uploaded` 目录连成一条受控数据通道。上传资源为 `POST /api/mobile/workspace-file-upload?workspaceId=...&directory=Uploaded&fileName=...`，请求体是原始文件字节；服务端不通过 JSON/Base64 聚合文件。工作区与目标目录均由 PC 注册表和 canonical realpath 校验决定，客户端不能提交绝对目录、父级穿越或带分隔符的文件名。

```text
Newmark Agent/
├─ DESKTOP/src/server.ts
│  └─ mobile token/remote-touch gate、64 MiB 流式接收、SHA-256、原子重名落盘
├─ DESKTOP/src/tests/mobileWorkspaceApiVerify.ts
│  └─ 真实 HTTP、双工作区隔离、并发、超限、穿越与符号链接契约
├─ android/app/src/main/java/com/newmark/mobile/
│  ├─ data/MobileApiClient.kt
│  │  └─ OkHttp RequestBody/InputStream 原始字节上传
│  ├─ vm/DesktopLinkViewModel.kt
│  │  └─ 点击时冻结 pair/workspace/conversation、固定目录上传、本地 send + Guide 注入
│  └─ ui/RightSidebar.kt
│     └─ 只读工作区文件树，不包含重复上传入口
├─ android/app/src/test/java/com/newmark/mobile/ui/WorkspaceUploadContractTest.kt
│  └─ endpoint、流式请求、无 Base64、当前目标和刷新契约
└─ 本地归档（未纳入公开仓库）
   └─ 威胁模型、RED/GREEN、压力门禁与已知 lint 边界
```

重名策略为保留两者：`a.ext` 已存在时依次分配 `a (1).ext`；同目录临时文件完成并 `fsync` 后用 exclusive hard link 原子发布，因此并行同名请求不会覆盖或暴露半文件。服务端返回最终相对路径、大小、显示用 MIME 和 SHA-256，但不信任 MIME、不自动打开/执行/解压。Android 仅从聊天输入区 `+` 发起上传，并在打开系统选择器前冻结目标；完成后通过普通 send endpoint 以 `inputMode=guide` 通知同一冻结对话，绝不重新读取当前选中目标。
# 2026-08-20 移动端左右侧栏单层动画所有权

本轮将移动端侧栏 shell 的动画归属收敛到最外层固定尺寸表面，避免背景、裁剪边界和子组件分别运动。

```text
Newmark Agent/
├─ android/app/src/main/java/com/newmark/mobile/ui/
│  └─ NewmarkApp.kt
│     ├─ ExpandedMainLayout：左右布局避让槽与固定侧栏表面分离
│     ├─ left expanded surface：240dp/280dp，单一 translationX
│     └─ right surface：完整 panelWidth，单一 translationX
├─ android/app/src/test/java/com/newmark/mobile/ui/
│  └─ ResponsiveSidebarContractTest.kt
│     └─ 固定尺寸、单一位移源、旧双层动画拒绝契约
└─ 本机私有归档（已从公开仓库排除）
   └─ 20260820-mobile-sidebar-single-surface-motion.md
      └─ 根因、修复边界、验证命令与 Release APK 哈希
```

`NewmarkApp.kt` 是移动端自适应布局与侧栏运动状态的唯一所有者。布局 Row 只预留左右当前可见边界；左右侧栏本体由外层 Box 作为完整合成层覆盖绘制，背景、边框、tabs、列表和 WebView 等子树不再绑定进度或获得独立 shell 位移。内部业务动画（例如设备工作区展开、二级页面切换）仍保留，其状态不参与侧栏开合位移。

验证状态：`testDebugUnitTest`、`lintVitalRelease`、`assembleRelease` 全部通过。正式 APK 位于 `android/app/build/outputs/apk/release/app-release.apk`，SHA-256 为 `1CB966B027FF02A151C9B27791EA92B02B7CE82CD143143828030829B3973845`。
## 2026-08-20 移动侧栏松手结算状态机

`android/app/src/main/java/com/newmark/mobile/ui/NewmarkApp.kt` 现在为左右侧栏各持有一个 `Animatable`。拖动进度负责实时呈现，最后一个拖动值作为 `settleStart` 传入普通 Compose 协程：先 `snapTo(settleStart)`，再 `animateTo(target)`。因此手势和结算共享连续位置，不再由停留在旧端点的独立动画重播。

`android/app/src/test/java/com/newmark/mobile/ui/ResponsiveSidebarContractTest.kt` 锁定左右 `settleStart` 捕获、`snapTo -> animateTo` 顺序，并拒绝旧 `settled* by animateFloatAsState` 路径。归档为 本地归档（未纳入公开仓库）；Release APK SHA-256 为 `318BEA2B4FAF482DD3A66E7F843D106888580835974CBF646097291CD3CA4BE5`。
## 2026-08-20 移动右栏浏览器常驻与输入可达性

```text
android/app/src/main/java/com/newmark/mobile/ui/
├─ NewmarkApp.kt
│  ├─ 宽屏右栏屏外常驻
│  └─ 本地 Uploads 选中态白名单
└─ RightSidebar.kt
   ├─ 450ms 延迟 WebView 预热与 keepMounted 生命周期
   ├─ 隐藏 WebView 的 View.INVISIBLE 触摸/绘制门禁
   ├─ BrowserRecognition 首次使用时延迟创建
   └─ TextFieldValue + cursor rect + horizontalScroll 地址跟随
android/app/src/test/java/com/newmark/mobile/ui/
├─ RightSidebarReadinessContractTest.kt
└─ ResponsiveSidebarContractTest.kt
```

`RightSidebar.kt` 现在在初始 Compose 工作完成后预热当前会话浏览器，WebView 随当前会话常驻并在不可见时使用原生 `INVISIBLE` 隔离输入。地址滚动算法维持 14dp 光标边缘余量并对左右边界和最大 scroll 做钳制。`NewmarkApp.kt` 保留零宽布局槽与屏外固定右栏，将组件生命周期从展开进度中解耦；本地选中态允许 Plan、Browser 与 Uploads。

完整 54/54 单测、Vital lint 和 Release 编译通过。APK SHA-256 为 `7008A4369764DFFBBBA887020C4933596662E2103107B89D7464643957A9B3E9`。当前无 ADB 设备，未声明真机交互或帧性能通过。
## 2026-08-20 移动侧栏松手帧连续性

`NewmarkApp.kt` 的 `sidebarPresentedProgress` 明确侧栏显示状态优先级：`dragProgress -> settleStart -> Animatable.value`。松手 effect 按 `snapTo(settleStart) -> clear settleStart -> animateTo(target)` 执行，保证拖动帧、交接帧和动画首帧位置一致。`ResponsiveSidebarContractTest.kt` 锁定三阶段数值连续性与状态清理顺序。

完整 Android 单测、Vital lint 和 Release 编译通过。APK SHA-256 为 `707FFEF3DB5D45EE9BF7988FBDFCABC83C2CAB1C1B2B28C5B51ECB6E6CD11FC7`；当前无 ADB 设备，未声明真机逐帧视觉验证通过。
## 2026-08-20 移动侧栏 easing 微调

`NewmarkApp.kt` 新增侧栏专用 `SidebarEaseInOut(0.4, 0, 0.2, 1)`，仅供左右侧栏 `Animatable.animateTo` 使用。右栏 250ms、左栏 320ms、状态交接、布局和其他 UI 动画均未改变。`ResponsiveSidebarContractTest.kt` 锁定曲线参数与两处使用点。

完整 Android 单测、Vital lint 和 Release 编译通过。APK SHA-256 为 `D9C83E93F71E642F4FFD23C16B6EA6C6AEA226CDD0B2BD6B9837EF1870CC9F95`；当前无 ADB 设备，未声明真机观感验证通过。
## 2026-08-20 移动侧栏 ARR 与帧级布局边界

```text
android/app/src/main/java/com/newmark/mobile/
├─ MainActivity.kt
│  └─ 旧版/固定模式的显示器最高 preferredRefreshRate
└─ ui/NewmarkApp.kt
   ├─ 动画期 Compose 根 View 的 ARR High 投票
   ├─ 动画结束恢复 DEFAULT
   └─ SidebarFrameProgressHost 独立逐帧 restart scope
```

`SidebarFrameProgressHost` 是左右 `Animatable.value` 的唯一逐帧组合读取点。它把进度传给现有 Compact/Expanded 布局，聊天边界仍随每个 frame-clock tick 连续重测，但 `NewmarkAppContent` 不再随每帧重新构建对话 surface 与外层页面。Android 15+ 使用 View 帧率类别参与 ARR 投票；系统不支持 ARR 或受电量/温度约束时仍以平台裁决为准。

完整 Android 单测、API 35 Vital lint 和 Release 编译通过。APK SHA-256 为 `9EC92F6D23BE90A3A25CC9F2DDA40C10B5668D0AF405B80B42F64270E7F54128`；当前无 ADB 设备，未声明真机高刷/jank 指标通过。

## 2026-08-20 Android 三态 Agent / MemoryLab 压力证据

```text
Newmark Agent/
├─ android/app/src/main/java/com/newmark/mobile/data/
│  └─ MemoryLabStore.kt
│     └─ 本轮确认 reindex 仅排序现有 tags，未从组件 tagPaths 重建 DAG
├─ android/scripts/
│  ├─ mobile-agent-stress.ps1
│  │  └─ 竖屏 resident Build/Goal/Flow/queue/stale-event 压力
│  └─ fixtures/
│     ├─ local-stress-providers.json
│     └─ local-stress-active-model.json
├─ DESKTOP/scripts/mobile-mock-server.cjs
│  └─ 移动本地 17 工具与远端状态确定性 fixture
└─ 本机私有归档（已从公开仓库排除）
   ├─ 20260820-mobile-three-form-agent-memorylab-pressure.md
   ├─ mobile-stress-20260820-205106.json
   └─ 20260820-three-form-*.{png,xml,json,md}
```

隔离 `com.newmark.mobile.stress` 在约 411dp 竖屏、674dp 折叠展开响应宽度和 1280dp 平板横屏完成实测。本地 Agent 三回合产生 17 个真实工具结果；MemoryLab 同名组件由 revision 1 改写到 revision 2，强停重启后正文与对话 SHA-256 保持。平板布局实测左栏 280dp、右栏 300dp，Uploads 子栏可进入。竖屏远端压力处理 138 个实际事件（含 14 个重复）并通过 Build/Goal/Flow/Next/过期事件门禁。三态 Newmark 包 FATAL/ANR 均为 0。

当前结论为部分通过：`MemoryLabStore.reindex()` 不会从组件的 `tags/tagPaths` 重建标签图，导致总览为 `0 标签 · 1 组件` 且详细页显示“暂无记忆”；本地 Browser 的 URL/history 在进程死亡后回到默认 Google 页。软件渲染 Debug AVD 的三态 jank 原始值分别为 30.79%、25.59%、10.54%，但本轮没有取得可信的硬件刷新模式轨迹，因此只能判定“未验证是否顶满设备当时选择的 ARR 自适应上限”，不能套用固定 60Hz 预算。现有 AVD 无 hinge sensor，因此折叠态只覆盖中等宽度响应分支，不覆盖真实折痕、遮挡或半开姿态。

## 2026-08-20 设置内部预测性返回交接

```text
android/app/src/main/java/com/newmark/mobile/ui/
├─ PredictiveBackMotion.kt
│  ├─ retainProgressOnCommit：设置主页退出时保留释放帧给外层页面
│  └─ settleProgressOnCommit：二级/三级页从释放 progress 连续归零
├─ SettingsScreen.kt
│  └─ Main 与内部页面按返回目标分别选择 retain / settle 所有权
└─ ../../test/java/com/newmark/mobile/ui/
   └─ PredictiveBackMotionContractTest.kt
      └─ 锁定提交顺序、真实起始 progress、220ms settlement 与顶层语义
```

此前设置内部页面提交返回后在 `finally` 强制归零，早于 `AnimatedContent` 的下一次组合，形成“先复位、再动画”。现在内部返回在提交目标页后，从手指松开值用与页面过渡一致的 220ms PC easing 连续归位；取消手势和其他独立页面默认语义不变。全量 Android 单测、Vital lint、R8、资源收缩和 Release 编译通过；正式包经 10 文件数据指纹守卫覆盖安装，模拟器“模型与供应商 → 设置”预测返回完成且无包级 FATAL/ANR。归档与录像见 本地归档（未纳入公开仓库）。

## 2026-08-20 dev-0.5.0 三端绑定发布边界

```text
Newmark Agent/
├─ VERSION                                  # Windows/Linux/Android 唯一版本源
├─ .github/workflows/release-linux.yml      # 标签触发三端构建与六资产 prerelease
├─ DESKTOP/
│  ├─ scripts/sync-release-version.cjs      # package/lock/Gradle/tag 一致性校验与同步
│  ├─ scripts/release-all.cjs               # 默认 Win + Linux + Android 本地编排
│  ├─ scripts/verify-github-release-assets.cjs
│  └─ scripts/release-notes-dev-0.5.0.md
├─ android/app/build.gradle.kts             # versionName 0.5.0 / versionCode 500
├─ README.md                                # 产品、安装、Tailscale 与开发说明
└─ release/                                 # 本地六个发布资产，不进入 Git
```

`VERSION=0.5.0` 绑定桌面 package/package-lock 与 Android `versionName/versionCode`，`dev-X.Y.Z` 标签也必须等于绑定版本。默认 `npm run release` 先跑完整桌面门禁和 Android 单测/Vital lint，再构建 Windows MSI/便携 ZIP、WSL Linux AppImage/deb/ZIP 和 Android APK；本地 electron-builder 显式 `--publish never`，仅 GitHub Release 步骤上传。工作流按三平台独立构建，聚合且只接受六个资产。

本轮完整桌面门禁连续两次通过；Android 单测、Vital lint、R8、资源收缩和 Release APK 通过。新 MSI 以托管流程卸载旧产品并安装成功（exit 0），`C:\Program Files\Newmark Agent\Newmark.exe --version` 为 `0.5.0`，注册表为 `0.5.0.0`，安装与打包 `app.asar` SHA-256 均为 `6C95B2C91C4AFFD7696E4FAC831E2DE360F8C62B9F84897D73BAC7BB1D441696`。六资产哈希与远端下载复核记录见 本地归档（未纳入公开仓库）。

`dev-0.5.0` prerelease 已发布六资产，GitHub 服务器端对每个资产计算的 size 与 SHA-256 digest 全部匹配本地。当前代理对 1 GiB 并发回下载在 30 分钟硬超时内保持 0 字节，直连被重置；1 MiB Range 下载可用但完整串行吞吐不可接受，因此没有把“完整回下载”误报为通过。标签触发的首轮 CI 中 Android/Linux 成功，Windows 因 hosted runner 缺少 OpenSSH server 资产失败；`master` 随后增加仅 CI 可显式启用的 packaged-SSH skip（本地默认 release 仍强制运行），手动 `release-platforms` run `32384431037` 的 Windows、Linux、Android 三个构建 Job 全部成功，publish Job 按非标签预期跳过。

## 2026-08-21 Android 固定玻璃档位与供应商 API 迁移

```text
DESKTOP/src/
├─ server.ts                               # 配对鉴权 POST 凭据迁移端点；普通 state 继续脱敏
└─ tests/mobileWorkspaceApiVerify.ts       # 锁定 POST/GET/脱敏边界
android/app/src/main/java/com/newmark/mobile/
├─ data/
│  ├─ MobileApiClient.kt                   # Bearer + no-store 显式拉取
│  └─ ProviderConfig.kt                    # 密钥保留、旧脱敏条目修复与模型合并
├─ vm/
│  ├─ DesktopLinkViewModel.kt              # 只从迁移端点解析可用目录
│  └─ ChatViewModel.kt                     # 落盘合并结果
└─ ui/
   ├─ SettingsScreen.kt                    # 删除玻璃程度设置条
   └─ theme/NewmarkTheme.kt                # 固定 DefaultGlassAlpha=0.85
```

“从连接设备拉取”此前复用 `/api/mobile/state.providers`，该响应按安全契约把 `api_key` 清空；移动端合并新供应商时又强制写入空 Key，因而拉取结果只能展示模型而不能本地调用。现在普通远程状态仍严格脱敏，用户显式拉取改走仅允许配对鉴权 POST 的 `/api/mobile/provider-catalog-export`，Bearer 令牌不进入 URL，响应禁止缓存；合并优先保留本机已有密钥，也能用远端凭据修复此前已落盘的无 Key 同 ID/接口条目。

玻璃渲染不再读取 SharedPreferences 或接受预览/提交回调，设置页不再显示玻璃强度 Slider，所有表面固定使用 85% 默认档位。桌面 TypeScript 编译与 52 项 mobile workspace API 契约通过；Android 64 项单测及全量 `testDebugUnitTest lintVitalRelease assembleRelease --no-daemon` 通过。Release APK 为 `android/app/build/outputs/apk/release/app-release.apk`，SHA-256 `C1C16EDBF97CBF09F517B5A7BA7FFD916F911CA813716148DA6540E9779286AA`。该 APK 已向 `emulator-5554` 保数据覆盖安装并启动，设置页新 UI dump 中“玻璃/不透明度/透明度/模糊”可见文本计数为 0，包级 FATAL/ANR 为 0；真实两设备凭据迁移仍只由隔离协议门禁覆盖。
## dev-0.5.2 Android Agent surface and ingress (2026-08-21)

```text
android/app/src/main/
├─ AndroidManifest.xml                    # exported share target and single-task delivery
└─ java/com/newmark/mobile/
   ├─ MainActivity.kt                     # ACTION_SEND queue and VIEW deep-link handoff
   ├─ data/
   │  ├─ ShareIngress.kt                  # cold/warm local/remote routing contract
   │  ├─ TerminalCommandCatalog.kt        # 80+ sandboxed command names and aliases
   │  ├─ LocalToolExecutor.kt             # terminal implementations and Calendar Intent
   │  ├─ LocalTools.kt                    # calendar_create function schema
   │  ├─ WorkRunProjection.kt             # thought completion/duration backfill
   │  └─ ChatModels.kt                    # deterministic elapsedAt clock projection
   ├─ vm/ChatViewModel.kt                 # public thought shell around provider waits
   └─ ui/
      ├─ ChatScreen.kt                    # narrow 100 ms running-duration ticker
      ├─ NewmarkApp.kt                    # share content validation/import/upload/send
      ├─ BrowserSession.kt                # address completion vs navigation boundary
      └─ RightSidebar.kt                  # mixed-content and Safe Browsing policy
```

Android local runs now publish an empty public `thought` activity before provider latency and complete it with `thought_result`; this exposes only lifecycle/duration, never private chain-of-thought. A running Build header owns a narrow 100 ms clock and stops ticking at `endedAt`, so “处理中/已处理” time advances without unrelated conversation mutations.

The sandboxed terminal exposes more than 80 familiar GNU/PowerShell/Android command names and aliases. Implementations cover time, safe workspace file operations, searching, line transforms, hashes/encoding, environment inspection, Memory Lab and settings; no unrestricted Android shell is granted, paths remain under `files/newmark/workspace`, and removal rejects the workspace root and non-empty directories. `calendar_create` uses `ACTION_INSERT` with `CalendarContract.Events.CONTENT_URI`, leaving final review/save to the installed calendar app and requiring no calendar read/write permission.

Android is an `ACTION_SEND`/`ACTION_SEND_MULTIPLE` target. A process cold start always creates a new local conversation; delivery to an existing activity follows the active local or remote conversation. Text is sent directly, local files are imported and their workspace location is sent to the Agent, and remote files use the target-bound upload pipeline. Only `content://` streams up to 20 MiB are accepted and data is read off the UI thread.

Browser address input completes host-like values with HTTP(S), uses HTTP only for explicit loopback/localhost input, and treats other ordinary text as a Google search. Navigation callbacks never use search fallback: they strictly validate parsed scheme, host, credentials, whitespace and port. WebView additionally rejects mixed content, file/content access, popup windows, geolocation and unsafe browsing hits.

Version is bound at desktop `0.5.2` and Android `versionName 0.5.2` / `versionCode 502`. Implementation record and current verification evidence are in 本地归档（未纳入公开仓库）.

Final Android gate `testDebugUnitTest lintVitalRelease assembleRelease --no-daemon` passed: 69 JVM tests, zero failures/errors, Vital lint, R8, resource shrinking and Release APK packaging all succeeded. The 45,838,216-byte APK SHA-256 is `37DA310D285585354017116432956F9B3AF747D519B5D0773C4C240EA275DDE7`. No ADB device was attached for this task, so system share-sheet/calendar UI and live remote-upload routing are not represented as device-observed evidence.

## dev-0.5.2 Android Agent terminal and calendar provider bridge (2026-08-21)

The local Build Agent now exposes `terminal_exec(command)` and routes it directly into the same sandboxed `LocalToolExecutor.execute` command engine used by the mobile terminal page. The Agent can use the complete built-in command catalogue while path canonicalization, explicit non-recursive deletion, bounded output and the absence of an Android system shell remain unchanged. Plan mode does not expose this mutating terminal tool.

Calendar access is now an Activity-owned runtime capability instead of an application-context-only launch. `NewmarkApp.kt` serializes Android permission requests, waits for the result inside the active tool call, and routes `calendar_create` through `WRITE_CALENDAR` or `calendar_read` through `READ_CALENDAR`. Creation still opens the documented default calendar insert UI. Reading queries the system `CalendarContract.Instances` provider over a bounded time range, result count and optional keyword filter, returning only permission-authorized event fields to the local Agent. The insert path no longer rejects valid handlers through a package-visibility-sensitive `resolveActivity` preflight.

Files and responsibilities: `LocalToolCatalog.kt`/`LocalTools.kt` publish Build/Plan capability boundaries; `LocalToolExecutor.kt` bridges terminal execution; `CalendarTool.kt` owns insert/read provider operations; `ChatViewModel.kt` binds tool calls to the Activity capability; `NewmarkApp.kt` owns permission prompts; `AndroidManifest.xml` declares calendar permissions; `LocalToolContractTest.kt` locks the complete path. Evidence is recorded in 本地归档（未纳入公开仓库）.

Final Android verification passed 71/71 JVM tests plus Vital lint, R8, resource shrinking and Release assembly. The installed APK SHA-256 is `9C79BF99E581B4605C659B4981E50DCBFD5FC48A8A2895357DEC95E47C6F1C88`. A preserve-data install to `emulator-5554` kept five private-state hashes unchanged, package manager confirmed both calendar permissions declared and ungranted, cold start completed with `MainActivity` top-resumed, and package FATAL/ANR matches were zero. No real provider call was spent solely to trigger the dialog, so actual Agent-driven permission UI and calendar data are not claimed as observed.

## 2026-08-23 dev-0.5.6 Kyant 菜单交互与静态表面回归

`android/app/src/main/java/com/newmark/mobile/ui/ChatScreen.kt` 现在以一个整体 Kyant 玻璃壳承载菜单，以唯一活动胶囊玻璃层承载按下/拖动选择。静态选中项恢复为色块，按住拖动时玻璃层跟随手指跨行，松手提交落点并回落为色块。PC `DESKTOP/src/ui/index.html` 删除全局静态按钮玻璃化，外围恢复原表面，按钮仅按下时浮起一层玻璃；输入区和终端本体不使用玻璃。

2026-08-24 追加校正：PC 设置/插件分页、MemoryLab 总览/详细、新建工作区三类型与输入区 Guide/Next 使用连续胶囊轨道和唯一透明移动玻璃；点按也完整播放旧项起浮、320ms 飞向目标、落地色块。活动玻璃通过 Electron 捕获真实窗口底图，WebGL2 实时执行从 Kyant 移植的圆角 SDF、透镜位移与七波段色散，已删除预烘焙光谱遮罩。开关按住后拇指扩展为放大胶囊，轨道按指针位置实时分割开启色/关闭色。左栏大空白根因为 `#left-thumb` 的 absolute 被后置 relative 覆盖，真实 Electron 坐标从错误的 `#left-content y=385.5` 修复为 `y=38`；靠窗浮块以窗口内侧为缩放方向，顶层渲染仍不被 overflow 裁剪。

Guide/Next 自身的通用按钮按压伪玻璃已禁用，交互期间只允许共享移动浮块存在。选择浮块取消 `scale(1.20)` 等比例放大，改为相对目标矩形四边固定外扩 9px；这使圆角胶囊获得均匀 9px 厚折射包边，不再随按钮宽度横向过度拉长。

PC WebGL2 移植进一步与 vendored Kyant `RoundedRectRefractionWithDispersionShaderString` 对齐：支持 `radiusAt`/四角半径、`circleMap` 透镜曲线、深度法线、显式 chromatic-aberration 强度，以及 red/orange/yellow/green/cyan/blue/purple 七次真实底图位移采样与原始通道权重。GPU 编译、链接和 WebGL2 不可用状态会写入浮块诊断属性并输出错误，不再静默伪装为成功玻璃。

PC 玻璃强度设置已统一进入同一透明度/光学强度映射，但区分两类材质：`.liquid-glass-carrier` 用于设置窗、模型/操作菜单等承载弹窗，提供独立底图磨砂、低透明染色和折射外壳；`.liquid-selection-float` 保持无填色、无 backdrop blur，只由 WebGL2 实时折射与色散。按钮交互层原先固定的 12px 模糊也改为 `--glass-blur-3` 派生。真实 Electron 在 50% 预览点测得 carrier blur `22px`、alpha `0.22`、浮块折射量 `48px`、色散强度 `2`，弹窗 computed filter 为 `blur(22px) saturate(1.5) brightness(1.02)`；探针随后恢复 85% 默认预览。

玻璃强度 range 使用 pointer capture，但状态语义不同于二态开关：按下时原色块圆形拇指原位扩展为单个 26x20px 玻璃胶囊；每次 pointer move 都立即更新滑条值、百分比 output、轨道分割、承载磨砂与浮块折射/色散。松手的 `change` 只保存已经实时呈现的当前值，不负责延迟应用效果；取消手势则恢复按下前值。合成后的原生 click 被抑制，避免松手后二次跳值或出现第二个静止玻璃。

桌面构建与 `pcGlassMigrationVerify` 通过；Android 128 项 JVM 单测、Vital lint、Release R8/assemble 全部通过。Release APK 位于 `android/app/build/outputs/apk/release/app-release.apk`，SHA-256 为 `858C8BF1B630BF6E568B9B74233B304C9DB33ADCDD67DFB6EFA4D9C1CD5E3F29`。PC 左右侧栏已接入同款选中项起点、淡入、放大和拖动落点玻璃块逻辑。`emulator-5556` 安装启动及包级 FATAL/ANR 扫描通过；`emulator-5554` 的安装服务因系统 `StorageManager` NPE 中断，未归因于应用。

## 2026-08-24 dev-0.5.6 连续玻璃状态机、排序避让与双源实时通知

```text
DESKTOP/
├─ src/ui/index.html                              # 唯一对话浮块重定向、排序避让、WebGL renderer pool
├─ src/tests/pcGlassMigrationVerify.ts            # PC 玻璃/排序/同项点击契约
└─ scripts/
   ├─ measure-liquid-renderer-calls.cjs            # 可观测 WebGL 调用计数
   └─ dev-liquid-renderer-performance-smoke.cjs    # 真实 Electron/WebGL2 fresh-texture 探针
android/app/src/main/
├─ java/com/newmark/mobile/
│  ├─ ui/ChatScreen.kt                             # 模型二级列表 300ms 手势仲裁与连续点击重定向
│  ├─ ui/Sidebar.kt                                # 本地/远程对话唯一浮块与换位避让
│  ├─ ui/components/LiquidHoldGesture.kt           # tap / scroll escape / held drag 共享契约
│  ├─ service/LocalAgentForegroundService.kt       # 远程/本地运行数协调与两行通知
│  └─ vm/{ChatViewModel,DesktopLinkViewModel}.kt   # 本地/远程真实运行计数发布
└─ res/
   ├─ layout/notification_agent_live_activity.xml  # 两行计数 + 横向进度条
   └─ drawable/notification_agent_marquee*.xml     # 黑白黑白循环移动帧
```

模型二级列表不再在 DOWN 时抢占纵向滚动：触摸在 300ms 前越过 slop 时完整让给父级滚动，短点按立即启动旧选择起浮、正常速度移动、落地，静止长按满 300ms 后才消费指针并允许跨行拖动。动画作业可取消重定向，连续点击沿唯一浮块的当前渲染位置飞往最后目标，仅最后目标提交；同项点击保留原位起浮、停留、落下。移动端本地/远程对话记录上一段视觉落地项，PC 复用正在过渡的 DOM 浮块，避免状态回写延迟造成从窗口外或错误上方重启。

对话排序期间 PC 与 Android 都关闭静态 active/selected 与 drop-target 胶囊，只显示携带中的玻璃胶囊；非拖动行继续按 `conversationDropIndex`/`conversationPreviewShift` 或 PC DOM 插入顺序整体避让并预览释放槽。PC WebGL2 在固定 6px 边缘保留完整 RGB 折射效果，中心完全透明且不执行截图纹理采样，避免深色底图以不透明矩形覆盖实时界面；首次和运动 draw 在当前交互/合成帧完成，不再嵌套等待下一帧。渲染池继续复用 context/program/buffer/texture、缓存 9 个 uniform、跳过重复几何并避免重复 canvas resize；真实 Electron 像素探针确认黑像素比例为 0，单一 context/program 持续复用。

前台通知由远程与本地 ViewModel 向同一服务发布去重运行数，任一侧仍有 Agent 即保留服务，两侧均为 0 才停止。自定义通知固定显示“远程有 n 个Agent正在运行”和“本地有 m 个Agent正在运行”，并由可动画 drawable 播放黑白黑白渐变条。API 35 模拟器实际通知记录、RemoteViews 文本和截图均通过；临时恢复系统动画倍率后，两张相隔 140ms 的条带截图出现像素位移，随后恢复模拟器原设置。

最终 Android 门禁为 136/136 JVM 单测、Vital lint、R8、资源收缩和 Release assembly 全通过；`app-release.apk` 为 45,938,144 bytes，SHA-256 `BEC316137289CE24B1DA8F94A19BE96DE190C2CD4D0C2BC4A9EE43617D133D5B`，已覆盖安装至 `emulator-5554`，包版本 0.5.6 且未发现 FATAL/ANR。100ms 快速纵向滑动模型二级弹窗后弹窗仍在，未误触选项。完整留痕见 本地归档（未纳入公开仓库）。

2026-08-24 的排序可见性修正进一步统一了预览与提交：Android 本地/远程对话均从源组索引和连续指针位移计算同一目标槽，实际移动首帧取消空飞行玻璃并显示携带内容；提交前将各对话 ID 的几何缓存重映射到新槽，避免活动对话排序后下一次点击仍从旧位置起飞。PC 使用真实按住行的克隆作为原生拖影，列表空隙也能提交当前 DOM 避让顺序，并在排序开始/提交时销毁旧玻璃飞行缓存。详见 本地归档（未纳入公开仓库）。

2026-08-24 22:12 将 PC 对话点击/排序彻底并入新版 Kyant 浮块管线：旧 `.conversation-selection-float` 阴影层和等比放大的原生拖影已删除；点击与拖动统一使用固定四边 9px 增厚的 `liquid-selection-float`、实时窗口底图和 RGB WebGL2 折射色散。排序时系统拖影为透明 1px 占位，唯一可见玻璃从活动对话飞向按住项，抵达后才克隆并包裹按住项内容，再随指针移动和驱动 DOM 避让。PC 完整桌面门禁、真实 Electron renderer 探针及 Android Release 门禁通过。产物与 UAC fresh-install 证据见 本地归档（未纳入公开仓库）。

## dev-0.5.3 移动运行时、后台通知与固定光条（2026-08-21）

Android 本地 Agent 现在在 chat/responses 两条协议上兼容旧 SSE 响应头，过滤空/`null` 思考增量并由运行所有权阻止双重最终回复；本地与远端对话共用 transcript 与 Markdown/TeX 呈现链。模型上下文支持主动/被动压缩、冷热历史管理及 Build block 有界读取，显示历史保持不变。普通 PC/Android provider 响应不设读取期限，PC PowerShell fallback 也不再把 0 隐式变成 1 秒。

本地运行使用 partial wake lock 与 sticky data-sync foreground service，持续通知显示“本地Agent运行状态 / 有n个本地Agent正在运行”，图标与模型/智能选择按钮语义一致。Android 16 使用原生 `ProgressStyle` promoted ongoing 流体云通知，进度载体为三段黑白交替；API 35 及以下保留既有自定义两行通知与跑马灯资源。PC/Android 跑马灯固定为纯黑、纯白、纯黑、纯白闭环，速度 3s，宽度分别为 2px/2dp；设置入口和配置读写已删除，旧三项 gradient 配置在升级首次加载时一次性清理。

Android 16 Live Updates 已改为真实 API 36 构建链：`compileSdk 36`、AGP 8.10.1 与 AndroidX Core 1.17.0。Manifest 声明 `POST_PROMOTED_NOTIFICATIONS`；API 36+ 只构建无进度条的 Standard Style Live Update，使用模型/智能选择 small icon、promoted ongoing 请求、“运行中”状态 chip、“本地Agent运行状态”标题及“有n个本地Agent正在运行”动态正文；API 35 及以下构建的普通 ongoing foreground notification也不显示进度条。旧反射实现把平台 `setShortCriticalText(String)` 错查为 `CharSequence`，会静默失败并回退普通通知，现已彻底移除。运行时同时检查结构资格 `hasPromotableCharacteristics()` 和系统/用户授权 `canPostPromotedNotifications()`，但不会在 Android 16 静默改回旧样式。

桌面编译及 1667/1667 综合断言通过；Android 单测、Vital lint、R8、资源收缩和 Release 构建通过。Android `targetSdk` 已提升到 36，满足系统对 Fluid Cloud/Live Update 的资格判定。最终 45,954,544-byte APK 位于 `android/app/build/outputs/apk/release/app-release.apk`，SHA-256 为 `C209F32F46D03EC2A1E52164AE580D17F9434263B0FFBB93ED33A72B07F1A2EE`。本轮同时扩展移动端 Markdown/LaTeX：支持无空格标题、删除线、分隔线、`~~~` 围栏、单行/多行 `$$...$$` 与 `\\[...\\]`、equation/align 等环境、更多常见 LaTeX 命令和符号；本地与远端继续共用同一渲染链。本轮同时将模型/智能选择图标显式设置为 Android 15 及以下 ongoing 通知和 Android 16+ Live Update 的 small/large icon，避免系统回退显示 Newmark launcher icon；新增 `ACCESS_NETWORK_STATE`、电池优化豁免声明和任务移除后继续运行的 data-sync 前台服务策略，启动时通过 Android 系统页面请求用户确认“不受电池优化限制”。APK 合并 Manifest 包含 promoted permission、网络状态和后台策略权限，Release DEX 包含 `android.requestPromotedOngoing=true`、`Notification.ProgressStyle` 三段进度和 short-critical-text extras。`emulator-5554` 仍为 API 35，因此 API 36 promoted chip、OPPO Fluid Cloud、物理设备息屏/OEM 保活及真实供应商长连接未声称已在设备上验证。完整记录见 本地归档（未纳入公开仓库）。

## 2026-08-25 dev-0.5.7 流体云与移动对话玻璃最终校正

`LocalAgentForegroundService.kt` 的 API 36 主路径恢复为已知可工作的 AndroidX Compat promoted
ongoing 构造，并移除自定义 RemoteViews、平台 ProgressStyle 与手写 promoted extras。
`Sidebar.kt` 为本地/远程、点按/拖动四条对话玻璃路径增加 180ms alpha 与 1.00→0.82 并行
回缩，完成后才隐藏浮层。`LiquidGlass.kt` 保持 6dp 光学折射厚度，并为半圆端帽定义固定
12dp 横向捕获外扩，补足圆角 SDF 消耗且不使用等比缩放。

定向测试与完整 `testDebugUnitTest lintVitalRelease assembleRelease --no-daemon` 均通过。
Release APK 为 45,954,544 bytes，SHA-256
`2A7961C5C7ED9A7D38445BB45575DF8836DAD51C568BDB0AA8A4942BE822E368`。

2026-08-25 后续实测修正：`Sidebar.kt` 为本地/远程对话维护独立视觉选中 ID，玻璃抵达后先
一次性提交并固定目标色块，再执行 240ms、1.00→0.68 的落地回缩，避免选中父状态回写造成
新旧底色竞争。对话胶囊、折叠/展开左栏三按钮及 `RightSidebar.kt` 分页按钮的静态选中边框
全部移除，运行中远程对话的胶囊 MarqueeBorder 也被取消，选择只通过 active surface 色块底
表达。Android 完整单测、Vital lint、R8 和 Release assembly 通过；留痕见
本地归档（未纳入公开仓库）。

同日追加统一移动选择玻璃生命周期：`ChatScreen.kt` 输入复合菜单、`Sidebar.kt` 对话与左栏
工具选择器、`RightSidebar.kt` 页签及 `MemoryLabScreen.kt` 分页均采用
`fill -> lift(100ms) -> move/drag -> land(240ms) -> fill`。moving/landing 为真时静态选中色块
一律不渲染；只有浮块退出后才恢复目标色块。对话的长按排序仍使用专用避让/跟手轨迹，但其
材质、起落比例和互斥规则与其他浮动玻璃一致。记录见
本地归档（未纳入公开仓库）。

移动端 selection overlay 进一步由 `components/LiquidGlass.kt` 的 `liquidSelectionMorph` 统一
承担色块与玻璃之间的可逆材质插值。所有选择器在松手后先归轨到目标几何，再以 240ms 同步
收回固定外扩、降低折射/模糊/高光并显出选中色块；终点动画层与静态色块完全同形同色后才
交接。对话胶囊使用运行时测得的目标矩形计算横纵缩放，完整留痕见
本地归档（未纳入公开仓库）。

PC `index.html` 为 `.conv-action-menu/.model-select-menu/.newmark-select-menu` 增加 List carrier
专用覆盖，停止旧版静态 `box-shadow` 泛光背景，同时保留 `.liquid-glass-carrier` 的实时磨砂。
PC 原生对话拖影按同一 pinned 分组计算首尾行矩形，固定 X 并夹取 Y；Android `Sidebar.kt`
新增 `clampConversationDragDelta`，本地/远程对话的可见浮块和目标槽共享相同轨道边界。记录见
本地归档（未纳入公开仓库）。

List carrier 的实机复核继续移除通用 `.liquid-glass::before` 整面固定折射渐变和 `::after` 固定
内阴影。三类 List 弹窗不再出现底部灰黑阴影带，carrier 的实时 backdrop 模糊与轮廓边线保留。

对话拖动浮块现将光学外壳与内容层的落地变换分离。PC `.conversation-drag-content` 在父浮块
收缩到 `.86` 时使用 `1/.86` 反向补偿，且 `landLiquidSelectionFloat` 在添加 landing class 前
清除速度形变；Android 两套对话行把 `liquidMotionDeformation` 限定为 `dragging` 期间，落地
内容保持原始比例。记录见 本地归档（未纳入公开仓库）。

后续实机校正补齐完整拖动端槽：PC 浮块固定在对话列 X 轴，同 pinned 分组的纵向轨道包含
首项前与末项后各一个完整插入槽，越过端点时 DOM 避让预览同步插到组首/组尾。Android 的
夹取范围同步包含这两个端槽，形变速度来自夹取后的实际位移，并移除内容行上的第二次液态
形变。Android 落地不再缩放整个 backdrop 采样节点，而是动态收回固定外扩宽高及对应左上角
偏移，使光学壳在目标中心落成色块，底层标题与图标保持 1:1 且无横向漂移。完整记录见
本地归档（未纳入公开仓库）。

Android 左栏折叠/展开三按钮与右栏子分页随后采用相同的 shell-only landing。三处删除
`graphicsLayer scaleX/scaleY` 落地缩放，分别以 40→36dp、整行→四周内收 4dp、
44×40→32×28dp 的动态几何变化完成色块交接；位置同步补偿半边尺寸差，中心保持锁定，
backdrop 中的图标与文字不再随外壳收缩。记录见
本地归档（未纳入公开仓库）。

Windows 0.5.7 Release 随后由 `dist:win` 重新构建。win-unpacked 身份/图标、SSH TUI、CLI、
上下文压缩、控制台边界、ZIP 与 MSI 管理映像 smoke 全部通过；UAC per-machine 安装返回 0，
注册表及 EXE 版本为 `0.5.7.0`，桌面/开始菜单快捷方式存在，Program Files 内 `app.asar`
与 release 产物 SHA-256 一致。MSI SHA-256 为
`F90E44A6BA82A30FD56EC5A97403E4FF6337F341164C4F52BA090F96FC3FD777`。记录见
本地归档（未纳入公开仓库）。

## 2026-08-25 审查增量唯一性与对话主题本底

```text
DESKTOP/
├─ src/ui/index.html                         # 审查状态/DOM upsert 与 #center 主题本底
├─ src/tests/workReviewDedupVerify.ts        # 同 run 快照更新及 provisional→canonical 门禁
└─ scripts/release-ui-work-review-bars-smoke.cjs # 真实 Electron 唯一卡片、本底与交互验证
本机私有归档（已从公开仓库排除）
└─ 20260825-work-review-incremental-upsert-chat-canvas.md
```

审查摘要不再使用 `runId + diff JSON` 作为追加键。同一逻辑运行的新快照覆盖旧状态并原位刷新
DOM；正式 runId 会通过 provisional alias 接管既有记录和卡片，同时清理同身份的多余节点。
不同 Build 即使文件统计相同仍各自保留审查卡。`#center` 新增由 `--app-bg` 与强调色混合的
不透明 `--chat-canvas`，处于对话滚动区、时间线轨道和交互玻璃的最底层，亮/暗主题分别使用
轻量 4%/8% 主题染色以增强可读性。

该修复随后通过开发态与打包态性能压力：300 次增量事件不替换既有 Build DOM，开发态输入
最大延迟 67.7ms；WebGL2 仅创建 1 context、编译 2 shader、链接 1 program、上传 1 texture，
两次首帧色散分别为 38ms/63ms，20 次完整点击 p95 为 510.5ms；打包版 10fps Build 限流下
输入最大延迟 30.6ms。新 MSI 的结构/安全 smoke 为 22+12 项全通过，并已通过 UAC 安装，
安装版 `app.asar` 与 release 候选 SHA-256 同为
`EEB2AC9AD01473F651BE7978676A567A3D0599D2DB9E1A80A2217B9AE7DF17AD`。记录见
本地归档（未纳入公开仓库）。

Build 展开路径的第二层重复根因随后修复：`workRunChangeBadge()` 输出
`.conversation-work-change-badge`，但 `updateConversationWorkRunElement()` 曾查询多出 `-run-`
的错误类名，导致每次交互更新都插入新徽标。现在查询与生成契约一致，真实 Electron 连续
8 次展开/收起后 badge 数量为 1。`.conversation-work-run-head` 同时加入通用按钮伪玻璃和
按压缩放排除清单，Build、block、tool、review 展开均为静态交互。记录见
本地归档（未纳入公开仓库）。

该修复的 Windows MSI 随后重新生成并通过 win-unpacked、SSH TUI 四轮重启、CLI、上下文压缩、
console 参数边界及 MSI 22+12 项管理映像 smoke。UAC 安装返回 0，注册表/EXE 为 `0.5.7.0`，
安装版 GUI 启动并产生 5 个主/GPU/renderer 进程，安装目录 `app.asar` 与候选哈希一致。记录见
本地归档（未纳入公开仓库）。

## 2026-08-25 移动选择器坐标与落地分层校正

```text
android/app/src/main/java/com/newmark/mobile/ui/
├─ Sidebar.kt          # 对话色块 Rect 转换到浮层宿主坐标，消除列表 inset 左偏
├─ RightSidebar.kt     # 记录右栏页签真实 Rect，按目标边界落地
└─ MemoryLabScreen.kt  # 总览/详细仅收缩玻璃外壳，不缩放采样内容
android/app/src/test/java/com/newmark/mobile/ui/
├─ ResponsiveSidebarContractTest.kt
└─ components/LiquidGlassContractTest.kt
本机私有归档（已从公开仓库排除）
└─ 20260825-mobile-selector-coordinate-and-shell-landing.md
```

对话浮块不再混用 LazyColumn 内容坐标与外层宿主坐标；右栏页签落地以实测色块宽高和 top 为
唯一目标，布局间距变化也不会破坏对齐。Memory Lab 采用 64×34dp 色块与四周 6dp 浮起外扩
之间的尺寸/位置插值，文字和 backdrop 采样内容不参与缩放。

该状态已通过 `assembleRelease --no-daemon` 完整构建，R8、Vital lint、资源优化和签名均成功。
APK 位于 `android/app/build/outputs/apk/release/app-release.apk`，SHA-256 为
`7761F5F841D75C3A32013FE248F26BFBA49C2541ECF87DE4BC8A57211D5022F5`。

## 2026-08-25 移动预测返回交接与对话移动态对齐

`TerminalScreen.kt` 的顶层返回和 `MemoryLabScreen.kt` 总览返回现在启用
`retainProgressOnCommit`，松手帧保持到 `NewmarkApp.kt` 的外层 `AnimatedVisibility` 退出接管；
Memory Lab 详细页返回总览使用 `settleProgressOnCommit`，避免同页切换留下手势变换。
`Sidebar.kt` 的本地/远程对话玻璃只在玻璃材质浮起期间应用 2dp 右向中心校正，进度 0 的
色块几何保持原样。完整 Android 单测通过，记录见
本地归档（未纳入公开仓库）。

该修复已完成 Android Release `assembleRelease --no-daemon`，R8、Vital lint、资源优化与签名
均成功。最新 APK 位于 `android/app/build/outputs/apk/release/app-release.apk`，大小
45,954,544 bytes，SHA-256 为 `F4A379867B05B667D4106F4F5986D46751A6D7639E73F71A970CFEB208F3E3E4`。

## 2026-08-25 移动右栏 PC carrier 同步

`RightSidebar.kt` 移除 `MobileRightSidebar` 全高容器上的 Kyant lens；背景聊天层仍由
`NewmarkApp.kt` 根据右栏展开 progress 记录并模糊，因此保留 PC 同款磨砂层次，但半拖时不会
把对话区折射成竖向倒影。亮色 carrier 固定使用 0.98 alpha，形状同步 PC 为左上/左下 18dp
圆角、右侧直角贴边，边线仅绘制在左侧。Android 完整单测通过，记录见
本地归档（未纳入公开仓库）。

最新 Release APK 已完成 R8、Vital lint、资源优化与签名，大小 45,954,544 bytes，SHA-256
`E1051DE9D6C02DB624626891874206D9A1E386F84EA9C7F2B4F7728738D224D5`。

后续按实机要求取消右栏 carrier 的左侧 18dp 圆角，容器恢复四角直角；亮色 0.98 alpha、
左侧 1dp 分隔线及无全高 lens 的行为保持。重新构建 APK 的 SHA-256 为
`A00D40A01E8EFB9DD218B4466A75744552756EA4C22DDC4FF63FD6908FE58795`。

## 2026-08-25 移动后台联网系统入口

`MobileCapabilityStore.kt` 新增后台数据限制状态读取；`SettingsScreen.kt` 的移动端权限区新增
“后台联网”开关，调起 `ACTION_IGNORE_BACKGROUND_DATA_RESTRICTIONS_SETTINGS` 并在返回时
刷新状态，不支持时回退 `ACTION_APPLICATION_DETAILS_SETTINGS`。Manifest 既有 `INTERNET` 和
`ACCESS_NETWORK_STATE` 保持。完整 Android 单测通过，记录见
本地归档（未纳入公开仓库）。

该状态已重新构建 Release APK，R8、Vital lint、资源优化与签名均成功；产物大小
45,970,928 bytes，SHA-256 `79A5577EEF1B0A92F2489B0BDCAA2933422DFA6474EBED03900CDED91ECDEB1D`。

后台联网开关现保存独立的 UI 请求状态：`false -> true` 才打开系统设置，`true -> false` 只更新
本地开关且无系统副作用。系统后台数据状态仍单独刷新显示。重新构建 APK 的 SHA-256 为
`A9DDA1C834B5A46393AF8AD580AD444D3BAC061C30CAE6F0CBDD502E0DC6BB1F`。

## 2026-08-26 全平台玻璃浮块并行运动状态机

```text
DESKTOP/src/
├─ ui/index.html                         # 到达检测、浮起/位移并发、拖动松手归轨落地
└─ tests/pcGlassMigrationVerify.ts       # PC 全部浮块入口与提交时序契约
android/app/src/main/java/com/newmark/mobile/ui/
├─ Sidebar.kt                            # 本地/远程对话与左栏三按钮
├─ RightSidebar.kt                       # 右栏子分页
├─ MemoryLabScreen.kt                    # 总览/详细分页
└─ ChatScreen.kt                         # 输入复合菜单选择器
android/app/src/test/java/com/newmark/mobile/ui/
├─ LiquidMotionConcurrencyContractTest.kt
├─ ResponsiveSidebarContractTest.kt
└─ components/LiquidGlassContractTest.kt
本机私有归档（已从公开仓库排除）
├─ 20260825-liquid-motion-full-audit.txt
├─ 20260825-liquid-motion-post-change-audit.txt
└─ 20260826-liquid-motion-concurrent-flight.md
```

移动端所有点击飞行删除 16/100ms 串行抬升等待与 220ms 原地空等；对话胶囊的材质浮起、固定
外扩和轨道位移在同一 coroutineScope 内并发。长按入口独立于点击提交路径，保持完整浮起直到
松手归轨。PC 使用实时目标几何收敛检测代替统一 360ms 计时器，浮块到达且浮起可见后立即
进入 120ms 落地；对话原生拖动松手后先归最终行再清理浮块和重绘列表。

验证：Android `testDebugUnitTest --no-daemon` 143 项通过；PC `npm run build` 通过；
`npx tsx src/tests/pcGlassMigrationVerify.ts` 全部检查通过。

### 最新构建与开发态启动

2026-08-26 对该状态执行 `lintVitalRelease assembleRelease --no-daemon`，Release APK 构建成功，
产物位于 `android/app/build/outputs/apk/release/app-release.apk`，大小 45,970,928 bytes，
SHA-256 为 `298E11F7A27000A7770956AB99AAEF1C3046E2BC5E3F1BA0DEDD44A0CABB8532`。
桌面端重新执行 `npm run build` 后，从工作区 `DESKTOP/node_modules/electron` 启动 Electron dev，
使用 `%TEMP%/newmark-electron-dev-057` 作为独立用户数据目录；主进程、GPU、network、renderer
与 Node utility 进程均确认存活。留痕见 本地归档（未纳入公开仓库）。

Windows 正式安装包随后由 `dist-portable.cjs` 从当前工作区重新生成。`win-unpacked` 通过图标、
SSH TUI/PTY、四轮重启、CLI、上下文压缩和 console 参数边界检查；MSI 管理映像通过 22+12 项
结构/安全断言。产物 `release/Newmark-Agent-0.5.7-x64.msi` 为 226,383,951 bytes，SHA-256
`3D6683B81E4FF3C90E51E26D2995808C3FBAFDA3A4D6E6EB06F122F145C2CF4A`。

本机 UAC 同版本升级返回 3010，表示成功但建议重启。注册表及 EXE 版本均为 `0.5.7.0`；安装
目录 `app.asar` 与候选哈希一致，安装版主/GPU/network/renderer 四个进程启动成功。完整记录
见 本地归档（未纳入公开仓库）。

## 2026-08-26 dev-0.5.8 对话菜单/归档退出动画

```text
android/app/src/main/java/com/newmark/mobile/ui/
├─ components/AnchorMenu.kt              # Popup 保活、锚点感知的缩放/淡入淡出
└─ Sidebar.kt                            # 本地/远程菜单触发源与归档分阶段提交
android/app/src/test/java/com/newmark/mobile/ui/
└─ ConversationMenuArchiveAnimationContractTest.kt
```

更多按钮使用右上 `TransformOrigin`，长按使用胶囊中心；关闭状态不会立即销毁 Popup。归档先播放
菜单反向退出，再以 alpha 与 scale 淡出胶囊，动画完成后才调用数据层归档回调。

## 2026-08-26 dev-0.5.8 默认时钟闹钟工具

`data/AlarmTool.kt` 通过 Android `AlarmClock` 公共 Intent 将创建与查看操作交给默认时钟应用。
Manifest 只声明标准 `SET_ALARM` 权限，已移除 Newmark 自建精确 AlarmManager、Receiver、通知
频道和内部 JSON 闹钟记录。工具面公开 `create|list`；系统未提供稳定的跨时钟 ID 枚举/删除
协议，因此不再向 Agent 暴露不可兑现的 `cancel` 参数。

### 当前 Android 压力/构建状态

`testDebugUnitTest` 共 151 项全部通过；`assembleStress` 生成隔离包
`android/app/build/outputs/apk/stress/app-stress.apk`；`lintVitalRelease assembleRelease` 完成
正式包的 lint、R8、资源优化与签名。当前主机没有 ADB 设备，依赖模拟器/实机的
`mobile-agent-stress.ps1` 未执行，不能纳入 runtime 压力通过结论。

## 2026-08-26 dev-0.5.8 移动端 Agent loop/context parity

`ChatViewModel.runAgentLoop` 不再使用 `while (loop < 6)`，而是绑定 coroutine 生命周期持续执行；
正常退出必须来自 provider 最终响应，取消映射为 interrupted，真实异常保留 error。每次 provider
请求前调用 `prepareActiveLoopContext`，按模型窗口重新估算当前工具链增长后的 context，并在
70%/90% 阈值执行普通/强制压缩。

`LocalContextContract.requestScopedTaskFocus` 对齐 PC 的请求级层次：最新真实 user 指令最高、
同一 Build Guide 顺序执行、历史仅作不可信证据、新任务不复活无关工作。该 system message 只
临时拼入 provider request， durable `modelContext` 中只保留公开对话、工具调用/结果、压缩摘要
与 continuation anchor。

缓存层面，`requestScopedTaskFocus` 为固定字节文本，不包含 mode、messages.size、toolCount、
messageId、时间戳或计划状态。工具子轮只在既有 durable prefix 后追加 assistant/tool messages，
使 provider 能复用最长公共 prompt 前缀；压缩完成属于必要的 context replacement 边界。

## 2026-08-26 dev-0.5.8 文件占位符与富文档读取

`LocalToolExecutor.recentFiles` 在现有 MediaStore 文档/图片/视频之外查询持久授权的
DocumentProvider，输出 URI、authority/document ID 组合的 `canonical_identity`、provider flags
及 placeholder 判断。`readSharedFile` 通过 `openAssetFileDescriptor` 让 provider 对在线占位内容
执行 hydrate，再按需取得 PDF seekable descriptor。

`RichDocumentReader.kt` 提供格式路由：OOXML 直接解析 docx/pptx/xlsx ZIP/XML；CSV/TSV 保持
行列；旧 doc/ppt/xls 使用 POI 文本/单元格模型。PDFBox 先读文字层，稀疏时用 Android
PdfRenderer 生成页面图，调用当前视觉模型；无结果则 ML Kit miniOCR，再将页面与 OCR 证据交给
LLM 综合，最后仍可做纯页面视觉转录。结果 JSON 标记具体 method，便于审计退路质量。

## 2026-08-26 dev-0.5.8 移动端重叠玻璃飞行

`ui/components/LiquidGlass.kt` 的 `runOverlappedLiquidFlight` 是既有浮块的统一材质/几何协调器：
lift 与 move 并发，起点浮起可见后 land 可与未完成的 move 并发，最终等待两者完成再交接目标色块；
hold 模式只执行 lift/move，禁止自动落地。现有浮块白名单包含对话胶囊、左右侧栏选择器、记忆实验室
分页和输入复合菜单，白名单仅用于审计，不用于把普通组件玻璃化。

入口分布于 `Sidebar.kt`、`RightSidebar.kt`、`MemoryLabScreen.kt`、`ChatScreen.kt`；
`OverlappedLiquidFlightContractTest.kt`、`LiquidMotionConcurrencyContractTest.kt` 与
`ResponsiveSidebarContractTest.kt` 共同验证重叠时序、按住保持、单浮块重定向和对话胶囊接入。

## 2026-08-26 dev-0.5.8 移动端全局无涟漪策略

`ui/theme/NewmarkTheme.kt` 在主题根部通过 `LocalIndication` 提供无绘制的
`NoVisualIndication`。因此普通 `Modifier.clickable`、显式读取 `LocalIndication` 的组件以及
Material3 Button/IconButton/TextButton 均不再绘制 Android 灰色 ripple，同时保留 InteractionSource、
点击语义、禁用态、长按/拖动和业务动画。`GlobalNoRippleContractTest.kt` 固化这一全局契约。
# PC terminal performance update (2026-08-26)

`DESKTOP/src/core/terminalOutputBuffer.ts` 负责 PTY 输出按时间窗合并、历史有界缓存及会话清理；`DESKTOP/src/ui/index.html` 的普通终端和 takeover 终端通过 `appendTerminalOutput` 使用 requestAnimationFrame + DocumentFragment 追加，避免高压输出下的同步全量 DOM 重排。
# Mobile Agent response recovery

`android/app/src/main/java/com/newmark/mobile/data/MobileResponseRecovery.kt` 定义可用响应、空响应错误分类和连续计数；`ChatViewModel.chatWithEmptyRecovery` 统一保护主 Agent、上下文压缩、视觉文档读取和 OCR 校正，避免不稳定 provider 将本地 build 错误结束。

## 2026-08-26 dev-0.5.8 空响应解析稳定性

`ApiClient.kt` 的 chat SSE 解析同时接受 `choices[0].delta` 与 `choices[0].message`。此前仅检查
`delta` 会丢弃兼容 provider 返回的完整消息帧，使正常连接在上层表现为连续空响应。恢复层固定
只有 provider 明确返回失效空响应才进入恢复；持续等待、静默连接、EOF、超时或流关闭本身不视为空响应。首次失效后依次等待 200ms、800ms、2s、10s、60s 执行第 1–5 次重试，第 5 次仍明确失效才终止；思考、正文、工具调用及其他有效流式活动都作为正常结果并立即清零计数。

回归由 `ApiClientStreamTest.kt`、`MobileResponseRecoveryTest.kt` 与
`MobileEmptyResponseRetryContractTest.kt` 固化；Release APK 已重新构建。

PC Chat SSE 只有观察到 `[DONE]` 或非空 `finish_reason` 后，零活动结果才可进入明确空响应恢复；
Responses 对应要求 `response.completed` 同时携带明确的内嵌 `response.status=completed`；缺失、空白、未知或非完成状态均失败。纯 EOF、连接重置、流关闭、读取超时和 broken pipe 始终属于
独立 transport failure，不使用空响应计数或等待序列；用户取消仍直接传播，不会被重试吞掉。

## 2026-08-26 dev-0.5.8 模型菜单帧调度隔离

```text
android/app/src/main/java/com/newmark/mobile/
├─ ui/ChatScreen.kt                         # 模型菜单稳定条目/几何、非观察飞行调度器、图层阶段运动读取
├─ ui/components/LiquidGlass.kt             # 与原形变公式一致的 deferred graphicsLayer 入口
└─ vm/ChatViewModel.kt                       # Agent 流式 delta 的 16ms 有序批量 UI 发布器
android/app/src/test/java/com/newmark/mobile/
├─ ui/ModelMenuGlassSchedulingContractTest.kt # 拖动热路径与 Agent 发布退压契约
├─ ui/components/LiquidGlassContractTest.kt  # 玻璃 recorder、材质和运动顺序契约
└─ vm/MobileEmptyResponseRetryContractTest.kt # 帧合并后仍保留完整空响应恢复边界
```

模型菜单的 `Animatable.value/velocity` 只在 graphics layer 更新阶段读取；Job 与 activeIndex 放在
非 Snapshot 调度器中，只有 moving/lifting/landing 等真正改变视觉结构的低频状态进入 composition。
模型分组、条目、命中几何和 pointer keys 按模型集合缓存。Agent provider 解析继续位于 IO，所有
thought/text delta 保序进入通道，主线程每 16ms 最多发布一次不可变 WorkRun 快照，响应结束前
强制 flush，因而不丢尾部增量，也不改变空响应成功判定。

## 2026-08-26 dev-0.5.8 移动端连续思考生命周期

```text
android/app/src/main/java/com/newmark/mobile/
├─ data/MobileThoughtContinuation.kt       # 跨 provider 子轮维持一个公开 thought 生命周期
├─ data/WorkRunProjection.kt               # thought_result 回填为一个完成节点
└─ vm/ChatViewModel.kt                     # 在工具/正文/Guide/错误/终态边界关闭 thought
android/app/src/test/java/com/newmark/mobile/data/
└─ MobileThoughtContinuationTest.kt        # 1000 子轮、流式去重与真实边界回归
```

此前 `runAgentLoop` 在每次 provider 子轮前无条件发布 `thought`，并在每次返回后立即发布
`thought_result`。当 provider 连续返回仅思考结果时，控制流继续下一子轮并创建新节点，最终在同一
Build 中堆叠大量“进行了思考”。`MobileThoughtContinuation` 现显式区分 provider round 与公开
thought lifecycle：thought-only 只结束 round 并把内容接到当前节点，真实工作边界才生成一次
`thought_result`。流式 delta 和最终 reasoning 字段按当前 round 对账，避免兼容 provider 同时返回
两种形式时重复正文；既有 16ms UI 批处理和五次明确空响应恢复逻辑未改变。

验证结果为 1000 轮 thought-only 压力下 1 个 thought 事件、结束后总计 2 个 thought/result 事件；
174 项 JVM 测试零失败，Vital Lint、R8 与 Release assembly 通过。APK 位于
`android/app/build/outputs/apk/release/app-release.apk`，SHA-256 为
`CBC301850B496EFD3B447138C05279F59CD5CE9328ED7F22D3EB57F87E42ABDB`。当前 ADB 无设备，
因此未声称完成模拟器或真机的长对话视觉验证。

## 2026-08-26 dev-0.5.8 移动端思考响应续接

```text
android/app/src/main/java/com/newmark/mobile/
├─ data/MobileThoughtContinuation.kt       # 公开思考单调对账 + 请求级有界续接检查点
└─ vm/ChatViewModel.kt                     # 子轮请求注入、真实工作边界清空、durable 上下文隔离
android/app/src/test/java/com/newmark/mobile/data/
├─ MobileThoughtContinuationTest.kt        # 不缩短、非持久化、1000 子轮有界压力
└─ MobileAgentLoopContextParityContractTest.kt # Agent loop 必须接入 transient continuation
```

此前 thought-only 返回虽然已复用同一个公开节点，但 `runAgentLoop` 没有把该轮 reasoning 放进
`messages`，下一子轮实际发送近乎相同的请求；无 provider 会话续接能力时，模型会从任务起点重新推理。
此外，round 对账在流式内容与最终字段不互为前缀时选择最终字段，可能用较短摘要覆盖已显示长内容。

`MobileThoughtRequestContinuation` 现聚合当前 Build 的 reasoning-only 进度、去除真实长重叠并保留
最多 12,000 字符尾部，作为 request-only assistant checkpoint 追加到稳定 prompt 尾部。Guide、工具、
正文、错误和终态清空它；返回的 `AgentLoopResult.modelContext` 始终只含 durable `messages`。
`MobileThoughtContinuation` 对不兼容最终字段优先保留已渲染 stream，保证内容单调不缩短。

## 2026-08-26 dev-0.5.8 移动端 thinking-mode 协议状态修复

```text
android/app/src/main/java/com/newmark/mobile/
├─ data/ChatModels.kt                      # request-only、transient reasoningContent
├─ data/ApiClient.kt                       # reasoning_content 序列化、finish_reason 与无限读取边界
├─ data/MobileThoughtContinuation.kt       # 仅模型截断状态生成下一轮检查点
├─ data/ConversationStore.kt               # 旧历史规范化且禁止 transient reasoning 落盘
└─ vm/ChatViewModel.kt                     # 当前部署档位映射与模型状态驱动的续传/停止
android/app/src/test/java/com/newmark/mobile/data/
├─ ApiClientStreamTest.kt                  # 协议体、断流、六档与自定义档位双协议回归
└─ MobileThoughtContinuationTest.kt        # 请求字段、有界合并与非持久化回归
```

截图中的 HTTP 400 来自续思检查点被作为普通 assistant `content` 发送，而 thinking-mode Provider
要求上一轮思考通过 `reasoning_content` 原样回传。请求模型现增加 transient `reasoningContent`，
Chat Completions 同时兼容有/无工具调用的 assistant 消息；Responses API 不伪造缺少 item ID 或
encrypted content 的 reasoning item。Provider 读取继续使用 `readTimeout(0)`，EOF 未携带 `[DONE]`
或 `finish_reason` 时作为传输失败返回且绝不自动重交。只有 `length`、`max_tokens`、
`max_output_tokens` 明确要求续写，`stop` 不续传。

智能档位 `low/medium/high/xhigh/max/ultra` 分别映射为 `low/medium/high/xhigh/max/max`；模型级
`thinking_tier_map` 继续按“原生档位 -> Newmark 档位”反查和向下就近选择，并同时进入 Chat
Completions `reasoning_effort` 与 Responses `reasoning.effort`。映射来源修正为当前供应商当前模型，
同名模型不再跨供应商串配置。183 项 JVM 测试、Vital Lint、R8、Release assembly 全部通过。

## 2026-08-27 dev-0.5.8 工具参数与上下文连续性

```text
DESKTOP/src/
├─ providers/provider-events.ts             # 标准增量/累计快照参数兼容组装
├─ providers/chat-completions.adapter.ts    # 按 index 隔离 Chat 并行工具参数
├─ providers/responses.adapter.ts           # Responses 快照折叠与缺失 done 兼容完成
├─ llm/provider.ts                          # GitHub Models 兼容流并行参数隔离
└─ tests/providerAdapterV2Verify.ts          # 参数流、上下文尾部与缓存前缀回归
android/app/src/main/java/com/newmark/mobile/data/
├─ ApiClient.kt                             # Chat/Responses 参数片段兼容组装
└─ LocalToolExecutor.kt                     # 严格单 JSON 对象执行边界
android/app/src/test/java/com/newmark/mobile/data/
├─ ApiClientStreamTest.kt                   # 累计流、后续请求与协议回归
└─ LocalToolContractTest.kt                 # 拒绝拼接对象与数组参数
APK/
└─ Newmark-Agent-0.5.8-context-continuity.apk
```

Agent 上下文循环原本会正确追加 assistant tool call 与匹配 call id 的 tool result；故障发生在追加前的
供应商参数归一化阶段。新组装器先保留可解析的标准增量，失败时折叠累计快照并选择最新合法对象；
执行器再以严格解析兜底。动态工具轨迹只追加在消息尾部，不改写稳定 system/bootstrap 或已有前缀，
因此修复连续性的同时维持 PC/移动端 prompt cache 友好结构。
## 2026-08-28 dev-0.5.10 设置页浮块合成边界

`DESKTOP/src/ui/index.html` 的 PC Kyant 玻璃仍复用离屏 WebGL renderer、shader、窗口截图纹理与 uniform 缓存，但可见 `liquid-selection-canvas` 改为每次浮块获取 renderer 时独立创建，并在每次绘制时显式绑定当前浮块 CSS 宽高。释放浮块会同时移除并清空该 display canvas 引用，避免 Windows Electron/Chromium 将较大浮块曾使用过的 promoted canvas layer 边界带入设置标签等小浮块，生成覆盖弹窗的白色矩形。设置页 DOM、布局、主题、浮块尺寸公式、折射材质及起落动效未改。

`DESKTOP/scripts/repro-settings-liquid-corruption.cjs` 覆盖浅色主题、缓存过期后窗口背景重捕获、1708×760 大浮块预热、设置标签五次往返拖动以及按住/释放截图；`DESKTOP/src/tests/pcGlassMigrationVerify.ts` 锁定每浮块独立 display canvas、显式 CSS 尺寸和释放清理契约。
## 2026-08-28 dev-0.5.10 移动端液态响应与回到底部画布

`android/app/src/main/java/com/newmark/mobile/ui/components/LiquidGlass.kt` 将共享移动速度形变从最大 1.075/0.965 小幅增强到 1.09/0.958，并把固定玻璃受阻方向的轴向延展/正交收缩从 2.5%/1.2% 调至 3.2%/1.5%；平方根阻尼、4dp 最大位移、浮起/移动/落地生命周期及布局均未改变。所有调用共享 deformation/`glassButtonSurface` 的既有移动玻璃组件同步获得更清晰但受控的液态感。

`android/app/src/main/java/com/newmark/mobile/ui/ChatScreen.kt` 的“回到底部”浮动按钮从直接在 40dp 节点绘制玻璃，改为复用 `GlassButtonCanvas`。外层仍占 40dp 并保持原右下角 14dp 间距、点击语义和 22dp 图标；仅内部光学 RenderNode 四边获得 8dp 透明外扩，容纳浮起放大、7dp 边缘、模糊和阴影，避免被按钮画布截断。契约位于 `GlassButtonCanvasOutsetContractTest` 与 `LiquidGlassContractTest`。
## 2026-08-29 dev-0.5.11 移动端 Memory Lab 与发送按钮三态

- `android/app/src/main/java/com/newmark/mobile/ui/components/LiquidGlass.kt`：新增矩形 `GlassButtonCanvas` 重载，名义宽高承载布局/语义/命中，四边 8dp 仅供光学 RenderNode 外扩。
- `android/app/src/main/java/com/newmark/mobile/ui/MemoryLabScreen.kt`：返回键、顶部新增/重建与图谱关系/清除/重置胶囊均进入共享透明光学画布；不再直接在按钮等大节点上调用 `glassButtonSurface`。
- `android/app/src/main/java/com/newmark/mobile/ui/ChatScreen.kt`：`SubmitButtonMode` 显式建模 `IdleSend`、`RunningStop`、`RunningSend`。运行中且有输入采用 PC `running-action + send` 第三态；停止态和第三态的 marquee 内容均强制中心对齐。
- `android/app/src/main/java/com/newmark/mobile/ui/components/Marquee.kt`：支持调用方声明内容对齐，默认行为保持不变。
- 回归契约位于 `InputComposerAndModelMenuContractTest` 与 `GlassButtonCanvasOutsetContractTest`；详细执行证据见 本地归档（未纳入公开仓库）。

## 2026-08-29 dev-0.5.11 模型供应商输入排除与点击飞行

`android/app/src/main/java/com/newmark/mobile/ui/components/ProviderSettingsCapsules.kt` 的纵向浮块通过 `selectableIndices` 只接受操作型胶囊；字段胶囊和协议横轨既不是落点，也不能成为父级长按/拖动起点。`LiquidHoldGesture.kt` 的 `canStartAt` 在首次按下处保留输入控件的完整手势所有权。新建供应商、模糊注入与新建模型页的初始纵向选择也固定在首个可操作胶囊，避免输入行获得静态高亮。

首页点击飞行不再直接改写浮块坐标后等待 380ms，而由 `Animatable.animateTo` 连续更新位置。位移 Job 与材质起落 Job 同时启动，并在导航回调前分别 `join`；因此 380ms 位移与 100ms 浮起、240ms 落下均完整完成。跨协议横轨仍按硬边界分段落地与重新起飞，横纵协调器继续保证两轴互斥。

## 2026-08-29 dev-0.5.11 模型供应商交互与设备拉取补正

- `ProviderSettingsCapsules.kt`：纵向点击命中从中心四舍五入改为按 44dp 胶囊加 6dp 间隔的实际区间取整；快速长按释放先取消并等待旧飞行 Job，再从 `Animatable.value` 连续完成 180ms 吸附和完整落地。新增按钮尺寸 `ProviderCapsuleAction`，复用共享玻璃的 105ms 浮起、165ms 落下和 4dp 拖动阻尼。
- `SettingsScreen.kt`：新建供应商、模糊注入、新建模型的创建/取消行从纵向 `selectableIndices` 排除，并改用两个独立 action glass。设备选择 Dialog 使用全屏窗口内居中 88% 宽面板，显示在线/离线和主机地址，仅当前已连接设备可拉取。
- `DesktopLinkViewModel.kt`：供应商目录拉取在 ViewModel 边界再次验证当前连接目标，并以 8 秒超时终止失联或无响应请求。
- `TerminalScreen.kt`：执行按钮图标由固定白色改为主题 `textPrimary`。
- 回归集中在 `ProviderSettingsCapsuleRailContractTest`；全量结果为 218 tests / 61 suites，Vital Lint、R8 和隔离 Release assembly 通过。

## 2026-08-29 dev-0.5.11 PC 启动优化 MSI 候选

`DESKTOP` 启动响应门禁重新验证 runtime marker 分批预处理和轻量启动页路径：startup shell 2536ms、index navigation 5092ms、interactive 11614ms，`nonRespondingSamples=0`、`Process.Responding=true`、最终 marker 1 个。独立输出 `release-0.5.11-startup-msi/Newmark-Agent-0.5.11-x64.msi` 通过 Windows MSI 行政解包、34 项功能断言、真实 loopback SSH/PTTY、亮色主题、4 轮重启、CLI、上下文压缩和 console wrapper 边界检查。MSI 未做 Authenticode 签名。

首次 UAC 被取消；重试维护安装返回 0，但 `REINSTALL=ALL` 使 0.5.11 进入 maintenance mode 并跳过 `RemoveExistingProducts`，边界核验仍为 0.5.10。之后旧产品代码 `{915C1DC5-C994-4EB1-8318-0A4AD0F91DB5}` 成功卸载，最终 UAC 全新安装产品代码 `{224D0740-4008-47BF-BE96-4E955D6114AD}`。注册表为 0.5.11.0，CLI 为 0.5.11，安装 `app.asar` 与候选大小和 SHA-256 完全一致，关键用户状态聚合哈希保持不变。安装版启动日志为 shell 603ms、Agent 1959ms、主界面 4288ms；113 个 Windows 进程响应样本无无响应记录。

## 2026-08-30 dev-0.5.11 全平台本地发布目录

```text
release-0.5.11-full-platform/
├─ Newmark-Agent-0.5.11-x64.msi                 # Windows x64 安装包
├─ Newmark-Agent-0.5.11-win-unpacked-x64.zip    # Windows x64 便携解包包
├─ Newmark-Agent-0.5.11-x86_64.AppImage         # Linux x64 AppImage
├─ Newmark-Agent-0.5.11-amd64.deb               # Debian/Ubuntu x64 包
├─ Newmark-Agent-0.5.11-linux-unpacked-x64.zip  # Linux x64 解包包
└─ Newmark-Agent-0.5.11-android.apk              # Android 0.5.11 / versionCode 511
```

桌面全量门禁在 TUI ConPTY 首轮遇到 Windows `AttachConsole failed` 瞬态后，专项重跑全部通过，并从失败点继续完成模式/对话、跨平台、SSH、WSL、CLI 和三端共享后端门禁。Windows 资产验证打包态 CLI、上下文压缩、控制台参数边界和功能/安全契约；Linux 资产由 Ubuntu 24.04 WSL 原生构建并分别完成 xvfb GUI 与双 shell 回环。Android 标准 APK 输出被外部进程占用，安全改用 `android/isolated-release-build/` 构建并复制到发布目录，未关闭用户进程或覆盖已打开文件。

当前主机闭合并发布了 Windows、Linux、Android 六资产；macOS DMG 仍需 macOS 主机。Windows 未做 Authenticode，Android 为 Debug v2 证书。GitHub `dev-0.5.11` prerelease 已从标签提交发布，六项资产已回下载并逐字节核对。

## 2026-08-30 dev-0.5.11 移动端图片显示增量

```text
android/app/src/main/java/com/newmark/mobile/
├─ data/LocalToolCatalog.kt       # Build/Plan 暴露 image_display
├─ data/LocalTools.kt             # PC 同名图片展示 schema
├─ data/LocalToolExecutor.kt      # 安全工作区 PNG/JPEG 校验、回执与展示载荷
├─ vm/ChatViewModel.kt            # tool_result 绑定持久 WorkDisplayImage
├─ ui/NewmarkApp.kt               # 本地用户图片投影为统一历史附件
├─ ui/ChatScreen.kt               # 图片位于用户文字上方；回到底部使用一体玻璃边框
└─ ui/components/LiquidGlass.kt   # 静态边框与动态玻璃共享光学层
android/app/src/test/java/com/newmark/mobile/ui/
└─ MobileImageDisplayContractTest.kt
release-0.5.11-mobile-images-glass/
└─ Newmark-Agent-0.5.11-android.apk
```

`image_display` 只读取 `files/newmark/workspace` 内有效、非空且不超过 10 MiB 的 PNG/JPEG；工具结果只返回有界元数据，Base64 仅进入公开展示事件，不回灌模型工具结果。远程附件、本地附件和 Agent 展示图继续使用既有 `RemoteConversationImage`/`WorkDisplayImage`，没有建立第二套图片历史模型。
## 2026-08-30 dev-0.5.11 移动端布局与发布增量

- `ui/ChatScreen.kt`：用户图片右对齐、Agent 展示图左对齐；输入上方浮层高度实时进入对话底部避让。
- `ui/RightSidebar.kt`：Markdown/LaTeX 阅读预览复用对话文字安全边界，窄屏保持可读区不出格。

## 2026-08-30 内核中断排查增量

- 运行中上下文窗口刷新改为语义事件节流，避免 text/thought 高频增量造成快照 IPC 竞争。
- Agent abort 支持记录触发原因，区分 user_stop、process timeout 与运行时故障。
- 实际配置 timeout 均为 0；provider 流式无限等待与 runtime 隔离回归通过。
## 2026-08-30 PC Build Block 材质边界修复

Build Block 对话展开严格保持纯时间线，不允许任何玻璃、白板底色、圆角、阴影或伪元素；对应 CSS 强制规则和 `pcGlassMigrationVerify` 门禁已更新。
## 2026-08-30 内置浏览器弹出页刷新

PC WebView 与移动端 WebView 均将安全的 `target=_blank`/`window.open` 页面导回当前会话浏览器页，沿用地址栏与刷新命令；移动端临时弹出 WebView 仅负责捕获 URL，不创建第二套会话。
## 2026-08-30 PC 图片点击区域与对齐

`DESKTOP/src/ui/index.html` 将用户附件和 Agent 展示图按钮改为内容尺寸布局，图片本体自然缩放并使用非胶囊方框；用户消息附件组右对齐，Agent/Build 展示图左对齐。`DESKTOP/src/tests/displayImageVerify.ts` 增加命中框、对齐及玻璃预览回归断言。

## 2026-08-30 队列用户输入可见性

`ConversationKernel.drainQueuedFollowUpMessage` 在 follow-up 出队时区分真实队列用户输入与内部自动续接：带稳定 clientMessageId 的队列项不会携带 hiddenUserInput，避免 PC/移动端把它误判为 Agent 自输入而过滤；内部无 client id 的续接仍保持隐藏。`queueDrainUserMessageVerify` 覆盖两种路径。

## 2026-08-30 自动续接循环保护

ConversationKernel 对自动 steer、Goal continuation 与隐藏续接记录最近 Assistant 文本指纹；连续完全重复且无新用户输入/工具进展时清理剩余自动队列并停止循环，真实用户 follow-up 不受影响。

## 2026-08-30 MSI/UAC 安装验证

已生成 release/Newmark-Agent-0.5.12-x64.msi（SHA-256：6A0070729DD1F480642AF7B446FDB5051F440FD884ACA7F28427D150A650AEFC）。已通过管理员权限启动 msiexec；当前会话无法取得其 UAC 交互结果，Program Files 中仍是既有 0.5.11 安装，因此未宣称替换安装已完成。

## 2026-08-30 UAC MSI 安装成功复核

确认 Windows Installer 已完成：Program Files\\Newmark Agent 的可执行文件与 app.asar 版本为 0.5.12.0，卸载注册表 DisplayVersion 为 0.5.12.0，msiexec 已退出；用户 .Newmark/config.json 仍存在并保留。

## 2026-08-30 Markdown/LaTeX 渲染与代码块复制

Android 引入内置 CommonMark 依赖以扩展 Markdown 语法覆盖，保留 Newmark Compose 样式与离线 LaTeX 可读渲染；PC Markdown 代码块新增独立复制按钮，不影响整条消息复制。桌面构建、图片/UI 回归与 Android compileDebugKotlin 通过。

## 2026-08-30 APK 打包状态

Release 编译、Lint 与 R8 通过；assembleRelease 最终 packageRelease 因旧 app-release.apk 被外部进程锁定而失败。未将旧 APK 宣称为本轮新产物，需释放文件锁后重试。

## 2026-08-30 APK 重打包重试

重试 assembleRelease 仍因旧 app-release.apk 外部文件锁在 packageRelease 失败；临时独立输出目录方案因 Gradle Windows 路径参数解析失败，已立即撤销，未保留构建脚本改动。

## 2026-08-30 移动端 Markdown 代码块解析修复

移动端 Markdown 解析器现在支持三字符以上反引号/波浪围栏，并兼容语言标记与首行代码粘连的异常输入，避免整段代码被误识别为语言名而裸显示。MarkdownLatexContractTest 已通过。
## 2026-08-30 Markdown 修复版 Release APK

已重新生成 Android Release APK，版本号保持 `0.5.12`、versionCode `512`。产物 `APK/Newmark-Agent-0.5.12-markdown-fix-release.apk`，大小 52,761,506 bytes，SHA-256 `B79DD9E478BBCCCA6EED5E2D1812AEFADC2A12115668D9B6AC898C341732F82D`。`assembleRelease`、Lint、R8 与 APK v2 签名验证通过。

## 2026-08-30 MSI 重打包与安装

已从 clean build 重新生成 release/Newmark-Agent-0.5.12-x64.msi（226,400,274 bytes，SHA-256 C59AE094B39803ADAB475649D6A735D30B9D3FF3237B4EF2817D8EBE61067B9B），并启动可见管理员安装。安装目录程序版本已为 0.5.12.0；Windows Installer 进程仍在运行，最终完成状态需等待安装界面结束。

## 2026-08-30 全平台发布门禁状态

版本 0.5.12 的桌面全量门禁通过，Windows MSI/ZIP 与 Linux AppImage/deb/ZIP 已生成；Android Release 编译、Lint、R8 可通过，但 `testDebugUnitTest` 有 2/222 失败（ChatModeContractTest、LiquidGlassContractTest），因此按门禁规则停止在上传前，未创建或上传 GitHub Release。

## 2026-08-31 dev-0.5.12 全平台发布完成

- `ChatModeContractTest` 已更新为 Chat 复用既有 `terminal_exec` 且只允许 `date/time/now` 的权限边界；执行器仍拒绝其他终端命令和全部写入工具。
- `LocalContextContract.kt` 恢复“证据充分后简洁总结”的 Chat 约束，避免时间权限提示覆盖快速回答行为。
- `LiquidGlassContractTest` 与当前 26dp `MobilePopupShape` 契约同步。
- Android 定向 18 项测试通过；全量 JVM、Vital Lint、R8 与隔离目录 Release assembly 通过。
- Windows MSI/ZIP 与 Linux AppImage/deb/ZIP 均完成打包态版本和 GUI/终端启动检查；`npm audit --omit=dev --audit-level=high` 为 0 漏洞。
- Android APK 为 versionName 0.5.12、versionCode 512，使用 Android Debug 证书并通过 APK Signature Scheme v2 验证。
- GitHub prerelease：`https://github.com/positer/Newmark-Agent/releases/tag/dev-0.5.12`。六个远端资产已回下载并与本地 SHA-256 逐项一致。
## dev-0.5.13 移动输入与队列事件边界

- `android/app/src/main/java/com/newmark/mobile/ui/ChatScreen.kt`：输入区使用 `TextFieldValue` 保存文本、selection 与 composition；根级收键盘手势只在 Final pass 且事件未消费时执行。队列排序长按手势仅挂载于拖动把手，避免覆盖 Guide/编辑/删除按钮。
- 运行中发送键：点按沿用 Next；300ms 长按上拉生成同尺寸上箭头玻璃浮块，释放走独立 `onGuide`，不经过队列。
- `android/app/src/main/java/com/newmark/mobile/vm/ChatViewModel.kt`：本地队列 Guide 与输入框直达 Guide 复用同一接收/事件投影实现，只有队列入口会删除被接受的条目。
- `android/app/src/main/java/com/newmark/mobile/data/LocalGuideDeliveryContract.kt`：以活动 runId 与接收状态作为本地 Guide 的唯一接收边界，不按 Build/Plan/Chat 模式分流；生成进入下一 provider 请求前沿的真实 user-role 消息。
- `android/app/src/test/java/com/newmark/mobile/data/LocalGuideDeliveryContractTest.kt`：锁定跨模式接收、runId 一致性与 provider 前沿消息结构。
- `android/app/src/test/java/com/newmark/mobile/ui/InputComposerAndModelMenuContractTest.kt`：锁定稳定编辑值与外部点击焦点边界。
- `android/app/src/test/java/com/newmark/mobile/ui/QueueDragAnimationContractTest.kt`：锁定拖动把手与操作按钮的互斥手势所有权。

## 2026-08-31 dev-0.5.13 Windows MSI 与安装边界

- `release/Newmark-Agent-0.5.13-x64.msi`：Windows x64 安装候选，243,902,901 bytes，SHA-256 `36E433210B226D058C1A34CA882FF0F2223D2E088D6834788955D62FDE80C10F`。
- `release/Newmark-Agent-0.5.13-win-unpacked-x64.zip`：Windows x64 解包候选，317,508,798 bytes，SHA-256 `92FF8788A386F39EC74EF807E3AB4F8990E5C85F8A2C690204D109AE202E6E9B`。
- `release/win-unpacked/resources/app.asar`：打包应用边界，196,521,066 bytes，SHA-256 `B20D31F19B1C709C2AA95A191EDF9AE79C9EBC4015CBC960E585606DF79D5761`。

本机安装注册表 DisplayVersion 为 `0.5.13.0`、ProductCode 为 `{14CE66AF-8E1D-4E30-BB3D-EF46E296F3BC}`；Program Files 内三种 CLI 均返回 `0.5.13`，安装版 `app.asar` 与候选包一致。安装器未改动用户 `.Newmark` 状态，启动后的主窗口和全部已采样子进程均响应。MSI 当前没有 Authenticode 签名。

## 2026-08-31 移动后台 Agent 前台服务

- `android/app/src/main/java/com/newmark/mobile/service/LocalAgentForegroundService.kt`：服务级 `SupervisorJob`、常驻通知、CPU/Wi-Fi lock、默认网络 callback、网络恢复分发、配对连接租约及无 UI 时的认证 SSE 保活所有者。
- `android/app/src/main/java/com/newmark/mobile/vm/ChatViewModel.kt`：本地 Agent 执行迁入服务运行域；仅在零模型活动的瞬态网络失败上等待恢复并按 250ms/1s/3s/10s/30s 退避重试，停止时立即释放本地服务计数。
- `android/app/src/main/java/com/newmark/mobile/vm/DesktopLinkViewModel.kt`：正式远程 SSE/重连迁入服务运行域；网络恢复时淘汰旧连接池并立即重连，活跃 Agent 期间持续重连，ViewModel 退出时把连接所有权交给服务保活通道。
- `android/app/src/main/java/com/newmark/mobile/data/ApiClient.kt` 与 `MobileApiClient.kt`：提供失效连接池清理及本地 Agent 瞬态网络错误分类。
- `android/app/src/main/AndroidManifest.xml`：前台服务类型改为 `specialUse`，声明长期本地/远程 AI Agent 网络会话子类型，并增加 Wi-Fi 状态权限。
- `android/app/src/test/java/com/newmark/mobile/ui/BackgroundAgentRuntimeContractTest.kt`：锁定服务所有权、配对连接租约、后台保活 SSE、安全重试、网络恢复与停止释放边界。

验证：230 tests / 64 suites、0 failures；Debug/Release Kotlin 编译、Vital Lint 与 R8 通过。当前无 ADB 设备，因此未声明锁屏/划走任务/网络切换的真机长时验收。

### 2026-09-01 后台强化 APK 打包

- 标准 `android/app/build/outputs/apk/release/app-release.apk` 仍被外部 Windows 进程占用；本轮不关闭未知进程，也不把该旧文件作为新产物。
- 复用受控的 `android/isolated-release-output.init.gradle` 将 app build directory 指向 `android/isolated-release-build/app/`，执行全新 `clean assembleRelease` 成功，最终交付副本为 `APK/Newmark-Agent-0.5.13-background-agent-service-release.apk`。
- APK 为 52,761,654 bytes，SHA-256 `AD2BE3FD29F7A38CB7F7FC9E2A44744B34BDE25A8906D78C36868283FE3FB04C`；源 APK 与交付副本哈希一致。
- `aapt` 确认包名 `com.newmark.mobile`、versionName `0.5.13`、versionCode `513`、minSdk 24、targetSdk 36。
- 最终二进制 Manifest 包含 `FOREGROUND_SERVICE_SPECIAL_USE`、`ACCESS_WIFI_STATE`、`LocalAgentForegroundService`、`foregroundServiceType=specialUse` 和 `PROPERTY_SPECIAL_USE_FGS_SUBTYPE=user_visible_long_running_local_and_remote_ai_agent_network_session`；服务 `exported=false`、`stopWithTask=false`。
- `apksigner` 验证 APK Signature Scheme v2 通过，签名人为工程既有 `Android Debug` 证书；不是 Google Play 生产签名。
- 发布门禁为 230 tests / 64 suites、0 failures/errors/skipped，Vital Lint、R8、资源收缩与隔离 Release assembly 全部通过。编译保留既有弃用提示、native strip 提示、Log4j min-api R8 提示和 Gradle 9 兼容提示，未形成构建错误。

当前 `adb devices` 无设备，因此未安装 APK，也不声明真机锁屏、划走任务、Wi-Fi/移动网络切换或 30 分钟以上后台运行通过。回滚方式为侧载上一份已验证 APK；Google Play 上架前必须替换生产签名并申报 `specialUse` 用途。

### 2026-09-01 移动后台断流全面复查

用户在真机后台运行时仍观察到 `Software caused connection abort`。该原文只由本地 Agent 的 `localAgentFailureMessage` 路径进入对话；配对 PC 的远程 SSE 将 Socket 失败折叠为“连接中断，正在重连…”，因此当前现象定位到 Android 本地 Agent → 模型供应商 SSE，而非 `/api/mobile/events` 远程观察连接。

主根因位于 `ChatViewModel.chatWithEmptyRecovery`：每次 provider turn 用 `observedThought`/`observedText` 记录是否已出现模型增量，只有两者均为 false 时才把 SocketException 交给 `awaitUsableNetwork`、退避和连接池淘汰。任一 thought/text 出现后，网络异常在同函数中明确直接返回失败。`ApiClient.executeProviderRequest` 的一次 connection-abort 重试也只包围 `newCall(...).execute()`，即取得响应头之前；响应头之后在 `readUtf8Line()` 读取 SSE 时发生的 abort 不在该重试层内。推理模型往往在正文前先产生 thought，因此真实后台长任务很快越过可恢复窗口，服务仍存活也会显示原始 SocketException。

次级问题：

- `LocalAgentForegroundService` 以 `NET_CAPABILITY_INTERNET` 作为 usable 判定，没有要求 `NET_CAPABILITY_VALIDATED`；Wi-Fi/蜂窝切换时 capability 可先于真实公网路由恢复，导致恢复循环过早发起新请求。
- service 使用 companion 静态 `runtimeScope` 与内存计数。正常 Activity/ViewModel 销毁不会取消运行，但整个进程被 OEM 杀死后，`START_STICKY` 无法重建内存中的 conversation/run/provider 请求，也没有持久 checkpoint/resume 协议。
- Wi-Fi lock 只约束 Wi-Fi 无线电，不能保证蜂窝、VPN/Tailscale、OEM 防火墙或 provider 连接不被系统中止；WakeLock 也不等于 socket 保活。
- `BackgroundAgentRuntimeContractTest` 主要用 `source.contains(...)` 锁定代码形状；`ApiClientStreamTest` 只验证响应头之前的首次 abort 和错误分类/退避，没有模拟“已收到 thought/text → 后台切换 → SSE abort → 网络恢复 → 无重复续接”。此前 230 项单测和 APK Manifest 验证不能证明真机后台连续性。

建议修复必须按可重放阶段设计，而不是无条件重发：provider turn 尚无增量时可安全重试；已有 thought/text 但尚无工具调用/副作用时，恢复后以持久的 partial assistant checkpoint 发起 continuation，并做重叠前缀去重；工具调用已形成或工具执行开始后，只能从持久化的 tool-call/tool-result 边界续接，不能重放原请求。网络门槛应要求 validated capability，并记录每轮 request id、网络 transport、首增量、断流点、恢复尝试和终态原因。进程死亡恢复需要单独的持久运行状态机。

当前没有 ADB 设备，无法验证真机安装的确切 APK 哈希、通知/电池优化授权、OEM 后台策略、网络 transport 变化和原始异常 cause chain。完整证据与分级结论见 本地归档（未纳入公开仓库）。

## 2026-08-31 PC 中断回复边界

- `DESKTOP/src/ui/index.html`：完成态优先使用最后一条非空 `final_response`；`interrupted`/`force_interrupted` 没有终态回复时，使用最后一条非空公开 `response` 恢复 Build 块外 Agent 行。
- 被提升到块外的中断回复会从展开 Build 的事件列表中排除，避免同一正文重复；无公开回复的中断只保留 Build，不生成虚假消息。
- 实时终结与持久快照重建使用同一选择函数；重复更新保持 `run-final-response` 结构类，继续按 runId 去重。
- `DESKTOP/src/tests/guideUiReconcileVerify.ts`：覆盖已有 user 行时的中断回复补齐、最后回复选择、单实例去重及无回复不伪造。

验证：Desktop typecheck、build、聚焦 Guide UI reconciliation 与 1685/1685 主验证通过。

### 2026-09-01 打包与覆盖安装边界

- `release-0.5.13-pc-agent-response-fix/Newmark-Agent-0.5.13-x64.msi`：243,911,093 bytes，SHA-256 `5A6A38326D5A1180160C8B8A0434F0C6721D04B241DB2DB9A403BBB55227F03F`，Authenticode 状态 `NotSigned`。
- `release-0.5.13-pc-agent-response-fix/Newmark-Agent-0.5.13-win-unpacked-x64.zip`：317,510,279 bytes，SHA-256 `D20196BACCDCFB1BCDD613EB3D0ED538F08DDEEA0B4D07E86B7C566C7A1AC622`。
- `release-0.5.13-pc-agent-response-fix/win-unpacked/resources/app.asar`：196,528,014 bytes，SHA-256 `73ED089782AA5774974D54FC7BBD2054370912E4835295B8A6E307A38F141427`。
- 候选包通过真实 SSH/PTTY/TUI 四轮重启、release CLI、上下文压缩、console wrapper、MSI/ZIP 结构门禁；从候选 `app.asar` 提取 `dist/ui/index.html` 后，已确认 `terminalAssistantResponseForRun`、中断事件提升与 `preserveRunFinalResponse` 三处关键修复存在。

覆盖安装前仅关闭了可执行路径经核实属于 `C:\Program Files\Newmark Agent` 的 4 个 Electron 进程。安装前 `.Newmark` 基线为 20,873 个文件、335,810,138 bytes、全量相对路径/大小/逐文件哈希聚合 SHA-256 `195FF9B3709A10D310C0CD2E2C9B3FD369A5D8456D4E3F957A204B23DBE73282`。两次 `Start-Process msiexec -Verb RunAs` 均由系统返回“操作已被用户取消”，没有创建 MSI 日志，候选未进入 Windows Installer 事务。安装尝试后同一基线三项完全一致，已安装 `app.asar` 仍为旧哈希 `B20D31F19B1C709C2AA95A191EDF9AE79C9EBC4015CBC960E585606DF79D5761`，注册表仍为既有 `0.5.13.0` / `{14CE66AF-8E1D-4E30-BB3D-EF46E296F3BC}`。旧版 GUI 已恢复运行，主窗口存在且 5 个采样进程全部 `Responding=true`。因此当前结论是“修复 MSI/ZIP 已构建并通过打包态验证，覆盖安装待用户允许下一次 UAC”，不声明安装版修复已验收。

## 2026-09-01 双端标题部署一致性与 Android r2 发行（历史候选，已被 r3 替代）

首次标题请求和首轮正式响应现在共享同一发送级部署快照。PC 在标题硬门禁前先完成不可用部署检查和 fallback 解析，再冻结 provider、model 与 intelligence；标题调用沿用该档位映射出的原生 `reasoningEffort`，正式 runner 不会在标题成功后切换到另一部署。Android 在发送同步区冻结不可变 `ApiConfig`、`ModelConfig` 与 intelligence，标题成功后才写入 `firstAgentResponseStarted` 并以同一快照启动本地 Agent。双端失败路径都保持正式 provider 调用为 0，并保留首条持久化用户消息供下一次发送重试。

结构与回归入口：

- `DESKTOP/src/core/agent.ts`：部署解析、标题门禁、冻结 intelligence/reasoning effort 与正式响应启动顺序。
- `DESKTOP/src/tests/verify.ts`：标题请求和正式流的 provider/model/intelligence/reasoning effort 一致性及 fallback 回归。
- `android/app/src/main/java/com/newmark/mobile/vm/ChatViewModel.kt`：标题 helper 显式接收 `turnIntelligence`，并与正式 loop 复用冻结配置。
- `android/app/src/test/java/com/newmark/mobile/vm/FirstInputTitleAndNetworkRecoveryContractTest.kt`：禁止标题作用域硬编码 `low`，约束冻结值透传。

该轮发布门禁为 Desktop typecheck/build/1696 assertions、Android 263 tests、`lintVitalRelease`、隔离 clean Release/R8/资源收缩、v2 签名、4-byte 与 16 KiB native 对齐、二进制 Manifest/版本和 APK 内容隐私扫描。r2 历史交付 `APK/Newmark-Agent-0.5.13-dual-platform-final-r2-release.apk` 为 52,794,422 bytes，SHA-256 `6A3B048E987F4BBE94C1F22EFCFD3E2B85DF96B58BEF813FE01C72A581243183`；API 35 模拟器覆盖安装后 `MainActivity` 前台运行且无 FATAL/ANR。旧 `8BDCF457...` 候选不再代表 r2 标题契约；r2 后续又因 Responses SSE 缺失内嵌状态仍被接受而由 r3 替代。Debug 签名与模拟器冒烟不替代生产签名或故障真机长时后台验收。

## 2026-09-01 Android Responses 严格完成态与 r3 发行（已被 r4/r5 替代）

Android `ApiClient.kt` 的流式 Responses 终态现在只接受 `response.completed` 事件中大小写不敏感的明确 `response.status=completed`。缺失、空白、未知或 `failed`、`incomplete`、`cancelled/canceled`、`queued`、`in_progress` 状态均进入受控失败；`ApiClientStreamTest.kt` 的成功 SSE fixture 全部显式携带完成状态，并新增缺失状态拒绝回归。

结构与回归入口：

- `android/app/src/main/java/com/newmark/mobile/data/ApiClient.kt`：流式 Responses 显式完成态校验。
- `android/app/src/test/java/com/newmark/mobile/data/ApiClientStreamTest.kt`：30/30 Responses 聚焦协议回归，包含缺失状态负例和显式完成成功例。

r3 门禁为 Android 68 suites / 264 tests / 0 failures/errors/skips，`lintVitalRelease` 3 分 50 秒成功，隔离 clean `assembleRelease` 50 tasks（48 executed、2 up-to-date）5 分 05 秒成功。历史交付 `APK/Newmark-Agent-0.5.13-dual-platform-final-r3-release.apk` 为 52,794,422 bytes，SHA-256 `B702EB35EC4E9DB42FD8598865D46EF75F7B707CE6C3C611307CBD573A5B8847`。r3 后由修正根级 Responses 状态绕过的 r4 替代；r4 又因终审发现 PDF 整体超时、Android 标题 native reasoning 和移动图片视觉三项缺口而由 r5 替代。

首次普通解压因重复 APK entry 失败，因此最终扫描直接逐 Zip entry 读取字节，重复 entry 也全部检查且未创建临时目录。结果未命中开发者 profile/workspace、非允许用户目录、凭据或私钥；裸数字 `12252` 仅命中 4 个 PDFBox CMap 和 2 个 BouncyCastle SIKE 常量 vendor 文件，4 ABI ML Kit 库中的 `/home/build` 是第三方通用构建标记。用户本轮只要求 APK，未重新打包 MSI。真机后台切网/长时运行、真实 provider、配对 PC bridge 与逐帧视觉仍未验证。

## 2026-09-01 双端终审修复与 Android r5 发行

- `DESKTOP/src/tools/index.ts`：`pdf_read` 从扫描页局部计时改为一个 1–120 秒累计工具预算；异步文件读取、pdf.js 文本解析和浏览器观察共享同一个 abort guard，超时回执包含 `stage`、`recoverable=true`，父级 Agent abort 仍按原取消语义抛出。
- `DESKTOP/src/tests/verify.ts`：用可注入文件读取/文本解析边界分别覆盖 file-read、text-parse、累计预算和 rendered-page timeout，并验证异常 PDF 超时后同一 Agent run 仍能消费工具回执并产生最终回复。
- `android/app/src/main/java/com/newmark/mobile/vm/ChatViewModel.kt`：首轮发送冻结 `thinkingTierMap` 并同时传给标题探测、文档/图片视觉子请求和正式 Agent loop；标题探测不再与正式首轮使用不同供应商原生 reasoning effort。
- `android/app/src/main/java/com/newmark/mobile/data/LocalTools.kt`、`LocalToolCatalog.kt`、`LocalToolExecutor.kt`：Build/Plan 新增只读 `image_inspect`。安全工作区无需额外全盘权限；`content://` 与共享存储路径要求现有授权。读取过程限制 10 MiB，解码后只接受 PNG/JPEG 且不超过 4000 万像素，base64 只经内部 `__image_visual_read` 进入一次性视觉请求，不返回公开工具文本或持久化历史。
- `FirstInputTitleAndNetworkRecoveryContractTest.kt`、`MobileImageInspectContractTest.kt`、`LocalToolContractTest.kt`：锁定标题/正式调用身份、视觉工具 schema/边界和 Build/Plan 工具清单。

验证为 Desktop typecheck、build、1702/1702 主断言与完整 `test:full-release`；Android Responses 32/32、69 suites / 267 tests / 0 failures/errors/skips；`lintVitalRelease` 3 分 01 秒；隔离 clean `assembleRelease` 50 tasks（47 executed、3 up-to-date）3 分 49 秒。当前交付 `APK/Newmark-Agent-0.5.13-dual-platform-final-r5-release.apk` 为 52,794,422 bytes，SHA-256 `C87DFA53B309D4FE1790FCB5F1EB2084F67BE6E44FC27D76D5E8E4E84A30A14B`，版本/Manifest/v2 Debug 签名/4-byte/16 KiB 对齐和逐 entry 隐私扫描通过。Desktop 后续补充 5 级标题自动退避、无供应商诊断与打包后 CLI 夹具，随后 Windows MSI 发行验证通过。

Windows MSI 经过打包后的 CLI smoke、context-compress CLI stress 和 console wrapper boundary stress；首次非提升 `/qn` 因无凭据提升返回 1603，UAC 提升安装返回 0。安装后 `C:\Program Files\Newmark Agent` 内的 `app.asar`、`Newmark.exe`、`Newmark Console Runtime.exe`、`Newmark.bat` 与本次 `win-unpacked` 哈希一致，注册表 `Newmark Agent 0.5.13.0` 的 ProductCode 为 `{B0B20387-74F3-413E-8550-4FDA74735E0B}`。

API 35 `emulator-5554` 冷启动恢复在线后完成 `adb install -r`。显式启动后 2 秒和 7 秒均为 `MainActivity` topResumed，PID 3173 不变，目标进程 FATAL/ANR 为 0。模拟器证据不外推到故障真机后台、真实 provider、配对 PC bridge、长时运行或逐帧视觉反馈。本轮没有打包 MSI。

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

### 20260905-144650 PC 长按选项飞行与文字稳定性修复

`DESKTOP/src/ui/index.html` 的 `wireDirectLiquidMenuInteractionsV2` 现按 selected source → 长按目标飞行 → 目标处持续轨道拖动 → 最终选项飞行 → 提交收缩的顺序执行。长按飞行完成后拖动基准保持落点，避免首个 pointermove 跳回原选中行。carrier block 在飞行/拖动期间启用厚边缘、折射、高光、阴影和内部圆角裁剪泛光，静止时恢复纯色块。direct option 节点同时锁定 `transform:none`、`scale:1`、`filter:none`，文字和图标不再变形。契约测试同步覆盖上述状态与样式。

### 20260905-145603 移动端暗色竖屏左边栏亮边修复

定位确认亮边来自 `CompactMainLayout` 的 `ModalDrawerSheet`：全高矩形抽屉把默认 Kyant 外沿高光绘制在整块左栏边界，暗色背景下形成异常亮框。`liquidGlassModifier` 新增 `edgeHighlight` 开关，竖屏抽屉传入 `false`，关闭整面 carrier 的外沿高光，同时保留磨砂、折射以及内部按钮/浮块的独立玻璃边缘和点击泛光。Android `:app:testDebugUnitTest` 全量通过。

Release APK/MSI hashes, install preparation, emulator screenshot, and the canceled MSI installation record for the dev-0.6.5 runtime gate.


Cross-platform release manifest with artifact sizes and SHA-256 hashes for MSI, portable ZIP, and Android APK.

Single-conversation long-run gate: 30/120/300 turns through the real kernel compaction path. Bounded context (`history` 7-8 entries, provider request 66-83 KiB) with intact visible transcript at 300 turns, 199 automatic compressions, cold-archive rollover, restore, and disk reload all passing. Also measured an unfixed quadratic cost: the workspace `conversations/state.json` document is rewritten in full ~5.33 times per turn (9.07 GB written over 300 turns) because the document grows with the conversation. New: `DESKTOP/src/tests/singleConversationCompressionStressVerify.ts`, `DESKTOP/scripts/dev-0.6.6-conversation-state-write-audit.cjs`, npm scripts `test:conversation-compression-stress[:built]` and `dev:conversation-state-write-audit` (wired into `test:full-release`).

Executed all four storage policies in order with monitoring, targeting run-time memory and I/O frequency rather than cumulative bytes. **S** coalesces mid-turn saves (terminal flush stays synchronous) and folds a cancelled snapshot's other-conversation changes into the synchronous write; **M** short-circuits byte-identical index/shard writes; **M+** bounds the live Build ledger to the persisted 120-run window; **L** splits `conversations/state.json` into a small index plus per-conversation shard files that hydrate lazily, keeps `providerUsage` in the index, and guards the durable queue with a queue revision so stale snapshots can neither drop nor resurrect queued work. Measured on the 300-turn single-conversation gate: index writes 1600 -> 701, index bytes 9 073 MiB -> 1.83 MiB, total bytes per turn 30.24 -> ~5.5 MiB, index file 10.0 MiB -> 2.7 KiB, in-memory Build records 307 -> 121, mean turn 766 -> 429 ms, peak heap 141.9 -> 136.7 MiB. Same cycle fixed three real defects surfaced by monitoring: archive JSON round-trip losing transcript/branch tree, stale conversation-state lock blocking saves after a killed runtime, and an unbounded busy loop in the kernel run loop (reproduced with HEAD sources, i.e. pre-existing; now bounded). `npm run test:desktop:built` is green (verify.js 1717/1717). New source-only tools: `core/conversationStateDocument.ts`, `scripts/dev-0.6.6-sharded-state-repro.cjs`. Layout note: conversations last written by 0.6.6 are index+shard; an older (<=0.6.5) build opening the same workspace will not see those transcripts until the shard is re-read by 0.6.6.

User-level UI monitoring with real screenshots for the storage/runtime policies. `scripts/dev-0.6.6-long-run-ui-monitor.cjs` seeds real storage through the production Agent (800- and 1600-message conversations, queued items, a goal, a paused Flow with its workflow file, branch pages, an archived conversation), boots the source-mode Electron renderer, drives real DOM interactions and captures a screenshot per step. 13/13 checks pass at both scales: conversation list renders the long conversation from the index (`ui-longrun (1600)`), the transcript opens in a bounded newest window with exact paging (`Load 1400 earlier messages`), the queue panel lists every queued row in order with its pause state, the goal bar shows the persisted objective, the Flow takeover shows the paused Flow, branch pages stay selectable with a stable runtime leaf, the archive list still resolves, the queue pause toggle round-trips, and a live send on the 800-message history runs and renders a turn (with a fresh-conversation control). Screenshots in 本地归档（未纳入公开仓库）. Monitoring also documented two boundaries: a send issued immediately after the pause toggle is interpreted as resuming the queue (the monitor now waits for the backend to settle), and a suspended Flow whose workflow file is missing is cleared by design.

Regenerated the unpacked Windows build (`npm run dist:win`: MSI `FAB1D24A…`, ZIP `3596EF88…`, `win-unpacked/resources/app.asar` `43015C16…`, all packaged-state gates green including the real SSH/TUI restart stress) and ran the user-level UI monitor against four combinations: new unpack + new store, installed 0.6.5 + legacy store, new unpack + legacy store (upgrade path), installed 0.6.5 + new store (downgrade path). The first three pass 13/13, so the storage/runtime changes did not alter the queue/goal/flow/long-history surfaces and the upgrade path migrates on write. The downgrade combination shows the conversation in the list but renders an empty transcript (screenshot `old-installed-newstore-02-...png`) while the index-resident goal and Flow banner still show; a store inspection afterwards proves it is display-only — shard pointers, `messageCount` (800/240/10) and all four shard files (465,802 bytes) survived the old build's session, so re-upgrading restores everything. Recommendation stands: do not run both versions against one workspace at the same time.

Extended the user-level UI monitor to sixteen checks (adding Build/Work-block rendering from the shard, the context/token inspector, and a stability sweep that proves paging through an extremely long history leaves queue, goal and Flow surfaces byte-identical) and ran it against the packaged `release/win-unpacked` executable at two extreme scales: 800 turns (1600 messages) and 1500 turns (3000 messages plus 24 Build records). Both runs pass 16/16 with real screenshots per step (`unpack-1600msg-*`, `unpack-3000msg-*` in 本地归档（未纳入公开仓库）): the list shows `ui-longrun (3024)` from the index alone, the transcript still opens in a bounded newest window, paging returns exact ordered pages, the queue shows `Queue 3` with the three seeded ids and correct pause state, the goal bar and paused Flow banner render, branch pages stay selectable, the archive list resolves, the pause toggle round-trips, and a live send on the 3000-message history runs and renders a turn (fresh-conversation control passes too).

Mobile "archive stays in standby too long" investigation with a measuring harness (`scripts/dev-0.6.6-mobile-archive-latency.cjs`: long fixture, standalone mobile server on a spare port, per-step timings, plus in-process archive and kernel settle timings). Two root causes were measured, not guessed: (1) `server.ts` `mobileConversationRuntimeBusy()` treated *any* non-idle agent status as running, so archiving/分支 the conversation the user is actually looking at was refused with 423 whenever its goal was paused (`goal_paused`) or an `error` state lingered — with a paused goal the same fixture archived in 124 ms when no goal existed; (2) `conversationKernel.prepareForArchive()` awaited the in-flight run with no bound, so a run that never settles held the archive click for at least the whole observation window, contradicting the archive command's own background force-stop design. Fixes: only `status === 'working'` counts as busy, and the archive settle wait is bounded by `ARCHIVE_RUN_SETTLE_MS = 5000`. After the fix, a 3024-message conversation archives in ~0.6 s in all three states (paused goal / no goal / suspended Flow) and `prepareForArchive` returns after 5014 ms even against a never-settling run. Regressions: `mobileWorkspaceApiVerify` now covers an active conversation with a paused goal (55 assertions) and `conversationArchiveRuntimeVerify` asserts the bounded settle; `npm run test:desktop:built` stays green. Not changed: the mobile client's infinite read timeout (proposed as a separate UX decision), and no APK rebuild/device run this round.


## 2026-09-26 PC GUI 高压帧间隔与长历史 Soak

- DESKTOP/scripts/test-user-soak-gui.cjs 增加可选 --frame-monitor：用 owned Electron 的原生 HWND 最大化窗口；按 165 Hz 基准记录 renderer RAF callback 间隔；为滚动、弹层和侧栏动画单独统计；采集 PerformanceObserver Long Task、GPU Engine 子进程计数器与进程树内存/响应状态。窗口/API、RAF 与 GPU 调用都限定在本次临时 root 启动的应用进程。
- 本地归档（未纳入公开仓库） 汇总正式安装包 0.6.6.0 与 v6 unpack 候选的完整测试。两边分别使用 3000/240/80 条会话历史与 loopback provider，180 秒活动目标；119/119、130/130 功能和冷启动检查通过。
- PC 主屏 2560×1600/165 Hz，Windows DPR 2；Electron 最大化工作区 1280×752 CSS 像素。正式包 renderer RAF callback cadence 56.00/s、p95 40.5 ms；v6 unpack 60.57/s、p95 40.4 ms。RAF 间隔 >9.091 ms 分别占 43.39% 与 31.23%，不是实际屏幕漏呈现帧率；两边仍出现数百次 ≥50 ms Long Task 与秒级最大 RAF 间隔，不能称为流畅达标。
- GPU Engine 3D 样本均值约 12%，最高单实例约 26–28%；配合 Long Task 数据，倾向 renderer 任务或调度阻塞，但稀疏 GPU 采样不能排除瞬时合成/驱动问题，且未采集主线程 profile。Astra 建议用短 Chromium/Perfetto trace 标记历史分页、侧栏/滚动卡顿，检查 JS、style/layout、paint/raster、GC、IPC、compositor 与调度，并另测实际 present 时间线。要归因稀疏 CU，需在同一候选构建内实际触发 CU 并进行功能开/关交错多轮对照。
- v6 候选仅从 win-unpacked 运行，未安装到 Program Files；不将其表现记作安装版结果，也不把单次候选差值归因于稀疏 CU。旧版 Electron page-CDP 不支持 Browser.getWindowForTarget，前两次校准在测量前安全退出；改用匹配 owned process tree 的 native HWND 后，30 秒 smoke 和两轮长测完成。
- 帧值是 renderer RAF callback intervals，不是 compositor presents；各轮只跑一次且串行，适合确认 PC GUI 卡顿与找下一步 profile 方向，不能替代多轮受控性能实验。
- 从 v6 unpack 生成 MSI 后，330 个提取文件的清单通过预检，主程序和 `app.asar` 与测试候选哈希一致。安装请求的 UAC 提权被 Windows 取消，worker 未启动；Program Files 两个哈希复核仍与正式包长测相同。MSI 和准备证据留在本归档，未将候选 MSI 称为生产安装版本。

## 2026-09-27 构建强制停止、稀疏 CU 与 PC GUI 回归

- `DESKTOP/scripts/build-driver.cjs`：按阶段运行 TypeScript、进程树 helper、TypeBox、图标、WSL/utility host 与 TUI 构建；阶段默认 180 秒超时，Ctrl+C/超时会终止整个子进程树。`--clean` 和 `--clean-only` 复用该监督器；`--package-only` 以独立 1200 秒默认上限监督 Windows 打包（本轮实测约 642 秒）。
- `DESKTOP/scripts/test-build-driver-cancellation.cjs`：1 秒超时回归生成子进程及孙进程，并确认都已退出。`DESKTOP/package.json` 将 build/clean/build:clean 和 Windows release 打包接入驱动，也把取消回归放入 `test:full-release`。
- `DESKTOP/src/ui/index.html`：长历史渲染期间跳过每条消息的自动滚动并缓存编辑按钮；`DESKTOP/src/tests/verify.ts` 更新对应 UI 与 Strict JSON 自动路由契约。
- 主 `verify.js` 1719/1719；Auto Strict JSON 32/32；JEV 路由不变性 20/20；稀疏 CU 8/8；CU-Lab 数据来源门 10/10；单对话 30 轮压缩、reload 检查通过。Windows unpack/MSI/ZIP 打包 smoke 完成，但未安装；真实 Provider 有 sparse/image transport 证据，没有语义闭环通过证据。
- GUI A/B 在同一 2560×1600、165Hz、DPR 2 环境下改善 RAF callback cadence 和文本/滚动响应；历史分页 p95 从 776.7ms 退化到 842.9ms，最长 RAF 间隔从 946.8ms 退化到 1067.1ms。RAF 是回调间隔而非真实 present FPS，不能据此声称达到刷新率目标。

## 2026-09-27 PC GUI 历史消息绘制优化、unpack Soak 与本机安装

- `DESKTOP/src/ui/index.html`：恢复/分页出的历史消息标为 `history-static`，禁用逐消息入场动画与 transform；`.chat-msg` 不再强制 `translateZ(0)` 持久合成层。新消息仍使用原有 250 ms 二维 `translateY` 动画。
- 对比同负载 0.6.6.0 unpack 一次基线：renderer RAF callback cadence 65.31→75.58 次/秒，RAF p95 间隔 46.3→42.4 ms；Long Task p95 168→150 ms；历史分页 p50/p95 580.1/791.9→406.6/663.4 ms；可信输入至绘制 p50/p95 20.5/151.8→9.9/51.8 ms。单次跨版本对照未隔离本次 CSS 的因果贡献。
- unpack 测试版、安装版 EXE SHA-256 均为 `18B375DB2FD0071147D3E4010BC06914CA8ABF7908BC621FBE80E713DD91955E`，`resources/app.asar` 均为 `2EBB3B34D4C064847B202AB7E55DF1CEA1E94C532EB751E85F72712B8021E727`。0.6.7.0 已写入 Program Files；安装版正常用户启动后主窗口可响应。
- 报告：本地归档（未纳入公开仓库）。RAF callback cadence 不是 compositor present；平均 75.58 次/秒仍低于 165 Hz，76.73% 间隔高于 6.061 ms 帧预算，仍有明显长任务。`npm run test:tui:built` 的最终旧式源码结构断言未通过（期待普通 build 脚本直接复制 TUI，而当前流程经 `build-driver.cjs`）；不能据此声称聚合 release 测试全绿。


## 2026-10-06 transport 诊断修复与证据树

- `Newmark2DSH/packages/newmark-core/components/agent-api/lib/llm-seam.js`：三条异常路径使用原始错误的 failureText，保留嵌套原因；不能恢复宿主已丢弃的原因。
- `Newmark2DSH/scripts/verify-agent-api.mjs`：新增即时拒绝、流异常、工具调用后流异常三条行为回归；最后一条同时验证单次派发。
- `Newmark2DSH/archive/20261006-232444-transport-audit/`：`REPORT.md` 结论和边界；`scan.mjs` 只读多帧解码器；`transport-events.json` 失败元数据；`session-summary.json` 真实智能体预设映射与事件计数；`scan-output.txt` 扫描输出；`probe-shipped-error.mjs` 使用实际安装版 LlmError 的无网络探针；`shipped-error-probe.json` 序列化前后对照；`gate-before.txt`/`gate-after.txt` 回归前后；`core-gate.txt` 总门禁；`preset-gate.txt` 预设门禁；`before/`/`after/` 本轮触及文件快照；`scoped-diff.patch` 相对于本轮开始快照的代码差异；`after-manifest.json` 快照 SHA-256。
- 验证：Agent API 268/268，总门禁 195/195，预设 23/23。339 次 TRANSPORT 失败尝试跨 rDev/Dev/cordis，322 条重试，17 次失败收尾；一个压缩帧解码失败。历史 cause 已丢失，网络或服务端根因未确定。本轮源码修复未安装、未发布，既有 0.2.20 候选改动保留。

## 2026-10-06 电脑控制 transport 复测

通过原生电脑控制在 DSH Desktop 2.0.17 / newmark2dsh 0.2.19 实测：开始时插件实际关闭；空白会话短文本测试 19 秒成功。临时启用插件后，正确加载的 rDev 空白会话同一提示 18 秒成功，两轮均无可见重试或工具调用。测试后恢复插件关闭状态。未复现当前断流，不能据两次成功排除间歇故障；关闭插件时保留的 rdev 标识不等于加载了该预设。

页面另观察到 Agent API 显示“已启用 / not loaded”，尚未确认是否真实挂载故障，也未证明与 TRANSPORT 有关。操作及边界见 `Newmark2DSH/archive/20261006-235200-computer-use-transport/REPORT.md`；该目录的 before/after 保存六份文档快照。两条测试会话保留供复核；没有重启、安装或部署源码。

## 2026-10-07 Newmark2DSH 安装修复状态与证据树

Newmark2DSH当前源码/安装均0.2.22，DSH Desktop2.0.17运行，四组件全启用；核心195/195、客户端119/119和实际模型/工具验收通过。原自动监控newmark2dsh-transport-debug已按用户要求删除；外部TLS间歇断开以一次性长任务验收记录为准。详细边界以安装debug报告为准。

新增 `Newmark2DSH/archive/20261007-101037-installed-debug/`：REPORT.md说明目标、最终状态、归因边界和回退；before/after保存六份项目文档及源码快照；installed-before/保存原安装包/本机profile/DSH adapter，仅供本机回退；candidate/保存tgz和干净安装；scratch/是Agent API显式测试工作区；runtime-evidence.json含实际PTC工具回执和TLS重试，extract-runtime.mjs提取它；hash-installed.mjs及installed-hashes.json逐项证明42安装文件与源码一致；monitor-transport.mjs为增量只读故障检查，monitor-state.json为游标，monitor-latest.json为最近结果；ui-*.jpg/txt保存真实电脑控制截图和访问树；其余gate/install/probe文本保留失败及通过过程。candidate中的0.2.22 tgz目前被实际profile依赖引用，不可作为可删冷文件处理。本机profile快照不上传。


## 2026-10-07 一次性全工具与长上下文 heavy 验收

按用户要求删除持续监控，一次性验收已结束。安装0.2.22全部15插件工具连续1416调用零失败；42测试文件与实际安装哈希一致。旧长会话第30轮62工具调用正常completed，跨上下文压缩继续完成5项真实模型任务，独立计算全正确、计数及租约归零。1070条安装版重试/取消函数用例通过。5次连接故障由宿主自动恢复，没有人工停止或重发。历史native会话没有run_code，JS验收由独立CLI补齐，不冒称会话内执行。详情见 Newmark2DSH/archive/20261007-oneshot-heavy/REPORT.md。

新增 Newmark2DSH/archive/20261007-oneshot-heavy/：REPORT.md为最终验收和边界；installed-all-tools.mjs与mount-installed-fixture.mjs执行隔离完整套件，installed-all-tools*.json/txt留存夹具拒绝与最终通过；installed-fixture/为安装包副本，isolated-newmark*/和isolated-work/为测试库；fixture-hashes/verification和verify-evidence记录42文件哈希及状态；extract-heavy及heavy-runtime-evidence/summary记录真实62调用和完成；verify-heavy-models与heavy-model-verification核对5真实结果；verify-installed-contracts与installed-contract-verification记录1070实际函数用例；heavy-run/包含真实会话产物，ui-completed.jpg/txt为完成界面；before/after/为文档快照。全文件作用和运行边界详见该目录REPORT.md。


## 2026-10-07 新发重试耗尽与限定连接修复

新发TLS连接失败耗尽5次重试已复现。为本机DSH Desktop 2.0.17的官方Messages精确origin https://api.deepseek.com安装可回退直连覆盖，使用同版本Undici fetch/dispatcher，保留TLS校验、取消、其他路由和全部插件能力；插件源码/安装仍0.2.22，未发布。初版dispatcher跨运行时兼容错误已由实机发现并修正。原失败长会话第10轮11工具调用正常completed、重试0，五项真实模型结果独立计算全正确，计数归零。限定origin20无凭据请求、非目标origin和取消用例通过。代理随后也曾恢复，不能称为永久代理故障或证明rDev因果。详见 Newmark2DSH/archive/20261007-1410-transport-exhausted/REPORT.md；持续监控保持删除。

归档包含REPORT.md最终边界、before/after/文档及宿主补丁快照、extract.mjs及heavy-runtime-evidence/summary/events-summary原生失败与完成事件、probe-routes与route-probes路由对照、install-route-fix/installed-route-fix安装和哈希、test-route-fix/route-fix-tests范围及取消行为验证、rollback-route-fix带哈希保护的回退、model-runs/RUNTIME/workspace真实任务回执、model-verification独立计算、ui-before/after实机界面；manifest记录最终快照哈希。宿主lib/newmark-transport-route.js与json为本机限定路径覆盖，不包含在插件包内。


## 2026-10-07 连接补丁后功能无损伤复核

连接补丁后的功能无损伤复核通过：安装0.2.22全部42文件与连接修复前逐项哈希一致且匹配源码；核心195/195、客户端119/119、Agent API268/268、Dev/rDev23/23和实际安装market兼容通过。全15插件工具连续1416调用零失败、零漏测，100模型夹具运行后activeRuns/retainedMessages为0，CU租约free。宿主adapter只改import与Messages fetch函数，鉴权/图像工具序列化/SSE/取消/重试代码逐字未改，其他origin参数与response原样传递。详情 Newmark2DSH/archive/20261007-function-integrity/REPORT.md；实际模型结果以此前1410归档为证。本轮未动生产记忆/源码、未重启或发布、不持续监控。

新归档含verify-integrity/plugin-integrity安装哈希，core/client/api/presets/market门禁，installed-all-tools和mount-installed-fixture全工具套件及回执，installed-fixture安装副本、isolated-newmark-accepted/isolated-work隔离库，verify-evidence与fixture-hashes/verification副本计数，verify-transport-invariance/transport-invariance宿主不变性，before/after与after-manifest文档快照。每项作用和测试范围见REPORT.md。

## 2026-10-08 NewMate 动画与同步候选

本轮改动范围为 Newmark2DSH，源码已实现并完成 297 项验证，未部署至生产 DSH。项目目标保持真实/虚拟输入隔离、原进程状态保留及空黑虚拟桌面。

- `packages/newmark-core/components/computeruse/lib/desktop-pet.cs`：DXGI 输出同步时钟、单待处理帧、解除捕获和取帧固定延时、同步诊断。
- 同目录 `desktop-transfer.cs`：Windows 映射采集/绘制使用显示器节拍。
- 同目录 `linux-desktop.py`：OpenGL 绘制与交换调度、独立 X11 采集线程、最新帧槽、纹理复用、按刷新率更新映射。
- 同目录 `linux-desktop.js`：WSLg D3D12 桥接库路径与驱动选择，保留用户显式覆盖。
- `scripts/measure-windows-animation.mjs` 与 `scripts/lib/desktop-animation-meter.cs`：隔离真实 NewMate 原生绘制回调和 CPU 测量。
- `scripts/measure-linux-animation.py`：相同 Qt 事件循环的源码/基线分阶段测量。
- `scripts/lib/desktop-pet-gpu-probe.cs`：等待弹簧完成后断言精确全屏，避免把 99.9% 中间态当完成态。
- `scripts/verify-linux-newmate.py`：独立输出目录，新增真实窗口更新、纹理清理、采集线程退出检查。
- `docs/06-linux-desktop.md`：Linux 显示同步与 WSLg 的验证边界。
- `archive/20261008-animation-vsync/`：REPORT.md 汇总、before/after 源码文档快照、manifest 哈希、Windows 原生与 Linux GUI/后端测试回执、计时 JSON、截图。子目录和测量失败过程逐项见 REPORT.md。

以上相对路径以 Newmark2DSH 为根；Windows 本机回调约 150 FPS，165 Hz 输出同步；WSLg 约 60 Hz。不能把 Qt swap 完成、浏览器 rAF 或原生绘制回调直接当作物理显示帧。

### 0.2.31 新增实现与验收文件

- components/computeruse/lib/desktop-transfer.cs：独立线程池控制心跳与显示同步绘制，分别保障退出/保活和动画。
- scripts/verify-desktop-transfer-pacing.mjs、scripts/lib/desktop-transfer-pacing-probe.cs：主动停显式绘制时钟，验证原生状态心跳、返回命令与原窗口存活。
- scripts/verify-failure-log.mjs：复制安装包链接时显式 dereference，破坏性故障注入只修改临时副本。
- scripts/verify-linux-newmate.py、measure-linux-animation.py、measure-windows-animation.mjs：支持直接定位实际安装包。
- archive/20261008-release-030/：中间0.2.30发布、失败原始日志、安装QA树、初始回归修复与心跳注入实验；prepare/prepare-qa/native-gates脚本保留复现过程。
- archive/20261008-release-031/：最终远端checkout、tarball、发布回执、双平台哈希、DSH进程替换、全部安装态门禁、性能与最终状态；REPORT.md逐项解释子目录，docs-before/和after/保存文档与源码快照。

相对路径以Newmark2DSH为根；公共发布仓库独立提交，未提交或重置父工作区。

### 2026-10-11 用户补充后的最终设计范围

newMate以授权本地文件事件、元数据和必要差分作稀疏测量，默认消极主动响应：无变化不后台思考，无关变化不读正文，有意义才调用Agent API，有必要才唤起DSH本体对话。定制陪伴以MemoryLab确认为权威来源；自主链硬禁止删除文件及间接删除。CU读屏只作可选任务辅助。宿主真实会话创建/消息投递/导航契约待核实，不以API临时run或桌宠气泡冒充。设计、工具与文件结构均未实现。

## 2026-10-13 macOS 隔离与 Neo 最低档评估

用户暂停 Space 实现并要求评估，最低部署基线为 MacBook Neo A18 Pro／8GB。Space 不提供独立输入，另用户虚拟显示会话具有原生操作分离的官方依据，但本项目同机接入未验收；VM 系统边界更强，资源开销以测前预算记录。此次仅写评估，不改CU源码、版本、安装或发布。详见[比较与容量预算](Newmark2DSH/docs/12-macos-spaces-vm-assessment.md)。

新增 docs/12-macos-spaces-vm-assessment.md：区分Space、独立GUI会话、Linux/macOS VM，保存Neo官方规格、原生操作隔离依据、资源估算假设及验收指标；archive/20261013-macos-isolation-assessment保存本次文档前后快照。


## 2026-10-14 Newmark2DSH GitHub 产品首页

Newmark2DSH/README.md 重写为五组件完整介绍，Newmark2DSH/taste.md 固化首页结构与更新要求；公开仓库同步 README、taste、OVERVIEW 与 About。Newmark2DSH/archive/20261014-101338-readme-product/ 保存前后快照、隔离公开 checkout、草稿、同步/验证脚本和交付回执；详细子文件职责见子项目 OVERVIEW 的本轮条目。0.3.14 运行代码及已安装状态未修改。


## 2026-10-14 Newmark2DSH README 润色

子项目 README 增加阅读导航、简化术语并写全工具名；公开与本地 taste 补充推送后读校验。操作记录及文件职责见 Newmark2DSH/archive/20261014-102246-readme-polish/ 与子项目 OVERVIEW；本轮只提交公开文档。


## 2026-10-14 Newmark2DSH CHANGELOG 归档

18 份历史 CHANGELOG 逐字节归档，公开目录改用 Releases；archive/ 已有忽略规则保持有效。证据与子文件职责见 Newmark2DSH/archive/20261014-104450-changelog-archive/ 与子项目 OVERVIEW。本轮不改运行代码、版本或安装。


## 2026-10-29 15:20 「code 工作区」对话卡死排查：记忆组件与超大文件被排除，问题在 run_code 没有开始执行

- **触发**：用户在 `C:\Users\12252\Desktop\Files\Code`（Code 根，168 个顶层项目 + 一个根 `.git`）让 DSH 处理「学代会通知 PDF + 附件 zip + 按用户画像判断」的 prompt，会话 `session-47c4ed77` 卡死；切走再回来始终不加载、无报错、UI 正常。
- **结论**：记忆组件（`memory_lab_*`/`shortMemory_*`）整场**一次都没被调用**；上下文 39,791 tokens / 1,000,000 窗口（system 22,184 / tools 628 / messages 15,807）说明 prompt 不大；第三次 run_code 只剩 5 行、只读 README 前 60 行仍然卡死 —— 两条怀疑都不成立。
- **真正的现象**：三次 run_code 全都没有执行证据（`tool/ptc-dispatch-start` = 0、`sessionStats.toolMs` = 0、`pendingCalls` = `{}`），三条 `tool/result` 都是会话修复合成的 `TOOL_OUTCOME_UNKNOWN`，时间戳被回填成调用时刻（所以日志里显示 0 ms）。
- **排除工作区/预设**：同一 Code 根 + 同一 `rdev` 预设，10-27/10-28 两次会话共 **108 次 run_code 全部成功**（ptc dispatch 117 条，首次冷启动 23,483 / 52,617 ms，之后 0.6–5 s）；今天 14:00 的 Minecraft 会话 296 次成功。工作区与预设本身无罪。
- **【推断·未隔离】** 阻塞发生在 `ptc-runtime.execute()` 之前（120 s 墙钟定时器没触发、没有 timeout/worker-exit 结果），最像进程内 PTC 调用闸/运行态被占死；`14:50:05` 重启后同一工作区完全恢复（本诊断会话 62 次 run_code、首次 64.7 s 冷启动）。
- **落盘**：`archive/20261029-152000-dsh-run-code-freeze/`（REPORT.md + evidence/ + probes/read-dsh-session.mjs + before/after + MANIFEST）。产品代码零改动；`README.md` 未改（对外能力无变化）。
- **顺带记下**：`run_code` 首次调用在本机实测 23.5 / 26.1 / 52.6 / 64.7 s —— 「秒级没反应」不等于卡死，判据是超过 120 s 仍无回音。
