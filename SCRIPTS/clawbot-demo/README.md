# clawbot-demo — 微信 ClawBot（iLink）双向探测 demo

**这是一次性探针，不是 NewMate 的渠道实现。** 它不碰 DSH 插件、不读 NewMate 状态、不改任何发布物；
它只回答一个问题：**这台机器能不能用二维码绑定一个微信 ClawBot，并且"微信 → 我们"和"我们 → 微信"
两个方向是否真的通。**

## 它证明什么 / 不证明什么

| 证明 | 不证明 |
|---|---|
| 客户端按官方 `@tencent-weixin/openclaw-weixin@2.4.10` 的协议形状发请求（头、体、游标、去重、`-14`、`ret=-2`、超时） | 微信侧一定允许第三方客户端：环境检查在手机上做，被拒时状态会一直停在 `wait` |
| 一台机器上的状态、幂等、限速保护由谁负责（协议不负责，必须自带） | 长期可用性：限速阈值、条数上限、`context_token` TTL 官方未公开 |
| 扫码 → 收到消息 → 回执 的可观测链路 | 多用户/多会话：demo 只认一个微信用户 |

## 快速开始

```sh
# 1) 离线自检（不联网、不需要微信、不需要安装任何依赖）
node SCRIPTS/clawbot-demo/clawbot-demo.mjs selftest

# 2) 绑定（会打印终端二维码，等手机扫码）
node SCRIPTS/clawbot-demo/clawbot-demo.mjs login

# 3) 收 + 自动回执（Ctrl+C 停止）
node SCRIPTS/clawbot-demo/clawbot-demo.mjs run

# 可选：额外发一次"正在输入"，并只看 3 条
node SCRIPTS/clawbot-demo/clawbot-demo.mjs run --typing --limit 3

# 可选：给上一条入站消息的发送者再发一句
node SCRIPTS/clawbot-demo/clawbot-demo.mjs send "第二条，手动发送"

node SCRIPTS/clawbot-demo/clawbot-demo.mjs status    # 只看会话摘要（不打印 token）
node SCRIPTS/clawbot-demo/clawbot-demo.mjs logout    # 删除本机会话（服务端绑定仍需在手机上解除）
```

前置条件：手机微信里要有「微信 ClawBot」插件入口（我 → 设置 → 插件）。没有这个入口说明未灰度到，
`login` 会一直停在"等待扫码"，这不是本 demo 的 bug。

## 你应当看到什么

`login`：

```
[1/2] 二维码内容（也可把下面的链接用手机打开）：
https://…
（终端二维码）
扫码路径：微信 → 我 → 设置 → 插件 → 微信 ClawBot → 扫描二维码
[2/2] 等待扫码…（二维码 8 分钟内有效）
  已扫码，正在验证…

✅ 已绑定。
   bot_id       xxxx@im.bot
   bot_token    ****cdef（已写入 …/.Newmark/clawbot-demo/session.json，仅本人可读）
```

`run`（在微信里发一句话）：

```
⬇ 收到第 1 条 14:20:31  from=****chat state=2
   id=17912345678901234567
   内容：你好
   context_token=****
⬆ 已回执 14:20:32  client_id=newmark-demo:1793… message_id=…
```

然后看手机：**微信里应当收到一条纯文本**「收到第 1 条：「你好」（clawbot-demo 双向探测回执）」。
看到这条 = 发送方向通了；看到 ⬇ 那行 = 接收方向通了。

退出时打印的报告会直接给判定：

```
=== 探测结果 ===
收到入站消息      1 条
回执成功 / 失败   1 / 0
判定              双向连通：收到了微信消息，且我们的回执也发出成功（请在微信里确认能看到回执）。
```

## 交互命令（`run` 时）

| 输入 | 作用 |
|---|---|
| `s <文本>` | 给最近的发送者发一条（需要先收到过一条消息，因为要用它的 `context_token`） |
| `t` | 发一次"正在输入" |
| `q` | 本轮结束后退出（`Ctrl+C` 立即退出） |

## 它为什么这样实现（几条硬边界，来自官方源码）

- **官方客户端没有入站去重**（`dedupe`/`seenSet` 在源码里 0 命中）→ demo 自己按 `message_id` 去重，
  并且把 id 当**字符串**保存：`message_id` 是 uint64，`JSON.parse` 会丢精度（`parseLossless()`，
  与官方 `parseWeixinApiJson` 同一手法）。
