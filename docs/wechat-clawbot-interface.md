# 微信 ClawBot 接口调研（iLink Bot API）

> 调研时间：2026-10-27 13:0x（UTC+8）。结论基于**官方 npm 包源码**（`@tencent-weixin/openclaw-weixin@2.4.10`，MIT，腾讯维护）、官方协议文档与官方新闻稿，社区二次实现与 issue 仅作旁证并单独标注。
> 证据分级：**实测/源码** > **官方文档** > **官方新闻口径** > **社区声明**。凡未验证的，本文显式写"未验证"。

---

## 1. 结论摘要

1. **"微信 ClawBot" 不是公众号/小程序那套开放平台接口**，而是腾讯 2026-03-22 上线的**个人微信号 Bot 插件**：用户在微信「我 → 设置 → 插件」启用「微信ClawBot」，再用 OpenClaw 官方 CLI 装插件、扫码绑定，即可在微信里和自己的 AI 助手（"龙虾"）私聊。
2. **底层协议叫 iLink**，是一套 **HTTPS + JSON** 的 Bot API，域名 `https://ilinkai.weixin.qq.com`，消息媒体走 `https://novac2c.cdn.weixin.qq.com/c2c`。**共 7 个 Bot 端点 + 2 个扫码端点**，全部为"长轮询 + 主动发送"形态，无 Webhook、无 WSS。
3. **鉴权是 Bearer bot_token + 一组 iLink 专有头**（`iLink-App-Id`、`iLink-App-ClientVersion`、`AuthorizationType: ilink_bot_token`、`X-WECHAT-UIN`）。token 由扫码换取，随账号落盘；失效表现为 `errcode: -14`。
4. **它是"单向消息管道"**：官方口径明确「个人专用、其他用户无法添加、**不支持群聊**、不自动化操作用户微信账号」。它不是自动化微信的工具，也不是给第三方开发者的通用开放平台。
5. **对 Newmark Agent 的含义**：协议本身足够薄，可以在 Newmark2DSH 里实现一个 iLink 渠道（约 7 个 HTTP 调用）。但**准入与风控是主要风险，不是代码量**：无公开开发者申请入口（issue #265 至今无官方回复）、云服务器/非官方运行时会触发扫码硬拦截（issue #333"运行环境存在风险"）、下行可能静默丢失（issue #264）。**建议只做实验性渠道、默认关闭**。

---

## 2. 它到底是什么（形态与准入门槛）

| 项 | 事实 | 来源 |
| --- | --- | --- |
| 上线时间 | 2026-03-22，腾讯发布微信「ClawBot」插件，支持接入 OpenClaw | 人民日报/光明网 2026-03-22 报道 |
| 用户侧开关 | 微信「我 → 设置 → 插件」启用「微信ClawBot」 | 站长之家 2026-03-23 转述官方口径 |
| 绑定方式 | 在跑 OpenClaw 的机器执行官方安装命令 → 生成二维码 → 微信扫码确认 | 官方 README 快速开始 |
| 会话形态 | **一对一私聊**；个人专用，他人无法添加；**不支持群聊** | 官方口径 + issue #42（群聊仍为 open 的功能请求） |
| 能力边界 | 单向消息传输管道，不自动化操作用户微信号 | 官方口径 |
| 官方仓库 | `github.com/Tencent/openclaw-weixin`（2026-03-27 建，调研时 981 stars / 173 forks / 193 open issues） | GitHub API |
| 官方包 | `@tencent-weixin/openclaw-weixin@2.4.10`（2026-10-11 发布，首版 1.0.0 为 2026-03-21），MIT | npm registry |
| 安装器 | `npx -y @tencent-weixin/openclaw-weixin-cli install` 或 `openclaw plugins install "@tencent-weixin/openclaw-weixin"` | 官方 README |
| 宿主耦合 | peer `openclaw >= 2026.5.12`，运行时检查 `>= 2026.3.22`，Node `>= 22.13.0` | package.json / README |

