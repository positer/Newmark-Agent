# Newmark 移动端接口适配文档（PC 端接口冻结版）

> 版本：`dev-0.4.6`
> 状态：PC 端接口已冻结。移动端按本文档适配，PC 端不再变更既有路径、字段、状态码。

---

## 1. 总览

移动端与 PC 端通过**同一内网（含 Tailscale 网络）** 通信，只要移动端能触及 PC 端端口即可；PC 端提供 HTTP + SSE 两种通道：

| 通道 | 用途 |
| --- | --- |
| HTTP REST | 配对、状态读取、对话列表、对话历史、发送消息 |
| SSE | 实时接收 PC 端工作事件（Agent Work Event） |

PC 端服务基址：

```text
http://<tailscale-ip>:47890
```

`<tailscale-ip>` 通过 PC 端二维码或 `hello` 接口获取。

---

## 2. 前置条件

1. PC 端已安装并启动 Newmark。
2. PC 端与移动端处于同一内网（或同一 Tailscale tailnet），移动端能访问 PC 端端口。
3. PC 端 `remote.touch_enabled` 开关为开（默认开）。
4. 移动端持有配对 token（来自二维码）。

---

## 3. 认证

所有 `/api/mobile/*` 接口与 SSE 都需要认证，二选一：

### 方式 A：HTTP Header（推荐）

```http
Authorization: Bearer <token>
```

### 方式 B：Query 参数（SSE EventSource 使用）

```text
/api/mobile/events?token=<token>
```

> 移动端在普通 HTTP 请求中优先使用 Header；SSE 因浏览器 `EventSource` 不支持自定义 Header，使用 Query。

未认证响应：

```http
401 Unauthorized
```

```json
{ "error": "Unauthorized" }
```

远程开关关闭响应：

```http
403 Forbidden
```

```json
{ "error": "Remote touch disabled" }
```

---

## 4. 配对流程

### 4.1 PC 端生成二维码

PC 端二维码内容是一个 URL，形如：

```text
newmark-pair://100.64.0.7:47890?token=<token>&host=PC-HOSTNAME&port=47890&pairingId=<id>&issuedAt=<ms>&expiresAt=<ms>
```

移动端扫码后解析字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `token` | string | 配对 token，后续所有请求认证使用 |
| `host` | string | PC 主机名（展示用） |
| `port` | number | 端口，固定 `47890` |
| `pairingId` | string | 本次配对窗口 ID |
| `issuedAt` | number | 窗口开始时间（epoch ms） |
| `expiresAt` | number | 窗口结束时间（epoch ms） |

### 4.2 移动端绑定握手

扫码后调用：

```http
POST /api/mobile/pair-confirm?pairingId=<pairingId>
Authorization: Bearer <token>
```

成功：

```http
200 OK
```

```json
{
  "ok": true,
  "status": {
    "pairingId": "<pairingId>",
    "issuedAt": 1750000000000,
    "expiresAt": 1750000120000,
    "confirmed": true,
    "confirmedAt": 1750000050000,
    "active": false,
    "expired": false
  }
}
```

失败：

```http
401 Unauthorized
```

```json
{
  "ok": false,
  "error": "Pairing window expired.",
  "status": { "...": "..." }
}
```

### 4.3 查询配对状态

```http
GET /api/mobile/pair-status
Authorization: Bearer <token>
```

响应：

```json
{
  "ok": true,
  "status": {
    "pairingId": "...",
    "issuedAt": 0,
    "expiresAt": 0,
    "confirmed": false,
    "confirmedAt": 0,
    "active": true,
    "expired": false
  }
}
```

移动端建议：
- `confirmed === true` 表示绑定成功。
- `expired === true` 表示二维码过期，需要 PC 端重新生成。
- 绑定成功后**持久化保存 token**，后续不再重复配对。

---

## 5. HTTP 接口详情

以下均需 `Authorization: Bearer <token>`。

### 5.1 GET /api/mobile/hello

用途：首次连接 / 健康检查 / 获取 PC 端信息。

响应：

