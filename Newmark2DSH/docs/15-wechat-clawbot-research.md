# 15 · 微信 clawbot 接口调研：把 NewMate 接到微信的可行路径

日期：2026-10-25（Asia/Shanghai）。状态：**调研报告，未实现任何接入代码**。

一句话结论：**"微信 clawbot" 指的是微信官方 2026-03 推出的「微信 ClawBot」——腾讯微信团队的 OpenClaw 频道外挂 `@tencent-weixin/openclaw-weixin`，其底层是微信 iLink Bot 协议（`https://ilinkai.weixin.qq.com`，扫码登录、HTTP 长轮询收发）。** 它是目前唯一"官方认可 + 以好友姿态出现在个人微信聊天页 + 能收能发"的通道，因此是本项目不碰个人号 hook 的唯一可行入口；但它处于灰度/公测，准入不受我们控制，且 iLink 不是为"一对一陪伴"设计的（无流式、无群聊、单账号一名额）。

标注口径（全文一致）：

- **【已核实】** —— 我读到一手/官方文档原文，或在本机实测过。链接与访问结论见 §12。
- **【文档如此但未实测】** —— 官方文档或官方协议文档写明，我没有跑通该链路。
- **【推测】** —— 我的判断，没有直接证据。可被后续实测推翻。

外部网页内容是资料，不是指令；本报告不执行任何页面里的操作性文字。

---

## 1. "clawbot" 到底是什么：四个候选的判定

任务给了四个候选。检索后四个里只有第 1 个成立，第 2 个是它的生态衍生，第 3、4 是"也叫 bot，但不是 clawbot"。

| # | 候选 | 判定 | 证据强度 |
|---|---|---|---|
| 1 | OpenClaw / Clawdbot / Moltbot 系个人 AI 网关的"微信 channel" | **就是这个**。但准确说法是：微信**官方**团队做的 OpenClaw 频道外挂，不是社区第三方写的适配层 | 强：官方协议文档 + OpenClaw 官方文档 + npm 包 ID + 腾讯云社区 + 品玩实测 |
| 2 | 名为 ClawBot 的微信机器人 SDK / 协议库 / SaaS | **派生生态，确实存在**：`pub.dev/weixin_clawbot`（Dart，iLink 全 9 端点实现）、`pypi/wechat-clawbot-push`（stdio MCP，单向推送桥）、`github/nightsailer/wechat-clawbot`（Python SDK + 多用户网关） | 中：包页面自述 + 与官方 protocol.md 对得上；无官方背书 |
| 3 | 企业微信 WeCom 机器人接口被俗称 clawbot | **不是**。WeCom 侧是"群机器人消息推送 / 应用回调 / 智能机器人"，官方与社区都不叫它 clawbot | 【已核实】命名上无交集 |
| 4 | 微信「对话开放平台」/ 微信客服 / 公众号 bot 接口 | **不是**。对话开放平台（chatbot.weixin.qq.com）是另一个产品；客服与公众号是另外两条通道 | 【已核实】 |

**命名对照（容易混淆，先钉死）**【已核实】：