- **官方客户端没有任何节流**→ demo 一条入站只回一条，超长文本直接拒绝（不拆条刷屏）。
- **`sendmessage` 的判据是 `if (resp.ret && resp.ret !== 0) throw`** → 响应缺 `ret` 不报错，
  所以 demo 会显式提示"响应缺少 ret"，不把"没报错"当"已送达"。
- **`errcode=-14` = 整账号暂停**（官方 `pauseSession` 60 分钟，不自动重登）→ demo 立刻停手并写清原因。
- **工具进度消息默认开启、每工具事件一条**→ demo 从不发进度消息，只发最终一句。
- **长轮询超时是正常控制流**（官方把 35s 超时改写成空响应）→ demo 把超时单独计数，不算错误。

## 跨重启：登录信息、游标、去重表都留在磁盘上

`login` 的产物不是一个进程内的句柄，而是三份文件：

| 文件 | 内容 | 重启后 |
|---|---|---|
| `session.json` | `botToken` / `botId` / `baseUrl` / `ilinkUserId` / `cursor` / `lastPeer{to,contextToken}` | 新进程直接可用，**不需要重新扫码** |
| `seen.json` | 已处理过的 `message_id`（≤2000） | 重启后仍能挡住重复投递 |
| `session.json.cursor` | `get_updates_buf` 游标 | 新进程第一轮就带它，不从头上重放 |

启动 `run` 时会把恢复情况打出来：

```
恢复会话：savedAt=…，bot_id=…@im.bot，从游标 ChAIAhCW3YLilzQYxY… 继续
已去重 id：2 条（来自本地 seen.json，跨重启保留）
```

**自动测试（离线、不需要微信）**：

```sh
node SCRIPTS/clawbot-demo/cross-restart-test.mjs      # 19 / 19 PASS
```

它用假 iLink 服务端跑两个"进程"：第二个只从磁盘读状态，断言"无需重新扫码 / 首轮带旧游标 /
重启前那条被去重 / 用磁盘凭据直接发信成功"，并检查 token 只出现在 `session.json`。

**活体实测（2026-10-27 15:24–15:35）**：15:24:52 绑定 → 收 `test` 并回执 → 用户把回执原文发回；
之后**重启新进程**，日志打出"从游标 … 继续 / 已去重 2 条"，随后**不重新扫码**直接发出一句并送达
（用户回复引用该句原文），新进程也收到了用户的那条回复并写回新游标。

## 安全与状态

- 会话落在 `~/.Newmark/clawbot-demo/session.json`，`0600`；stdout 只打印掩码（`****cdef`）。
- 去重表 `seen.json` 同样在 `~/.Newmark/clawbot-demo/`，最多保留 2000 条 id。
- **`logout` 只删本机文件**：服务端绑定记录只能在手机微信里解除。

## 目录

```
SCRIPTS/clawbot-demo/
├── clawbot-demo.mjs            单文件 CLI（零运行时依赖）
├── README.md                   本文件
└── vendor/qrcode-terminal/     二维码终端渲染（Apache-2.0，见其 LICENSE，未改动）
```

## 本轮实测（2026-10-27）

| 项 | 结果 |
|---|---|
| 离线自检 | **28 / 28 PASS**（登录、游标续传、去重、超时、`ret=-2`、`-14`、请求体字段、头、幂等、长度上限、token 不外泄） |
| 种植变异（`message_type: 2` → `1`） | 27 / 28，exit 1，唯一失败项 = `sendmessage: message_type=2 / state=2`（证明自检能变红） |
| 真实 `login` 命令（未扫码） | 生产端点返回二维码并渲染成 41 列 × 17 行终端码，备用链接形如 `https://liteapp.weixin.qq.com/q/…?qrcode=<32 hex>&bot_type=3`；9 秒内 26 行输出、stderr 空、未绑定任何账号 |
| 生产端点探针（未扫码） | `get_bot_qrcode` 992 ms 返回；`qrcode` 32 字符、`qrcode_img_content` 89 字符且是 http(s) 链接；第一次 `get_qrcode_status` 长轮询到客户端 15 s 超时 → `wait`（与官方"超时按空响应"一致） |
| 真机扫码 + 双向收发 | **已连通（15:24–15:26）**：扫码 → `confirmed`；收到 `test`（19 位 uint64 id）；回执被服务端接受并分配 `message_id`；用户把回执原文发回 → 客户端可见性得到独立证明。两次 `sendmessage` 都**没有 `ret`**（缺 `ret` 不抛错，实测样本） |
