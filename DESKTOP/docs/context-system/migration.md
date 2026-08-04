# dev-0.3.0 迁移规划:新系统接管默认运行时 + 移除旧组件

> 本文件是"重构完成且自主连续压力测试通过后移除旧组件"决策的执行依据。
> 原则:**保留产品能力,移除被替代的重复实现**;每层迁移以"行为逐字节等价"为验收标准;每层完成后跑全量门禁再进下一层。

## 0. 决策记录(2026-08-03)

- 范围:全量迁移——新路径接管默认运行时后删除被替代的旧组件。
- Flags:保留 14 个 feature flags,默认值翻转为 true,保留逐项关闭能力;回退靠 git(旧路径代码删除后 flags=false 不再有旧实现可回退,已无意义)。
- 执行方式:现在直接执行,逐层推进、逐层回归。

## 1. 目标架构

```
运行时唯一接缝                         新实现(dev-0.3.0)
─────────────────────────────────────────────────────────────
1. systemPrompt 组装(唯一入口)    →   ContextOrchestrator.assemble(18 节,分层 hash)
   - 现状: agent.ts:6513 buildSystemPrompt() + agentKernelRunner.ts:380 手动 join
2. 工具暴露链(每轮 tool surface)  →   ToolExposurePlanner + ActiveToolsetService + CapabilityBoundary
   - 现状: agentKernelRunner.ts ToolProvisionSession(:995)/routeToolSurface(:1205)
3. LLM 请求序列化 + SSE 解析      →   ChatCompletionsAdapter / ResponsesAdapter(唯一实现)
   - 现状: llm/provider.ts 内联 openAIChatMessages/SSE 循环/responsesBody
4. Agent 运行生命周期              →   AgentRunService(持久化状态机)
   - 现状: agent.ts begin/finishConversationWorkRun(内存)
5. token 预算快照                 →   AgentContextManager.snapshot(ContextBudgetService)
   - 现状: 前端内联估算
```

## 2. 分层迁移方案(顺序 = 风险从低到高)

### 层 A:上下文组装接入 ContextOrchestrator(agent.ts + agentKernelRunner.ts)

**接线**:
- agent.ts 新增 `assembleV2Context(): AssembledContext`(或等价方法),将 `buildSystemPrompt()` 现有输出整体放入 `generalPrompt` 节;其余 17 节先置空(空节被 `filter(Boolean)` 跳过,`text === buildSystemPrompt()` 逐字节等价)。
- agentKernelRunner.ts:380 改为 `const assembled = agent.assembleV2Context(); kernel.state.systemPrompt = assembled.text;`
- systemPromptCache 缓存保留(identity 不变),orchestrator 的 hash 在内容不变时稳定。
- `AgentContextManager.snapshot(...)` 在请求构造处调用一次,快照可被前端/遥测消费(预留,不阻塞)。

**验收**:verify.js 1410 全过;systemPrompt 输出与迁移前逐字节一致(用缓存断言)。

**后续迭代(改变输出,需独立验证)**:把 buildSystemPrompt 的 parts 拆入 18 节(workspace_agent_profile/agent_role_and_permissions/linked_plan 等),toolSurfaceNotice 入 active_toolset_manifest。

### 层 B:工具暴露链接入 toolchain(agentKernelRunner.ts)

**接线**:
- 启动时用 `agent.cachedToolDefinitions()` 灌入 `ToolRegistry.register`(每个 tool 一个 descriptor,risk 来自 toolPolicy)。
- CapabilityCatalog.register:按 nativeTools 分类生成能力描述(读/写/网络/子代理等域)。
- `refreshToolSurface` 闭包改为调用 `ToolExposurePlanner.plan(...)`,输出经 `ActiveToolsetService.build(...)` 渲染 manifest 文本,注入 active_toolset_manifest 节。
- `tool_provision` 语义保留:`SchemaLoader.load(...)` 在模型请求按需加载;`toKernelTools` 只用 planner 选中的 toolIds 的 schema。
- 执行层 `executeNewmarkTool` 前加 `ToolPermissionService.authorize(...)` 校验(读类无变化,破坏性/外部类对 subagent 拒绝)。

**风险**:toolProvisioningVerify/normalChatRegressionVerify/verify 断言旧 surface 行为(INITIAL_TOOL_SCHEMA_LIMIT=8、tool_provision 名称等)。迁移时同步更新这些断言为 v2 语义,但保持"模型可见行为"等价:首轮 surface 应包含同一批工具(planner 默认选中 base toolset + 任务相关),名字不变。

### 层 C:Provider 委托新 adapters(llm/provider.ts)

**接线**:
- 新增 `providers/chat-messages.ts`:把 openAIChatMessages 的历史修复(压缩后 tool result 补全、orphan 重建)提取为共享导出函数;ChatCompletionsAdapter.serializeRequest 与 LLMProvider 都使用它(单一实现,行为不变)。
- `chatStreamWithTools` chat 分支:adapter.serializeRequest 构造 url/headers/body → 保留 LLMProvider 传输编排(fetch 失败 nodeHttp/powershell fallback、4xx Chat→Responses 降级、120s/30s 超时、content_filter)→ SSE 解析委托 adapter(execute 事件流 → StreamToken 桥)。
- adapter.execute 增加可选 `transport` 注入参数(默认全局 fetch),LLMProvider 注入 loopback/fallback 传输;4xx 状态在事件流中以 `response.failed`(错误文本含状态码)呈现,LLMProvider 检测后降级。
- responses 分支同构处理(ResponsesAdapter)。
- github_models 特判、anthropic 协议、validate/generateImage/chatStrictJson/probeStreamCompletion 等能力方法**全部保留**(新系统无等价物,不属于"被替代组件")。

