/**
 * dev-0.5.6 queue-drain user-message visibility gate.
 *
 * 排队自动发送的消息必须显示在用户输入时间线。此前 enqueueSameSession 为
 * 队列项保留 clientMessageId 并把 runId 固定为入队时运行的 runId；drain 时
 * 原样传给 process，写入 chatMessages 的用户消息同时带 clientMessageId 和
 * 旧 runId，PC renderTranscript / 移动端 projectRemoteConversationItems 会把
 * 「clientMessageId + runId 命中 workRuns」的消息误判为 guide 消息而跳过气泡。
 *
 * 本测试验证 drainQueuedFollowUpMessage 的转换契约：
 * - followUp 队列消息的 clientMessageId / runId 被清除（走普通用户消息分支）；
 * - visibleUserInput / visibleMode / 文本 / 图片 / 附件保留；
 * - string 载荷原样透传；
 * - 转换后的消息不会被两端渲染过滤条件命中。
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';

function kernelSource(): string {
  return fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'core', 'conversationKernel.ts'), 'utf-8');
}

function check(condition: boolean, message: string): void {
  if (condition) console.log(`  [PASS] ${message}`);
  else console.log(`  [FAIL] ${message}`);
  assert.ok(condition, message);
}

// 提取方法体（Block），包成可执行函数。
function extractMethodBody(source: string, className: string, methodName: string): string {
  const file = ts.createSourceFile('kernel.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let body: ts.Block | undefined;
  const visit = (node: ts.Node): void => {
    if (body) return;
    if (ts.isClassDeclaration(node) && node.name?.text === className) {
      ts.forEachChild(node, (child) => {
        if (body) return;
        if (ts.isMethodDeclaration(child) && child.name.getText(file) === methodName && child.body) {
          body = child.body;
        }
      });
    }
    if (!body) ts.forEachChild(node, visit);
  };
  visit(file);
  if (!body) throw new Error(`method ${className}.${methodName} not found`);
  const bodyText = body.getText(file); // "{ ... }"
  const js = ts.transpileModule(bodyText, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return `function drainQueuedFollowUpMessage(message) ${js}`;
}

function runMethod(methodText: string, input: unknown): unknown {
  const fn = new Function('return ' + methodText + ';')();
  return fn(input);
}

// 两端渲染过滤条件的等价复刻（与代码保持同步语义）：
// PC renderTranscript: clientMessageId && runId && persistedRuns.some(runId 匹配) -> 跳过
// 移动端 projectRemoteConversationItems: clientMessageId.isNotBlank() && runId in remoteRunsById -> 跳过
function rendererSkips(message: Record<string, unknown>, knownRunIds: string[]): boolean {
  const clientMessageId = String(message.clientMessageId || '');
  const runId = String(message.runId || '');
  return clientMessageId.length > 0 && runId.length > 0 && knownRunIds.includes(runId);
}

function main(): void {
  console.log('queueDrainUserMessageVerify');
  const source = kernelSource();
  const method = extractMethodBody(source, 'ConversationKernel', 'drainQueuedFollowUpMessage');

  // 1) followUp 队列消息：clientMessageId/runId 必须被清除
  const queued = {
    text: '[Next queued while current turn is running]\nhello from queue',
    visibleUserInput: 'hello from queue',
    visibleMode: 'build',
    clientMessageId: 'queue-uuid-1',
    runId: 'old-run-1',
    goalObjective: '',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  const drained = runMethod(method, queued) as Record<string, unknown>;
  check(drained.clientMessageId === undefined, 'drain 清除 clientMessageId');
  check(drained.runId === undefined, 'drain 清除 runId');
  check(drained.text === queued.text, 'drain 保留完整 text（含前缀，供 history/continuation 匹配）');
  check(drained.visibleUserInput === 'hello from queue', 'drain 保留 visibleUserInput（去掉前缀的显示文本）');
  check(drained.visibleMode === 'build', 'drain 保留 visibleMode');

  // 2) 转换后不再被渲染端过滤条件命中
  check(
    rendererSkips(drained, ['old-run-1']) === false,
    '转换后用户消息不被 PC/移动端过滤（clientMessageId 已清除）',
  );
  check(
    rendererSkips(queued, ['old-run-1']) === true,
    '对照：未转换的队列消息会被过滤（复现原 bug）',
  );

  // 3) 图片/附件保留
  const withImages = {
    text: '[Next queued while current turn is running]\ncheck this',
    visibleUserInput: 'check this',
    visibleMode: 'plan',
    images: [{ dataUrl: 'data:image/png;base64,AAA', name: 'a.png', type: 'image/png' }],
    attachments: [{ id: 'att-1', name: 'f.txt', mimeType: 'text/plain', dataUrl: 'data:text/plain;base64,QQ==' }],
    clientMessageId: 'queue-uuid-2',
    runId: 'old-run-2',
  };
  const drainedImages = runMethod(method, withImages) as Record<string, unknown>;
  check(Array.isArray(drainedImages.images) && (drainedImages.images as unknown[]).length === 1, 'drain 保留 images');
  check(Array.isArray(drainedImages.attachments) && (drainedImages.attachments as unknown[]).length === 1, 'drain 保留 attachments');
  check(rendererSkips(drainedImages, ['old-run-2']) === false, '带图队列消息同样不被过滤');

  // 4) string 载荷原样透传
  const plain = runMethod(method, 'plain string message');
  check(plain === 'plain string message', 'string 载荷原样透传');

  // 5) 无 visibleUserInput 时 text 作为显示文本
  const noVisible = {
    text: '[Next queued while current turn is running]\nraw',
    visibleMode: 'build',
    clientMessageId: 'queue-uuid-3',
    runId: 'old-run-3',
  };
  const drainedNoVisible = runMethod(method, noVisible) as Record<string, unknown>;
  check(drainedNoVisible.visibleUserInput === undefined, '无 visibleUserInput 时不注入空字段');
  check(rendererSkips(drainedNoVisible, ['old-run-3']) === false, '无 visibleUserInput 的队列消息同样不被过滤');

  console.log('queueDrainUserMessageVerify: all checks passed');
}

main();