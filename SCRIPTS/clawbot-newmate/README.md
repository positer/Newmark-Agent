# clawbot-newmate — 微信 ClawBot ↔ NewMate 信道

把微信当成 NewMate 的**同一条输入**：用户在微信里发的一句话，等价于在 NewMate 页面里打的一句话；
NewMate 的**最终回复只以「通知气泡的纯文字版」发回微信**。**未改动 NewMate 任何核心代码。**

## 三条硬约束，以及它们落在哪

| 约束 | 实现方式 | 证据 |
|---|---|---|
| **微信发信 = 用户发信**（含运行中"插入引导"完全一致） | 直接发页面同款请求：`POST /newmark-newmate {action:'chat', text, threadId:<页面当前活动对话>}` + 页面头 `x-newmark-newmate: 1`。同一个 `chat()` 决定 start/steer/queue | 自检 A 组：请求体、头、`threadId` 与页面一致；第二次投递时 `chat()` 返回同一 task 且 `mode:'steer'` |
| **只转发最终回复的纯文字气泡** | 按 task id 取 `messages[]` 中 `id===task.id && role==='assistant'` 的那条，取 `plain`（缺失时用 NewMate 自己的 `toPlain(text)` 兜底）。**永远不用 `text`** | 自检 A 组：发出的正文等于 `plain`、不等于渲染版；主动消息与其他线索不转发。种植变异（改成转发 `text`）→ 2 条断言变红 |
| **接收确认：确认后不再重投** | 持久账本 `bridge.json`：NewMate 回 `ok` 的那一刻把该 `message_id` 写成 `acked`；此后无论重启还是 iLink 重放，都只记"已确认接收过"，不再交给 NewMate。**确认不发微信**（不是回执消息） | 自检 B 组：服务端重放同一条 → `POST` 计数不增加；C 组：NewMate 拒绝时不算已接收、留在待投递队列、恢复后确认 |

## 用法

```sh
# 1) 先绑定微信（一次即可，跨重启保留）
node SCRIPTS/clawbot-demo/clawbot-demo.mjs login --qr-png "$TEMP/clawbot-qr.png"

# 2) 离线自检
node SCRIPTS/clawbot-newmate/bridge.mjs selftest        # 22 / 22 PASS

# 3) 跑桥
node SCRIPTS/clawbot-newmate/bridge.mjs run             # Ctrl+C 停止
node SCRIPTS/clawbot-newmate/bridge.mjs run --limit 1   # 转发一条后退出（验收用）
node SCRIPTS/clawbot-newmate/bridge.mjs status          # 账本摘要（不含正文）
```

NewMate 的端口每次重启都会变，桥会**自动发现**（显式 `--newmate-url` > 环境变量 `DSH_WEB_URL` >
回环端口并行探测 `/newmark-newmate/loop`）。发现失败时直接报错并提示用 `--newmate-url`。

## 接收确认（ack）的准确语义

`bridge.json`：

```jsonc
{
  "cursor": "…",                       // iLink 游标，和账本同一次原子写
  "ledger": { "<message_id>": { "state": "acked", "taskId": "…", "mode": "start|steer", "attempts": 1 } },
  "pending": [ { "id": "…", "text": "…", "attempts": 1, "lastAttempt": 1793 } ],
  "awaiting": { "<taskId>": { "peer": "…@im.wechat", "contextToken": "…" } },
  "sent": { "<taskId>": { "messageId": "…", "chars": 36 } }
}
```

- **顺序**：先写 `pending` → 调 NewMate → 得到 `ok` 才写 `acked` 并把游标一起推进（同一文件原子替换）。
  所以"游标前进"永远不会早于"接收确认"。
- **未确认就会重试**：NewMate 没回 ok（宕机/超时/500）→ 留在 `pending`，冷却 2 秒后重试，
  最多 2 次（`MAX_DELIVERY_ATTEMPTS`），超过标 `failed` 并明确放弃。
- **确认后永不重投**：重启、游标回退、服务端重放，都只会打印"已确认接收过"，不会再交给 NewMate。
- **确认不是回复**：整个过程不给微信发任何"已收到"。微信只会在 NewMate 产出最终回复后收到那一条纯文字气泡。
- **微信侧没有"已读"接口**：官方 7 个端点里没有标记入站消息已读的调用，所以"已读取"是桥的账本状态，不是微信里的已读回执。

## 出站为什么只可能是最终回复

桥只认自己投递时拿到的 `taskId`，按 id 取那条 assistant 消息。因此：

- 主动消息（`self_activation`）不会被转发——它没有对应的 `taskId`；
- 页面上其他轮次的回复不会被转发；
- 思考、工具调用、进度消息从来没有出现在这条通道里；
- 没有 typing 指示——按你的要求，微信侧只收到最终那一条。

## 已知边界（不夸大）

1. **崩溃窗口**：NewMate 返回 `ok` 之后、账本落盘之前进程被杀，重启后这条会**再投递一次**（最多 2 次尝试封顶）。这是"至少一次"交付的固有代价，没有给 `chat()` 加幂等键（那属于核心改动，本轮明确不做）。
2. **多微信用户**：本轮按"一个微信号 = 一个 NewMate 对话"实现（绑定本身就是一个微信号一名额）。多人会共享同一个活动对话，属于下一步。
3. **回复延迟**：受 NewMate 一轮 run 的耗时决定（历史样本 10–60 秒），桥按 1 秒轮询其 task。
4. **丢弃规则**：回复超过 15 分钟仍未出现则放弃转发并记日志（NewMate 里仍可见）。
5. **自检覆盖的是桥，不是微信**：iLink 侧的真实性由 `clawbot-demo` 的自检与真机实测覆盖。

## 文件

```
SCRIPTS/clawbot-newmate/
├── bridge.mjs   单文件（状态机 + 投递 + 回复转发 + CLI + 离线自检）
└── README.md
```

运行状态：`~/.Newmark/clawbot-newmate/bridge.json`（0600）；
微信凭据沿用 `~/.Newmark/clawbot-demo/session.json`（同一个绑定，不重复存 token）。