**注意**：官方包是 **OpenClaw 插件**（`openclaw.plugin.json` 声明 channel `openclaw-weixin`），不是一个独立 SDK。它的"接口"价值在于：**源码把服务端协议完整暴露出来了**（`src/api/api.ts` + `src/api/types.ts` + 官方 `docs/protocol_zh_CN.md`）。

---

## 3. 传输与鉴权

### 3.1 基址与超时

| 项 | 值 | 出处 |
| --- | --- | --- |
| API base | `https://ilinkai.weixin.qq.com`（可被服务端下发的 `baseurl` 覆盖） | `src/auth/accounts.ts:13` |
| CDN base | `https://novac2c.cdn.weixin.qq.com/c2c` | `src/auth/accounts.ts:14` |
| 普通 API 超时 | 15 s | `src/api/api.ts:213` |
| 轻量 API（getconfig/sendtyping/notify） | 10 s | `src/api/api.ts:215` |
| getUpdates 长轮询 | 默认 35 s，服务端可用 `longpolling_timeout_ms` 改 | `src/api/api.ts:211`、`monitor.ts:107-110` |
| 传输 | 普通接口 POST JSON；二维码状态轮询是 GET | 官方协议文档 |

### 3.2 请求头（每个鉴权请求）

| Header | 值 |
| --- | --- |
| `Content-Type` | `application/json` |
| `AuthorizationType` | `ilink_bot_token` |
| `Authorization` | `Bearer <bot_token>` |
| `X-WECHAT-UIN` | 随机 uint32 → 十进制字符串 → base64，**每次请求重新生成** |
| `iLink-App-Id` | 插件 `package.json` 的 `ilink_appid`，当前为 `bot` |
| `iLink-App-ClientVersion` | 版本按 `0x00MMNNPP` 编码后的十进制（如 1.0.11 → 65547） |
| `SKRouteTag` | 可选，部署侧路由标签 |

出处：`src/api/api.ts:221-254`、官方协议文档"请求头"节。
二维码状态轮询**只带** `iLink-App-Id` / `iLink-App-ClientVersion` / `SKRouteTag`，不带鉴权头。

### 3.3 `base_info`（所有 Bot 请求的公共体）

```json
{ "base_info": { "channel_version": "2.4.10", "bot_agent": "OpenClaw" } }
```

`bot_agent` 是 UA 风格的自述标识（`Name/Version (comment)`，≤256 字节），**只用于观测归因，不参与鉴权与路由**（`src/api/types.ts:9-21`、README"自定义 BotAgent"）。

---

## 4. 端点清单

### 4.1 扫码登录（2 个）

| 操作 | 方法与路径 | 说明 |
| --- | --- | --- |
| 取二维码 | `POST /ilink/bot/get_bot_qrcode?bot_type=3` | body `{ "local_token_list": [...最近10个token] }` → `{ qrcode, qrcode_img_content }` |
| 轮询状态 | `GET /ilink/bot/get_qrcode_status?qrcode=<v>` | 需要验证码时追加 `&verify_code=<v>`；长轮询 35 s |

`bot_type` 官方客户端固定用 `"3"`（`src/auth/login-qr.ts:36`）。`local_token_list` 的作用是让服务端识别"已绑定过本端"的 bot 并下发 `binded_redirect`，避免重复发会话（CHANGELOG 2.3.1）。

**状态机**（`login-qr.ts:15-24`，官方协议文档同）：

| status | 含义 |
| --- | --- |
| `wait` | 等待扫码 |
| `scaned` | 已扫码，继续验证 |
| `confirmed` | 成功，返回 `bot_token` / `ilink_bot_id` / `baseurl` / `ilink_user_id` |
| `expired` | 二维码过期 |
| `need_verifycode` | 需要输入手机上显示的验证码 |
| `verify_code_blocked` | 验证失败次数过多 |
| `scaned_but_redirect` | 按 `redirect_host` 切换基址继续轮询（IDC 调度） |
| `binded_redirect` | 已绑定到本端，**不换发凭据**，视为成功 |

### 4.2 Bot API（7 个）