| 名字 | 是什么 | 出处 |
|---|---|---|
| 微信 ClawBot | 微信客户端里的一个插件/机器人身份，出现在聊天列表 | 品玩实测、腾讯云社区文章 |
| `openclaw-weixin` | OpenClaw 的频道 ID（`weixin`、`wechat` 为别名） | [OpenClaw 微信频道文档](https://docs.openclaw.ai/zh-TW/channels/wechat.md) |
| `@tencent-weixin/openclaw-weixin` | npm 包，由**腾讯微信团队维护的外部外挂** | 同上 + [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin) |
| `@tencent-weixin/openclaw-weixin-cli` | 一键安装 CLI（`npx -y … install`） | OpenClaw 文档、腾讯云社区 |
| iLink / ilinkai | 底层 Bot 协议与 API 域名 | [docs/protocol.md](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md) |

OpenClaw 官方文档原话交代了分层【已核实】：微信代码不在 OpenClaw 核心仓库里；OpenClaw 只提供通用频道外挂契约，外挂负责"微信登录、腾讯 iLink API 调用、媒体上传下载、上下文 token 和账号监控"。外挂的能力元数据**只声明私聊**，不声明群聊。

---

## 2. 微信 ClawBot / iLink 协议面（最相关的一条）

一手材料是腾讯官方仓库里的协议文档（`Tencent/openclaw-weixin` → `docs/protocol.md`）。它自己声明了三层口径：**字段与示例**描述客户端的线上格式；**client behavior** 描述插件当前怎么发、怎么重试；**integration guidance** 是给别的实现者的建议——"客户端类型与行为不构成完整的服务端契约"。引用时保持这个区分。

### 2.1 传输与鉴权【已核实】

| 项 | 值 |
|---|---|
| 传输 | JSON over HTTPS；普通 API 用 POST，二维码状态轮询用 GET |
| API base | `https://ilinkai.weixin.qq.com`（登录成功后服务端可返回 `baseurl` 重定向） |
| CDN base | `https://novac2c.cdn.weixin.qq.com/c2c` |
| 鉴权头 | `AuthorizationType: ilink_bot_token`、`Authorization: Bearer <bot_token>` |
| 设备/版本头 | `X-WECHAT-UIN`（随机 uint32 的 base64 十进制）、`iLink-App-Id: bot`、`iLink-App-ClientVersion`（`0x00MMNNPP` 的十进制串）、可选 `SKRouteTag` |
| base_info | 已鉴权的 POST 都带 `{channel_version, bot_agent}`；`bot_agent` 只用于可观测，不参与鉴权与路由 |

### 2.2 扫码登录链路【已核实】

1. `POST /ilink/bot/get_bot_qrcode?bot_type=3`，body `{"local_token_list":[]}` → `{qrcode, qrcode_img_content}`
2. `GET /ilink/bot/get_qrcode_status?qrcode=…`（需要验证码时加 `&verify_code=…`）→ `status` 取 `wait` / `scaned` / `confirmed` / `expired` / `need_verifycode` / `verify_code_blocked` / `scaned_but_redirect` / `binded_redirect`
3. `confirmed` 返回 `bot_token`、`ilink_bot_id`、`baseurl`、`ilink_user_id`（扫码的微信用户 ID）
4. 凭据落在本地（OpenClaw 默认 `~/.openclaw`；SDK 实现落各自目录）

**没有服务端解绑接口**：官方"解绑"= `notifyStop` + 删本机凭据【文档如此但未实测，来自二手 SDK 对官方 src 的转述 + 协议文档端点表】。

### 2.3 七个 Bot 端点【已核实】

| 操作 | 方法与路径 | 要点 |
|---|---|---|
| `getUpdates` | `POST /ilink/bot/getupdates` | HTTP 长轮询；请求带上一轮的 `get_updates_buf` 游标（首轮空串）；响应 `{ret,msgs[],get_updates_buf,longpolling_timeout_ms}`，示例建议 35000ms |
| `sendMessage` | `POST /ilink/bot/sendmessage` | `msg{from_user_id:"",to_user_id,client_id,message_type:2,message_state:2,context_token,item_list[]}` |
| `getUploadUrl` | `POST /ilink/bot/getuploadurl` | 媒体上传参数；`media_type` 1 图 / 2 视频 / 3 文件 / 4 语音 |
| `getConfig` | `POST /ilink/bot/getconfig` | 取 `typing_ticket` |
| `sendTyping` | `POST /ilink/bot/sendtyping` | `status` 1 显示 / 2 取消"正在输入" |
| `notifyStart` | `POST /ilink/bot/msg/notifystart` | 通道启动通知 |
| `notifyStop` | `POST /ilink/bot/msg/notifystop` | 通道停止通知 |

### 2.4 消息模型与媒体【已核实】

- `WeixinMessage`：`seq / message_id / from_user_id / to_user_id / client_id / create_time_ms / update_time_ms / session_id / group_id / message_type(1 用户, 2 机器人) / message_state(0 new, 1 generating, 2 finished) / item_list / context_token / run_id`。
- `MessageItem.type`：`1` 文本、`2` 图片、`3` 语音、`4` 文件、`5` 视频、`11` 工具调用开始、`12` 工具调用结果；`ref_msg` 承载引用消息。
- 媒体：AES-128-ECB + PKCS#7；上传三步（`getUploadUrl` → POST 密文到返回 URL → 读响应头 `x-encrypted-param`）；下载优先 `full_url`，否则 `{cdn}/download?encrypted_query_param=…`；图片密钥优先 `image_item.aeskey`（32 hex），其次 `media.aes_key`（base64）。
- `group_id` 只出现在类型定义里 —— 协议文档明说"字段描述了类型面，不保证插件实现该功能"，与 OpenClaw 文档"只声明私聊"一致。

### 2.5 错误与冷却【已核实】

- `getUpdates`：`ret` 或 `errcode` 为 `-14` → **账号会话暂停 1 小时**；其他失败走重试/退避。
- `sendMessage`：`ret` 非 0 抛错；`ret` 缺失不触发该检查。
- 第三方桥包提到发送失败遇 `ret=-2` / `errcode=-14` 时刷新 `context_token` 重试，并会在冷启动缺省 token 时落到"最近活跃会话"——**这是二手实现经验，不是服务端契约**【推测/二手】。

### 2.6 准入与真实能力边界

| 结论 | 级别 | 依据 |
|---|---|---|
| 微信侧入口是客户端插件「微信 ClawBot」，需要较新客户端（实测报道为 8.0.70，首发仅 iOS），且**插件权限仍在逐步放开（灰度）** | 二手实测 | 品玩 2026-03-23 实测；知乎"没灰度到也可以用上"一文互为印证 |
| **一个微信号只能连一只** AI；一只 OpenClaw 可以连多个微信号 | 二手实测 | 品玩实测；腾讯云社区提问"暂不支持连接多个 OpenClaw"；PyPI 桥包自述"名额只有一个，重复扫码会顶掉上次授权" |
| 以独立账号出现在聊天页，可改昵称头像；**不能进已有群聊**、读不到联系人/历史、不能主动发给朋友 | 二手实测 | 品玩实测；与 OpenClaw 文档"仅私聊"一致 |
| 不支持图文混排，图片/文件只能逐条发；发图后机器人会立即开始处理 | 二手实测 | 品玩实测 |
| 文件"只进不出"（3 月实测）；但当前协议文档已有完整 `getUploadUrl` + 文件 `item_list` 发送管线 | 矛盾，**以实测为准** | 品玩 vs protocol.md §CDN；能力在演进，不写死结论 |
| 官方首发 2026-03-23，Public Beta，官方提醒遵守微信生态内容合规 | 二手 | 腾讯云社区文章（2026-03-23）+ 品玩同日 |
| iLink 是否还有未公开的频率限制 | **【推测】有，具体未知** | 协议文档未声明任何 QPS/条数限制；这不等于没有 |

---

## 3. 企业微信（WeCom）：三条互不相同的接口

### 3.1 群机器人 / 消息推送 webhook（只能发，不能收）【已核实】

- 地址：`https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=KEY`；POST JSON。
- 支持 `text / markdown / markdown_v2 / image / news / file / voice / template_card` 八种。
- **文本 content ≤ 2048 字节；markdown / markdown_v2 ≤ 4096 字节**（UTF-8）。
- **频率：每个消息推送不超过 20 条/分钟**。
- 文件/语音要先 `webhook/upload_media?key=KEY&type=file|voice`：文件 ≤ 20MB，语音 ≤ 2MB 且 ≤ 60s、仅 AMR；`media_id` 3 天有效。
- **不需要企业认证就能建 webhook**（文档只要求"创建者"在管理后台看到该推送的 webhookurl）；但它是**单向推送**，收消息另走回调。
- 文档最后更新 2025/08/07。

对项目的意义：这是最便宜的"NewMate 主动消息出路"，但拿不到"用户发微信 → NewMate 回"的闭环。

### 3.2 自建应用 接收消息与事件（URL 回调）【已核实】

- URL 验证：企业微信发 `GET ?msg_signature&timestamp&nonce&echostr`，服务必须解密 `echostr` 并返回明文才算通过。
- 业务回调：POST 包体含 `Encrypt`；校验 `msg_signature`（token + timestamp + nonce + 密文体的签名）→ 解密 → 处理 → 需要时构造加密被动回复包 `<Encrypt><MsgSignature>…`。
- **超时与重试：企业微信服务器 5 秒内收不到响应会断连并重新发起请求，总共重试 3 次**（仅对网络失败/超时）。文档还明说：**无法保证 100% 回调成功，开发者失败/超时过多时企业微信可能丢弃一些回调事件，不要强依赖回调**。
- 需要公网可访问 URL（下文 §3.3 的长连接是对这一点的官方替代）。

### 3.3 智能机器人（WeCom AI Bot）——两条接收路径【已核实】

官方 2026/10/10 更新的文档把两种 API 模式摆在同一张对比表里：

| 特性 | Webhook（短连接） | WebSocket（长连接） |
|---|---|---|
| 服务端要求 | **需要公网可访问 URL** | **无需固定公网 IP** |
| 加解密 | 需要处理消息加解密 | **无需加解密** |
| 延迟/实时性 | 一般 | 低/好 |
| 复杂度/可靠性 | 低 / 高（无状态） | 较高（心跳保活、断线重连） |

长连接要点【已核实】：

- 地址 `wss://openws.work.weixin.qq.com`；订阅帧 `{cmd:"aibot_subscribe", body:{bot_id, secret}}`；凭证是管理后台「智能机器人 → API 模式 → 长连接」给出的 `BotID` 与**长连接专用 `Secret`**（与 webhook 的 Token/EncodingAESKey 不是一套）。
- **每个机器人同一时间只能一条有效长连接，新连接会踢掉旧连接**（旧连接收到 `disconnected_event`）；高可用要主备，不能并行多连。
- 上行：`aibot_msg_callback`（`msgid` 用于排重、`chattype` single/group、`from.userid`、`msgtype`；非超管创建者拿到的是**加密 userid**）、`aibot_event_callback`（`enter_chat` / `template_card_event` / `feedback_event` / `disconnected_event`）。
- 下行：`aibot_respond_msg`（**流式** `stream.id` + `finish`，**10 分钟内必须 finish**）、`aibot_respond_welcome_msg`（**5 秒内**）、`aibot_send_msg`（主动推送，无回调触发）、`aibot_respond_update_msg`。
- **频率与窗口：收到消息回调后 24 小时内可回复该会话；无论回复还是主动推送，单会话 30 条/分钟、1000 条/小时。**
- 媒体：`image/file/video` 结构体带每条 URL 独立的 `aeskey`，**AES-256-CBC + PKCS#7（补齐到 32 字节倍数），IV 取 aeskey 前 16 字节，URL 5 分钟内有效**。
- 官方 SDK：`aibot-node-sdk`（Node.js）与 `aibot-python-sdk`（Python）。
- 每个机器人最多三条消息交互中（webhook 模式文档写明）。

**准入未写死**：文档描述的是"在企业微信管理后台创建智能机器人并开启 API 模式"，即以企业微信企业主体为前提；**是否要求企业认证，文档没有明确写**【推测：大概率不强制认证即可建企业，但这一点必须实测】。

---

## 4. 微信公众号（服务号）：被动回复 5 秒 + 客服消息 48 小时

### 4.1 服务器配置与验签【已核实】

- 在「微信开发者平台 → 我的业务 → 服务号 → 消息与事件推送」填 **URL / Token / EncodingAESKey**，选加解密模式（明文 / 兼容 / **安全（推荐）**）；**数据格式仅支持 XML**。
- URL 验证：微信发 `GET ?signature&timestamp&nonce&echostr`；`signature = sha1(sort([token,timestamp,nonce]))`，校验通过后**原样返回 echostr**。
- 安全模式：验签用 `msg_signature = sha1(sort([token,timestamp,nonce,Encrypt]))`（注意：**不要用 signature 验密文**）；解密 `AESKey = Base64Decode(EncodingAESKey + "=")`（32 字节），AES-256-CBC + PKCS#7，明文结构 `random(16B) + msg_len(4B, 网络序) + msg + appid`，**必须校验 appid 是自己的**。
- 用户标识是 **OpenID**（同一用户对每个服务号一个）。

### 4.2 收消息与 5 秒窗口【已核实】

- 微信服务器 POST XML 到配置 URL；**5 秒内收不到响应就断连并重发，总共重试 3 次**；排重推荐 `MsgId`，事件用 `FromUserName + CreateTime`。
- 不能保证 5 秒内答完：**直接回 `success` 或空串（长度 0）**，微信不做处理也不再重试，之后用客服消息异步回复。
- 踩线后果：5 秒内没回、或回了异常数据（例如 JSON），会话里会向用户下发"该服务号暂时无法提供服务，请稍后再试"。

### 4.3 客服消息的硬额度【已核实】

| 触发场景 | 下发额度 | 有效期 |
|---|---|---|
| 用户发送消息 | **5 条** | **48 小时** |
| 点击自定义菜单 | 3 条 | 1 分钟 |
| 关注服务号 | 3 条 | 1 分钟 |
| 扫描二维码 | 3 条 | 1 分钟 |

接口 `POST /cgi-bin/message/custom/send`；每个账号最多 100 个客服账号；另有"客服输入状态"`/cgi-bin/message/custom/typing`。

另有 `transfer_biz_ai_ivr`（转接 AI 回复）——需要服务号已开启 AI 回复并学习完历史文章，**目前在灰度**【文档如此但未实测】。

### 4.4 对本项目的意义

服务号路径的形态是"公众号对话框"，不是"微信好友聊天"；且 5 秒被动回复 + 48h/5 条的额度，对"每次都要跑一次模型循环"的陪伴场景非常紧。**不建议作为 MVP 主路径**，但它是 48 小时内可主动触达的老通道。

---

## 5. 微信客服（微信客服 API / kf）

### 5.1 收：回调只给信号，消息要自己拉【已核实】

- 回调 XML：`MsgType=event`、`Event=kf_msg_or_event`、`Token`（拉取用，**10 分钟内有效**）、`OpenKfId`。
- 拉取：`POST https://qyapi.weixin.qq.com/cgi-bin/kf/sync_msg?access_token=…`，body `{cursor, token, limit≤1000, voice_format, open_kfid}`。
- **只保留最近 3 天**；`limit` 默认与最大都是 1000；**不能靠"msg_list 为空"判断结束，要看 `has_more`**；`next_cursor` 必须持久化，否则会从头拉、造成延迟。
- 媒体上限（读取）：图片 2MB、语音 2MB、视频 10MB、文件 20MB；超出会收到文本提示消息而不是文件。
- 权限：自建应用必须配置到「微信客服 - 可调用接口的应用」；**2023-12-01 起不再支持用系统应用 secret 调用**；客服账号必须设为"通过 API 管理"。

### 5.2 发：只有 48 小时 / 5 条，还有状态门槛【已核实】

- `POST /cgi-bin/kf/send_msg?access_token=…`。
- **只有当微信客户处于「新接入待处理」或「由智能助手接待」状态时才能发**。
- **用户主动发消息后的 48 小时内，最多 5 条**；用户再发一条，额度重置。
- 文本 `content ≤ 2048 字节`（超出截断）；`msgid` 32 字节内、客服账号内唯一。
- **接口返回成功不代表最终送达**，要看"消息发送失败事件"回调。

### 5.3 对本项目的意义

微信客服是"客服"语义：客户从入口点进来，48h 内 5 条。适合"用户主动来找、问一次答一次"的问答型接入，不适合 NewMate 的持续主动陪伴（主动推送几乎不可能）。

---

## 6. 个人微信号：官方没有接口，且明文禁止这么做

这一节是"不可作为产品路径"的判断依据，结论先写：**任何 hook / 协议库 / 多开方案都不进产品路线**。

### 6.1 官方文档里不存在个人号消息 API【已核实（缺失证据）】

微信官方开发者文档有完整索引 `https://developers.weixin.qq.com/doc/llms.txt`（实测 642,040 字节 / 8,810 行）。检索"个人号 / 个人微信 / 个人账号消息"**零命中**；列出的通道只有小程序、小游戏、订阅号、服务号、开放平台、微信小店、视频号、智能对话。也就是说，官方没有面向"个人微信号收发消息"的开放接口。

### 6.2 《微信个人账号使用规范》直接封死这条路径【已核实】

原文（`https://weixin.qq.com/cgi-bin/readtemplate?t=page/agreement/personal_account&lang=zh_CN`）：

- 1.2.4 禁止"对微信软件或者运行过程中释放到内存中的数据、客户端与服务器端的交互数据…进行复制、修改、增加、删除、**挂接运行**…形式包括但不限于使用**插件、外挂或非经腾讯授权的第三方工具/服务接入微信软件和相关系统**"；
- 1.2.6 禁止"通过非腾讯开发、授权的第三方软件、插件、外挂、系统等，注册、登录、使用微信软件及服务或**进行自动化操作**，对微信软件及其组件、模块、界面、数据等进行访问、读取或控制，**或制作、发布、传播上述工具、方法**"；
- 1.2.7 禁止"规避、破坏微信软件设置的安全保护等技术措施"；
- 1.2.9 把"抢红包插件、微信多开插件、皮肤修改插件、一键转发插件"等列为常见违规示例。
- 处罚：警告、限制/追责、**停止账号部分或全部功能的服务、封禁账号**。

注意 1.2.6 里的"**制作、发布、传播**"——这不止约束使用者，也约束我们作为工具提供方。

### 6.3 wechaty / PadLocal / hook 的技术原理与风险【已核实机制 + 推测风险】

- **Web 协议**：模拟微信网页版登录（早已大范围不可用）。
- **PadLocal**：Wechaty 生态的付费协议网关。官方文档自述其动机就是规避风控——旧模式"所有消息收发的 IP 都来自同一个 IP 池，会加重账号风险"，PadLocal 把网关放在**本地**运行，"就像电脑客户端一样收发"，"极大程度上减小了账号风险系数"。文档同时说明需要 `WECHATY_PUPPET_PADLOCAL_TOKEN`（付费）。
- **hook 类**（注入客户端、读内存/改协议包）：直接落在 §6.2 的 1.2.4 / 1.2.5 / 1.2.7 上。

风险结论：

1. **账号风险**：不是"会不会被抓"，而是"什么时候被抓"——风控是概率与节奏问题，产品不能建立在概率上【推测，但 §6.2 的条款是确定的】。
2. **合规/法律风险**：条款禁止"制作、发布、传播"，意味着我们分发这类方案本身就是被禁止的行为，与用户是否知情无关【已核实条款】。
3. **工程风险**：协议随客户端版本漂移，逆向侧永远在追；一次微信升级就能让产品全线不可用。
4. **数据风险**：hook 方案要拿到用户的登录态/消息流，等于持有全量社交数据，隐私与合规面无法用"本地运行"简单抵掉。

**因此：个人号 hook / 协议库 / 多开 一律不作为产品路径，只作为"用户个人实验"存在，且不得写进 README 的能力声明。**

---

## 7. 小程序 / 微信「对话开放平台」的边界

- **微信对话开放平台**（`chatbot.weixin.qq.com`，官方文档 `/doc/aispeech/platform/INTRODUCTION.md`）【已核实】：官方智能对话机器人平台，"零门槛"，一键接入**公众号、小程序（插件/客服消息）、H5、开放 API**；可视化配置、知识库、转人工、标签群发。**它的接入渠道里没有"个人微信好友"**——所以它解决的是"公众号/小程序里放一个 bot"，不解决"用户在自己的微信里跟 NewMate 聊天"。
- **小程序客服消息**【文档如此但未实测】：是小程序内会话里的消息，用户必须进小程序；与个人微信聊天页不是同一个界面。（本轮该页正文取到的是"该内容不存在或不可见"，因此不引用其细节。）
- 结论：这两条都**不适合**当 NewMate 与用户一对一陪伴的入口，但对话开放平台可以作为"公众号渠道里那层对话能力"的现成替代。

---

## 8. 六条通道横向对比（以"不碰个人号 hook 拿到收发闭环"为判据）

| 通道 | 收消息 | 发消息 | 需要公网 IP | 准入门槛 | 主要硬限制 | 结论 |
|---|---|---|---|---|---|---|
| **微信 ClawBot / iLink** | ✅ HTTP 长轮询 `getupdates` | ✅ `sendmessage` + 媒体 + 输入状态 | ❌ 不需要（本机出网即可） | 微信 8.0.70 + 「微信 ClawBot」插件灰度 + 扫码绑定 | 私聊 only、群聊不可用；**一个微信号只能绑一只**；无流式；Public Beta；`-14` 冷却 1 小时 | **首选**（唯一"好友式"闭环） |
| WeCom 智能机器人（长连接） | ✅ WebSocket `aibot_msg_callback` | ✅ 流式 + 主动推送 | ❌ 不需要 | 企业微信企业 + 后台开 API 模式 + BotID/Secret | 单机器人一条长连接；24h 回复窗；30 条/分、1000 条/时；群聊要 @ | 企业/团队场景最优 |
| WeCom 应用回调（URL） | ✅ 加密回调 | ✅ 应用消息 | ✅ **需要** | 企业微信 + 自建应用 + 可信域名 | 5 秒 + 3 次重试；可能丢事件 | 有公网服务器时可用 |
| 公众号（服务号） | ✅ XML 推送 | ✅ 被动回复 + 客服消息 | ✅ 需要 | 服务号（多数能力要认证） | **5 秒**被动回复；客服 **5 条/48h**；额度按触发场景 | 不适合高频陪伴 |
| 微信客服 kf | ✅ 回调 + `sync_msg`（3 天） | ✅ `send_msg` | ✅ 需要 | 企业微信 + 微信客服账号 +「可调用接口的应用」 | **48h / 5 条**；只在新接入/智能助手接待态可发 | 适合问答型客服 |
| 个人号 hook / wechaty | ✅ | ✅ | ❌ | 无（但违规） | 封号 + 违约 + 版本漂移 | **禁止** |

---

## 9. 对本项目的最小可行接入方案

### 9.1 NewMate 现有边界（本机实测，2026-10-25）

先纠正任务描述里的一处前提：**MCP 面不是三个工具，是七个**。本机 `tools/list` 实测返回：

```
newmate_todo_add, newmate_todo_list, newmate_todo_cancel,
newmate_chat, newmate_task_status, newmate_message, newmate_memory_context
```

这七个里 `newmate_message`（主动发消息到桌宠气泡）和三个 todo 工具对"接到微信"是**关键资产**——出站不必另造。

实测到的接口形状（均为本机真实调用）：

| 事实 | 值 | 级别 |
|---|---|---|
| 端点 | `POST http://127.0.0.1:54879/newmark-newmate/mcp`，streamable-http | 【已核实·实测】 |
| 协议版本 | `2025-06-18`（`2025-03-26` 亦可），serverInfo `newmark-newmate v0.3.14` | 【已核实·实测】 |
| 鉴权 | `Authorization: Bearer <token>`；token 在 `<用户目录>/.Newmark/newMate/mcp-token`（64 hex，0600），**不写进文档** | 【已核实·实测】 |
| 无 token | `401` + `WWW-Authenticate: Bearer realm="NewMate"` | 【已核实·实测】 |
| 必需头 | `Accept` 必须**同时**含 `application/json` 与 `text/event-stream`；`Content-Type: application/json` | 【已核实·源码】 |
| Origin | 只有带 `Origin` 时才校验（必须 loopback 且等于 `Host`）；本地服务进程不带 Origin 可通过 | 【已核实·源码 + 实测】 |
| 请求体上限 | 32768 字节 | 【已核实·源码】 |
| `newmate_chat` 入参 | **只有 `prompt`，没有 threadId** | 【已核实·源码】 |
| `newmate_chat` 返回 | **立即返回** `{ok,id,mode,inputId}`；回复异步落到 store，用 `newmate_task_status` 轮询 | 【已核实·源码】 |
| `newmate_message` | 受"陪伴开关"与 `proactiveMessageGate` 约束，**可能 `suppressed`**；`id` 相同即去重（`duplicate:true`） | 【已核实·源码】 |
| 出站呈现 | `notify()` → `onNotify` → 桌宠气泡；即"现在是本机气泡，不是微信" | 【已核实·源码】 |

另一条实测：本机**普通进程**（PowerShell）可以直接访问 DSH 的 HTTP 面——`GET /newmark-newmate/loop` 返回 200，MCP 路由在无 token 时返回 401、带 token 时 200。也就是说**"本地桥进程 ↔ NewMate"这一跳不存在网络准入障碍**（DSH 的 renderer 准入策略没有挡住这类请求）。

### 9.2 方案 A（首选）：本地 ClawBot 桥 + NewMate MCP

```
微信用户 ──微信 ClawBot── ilinkai.weixin.qq.com ──HTTPS 长轮询── wechat-bridge（本地 Node 进程）
                                                                    │  Bearer + loopback
                                                                    ▼
                                                        NewMate MCP (/newmark-newmate/mcp)
                                                                    │
                                                        DSH agent-api run（模型 + 工具）
                                                                    │
                                                    回复写入 store → bridge 取回 → sendmessage
```

**入站链路（用户发微信 → NewMate 回微信）**

1. bridge 用 `bot_token` 起 `POST /ilink/bot/getupdates` 长轮询，维护 `get_updates_buf` 游标（持久化到磁盘，重启续用；协议建议 35s 超时）。
2. 收到 `msgs[]` → 用 `message_id`（`seq` 作为后备）做幂等去重 → 只处理 `message_type==1`（用户）且 `item_list` 含 `type==1` 文本的项。
3. 调 `newmate_chat{prompt}` → 拿到 `{ok,id}`（**异步**，不等于有回复）。
4. 轮询 `newmate_task_status{id}`：`running` 转 false 且 `task.status` 完结时，从返回的 `messages` 取该任务最新 assistant 文本；同时把 `agentLoop` 的 phase/当前工具映射成"正在输入"（`getconfig` 拿 `typing_ticket` → `sendtyping status=1`，回复前 `status=2`）。
5. 用**入站消息的 `context_token`** 调 `POST /ilink/bot/sendmessage`：`to_user_id = 原 from_user_id`、`from_user_id: ""`、`client_id` 由 bridge 生成、`message_type: 2`、`message_state: 2`、`item_list=[{type:1,text_item:{text}}]`。

**出站链路（NewMate 主动发微信）**

现成的 `newmate_message` 只落本机气泡。最小改法是加一个**出站队列**：NewMate 的 `notify()` 在写完 store 后把同一条消息 append 到 `newMate/wechat-outbox.jsonl`（或推给 bridge 的一个 loopback 端点）；bridge 消费后 `sendmessage`，用 `message.id` 作为 `client_id` 实现幂等。这样 `newmate_message` 的语义从"桌宠气泡"扩成"桌宠气泡 + 微信"，而**不需要模型知道微信存在**。

**必须实现的四件"不显眼但会咬人"的事**

| 关注点 | 做法 | 理由（已核实） |
|---|---|---|
| 去重 | 入站按 `message_id` 幂等表；出站用 `client_id`/`message.id` | iLink 是长轮询，游标回退或重试会重复投递；`newmate_message` 本身已按 id 去重，可复用 |
| 超时回复 | 没有微信侧 5 秒硬限（iLink 是长轮询，不是被动回复），但要**自己设预算**：收到即 `sendtyping`，超过 N 秒（建议 20–30s）先发一条"还在处理"的短消息，再发结果 | 用户端没有"服务号暂时无法提供服务"那种系统兜底，超时会变成"已读不回" |
| `context_token` | 每次回复回传入站 token；遇 `ret`/`errcode` 为 `-14` 立刻停手，等冷却结束 | 协议文档：`-14` → 会话暂停 1 小时 |
| 单用户绑定 | MVP：**一个 bridge = 一个微信用户 = 一个 NewMate 会话**。桥侧持久化 `ilink_user_id ↔ NewMate task/thread` 映射 | `newmate_chat` 没有 `threadId` 入参，MCP 侧只有一个默认会话；多用户必须改代码 |

**多用户是明确的代码改动，不是配置**：要支持"A 的微信只进 A 的会话"，需要给 `newmate_chat`（MCP schema 与 `mate.chat`）加 `threadId`/`conversationKey` 参数，并在 MCP 层做越权校验（只允许桥声明的那个 thread）。在这之前，**"多人共用一个 NewMate"在语义上就是错的**，不要靠 bridge 侧自己分桶假装隔离。

### 9.3 方案 B：WeCom 智能机器人长连接（企业/团队场景）

需要"公司里一群人通过企业微信找 NewMate"时，这条比 ClawBot 更稳：

- 官方 SDK（`aibot-node-sdk`）+ WebSocket 长连接 → **不需要公网 IP、不需要自己实现加解密**。
- 流式回复（`aibot_respond_msg` + `stream.id`，10 分钟内 finish）比 iLink 的分条发送体验更接近"在打字"。
- 代价：单机器人只能一条长连接（要主备切换）；每会话 30 条/分、1000 条/时；24 小时回复窗；群聊场景要 @ 机器人。
- 与 NewMate 的耦合点与方案 A 相同（`newmate_chat` + `newmate_task_status`），只是传输层换掉。

### 9.4 方案 C（不建议做 MVP）

公众号需要公网服务器 + 5 秒被动回复 + 客服消息 5 条/48h 额度，且形态是"公众号对话框"。除非产品定位改成"服务号里问一句答一句"，否则投入产出不划算。

### 9.5 需要新增/修改的清单

| 位置 | 变更 | 类型 |
|---|---|---|
| 新包 `packages/wechat-bridge`（或独立进程） | iLink 客户端：QR 登录、`getupdates` 长轮询、`sendmessage`、`sendtyping`、媒体上传下载、游标与去重持久化 | 新增 |
| 同上 | NewMate MCP 客户端：Bearer 从 `mcp-token` 读、loopback、`Accept` 双值、32KB 体上限、超时与重试 | 新增 |
| 同上 | 出站队列消费器 + 失败重投（`-14` 立刻停） | 新增 |
| `components/newmate/lib/mcp.js` | `newmate_chat` 增加可选 `threadId`（或 `conversationKey`）+ 归属校验 | 修改 |
| `components/newmate/component.js` | `notify()` 后写 outbox（或在 `message()` 成功后广播） | 修改 |
| 配置 | `bot_token` 单独文件、0600、不进日志、不进 README；与 `mcp-token` 分开存 | 新增 |
| 门禁 | `verify-wechat-bridge`：假 iLink 服务端（本地 HTTP）+ 真 MCP，断言游标续传、重复投递只回一次、`-14` 停手、超时先回执、outbox 幂等 | 新增 |

### 9.6 事实分级（这一段是给评审的，不要漏）

**已核实（可复现）**

- `clawbot` = 微信 ClawBot / iLink，腾讯维护，协议文档给出 9 个端点（7 个 Bot 端点 + 2 个扫码端点）与完整消息模型。
- NewMate MCP 七工具、Bearer 鉴权、`newmate_chat` 异步、无 `threadId`、本地进程可直连（实测）。
- 各通道的 5 秒 / 20 条/分 / 48h·5 条 / 24h·30 条/分·1000 条/时 等数字，均来自官方文档原文。
- 个人号无官方接口；《微信个人账号使用规范》禁止第三方自动化。

**文档如此但未实测**

- iLink 的扫码登录与收发全链路（本轮没有你的微信去扫，不能声称跑通）。
- WeCom 智能机器人长连接的握手、流式、`disconnected_event` 行为。
- 服务号/客服的 XML 与 AES 细节（读了文档，没搭服务端）。
- 微信客服 `sync_msg` 的 `has_more` 边界行为。

**推测（明确标注）**

- iLink 存在未公开的频率限制（协议文档未声明 ≠ 没有）。
- ClawBot 的"一个微信号一名额"是稳定约束而非临时灰度策略（三处二手一致，但无一手文档）。
- 企业微信智能机器人对企业认证的强制程度。
- NewMate 一轮 run 的典型耗时在 10–60 秒量级，因此 §9.2 的 20–30s 首条回执阈值是经验值，需要实测标定。

---

## 10. 风险与合规清单

1. **准入风险（最高）**：ClawBot 是灰度 + Public Beta。我们的接入能力不由代码决定，而由"这个微信号有没有插件权限"决定。产品文案不能说"支持微信"，只能说"在已开通微信 ClawBot 的环境里可用"。
2. **单名额冲突**：用户若已把 ClawBot 绑给别的助手（WorkBuddy / 其他 OpenClaw 实例），我们再扫码会**顶掉**上一次授权——三处二手一致。这必须是显式告警 + 二次确认，不能静默替换。
3. **内容合规**：腾讯云社区文章与 OpenClaw 文档都点出内容合规要求；NewMate 的主动消息已有 `proactiveMessageGate`，接微信后**不放松**。
4. **频率风险**：WeCom 侧 20 条/分、30 条/分、1000 条/时是硬墙；iLink 侧未知【推测】。桥必须自带令牌桶，不能把 NewMate 的自主轮次直接放大成消息。
5. **凭据**：`bot_token` 等同"这个微信身份的发消息权限"。0600 落盘、不进日志、不进 issue、不进 README、不进报告（本报告不含任何 token）。
6. **数据面**：桥会看到用户消息原文与媒体。本地处理没问题，但**不得**为了"方便调试"把它同步到任何远端。
7. **不可逆操作**：解绑只能在本机 `notifyStop` + 删凭据，服务端授权记录只能在手机微信里看/管（二手，官方 src 转述）。UI 必须说清"我们能做的只有本机停用"。

---

## 11. 未决问题（下一步要测什么）

| # | 问题 | 验证方式 |
|---|---|---|
| 1 | 我们的微信号是否已有「微信 ClawBot」插件权限 | 客户端版本 + 聊天页是否出现入口；装 CLI 扫码 |
| 2 | iLink 的真实频率/并发限制 | 受控压测 `getupdates` + `sendmessage`，观察 `ret`/`errcode` |
| 3 | 一个微信号一名额是否硬约束 | 用同一微信号先后绑两只 bot，观察是否顶掉 |
| 4 | 文件/图片能不能"出" | 让 NewMate 产出 PNG，走 `getuploadurl` + `sendmessage` 实测（品玩 3 月说不能） |
| 5 | NewMate 一轮 run 的实际 P50/P95 耗时 | 在 `agentLoop.elapsedMs` 上采样，用于定 §9.2 的回执阈值 |
| 6 | WeCom 智能机器人是否要求企业认证 | 注册未认证企业试建智能机器人 |
| 7 | 多用户隔离的最小改动面 | 设计 `threadId` 参数 + 归属校验，先写门禁再写实现 |
| 8 | DSH 端口稳定性 | `54879` 是当前值；桥不能硬编码，应从 `newmate_mcp_info` 或配置发现 |

---

## 12. 证据（全部 URL 与访问结论）

访问时间：2026-10-25（Asia/Shanghai）。"读到"= 我用 web_fetch / Invoke-WebRequest 实际拿到了正文，不是搜索摘要。

### 12.1 微信 ClawBot / iLink

| URL | 访问结论 | 用于支撑 |
|---|---|---|
| https://docs.openclaw.ai/zh-TW/channels/wechat.md | 200，读到全文 | 外挂由腾讯微信团队维护；频道 ID `openclaw-weixin`；扫码登录；**只声明私聊**；版本矩阵；sidecar 与重启循环问题 |
| https://github.com/Tencent/openclaw-weixin | 200，读到 README | 仓库是 OpenClaw 的微信频道外挂；Node ≥22.13、OpenClaw ≥2026.3.22；MIT；`npx -y @tencent-weixin/openclaw-weixin-cli install` |
| https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md | 200，读到全文（18,366 字符） | 传输、头、`base_info`、二维码状态机、9 个端点（7 Bot + 2 扫码）、消息模型、CDN 加解密、错误与 `-14` 冷却、三层证据口径 |
| https://cloud.tencent.cn/developer/article/2644003 | 200，读到正文 | 2026-03-23 首发；安装命令；扫码授权；Public Beta；内容合规提示；"绑定机器人一开始在列表里看不到" |
| https://www.pingwest.com/a/312336 | 200，读到正文 | 独立实测：需 8.0.70（首发 iOS）、插件权限灰度、**一个微信号只能连一只**、不能进群、读不到联系人/历史、不支持图文混排、文件"只进不出" |
| https://zhuanlan.zhihu.com/p/2019721011319297398 | 搜索命中（未逐字读全文） | 旁证"灰度"存在（"没灰度到也可以用上"） |
| https://cloud.tencent.cn/developer/ask/2213133 | 搜索命中 | 旁证绑定冲突："暂不支持连接多个 OpenClaw" |
| https://pub.dev/packages/weixin_clawbot | 200，读到 README | Dart 实现覆盖官方 9 个端点；`ilinkai.weixin.qq.com`；解绑无服务端接口；换绑语义 |
| https://pypi.org/project/wechat-clawbot-push/2.0.5/ | 200，读到 README | **"微信侧 ClawBot 名额只有一个，重复扫码授权会顶掉上一次"**；`bot_token` vs `context_token`；`ret=-2 / errcode=-14` 的处理经验 |

### 12.2 企业微信

| URL | 访问结论 | 用于支撑 |
|---|---|---|
| https://developer.work.weixin.qq.com/document/path/91770 | 200，落盘转文本后读到正文（28,647 字符） | 群机器人 webhook 形状、8 种消息类型、text ≤2048 字节、markdown ≤4096、**20 条/分钟**、`upload_media` 与 3 天 media_id、文件 ≤20MB / 语音 ≤2MB·60s |
| https://developer.work.weixin.qq.com/document/path/90930 | 200，读到正文 | URL 验证（`echostr` 解密）、`msg_signature`、加密被动回复、**5 秒 + 3 次重试**、可能丢事件 |
| https://developer.work.weixin.qq.com/document/path/100719 | 200，读到正文（29,411 字符） | 智能机器人接收消息：支持的场景、`msgid` 排重、`chattype`、加密 userid、`response_url`、单机器人最多三条交互中 |
| https://developer.work.weixin.qq.com/document/path/101463 | 200，读到正文（36,327 字符） | 智能机器人**长连接**：`wss://openws.work.weixin.qq.com`、`aibot_subscribe`、单连接限制、`aibot_msg_callback`/`aibot_event_callback`、流式 10 分钟、欢迎语 5 秒、**24h / 30 条每分 / 1000 条每小时**、AES-256-CBC 媒体、`aibot-node-sdk`/`aibot-python-sdk` |
| https://developer.work.weixin.qq.com/document/path/101138 | 200（同族文档），未逐段引用 | 主动回复消息（`response_url` 路径） |
| https://developer.work.weixin.qq.com/document/path/94670 | 200，读到正文（33,717 字符） | 微信客服：`kf_msg_or_event`、`sync_msg`、3 天、`has_more`、媒体上限、权限要求、2023-12-01 起不再支持系统应用 secret |
| https://developer.work.weixin.qq.com/document/path/94700 | 200，读到正文（23,825 字符） | 微信客服发消息：**仅"新接入待处理/由智能助手接待"状态**、**48 小时 5 条**、text ≤2048 字节、返回成功≠送达 |

### 12.3 公众号（服务号）

| URL | 访问结论 | 用于支撑 |
|---|---|---|
| https://developers.weixin.qq.com/doc/service/guide/dev/push/ | 200，读到正文 | 服务器配置三要素、明文/兼容/安全三模式、**仅 XML**、`signature=sha1(sort(token,timestamp,nonce))`、`echostr` 原样返回、OpenID 语义 |
| https://developers.weixin.qq.com/doc/service/guide/product/message/Passive_user_reply_message.md | 200，读到 md 全文 | **5 秒 + 3 次重试**、回 `success`/空串免重试、"该服务号暂时无法提供服务"、各消息类型 XML |
| https://developers.weixin.qq.com/doc/service/guide/product/message/Receiving_standard_messages.md | 200，读到 md 全文 | POST XML 收消息、`MsgId` 排重、5 秒 + 重试 3 次 |
| https://developers.weixin.qq.com/doc/service/guide/dev/push/encryption.md | 200，读到 md 全文 | `msg_signature` 四元组、`EncodingAESKey+"="` → 32 字节 AESKey、AES-256-CBC/PKCS#7、`random+len+msg+appid`、回包加密形状 |
| https://developers.weixin.qq.com/doc/service/guide/product/kf/intro.md | 200（HTML 版读到正文） | **客服消息额度表：用户发消息 5 条/48 小时**；菜单/关注/扫码 3 条/1 分钟；`/cgi-bin/message/custom/send`；100 个客服账号 |
| https://developers.weixin.qq.com/doc/llms.txt | 200，落盘 642,040 字节 / 8,810 行 | 官方文档全量索引；用于**证明个人号消息 API 不存在**，以及定位各页 `.md` 路径 |

### 12.4 个人号与平台

| URL | 访问结论 | 用于支撑 |
|---|---|---|
| https://weixin.qq.com/cgi-bin/readtemplate?t=page/agreement/personal_account&lang=zh_CN | 200，读到正文（15,238 字符） | **《微信个人账号使用规范》1.2.4 / 1.2.6 / 1.2.7 / 1.2.9 + 处罚条款** —— "不可作为产品路径"的判定依据 |
| https://weixin.qq.com/cgi-bin/readtemplate?t=weixin_agreement&s=default | 200，读到正文 | 《腾讯微信软件许可及服务协议》：personal、non-transferable 许可；不得反向工程 |
| https://wechaty.readthedocs.io/zh-cn/latest/introduction/use-padlocal-protocol/ | 200，读到正文 | PadLocal 的动机与原理（本地网关降低 IP 池风控）、付费 token、docker 网关 |
| https://developers.weixin.qq.com/doc/aispeech/platform/INTRODUCTION.md | 200，读到 md 全文 | 对话开放平台定位；接入渠道只有公众号/小程序/H5/开放 API，**没有个人微信** |
| https://developers.weixin.qq.com/doc/miniprogram/dev/server/API/kf-mgnt/kf-message/api_sendcustommessage.md | 200 但正文为"该内容不存在或不可见" | 小程序客服消息接口本轮**未取得正文**，报告不引用其细节 |

### 12.5 本机实测（NewMate 侧）

| 动作 | 结果 |
|---|---|
| `newmate_mcp_info` | `{path:"/newmark-newmate/mcp", transport:"streamable-http", tokenFile:"…/.Newmark/newMate/mcp-token", protocolVersions:["2025-06-18","2025-03-26"]}` |
| `GET /newmark-newmate/loop`（无鉴权） | `200`，返回 `agentLoop` 快照 → 本地普通进程可访问 DSH HTTP 面 |
| `POST …/mcp`（无 token） | `401`，`WWW-Authenticate: Bearer realm="NewMate"` |
| `POST …/mcp` initialize（带 token） | `200`，`serverInfo: newmark-newmate v0.3.14`，`protocolVersion: 2025-06-18` |
| `tools/list` | `200`，**7 个工具**（见 §9.1） |
| `tools/call newmate_memory_context` | `200`，84,372 字节；`tags=106`、`shortMemory=13`、`toolsMissing=[]` → 端到端调用链通 |

（以上实测未记录任何 token 值；本报告不含密钥、不含个人隐私。）

---

## 13. 一句话给决策者

**能做的**：在"用户已开通微信 ClawBot"的前提下，用一个本地桥进程把 iLink 长轮询接到 NewMate 的 MCP 上，就能拿到"用户发微信 → NewMate 跑一轮 → 回微信"的闭环，不碰个人号 hook、不需要公网 IP、出站还能复用现成的 `newmate_message`。

**不能承诺的**：ClawBot 还处在灰度公测、"一个微信号只能绑一只"、"不能进群/读不到历史"、iLink 是否有限速未知——这些都不是我们的代码能解决的。所以对外只能说**"在已开通微信 ClawBot 的环境里可用"**，不能说"支持微信"。

**最先该做的三件事**：① 用真实微信号验证插件权限与扫码绑定；② 标定 NewMate 一轮 run 的 P50/P95，再定回执阈值；③ 给 `newmate_chat` 加 `threadId`，否则多用户接入从第一天就是错的。