```json
{
  "ok": true,
  "version": "0.4.6",
  "hostname": "Push_Air",
  "platform": "win32",
  "tailscaleIpv4": "100.64.0.7",
  "lanIpv4": "192.168.1.20",
  "workspace": {
    "id": "workspace-...",
    "name": "2026-08-16_1344",
    "path": "C:\\Users\\...\\Work\\2026-08-16_1344"
  },
  "conversationCount": 3,
  "activeConversationId": "default"
}
```

说明：
- `workspace` 可能为 `null`。
- `tailscaleIpv4` 未检测到时为 `null`。
- `lanIpv4` 为 PC 端同一内网 IPv4，未检测到时为 `null`；客户端优先用二维码中的 `host` 连接。

### 5.2 GET /api/mobile/state

用途：获取当前 PC 端运行态与当前对话最近消息窗口。

响应：

```json
{
  "mode": "build",
  "model": "auto",
  "status": "idle",
  "activeConversationId": "default",
  "conversations": [],
  "workspaces": {
    "internal": [],
    "external": [],
    "current": {}
  },
  "pendingOptions": [],
  "contextWindow": {
    "estimatedTokens": 0,
    "maxTokens": 1,
    "ratio": 0,
    "warning": "ok",
    "model": "auto"
  },
  "chatMessages": [],
  "totalMessages": 0,
  "conversationLocked": false
}
```

用途：
- 轮询 PC 端当前状态。
- 获取当前对话消息窗口。
- 获取待处理选项 `pendingOptions`。

### 5.3 GET /api/mobile/conversations

用途：获取对话摘要列表。

响应：

```json
[
  {
    "id": "default",
    "key": "internal-...::conversation:default",
    "title": "New conversation",
    "messageCount": 12,
    "historyCount": 30,
    "updatedAt": "2026-08-16T13:00:00.000Z",
    "pinned": false,
    "pinnedAt": "",
    "order": 0,
    "branchCommunication": false
  }
]
```

字段说明：
- `id`：对话 ID，后续拉历史/发送时作为 `conversationId`。
- `title`：展示标题。
- `messageCount` / `historyCount`：消息/历史计数。
- `pinned`：是否置顶。

### 5.4 GET /api/mobile/conversation

用途：分页读取指定对话消息。

请求参数：

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `conversationId` | string | 否 | 目标对话 ID，缺省为 PC 当前活动对话 |
| `window` | number | 否 | 返回最近 N 条消息，默认 `200`，最大 `500` |
| `before` | number | 否 | 分页锚点：返回 `before` 之前的 `window` 条，缺省为最新 |

示例：

```http
GET /api/mobile/conversation?conversationId=default&window=50&before=120
```

响应：

```json
{
  "conversationId": "default",
  "conversations": [],
  "conversationPlan": { "items": [] },
  "linkedPlan": { "markdown": "", "revision": 0 },
  "subagents": [],
  "chatMessages": [
    {
      "role": "user",
      "content": "hello",
      "messageId": "...",
      "timestamp": "2026-08-16T13:00:00.000Z"
    }
  ],
  "totalMessages": 120,
  "windowStart": 70,
  "historyMessages": 0,
  "workRuns": [],
  "continuations": [],
  "modelSelection": null,
  "flowSelection": null,
  "inputMode": "guide",
  "mode": "build",
  "goal": null,
  "branches": null
}
```

移动端分页策略：
- 首次加载：`window=50`（不传 `before`）。
- 上拉加载更早：取当前 `windowStart` 作为下一次的 `before`。
- 当 `windowStart === 0` 表示已到最早消息。

### 5.5 GET /api/mobile/workspaces

用途：获取工作区列表。

响应：

```json
{
  "internal": [],
  "external": [],
  "current": {}
}
```

### 5.6 POST /api/mobile/send

用途：向指定对话发送消息，并获取 PC 端回复。

请求：

```http
POST /api/mobile/send
Authorization: Bearer <token>
Content-Type: application/json
```

```json
{
  "conversationId": "default",
  "message": "你好"
}
```