| 操作 | 方法与路径 | 用途 | 关键请求字段 |
| --- | --- | --- | --- |
| `getUpdates` | `POST /ilink/bot/getupdates` | 长轮询收消息 | `get_updates_buf`（游标，首次传空串）、`base_info` |
| `sendMessage` | `POST /ilink/bot/sendmessage` | 发消息 | `msg`（见 §5） |
| `getUploadUrl` | `POST /ilink/bot/getuploadurl` | 取媒体上传参数 | `filekey`/`media_type`/`rawsize`/`rawfilemd5`/`filesize`/`aeskey` |
| `getConfig` | `POST /ilink/bot/getconfig` | 取 `typing_ticket` | `ilink_user_id`、可选 `context_token` |
| `sendTyping` | `POST /ilink/bot/sendtyping` | "正在输入" | `ilink_user_id`/`typing_ticket`/`status`(1 输入, 2 取消) |
| `notifyStart` | `POST /ilink/bot/msg/notifystart` | 上线通知 | 仅 `base_info` |
| `notifyStop` | `POST /ilink/bot/msg/notifystop` | 下线通知 | 仅 `base_info` |

`getUpdates` 响应：

```json
{ "ret": 0, "msgs": [], "get_updates_buf": "<下次游标>", "longpolling_timeout_ms": 35000 }
```

客户端行为：只有 `get_updates_buf` 非空才落盘更新（`monitor.ts:152-156`）；`sync_buf` 字段已废弃。**客户端超时被当作空响应继续轮询**，不是错误（`api.ts:475-486`）。

---

## 5. 消息模型

### 5.1 外层 `WeixinMessage`

| 字段 | 说明 |
| --- | --- |
| `seq` | 序列号 |
| `message_id` | uint64，**线上是数字，官方解析时强制转字符串以免丢精度**（`api.ts:518-577`） |
| `from_user_id` / `to_user_id` | 发送方 / 接收方（形如 `xxx@im.wechat`、`xxx@im.bot`） |
| `client_id` | 客户端生成：`openclaw-weixin:<ms>-<8位hex>`（`random.ts:8`） |
| `session_id` / `group_id` | 会话 / 群（类型里有，**官方实现未用群**） |
| `message_type` | `1`=用户，`2`=Bot |
| `message_state` | `0`=NEW，`1`=GENERATING，`2`=FINISH |
| `item_list` | 内容数组 |
| `context_token` | **回复时必须原样回传**的会话上下文令牌 |
| `run_id` | 生成/运行 id，可选 |
| `ref_msg` | 引用（含 `svr_id`、`partial_text` 局部引用） |

### 5.2 `MessageItem` 类型码

| type | 内容 |
| ---: | --- |
| 1 | `text_item.text` |
| 2 | `image_item`（`media.aes_key`、`mid_size`、`url`） |
| 3 | `voice_item`（`encode_type` 1=pcm…8=ogg-speex，`text` 可带语音转写） |
| 4 | `file_item`（`file_name`/`md5`/`len`） |
| 5 | `video_item`（`video_size` 为密文字节数） |
| 11 | `tool_call_start_item`（工具调用进度） |
| 12 | `tool_call_result_item`（工具结果进度） |

**发消息的最简请求**（`src/messaging/send.ts:56-80`）：

```json
{
  "msg": {
    "from_user_id": "",
    "to_user_id": "<对方ID>",
    "client_id": "openclaw-weixin:1761550000000-a1b2c3d4",
    "message_type": 2,
    "message_state": 2,
    "context_token": "<来自最近一条入站消息>",
    "item_list": [{ "type": 1, "text_item": { "text": "回复内容" } }]
  },
  "base_info": { "channel_version": "2.4.10", "bot_agent": "OpenClaw" }
}
```

要点：`item_list` **每次只放一个 item**；带媒体的回复会把文本与媒体**拆成两次请求**、各自一个 `client_id`（`send.ts:192-264`）。

---

## 6. 媒体 CDN 流程

上传（`src/cdn/upload.ts`、官方协议文档）：

