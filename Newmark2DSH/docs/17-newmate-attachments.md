# 17 — 文件进入 NewMate：页面上传与微信入站媒体（0.3.62，源码候选）

本文记录「用户把文件交给 NewMate」的契约。两条入口，一套存储，一条入站内核。

- 页面：`POST /newmark-newmate/upload`（body 就是文件字节）。
- 微信：ClawBot 频道从媒体 CDN 取回并解密一条入站媒体。

两者都落到 `<root>/newMate/uploads/<uploadId>/<name>`，都以
`chat(text, execution, threadId, attachments)` 的第四个参数交给同一次 run。

## 1. 为什么是第四个参数，而不是第二条入口

`chat()` 是唯一的入站内核（页面、MCP `newmate_chat`、微信频道都汇到它）。附件如果另开一条路，
就没有人替它决定「运行中插队 / 排队合并 / 新建任务」这三件事，而这三件事的语义已经在
`chat()` 里写好了。因此只加一个可选参数：

| 位置 | 变化 |
|---|---|
| `chat(text, execution, threadId, attachments)` | 第四参数可选，老调用完全不受影响；空文本仅在带附件时合法 |
| `sources.tasks[]` 记录 | 加 `attachments`（排队与重试不丢） |
| `sources.messages[]` 用户行 | 保留用户原话 `text`，附件另存 `attachments`（气泡与微信仍只发原话） |
| 任务 prompt | 原话 + 附件说明块（路径、字节、类型、文本片段或「内容未读取」） |

## 2. 存储（`components/newmate/lib/upload-store.js`）

| 常量 | 值 | 依据 |
|---|---|---|
| `UPLOAD_MAX_BYTES` | 20 MiB | **自设**。iLink 2.4.10 源码里没有任何附件上限；同一数字用于出站与入站，避免两个数互相矛盾 |
| `UPLOAD_MAX_PER_MESSAGE` | 8 | 一条消息要装得进 16000 字符的任务提示 |
| `UPLOAD_EXCERPT_CHARS` | 4000 | 单条任务提示里最多引用多少字 |
| `UPLOAD_READ_MAX_BYTES` / `UPLOAD_READ_MAX_LINES` | 2 MiB / 2000 行 | 读取工具的单次上限 |
| `UPLOAD_MAX_KEPT` | 200 个目录 | 保留策略（按 mtime，最新优先） |

布局 `<uploads>/<uuid>/<sanitize 后的名字>`：id 让同名文件不必改名，容器判定则落在
**解析后的父路径**上（`realpath` 后的前缀比较），因此 `../../x` 与符号链接都越不出去。

`sanitizeUploadName` 永不抛错：按最后一个分隔符（`/` 与 `\` 都算）取基名、去掉控制字符、
把 Windows 非法字符换成 `_`、去掉结尾的 `.` 与空格、超长时保留扩展名。

## 3. 任务提示里的附件块

格式（每次 run 都重新生成，因为任务记录才是权威）：

```text
用户随这条消息给了 1 个文件（已保存在本机，路径真实存在，不是你编造的）：
1. design.md — text，1.4 KB（1450 字节）
   路径：C:\Users\…\newMate\uploads\<id>\design.md
   内容（只引用前 4000 字，其余未提供）：
   <<<
   …
   >>>
   需要更多内容时用 newmate_attachment_read 按行读取这个路径（offset/limit）。