说明：
- `conversationId` 可选，缺省使用 PC 当前活动对话。
- 调用会切换到该对话，PC 端界面也会同步到该对话。

响应：

```json
{
  "ok": true,
  "conversationId": "default",
  "response": "你好，我是 Newmark。",
  "tokens": [
    { "type": "text", "text": "你好，我是 Newmark。" }
  ],
  "options": [],
  "status": "idle",
  "conversations": [],
  "chatMessages": [],
  "totalMessages": 13
}
```

错误：
- 空 `message`：`400 {"error":"No message"}`。
- 远程关闭：`403 {"error":"Remote touch disabled"}`。
- 未认证：`401 {"error":"Unauthorized"}`。

> `send` 是同步请求，会等待 PC 端完整回复。移动端可在请求期间显示"运行中"状态；若需要流式输出，配合 SSE 监听 work 事件。

---

## 6. SSE 实时事件

端点：

```text
GET /api/mobile/events?token=<token>
Accept: text/event-stream
```

连接成功首帧：

```text
retry: 3000
```

心跳（每 15 秒）：

```text
: ping
```

工作事件：

```text
event: work
data: { ...AgentWorkEvent... }
```

移动端建议：
- 使用 `EventSource`（Web）或原生 SSE 客户端。
- 连接断开后按 `retry`（3 秒）自动重连。
- 收到 `event: work` 时，根据事件类型刷新 UI 或请求 `/api/mobile/state`。
- 保持 SSE 常连接，同时用 HTTP 轮询作为兜底。

---

## 7. 错误处理

所有移动端接口错误统一为：

```json
{ "error": "错误信息" }
```

常见状态码：

| 状态码 | 含义 | 处理 |
| --- | --- | --- |
| 400 | 参数错误（如空 message） | 修正参数重试 |
| 401 | 未认证 / 配对失败 | 重新扫码配对 |
| 403 | 远程触及已关闭 | 提示用户在 PC 端开启 |
| 404 | 未知接口 | 检查基址/路径 |
| 500 | PC 端处理异常 | 稍后重试 |

---

## 8. 完整生命周期示例

```text
1. 移动端扫码
   → 解析 newmark-pair URL
   → 保存 token / host / port / pairingId

2. 绑定握手
   → POST /api/mobile/pair-confirm?pairingId=<pairingId>
   → 200 后标记已绑定

3. 建立实时连接
   → GET /api/mobile/events?token=<token>

4. 拉取初始状态
   → GET /api/mobile/hello
   → GET /api/mobile/state
   → GET /api/mobile/conversations

5. 打开对话
   → GET /api/mobile/conversation?conversationId=<id>&window=50

6. 发送消息
   → POST /api/mobile/send {"conversationId":"<id>","message":"..."}
   → 同时 SSE 可能收到 work 事件

7. 后台恢复
   → 重新连接 SSE
   → GET /api/mobile/state 拉最新状态
```

---

## 9. 兼容承诺（冻结）

- 既有 `/api/mobile/*` 路径不删除、不改名。
- 既有响应字段不删除、不改类型；可新增字段。
- 认证方式保持 `Bearer` 与 `?token=` 双通道。
- SSE 事件名 `work` 与心跳格式保持。
- 若未来需要破坏性变更，必须新增 `/api/mobile/v2/*`，旧接口继续保留。

---

## 10. 移动端适配注意事项

1. **保存 token**：绑定成功后持久化保存，后续启动复用，不要每次重新扫码。
2. **保存基址**：保存二维码中的 `host` 与端口；如果 PC 端内网/Tailscale IP 变化，需要重新扫码或手动更新。
3. **后台限制**：移动端进入后台可能被系统暂停 SSE，恢复后应主动重连并拉取 `/api/mobile/state`。
4. **超时控制**：`send` 可能耗时较长（取决于模型），建议设置合理请求超时（如 120s）并允许用户取消。
5. **分页加载**：历史消息使用 `before=windowStart` 向前翻页，直到 `windowStart===0`。
6. **token 安全**：token 等同连接凭据，不要打印到日志或上传。