1. 读明文，算 `rawsize` + `rawfilemd5`；
2. 生成 16 字节 AES key 与 filekey，算 **AES-128-ECB + PKCS#7** 后的密文大小 `filesize`；
3. `POST getuploadurl`（固定 `no_need_thumb: true`，当前实现不做缩略图）；
4. 把密文 `POST` 到返回的 `upload_full_url`（没有则用 `upload_param`+filekey 拼）；
5. 读响应头 `x-encrypted-param`；成功判据是 **HTTP 200 且该头非空**，其它失败最多重试 3 次、4xx 立即终止；
6. 把 `encrypt_query_param` + base64(aeskey) 写进 `image_item.media`，再 `sendMessage`。

下载：优先 `full_url`；否则 `<cdn_base>/download?encrypted_query_param=<urlencoded>`。图片优先用 `image_item.aeskey`（32 位 hex），其次 `media.aes_key`；两者都无则当明文。语音/文件/视频缺 `media.aes_key` 时当前实现**跳过不解密**。

---

## 7. 硬边界与已知坑（这部分比协议本身重要）

| 现象 | 证据 | 影响 |
| --- | --- | --- |
| **同一 `context_token` 连续回复会被拒** | issue #81：同一 token 连续发，约 10 条后 `{"ret":-2}`；无新入站消息也不恢复 | 必须"一条入站消息 → 有限条回复"，长回答要么合并要么等新消息 |
| **限速** | issue #142 日志：`ret=-2 errmsg=rate limited`，3 s 退避后仍连续失败 | 需要本地发送队列 + 间隔，不能把它当实时通道刷 |
| **token 失效 `errcode=-14`** | `session-guard.ts:6`；官方处理是**整账号暂停 1 小时**（`monitor.ts:118-127`） | 没有自动重登逻辑，需人工重新扫码 |
| **下行"成功但不可见"** | issue #264：`sendmessage` HTTP 200 / `ret:0`，客户端看不到；换绑账号即恢复 | 不能以 `ret:0` 作为投递成功；风控状态服务端不回传 |
| **扫码硬拦截** | issue #333：非官方运行环境/云服务器扫码后微信提示"此 OpenClaw 的运行环境存在风险，暂无法连接"，官方原版登录函数在同环境复现 | **自建客户端不被保证可用**，且拦截发生在手机端，API 侧只看到 `wait` |
| **无正式开发者入口** | issue #265 询问独立客户端接入的申请/白名单/主体认证，至今 open、无官方回复 | 没有"申请 API key"这条路；能力随官方插件走 |
| **不支持群聊** | 官方口径 + issue #42（open 的功能请求） | 只能私聊 |
| **Markdown 不被渲染** | `src/messaging/markdown-filter.ts`：流式剥掉不支持语法（图片整段删除、CJK 斜体标记去掉），仅代码块/行内码/表格/分隔线/加粗/纯拉丁斜体透传 | 输出要按微信纯文本排版，别指望渲染 |
| **连接有效期 24 小时**（社区声明） | 社区实现 `nlnhvfpt378/weixin-ClawBot-API` README 的"24 小时自动重连"设计 | **官方源码未体现**：官方只处理 -14 后暂停 1 h。此条记为未核实 |

---

## 8. 生态对照（旁证，非权威）

| 项目 | 形态 | 备注 |
| --- | --- | --- |
| `@tencent-weixin/openclaw-weixin` | 官方 OpenClaw 插件（TS，MIT） | 唯一权威实现；源码即协议 |
| `nlnhvfpt378/weixin-ClawBot-API` | Python/Node 独立实现 + Docker/exe | 声称"免 OpenClaw 直接接入"；只支持文本；内置 24 h 重连与 `/help` 指令 |
| `DBAAZzz/easy-weixin-clawbot` | 多账号 Web 管理平台（Node + Postgres + Docker Compose，GPL-3.0） | 含记忆/工具/技能/RSS/任务/MCP 后台，工程量大 |
| `weixin_clawbot`（pub.dev，0.5.2） | Dart 纯客户端包 | 说明协议可被任意语言复刻 |
| `@onebots/adapter-wechat-clawbot` / `wechat-clawbot-push` | 适配器 / 推送小工具 | 生态衍生 |

**判断**：协议本身不复杂（7 个端点 + 一套消息体），难度集中在**准入、风控、稳定性**，而不是实现。

---