**验收**:verify/intelligenceTierVerify/toolProcessVerify/normalChatRegressionVerify/modelValidationAgentIntegrationVerify/autoAgentIntegrationVerify 等 provider 相关测试全过(请求体与 StreamToken 流逐字节等价)。

**移除**:provider.ts 中被替代的内联实现(openAIChatMessages、SSE 解析循环、responsesBody、openAIHeaders 等),改为 import 共享实现。

### 层 D:AgentRunService 接入主循环(agent.ts)

**接线**:
- `beginConversationWorkRun` 内:若 flag 开启,同步 `AgentRunService.create(...)` 并持有 runId 映射;`finishConversationWorkRun` 调 `complete/fail/cancel`。
- `emitWorkEvent` 的 status 变化同步 `transition`;中断/崩溃恢复走 `recoverRunningAgentRuns`。
- 内存 ConversationWorkRun 保留为视图(与 AgentRun 双写),避免破坏 UI 契约。

**验收**:agentRuntimeV2Verify + guideWorkRunVerify + verify 全过。

### 层 E:flags 默认翻转

- `DEFAULT_CONTEXT_FEATURE_FLAGS`(context/feature-flags.ts)全 true。
- `core/config.ts` defaultContext 的 12 个 flag 默认 true。
- `normalizeContextFeatureFlags`/`featureFlagsFromConfigSections` 语义不变。

### 层 F:删除旧组件(每层迁移完成且全绿后)

| 文件 | 删除内容 | 替代 |
|---|---|---|
| llm/provider.ts | openAIChatMessages/openAIHeaders/responsesBody/responsesInput/responsesTools/SSE 循环/extractChatCompletionText/extractResponsesText/normalizeOpenAIContent(移共享) | providers/* |
| agentKernelRunner.ts | ToolProvisionSession/routeToolSurface/selectTaskToolDefinitions/refreshToolSurface 内联逻辑 | toolchain/* |
| agent.ts | buildSystemPrompt 内联拼接(改走 orchestrator) | context/* |
| 临时调试文件 | .tmp-*、debug-autowin*.cjs、temp-build-and-package.cmd 等 untracked 残留 | — |

## 3. 已知缺口与决策

- 新 adapters 无 anthropic 协议 → 保留 LLMProvider.anthropicChatWithTools(能力保留,不迁移)。
- 新 adapters 无 nodeHttp/powershell fallback → 通过 transport 注入保留。
- 新 adapters 无 content_filter 检测 → 在事件流桥接层保留检测(adapter 增加 finish_reason 检测并产出 response.failed)。
- 新 adapters 无 4xx Chat→Responses 自动降级 → LLMProvider 编排层保留。
- `createToolchainCore()` 是空壳:工具/能力注册器(registry-seeder)需要从旧定义生成,是层 B 的前置工作。

## 4. 门禁(每层完成必须全绿)

```
npm run typecheck && npm run lint
npm run build
node dist/tests/verify.js                                  (1410 断言,主回归)
node dist/tests/contextSystemV2Verify.js
node dist/tests/contextSystemV2StressVerify.js             (1461 断言)
node dist/tests/providerAdapterV2Verify.js
node dist/tests/agentRuntimeV2Verify.js
node dist/tests/toolchainExposureV2Verify.js
+ 该层直接相关的旧测试(toolProvisioningVerify/normalChatRegressionVerify/intelligenceTierVerify 等)
```

## 5. 回退

- 每层独立提交;层未完成前不翻转对应 flag(flags=false 时全部走旧路径)。
- 删除旧组件前确认该层迁移已提交;整体回退 = `git checkout` 到层提交点。
- 产品侧:flags 可逐项关闭,优先回退层 A(上下文)与层 C(Provider)。

## 6. 执行状态

| 层 | 状态 | 备注 |
|---|---|---|
| A 上下文组装 | ✅ | 等价接入,text 逐字节一致;verify.js 全绿 |
| B 工具暴露链 | ✅ | B1 registry-seeder + B2 adaptiveToolExposureV1 flag 门控;toolSurfaceV2Verify/registrySeederV2Verify 全绿 |
| C Provider | ⬜ | 前置:chat-messages 共享提取 |
| D AgentRun | ⬜ | 双写,保留内存视图 |
| E flags 翻转 | ⬜ | 各层完成后逐 flag 翻转 |
| F 删除旧组件 | ⬜ | 每层迁移后删除该层被替代实现 |

## 7. 压力测试(连续工作反馈)

Guide/Next/Goal 全连续工作反馈压力门禁(新建,每次会话相关改动后必须全绿):

```
node dist/tests/guideInsertionStressVerify.js            (40 断言)
```

覆盖高危插入位置:标准中间插入(kernel-accepted + fallback 突发 8 连发)、
开头初次响应前插入(含 receipt 幂等/过期 runId 拒绝)、Build block 收尾时插入
(完成事件同步提交 → 同一 work run 重开续跑,receipt accepted→deferred→applied)、
收尾后插入 = 下一段 build 起始(新 run)、Goal 模式自主续跑(有界、绝不抢跑用户输入)、
Next/Flow 模式 follow-up 可见队列连续排空。

> 2026-08-03 首建即全绿:verify.js 1410、contextSystemV2StressVerify 1461、
> guideInsertionStressVerify 40、toolchainExposureV2Verify、registrySeederV2Verify、
> toolSurfaceV2Verify、contextSystemV2Verify、toolProvisioningVerify 64/64、
> test:desktop:built 全链、lint 0 errors。