```

- 文本（按扩展名白名单 + 是否含 `\0` 判定）才引用片段；预算 = `15000 - 原话长度 - 240×附件数`，
  多附件时平均分。预算为 0 时明说「内容未引用」而不是给一个空片段。
- 非文本（图片 / PDF / Office / 压缩包 / 音频 / 视频）**一律写「内容未读取」**，并说明只能按名称与
  字节数转述。这是本功能唯一不可越过的诚实边界：本机不解码这些格式，模型也不许假装看过。
- 整条任务提示仍受 16000 字符上限约束；装不下时先缩片段，再放弃片段，仍装不下则拒绝这条消息。

## 4. `newmate_attachment_read`（能读到什么）

| 项 | 规则 |
|---|---|
| 权限 | 只读 `<root>/newMate/uploads/**`；解析后的真实路径不在其中一律 `file_not_in_upload_store` |
| 参数 | `path`（必填）、`offset`（1 基）、`limit`（≤2000，默认 500） |
| 返回 | `{ok, path, fileName, bytes, text, offset, lines, truncatedBy, more}` |
| 拒绝码 | `path_required` / `file_not_found` / `file_unreadable` / `file_not_in_upload_store` / `not_a_regular_file` / `file_not_text` |

它进 `NEWMATE_RUN_TOOLS`（NewMate 自己那一轮拿得到），**不进** `NEWMATE_REQUEST_TOOLS`：
它读不到用户没给过的东西，所以不必算作「必须用户明确要求」的外部动作。

## 5. 微信入站媒体（协议出处：`@tencent-weixin/openclaw-weixin@2.4.10`）

| 事实 | 出处 |
|---|---|
| 条目类型 TEXT 1 / IMAGE 2 / VOICE 3 / FILE 4 / VIDEO 5 | `src/api/types.ts` `MessageItemType` |
| 一条消息最多下载一个媒体，优先级 image > video > file > voice | `src/messaging/process-message.ts` |
| 下载**没有** getmedia 接口；CDN GET `{cdn}/download?encrypted_query_param=…`，有 `full_url` 就用它 | `src/cdn/cdn-url.ts` |
| 字节是 AES-128-ECB + PKCS#7（无 IV） | `src/cdn/aes-ecb.ts` |
| `media.aes_key` 是 base64，可能是 16 原始字节**或**32 位 hex 的 ASCII；`image_item.aeskey` 是裸 32 位 hex 且优先 | `src/cdn/pic-decrypt.ts`、`src/media/media-download.ts` |
| 加密类型 `encrypt_type` 在收发两侧都没有被读，不作为解密开关 | 全仓 grep 仅 `send.ts` 写入 |
| 语音：服务端给转写 `voice_item.text` 时不下载；SILK 解码依赖 `silk-wasm`（只在 devDependencies） | `src/media/media-download.ts`、`src/media/silk-transcode.ts` |

实现：`wechat-ilink.js` 增 `decryptAesEcb` / `parseAesKey` / `cdnDownloadUrl` / `downloadMedia`；
`wechat-channel.js` 的 `queue()` 认媒体、`drain()` 先取回再交 `chat()`。

| 情形 | 行为 |
|---|---|
| 文件（type 4） | 用 `file_item.file_name` 作名字，`len` 只作为记录（官方不校验，本实现只记进回执） |
| 图片（type 2） | 无名字：按**字节魔数**嗅探扩展名（jpg/png/gif/webp/bmp，否则 .img）；无密钥按明文保存（官方同样如此） |
| 视频（type 5） | 名字 `video.mp4`（官方硬编码 `video/mp4`） |
| 语音（type 3） | 有服务端转写→当文本；没有→计入 `voiceUnsupported`，不下载（本机无 SILK 解码器） |
| 取回失败 | 重试到 `MAX_DELIVERY_ATTEMPTS`(2) 后，把「本机没能取回：<名字>；原因：<码>」**交回 NewMate**，由它如实告诉用户；回执记 `mediaFailure` |

## 6. 错误码（页面/频道共用）

`file_empty` / `file_too_large` / `file_size_invalid` / `file_write_failed` / `file_bytes_required` /
`file_not_found` / `file_unreadable` / `file_not_in_upload_store` / `not_a_regular_file` / `file_not_text` /
`path_required` /（入站）`media_reference_missing` / `cdn_download_failed` / `cdn_download_timeout` /
`media_too_large` / `media_empty` / `aes_key_missing` / `aes_key_invalid` / `media_decrypt_failed`。

## 7. 门禁

```text
node scripts/verify-newmate-attachment.mjs    # 87 PASS
node scripts/verify-newmate-wechat-channel.mjs # 118 PASS（既有，未回退）
```

`verify-newmate-attachment` 分五段：存储（含容器判定与保留）、`chat()`（提示块/落库/排队合并/预算）、
频道（假 iLink + 假媒体 CDN，服务端真发 AES 密文）、真实挂载行（注册表 + 字节路由 + 读取工具）、
页面与行源码断言。变异证明：把 `resolveUploadPath` 的容器判定改成恒假，恰好两条容器断言变红
（`reader: 拒绝读上传目录之外的文件`、`tool: 上传目录之外一律拒绝`），其余 85 条仍绿。

## 8. 未验证 / 边界

- **未打包、未安装、未重启**：运行中的 0.3.61 还没有这些能力；要在页面上真的点「上传文件」必须装 0.3.62 并重启。
- **没有真机微信发文件的样本**：解密路径由官方源码 + 假 CDN 回环证明（服务端真发密文），但「用户的手机发来的真实文件」本轮没有测。
- 图片没有送进模型：NewMate 的 run 走 `agent_api_send`，图片块要求授权模型具备已核验的图片输入能力；当前 deepseek-chat 不具备，因此图片只存不读（提示词如实说明）。
- 未做文档解析（PDF / DOCX / XLSX）与 OCR：这是刻意的边界，不是遗漏。
- 入站 `md5` / `len` 不做完整性校验（官方也不校验）；`len` 只在回执里记录。
- 保留策略只按目录数（200）裁剪，没有总字节配额。
- MCP 的 `newmate_chat` 仍只接受文本：它没有字节入口，加上 `attachments` 会让外部客户端能指名本机任意路径。