## 9. 对 Newmark Agent / NewMate 的接入建议

三条路线，取舍如下：

| 方案 | 做法 | 优点 | 代价/风险 |
| --- | --- | --- | --- |
| A. 官方插件 + 桥接 | 装 OpenClaw + 官方插件，扫码登录，再把消息桥到 DSH | 完全走官方路径，风控最友好 | 多一个常驻运行时；版本强耦合（2.4.10 就是在修 OpenClaw 2026.10 兼容）；对 Newmark 是重依赖 |
| B. 在 Newmark2DSH 内实现 iLink 渠道 | 直接按 §3–§6 实现 7 个调用 + 消息映射 | 无额外运行时，架构干净 | **不被官方保证**：可能触发"运行环境存在风险"硬拦截；无开发者准入；下行可能静默丢失 |
| C. 社区实现做网关 | 用 Python/Node 社区项目当网关，Newmark 只对接其本地接口 | 上手快 | 继承同样风控风险 + 第三方代码质量/安全面 |

**推荐**：若要做，走 **B，但严格按实验性渠道处理**，并先满足这些硬约束：

1. **默认关闭、显式开关**；未扫码成功前不注册任何路由。
2. **一条入站消息最多回 N 条**（N≤3，低于社区实测的 10 条上限）+ 发送间隔 ≥1 s + 本地队列；`ret != 0` 一律 fail-closed，不重试刷屏。
3. **`ret:0` 不等于送达**：记录 `client_id` 与 `message_id`，把"已发送"和"已被看到"分开陈述。
4. **`errcode=-14` 当作"需人工重新扫码"**，不要静默重试；`-14` 后按官方口径暂停该账号。
5. **输出按纯文本排版**（复用 markdown 剥离的思路），长回答截断或分轮。
6. **首轮必须量三件事**再做产品判断：扫码是否被硬拦截、单条入站能回几条、连续对话多久出现 `-2`。

**不建议**：把它当稳定开放接口来做产品级 SLA；官方明确保留变更/终止权利，且这是"单向管道"，不能用来操作用户微信号。

---

## 10. 未验证 / 待确认清单

- [ ] 24 小时连接有效期：仅社区声明，官方源码未见定时重连（**未验证**）。
- [ ] `bot_type` 除 `3` 外是否还有其它取值（公众号/服务号形态）：**未验证**。
- [ ] 文本单条长度上限：官方客户端未见分片逻辑，服务端上限**未测**。
- [ ] `context_token` 的确切 TTL 与刷新规则：issue #81 提问，官方未答（**未验证**）。
- [ ] 群聊能力：类型含 `group_id`，但官方实现 groupPolicy=disabled，是否服务端已开放**未验证**。
- [ ] 自建实现的合规边界（个人非商业内测是否被允许）：issue #265 无官方回复（**未验证**）。
- [ ] 本次调研**未实际扫码调用任何接口**，全部结论来自官方源码/文档/issue；任何"能跑通"的结论都需要一次真机实测。

---

## 附：关键源码位置（官方包 2.4.10）

| 主题 | 文件:行 |
| --- | --- |
| 基址与 CDN | `src/auth/accounts.ts:13-14` |
| 请求头与 X-WECHAT-UIN | `src/api/api.ts:221-254` |
| 超时（35s/15s/10s） | `src/api/api.ts:211-215` |
| getUpdates 长轮询 | `src/api/api.ts:444-487` |
| uint64 无损解析 | `src/api/api.ts:518-577` |
| 消息类型码 | `src/api/types.ts:64-85` |
| 扫码与状态机 | `src/auth/login-qr.ts:36-158` |
| token 失效暂停 1h | `src/api/session-guard.ts:3-28` |
| 轮询重试/退避 | `src/monitor/monitor.ts:13-16, 136-147` |
| 发消息构造 | `src/messaging/send.ts:56-80, 192-264` |
| Markdown 剥离 | `src/messaging/markdown-filter.ts:1-27` |
| 入站授权（私聊 pairing / 群 disabled） | `src/messaging/authorization.ts:19-36` |
| 官方协议文档 | `docs/protocol_zh_CN.md`（仓库内） |
