import * as assertStrict from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConfigManager } from '../core/config';
import { ensureMobileToken } from '../core/mobilePairing';
import { WorkspaceInfo, WorkspaceManager } from '../core/workspace';

type VerifyAssert = (condition: boolean, name: string, detail?: string) => void;

interface JsonResponse {
  status: number;
  body: Record<string, any>;
}

const SHARED_ID = 'shared-mobile-conversation';
const A_ONLY_ID = 'workspace-a-only';
const B_ONLY_ID = 'workspace-b-only';
const A_SECRET = 'A_WORKSPACE_PRIVATE_MESSAGE';
const B_SECRET = 'B_WORKSPACE_PRIVATE_MESSAGE';
const B_DUPLICATE_ID = 'workspace-b-duplicate-content';
const B_ARCHIVE_ID = 'workspace-b-archive-context';
const B_SCOPED_SEND_ID = 'workspace-b-scoped-send';
const FOREGROUND_GOAL = 'FOREGROUND_GOAL_MUST_NOT_LEAK';
const BACKGROUND_GOAL = 'BACKGROUND_ARCHIVE_GOAL';

function workspacePrefix(workspace: WorkspaceInfo): string {
  const supplied = String(workspace.conversationStatePrefix || '').trim();
  if (/^(?:internal|external)-[a-f0-9]{16}$/i.test(supplied)) return supplied.toLowerCase();
  const kind = workspace.isInternal ? 'internal' : 'external';
  const hash = createHash('sha256').update(path.resolve(workspace.path).toLowerCase()).digest('hex').slice(0, 16);
  return `${kind}-${hash}`;
}

function conversationEntry(title: string, message: string, order: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title,
    chatMessages: [{ role: 'user', content: message, timestamp: '2026-08-17T00:00:00.000Z' }],
    history: [],
    plan: { items: [] },
    linkedPlan: { markdown: '', revision: 0 },
    workRuns: [],
    continuations: [],
    inputMode: 'guide',
    mode: 'build',
    goal: null,
    updatedAt: '2026-08-17T00:00:00.000Z',
    pinned: false,
    pinnedAt: '',
    order,
    branchCommunication: false,
    ...overrides,
  };
}

function writeWorkspaceConversationState(
  workspace: WorkspaceInfo,
  entries: Array<{ id: string; title: string; message: string; overrides?: Record<string, unknown> }>,
): void {
  const prefix = workspacePrefix(workspace);
  const conversations = Object.fromEntries(entries.map((entry, index) => [
    `${prefix}-${entry.id}`,
    conversationEntry(entry.title, entry.message, index, entry.overrides),
  ]));
  const directory = path.join(workspace.path, 'conversations');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'state.json'), JSON.stringify({
    version: 3,
    activeConversationId: SHARED_ID,
    conversations,
  }, null, 2), 'utf-8');
}

function setupRoot(): { root: string; workspaceA: WorkspaceInfo; workspaceB: WorkspaceInfo; token: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-mobile-workspace-api-'));
  fs.mkdirSync(path.join(root, 'Work'), { recursive: true });
  fs.writeFileSync(path.join(root, 'PC_Hash.config'), 'mobile-api-test-pc|test|x64', 'utf-8');
  const config = new ConfigManager(root);
  config.set('workspace', 'auto_create_timestamp_workspace', false);
  config.set('remote', 'touch_enabled', true);
  config.save();
  const workspaces = new WorkspaceManager(root, config);
  const workspaceA = workspaces.createInternal('mobile-api-a');
  const workspaceB = workspaces.createInternal('mobile-api-b');
  if (!workspaceA.id || !workspaceB.id) throw new Error('Workspace test identities were not created');
  workspaces.select(workspaceA.id);
  writeWorkspaceConversationState(workspaceA, [
    { id: SHARED_ID, title: 'A shared title', message: A_SECRET, overrides: {
      inputMode: 'next',
      mode: 'goal',
      modelSelection: { kind: 'deployment', providerId: 'foreground-provider', modelId: 'foreground-model' },
      goal: { objective: FOREGROUND_GOAL, changes: [], goalRounds: 1, verified: false, paused: false },
    } },
    { id: A_ONLY_ID, title: 'A only title', message: 'A_ONLY_MESSAGE' },
  ]);
  writeWorkspaceConversationState(workspaceB, [
    { id: SHARED_ID, title: 'B shared title', message: B_SECRET, overrides: {
      inputMode: 'guide',
      mode: 'plan',
      modelSelection: { kind: 'deployment', providerId: 'background-provider', modelId: 'background-model' },
      plan: { items: [{ id: 'b-plan-1', text: 'Background plan item', status: 'pending' }] },
      linkedPlan: { markdown: '# Background linked plan', revision: 7 },
    } },
    { id: B_ONLY_ID, title: 'B only title', message: 'B_ONLY_MESSAGE' },
    { id: B_DUPLICATE_ID, title: 'B duplicate hidden row', message: 'B_ONLY_MESSAGE' },
    { id: B_ARCHIVE_ID, title: 'B archive context', message: 'B_ARCHIVE_PRIVATE_MESSAGE', overrides: {
      inputMode: 'guide',
      mode: 'goal',
      modelSelection: { kind: 'deployment', providerId: 'background-provider', modelId: 'background-archive-model' },
      goal: { objective: BACKGROUND_GOAL, changes: [], goalRounds: 2, verified: false, paused: true },
    } },
    { id: B_SCOPED_SEND_ID, title: 'B scoped send', message: 'B_SCOPED_INITIAL_MESSAGE' },
  ]);
  fs.mkdirSync(path.join(workspaceB.path, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspaceB.path, 'README.md'), '# mobile editor fixture\n', 'utf-8');
  fs.writeFileSync(path.join(workspaceB.path, 'src', 'nested.txt'), 'nested fixture\n', 'utf-8');
  fs.writeFileSync(path.join(workspaceB.path, 'binary.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(path.join(workspaceB.path, 'oversized.txt'), Buffer.alloc(1024 * 1024 + 1, 0x61));
  return { root, workspaceA, workspaceB, token: ensureMobileToken(root) };
}

function requestJson(port: number, token: string, method: 'GET' | 'POST', endpoint: string, payload?: Record<string, unknown>): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, `http://127.0.0.1:${port}`);
    url.searchParams.set('token', token);
    const body = payload ? JSON.stringify(payload) : '';
    const request = http.request(url, {
      method,
      headers: body ? {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
      } : undefined,
    }, response => {
      let text = '';
      response.setEncoding('utf-8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        let parsed: Record<string, any> = {};
        try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
        resolve({ status: response.statusCode || 0, body: parsed });
      });
    });
    request.setTimeout(5_000, () => request.destroy(new Error(`Mobile API request timed out: ${method} ${url.pathname}`)));
    request.once('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(error => {
        if (error) reject(error);
        else if (!port) reject(new Error('Unable to allocate an isolated mobile API test port'));
        else resolve(port);
      });
    });
  });
}

async function waitForServer(child: ChildProcess, port: number, token: string, output: () => string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Mobile server exited before readiness (${child.exitCode}):\n${output()}`);
    try {
      const response = await requestJson(port, token, 'GET', '/api/mobile/hello');
      if (response.status === 200) return;
    } catch {
      // Server startup is asynchronous; retry until the bounded deadline.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Mobile server did not become ready:\n${output()}`);
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  child.kill();
  await Promise.race([
    exited,
    new Promise<void>(resolve => setTimeout(resolve, 3_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

function rows(response: JsonResponse): Array<Record<string, any>> {
  return Array.isArray(response.body.conversations) ? response.body.conversations : [];
}

function rowById(response: JsonResponse, id: string): Record<string, any> | undefined {
  return rows(response).find(item => String(item.id || '') === id);
}

async function getWorkspaceRows(port: number, token: string, workspace: WorkspaceInfo): Promise<JsonResponse> {
  return requestJson(port, token, 'GET', `/api/mobile/workspace-conversations?workspaceId=${encodeURIComponent(String(workspace.id || ''))}`);
}

function collectMobileWorkEvents(port: number, token: string): {
  events: Array<Record<string, any>>;
  ready: Promise<void>;
  close: () => void;
} {
  const events: Array<Record<string, any>> = [];
  let request: http.ClientRequest | null = null;
  const ready = new Promise<void>((resolve, reject) => {
    const url = new URL('/api/mobile/events', `http://127.0.0.1:${port}`);
    url.searchParams.set('token', token);
    request = http.get(url, response => {
      response.setEncoding('utf-8');
      let buffer = '';
      response.on('data', chunk => {
        buffer += String(chunk);
        const frames = buffer.split('\n\n');
        buffer = frames.pop() || '';
        for (const frame of frames) {
          const data = frame.split(/\r?\n/).find(line => line.startsWith('data: '));
          if (!data) continue;
          try { events.push(JSON.parse(data.slice('data: '.length))); } catch {}
        }
        resolve();
      });
    });
    request.setTimeout(5_000, () => request?.destroy(new Error('Mobile SSE readiness timed out')));
    request.once('error', reject);
  });
  return { events, ready, close: () => request?.destroy() };
}

async function waitUntil(predicate: () => boolean, message: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

export async function verifyMobileWorkspaceApi(record: VerifyAssert): Promise<void> {
  const port = await findAvailablePort();
  const fixture = setupRoot();
  const serverModule = path.join(__dirname, '..', 'server.js');
  const childBootstrap = [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const Module = require('node:module');",
    `const filename = ${JSON.stringify(serverModule)};`,
    `const root = ${JSON.stringify(fixture.root)};`,
    `const port = ${port};`,
    "const { Agent } = require(path.join(path.dirname(filename), 'core', 'agent.js'));",
    "Agent.prototype.process = async function(input) {",
    "  const message = typeof input === 'string' ? input : String(input.text || '');",
    "  this.status = 'working';",
    "  this.chatMessages.push({ messageId: 'mock-user-' + Date.now(), role: 'user', content: message, mode: this.modeName(), model: this.model, timestamp: this.nowLabel() });",
    "  this.history.push({ role: 'user', content: message });",
    "  this.saveWorkspaceConversationState(true);",
    "  this.emitWorkEvent({ type: 'start', content: 'Mock scoped request started.' });",
    "  await new Promise(resolve => setTimeout(resolve, 250));",
    "  const reply = 'MOCK_SCOPED_RESPONSE:' + message;",
    "  this.chatMessages.push({ messageId: 'mock-assistant-' + Date.now(), role: 'assistant', content: reply, mode: this.modeName(), model: this.model, timestamp: this.nowLabel() });",
    "  this.history.push({ role: 'assistant', content: reply });",
    "  this.status = 'idle';",
    "  this.saveWorkspaceConversationState(true);",
    "  this.emitWorkEvent({ type: 'done', content: 'Mock scoped request completed.' });",
    "  return [{ type: 'text', text: reply }];",
    "};",
    "let source = fs.readFileSync(filename, 'utf-8');",
    "source = source.replace('const PORT = 47890;', 'const PORT = ' + port + ';');",
    "if (!source.includes('const PORT = ' + port + ';')) throw new Error('Mobile server port seam was not found');",
    "const target = new Module(filename, module);",
    "target.filename = filename;",
    "target.paths = Module._nodeModulePaths(path.dirname(filename));",
    "target._compile(source, filename);",
    "target.exports.runServer(root);",
  ].join('\n');
  let output = '';
  const child = spawn(process.execPath, ['-e', childBootstrap], {
    cwd: path.join(__dirname, '..', '..'),
    env: { ...process.env, NEWMARK_BIND_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', chunk => { output += String(chunk); });
  child.stderr.on('data', chunk => { output += String(chunk); });

  try {
    await waitForServer(child, port, fixture.token, () => output);
    const workspaceAId = String(fixture.workspaceA.id || '');
    const workspaceBId = String(fixture.workspaceB.id || '');

    const snapshotB = await requestJson(
      port,
      fixture.token,
      'GET',
      `/api/mobile/conversation?workspaceId=${encodeURIComponent(workspaceBId)}&conversationId=${encodeURIComponent(SHARED_ID)}`,
    );
    const snapshotText = JSON.stringify(snapshotB.body.chatMessages || []);
    record(snapshotB.status === 200 && snapshotText.includes(B_SECRET) && !snapshotText.includes(A_SECRET),
      'mobile workspace snapshot: same conversation id reads the requested workspace without leaking the foreground workspace',
      JSON.stringify(snapshotB.body));
    record(snapshotB.body.inputMode === 'guide'
      && snapshotB.body.mode === 'plan'
      && snapshotB.body.modelSelection?.modelId === 'background-model'
      && snapshotB.body.goal == null,
    'mobile workspace snapshot: background input mode, model, mode, and goal come only from the requested conversation',
    JSON.stringify(snapshotB.body));

    const rightState = await requestJson(
      port,
      fixture.token,
      'GET',
      `/api/mobile/right-sidebar-state?workspaceId=${encodeURIComponent(workspaceBId)}&conversationId=${encodeURIComponent(SHARED_ID)}`,
    );
    record(rightState.status === 200
      && rightState.body.workspace?.id === workspaceBId
      && rightState.body.conversationId === SHARED_ID
      && rightState.body.conversationPlan?.items?.[0]?.text === 'Background plan item'
      && rightState.body.linkedPlan?.markdown === '# Background linked plan'
      && rightState.body.linkedPlan?.revision === 7,
    'mobile right sidebar: exact workspace conversation exposes conversation plan and linked plan',
    JSON.stringify(rightState.body));

    const crossRightState = await requestJson(
      port,
      fixture.token,
      'GET',
      `/api/mobile/right-sidebar-state?workspaceId=${encodeURIComponent(workspaceAId)}&conversationId=${encodeURIComponent(B_ONLY_ID)}`,
    );
    record(crossRightState.status === 404,
      'mobile right sidebar: cross-workspace conversation access fails closed',
      JSON.stringify(crossRightState.body));

    const rootFiles = await requestJson(port, fixture.token, 'GET',
      `/api/mobile/workspace-files?workspaceId=${encodeURIComponent(workspaceBId)}&path=`);
    record(rootFiles.status === 200
      && rootFiles.body.path === ''
      && rootFiles.body.entries?.some((entry: Record<string, unknown>) => entry.name === 'src' && entry.directory === true)
      && rootFiles.body.entries?.some((entry: Record<string, unknown>) => entry.name === 'README.md' && entry.directory === false),
    'mobile workspace files: root directory lists real folders and files',
    JSON.stringify(rootFiles.body));

    const nestedFiles = await requestJson(port, fixture.token, 'GET',
      `/api/mobile/workspace-files?workspaceId=${encodeURIComponent(workspaceBId)}&path=src`);
    record(nestedFiles.status === 200 && nestedFiles.body.path === 'src'
      && nestedFiles.body.entries?.[0]?.path === 'src/nested.txt',
    'mobile workspace files: nested directory keeps workspace-relative paths',
    JSON.stringify(nestedFiles.body));

    const readFile = await requestJson(port, fixture.token, 'GET',
      `/api/mobile/workspace-file?workspaceId=${encodeURIComponent(workspaceBId)}&path=${encodeURIComponent('src/nested.txt')}`);
    record(readFile.status === 200 && readFile.body.content === 'nested fixture\n',
      'mobile workspace editor: reads an allowed text file',
      JSON.stringify(readFile.body));

    const saveFile = await requestJson(port, fixture.token, 'POST', '/api/mobile/workspace-file', {
      workspaceId: workspaceBId,
      path: 'src/nested.txt',
      content: 'saved fixture\n',
    });
    record(saveFile.status === 200 && fs.readFileSync(path.join(fixture.workspaceB.path, 'src', 'nested.txt'), 'utf-8') === 'saved fixture\n',
      'mobile workspace editor: saves only the requested existing text file',
      JSON.stringify(saveFile.body));

    const rejectedFiles = [
      await requestJson(port, fixture.token, 'GET',
        `/api/mobile/workspace-file?workspaceId=${encodeURIComponent(workspaceBId)}&path=binary.png`),
      await requestJson(port, fixture.token, 'GET',
        `/api/mobile/workspace-file?workspaceId=${encodeURIComponent(workspaceBId)}&path=oversized.txt`),
    ];
    record(rejectedFiles.every(response => response.status === 415),
      'mobile workspace editor: binary and oversized files are rejected',
      rejectedFiles.map(response => `${response.status}:${JSON.stringify(response.body)}`).join(','));

    const lexicalEscape = await requestJson(port, fixture.token, 'GET',
      `/api/mobile/workspace-files?workspaceId=${encodeURIComponent(workspaceBId)}&path=${encodeURIComponent('../')}`);
    record(lexicalEscape.status >= 400,
      'mobile workspace files: parent traversal outside the workspace is rejected',
      JSON.stringify(lexicalEscape.body));

    if (process.platform !== 'win32') {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-mobile-outside-'));
      fs.writeFileSync(path.join(outside, 'outside.txt'), 'outside', 'utf-8');
      fs.symlinkSync(outside, path.join(fixture.workspaceB.path, 'outside-link'), 'dir');
      const symlinkEscape = await requestJson(port, fixture.token, 'GET',
        `/api/mobile/workspace-files?workspaceId=${encodeURIComponent(workspaceBId)}&path=outside-link`);
      record(symlinkEscape.status >= 400,
        'mobile workspace files: symbolic-link escape outside the workspace is rejected',
        JSON.stringify(symlinkEscape.body));
      fs.rmSync(outside, { recursive: true, force: true });
    }

    const planUpdate = await requestJson(port, fixture.token, 'POST', '/api/mobile/conversation-plan-update', {
      workspaceId: workspaceBId,
      conversationId: SHARED_ID,
      items: [{ id: 'b-plan-1', text: 'Background plan item', status: 'done' }],
    });
    const stateAfterPlan = await requestJson(port, fixture.token, 'GET',
      `/api/mobile/right-sidebar-state?workspaceId=${encodeURIComponent(workspaceBId)}&conversationId=${encodeURIComponent(SHARED_ID)}`);
    const foregroundAfterPlan = await requestJson(port, fixture.token, 'GET',
      `/api/mobile/right-sidebar-state?workspaceId=${encodeURIComponent(workspaceAId)}&conversationId=${encodeURIComponent(SHARED_ID)}`);
    record(planUpdate.status === 200
      && stateAfterPlan.body.conversationPlan?.items?.[0]?.status === 'done'
      && (foregroundAfterPlan.body.conversationPlan?.items || []).length === 0,
    'mobile conversation plan: update is scoped to the exact workspace conversation',
    JSON.stringify({ planUpdate: planUpdate.body, stateAfterPlan: stateAfterPlan.body, foregroundAfterPlan: foregroundAfterPlan.body }));

    const missingSnapshot = await requestJson(
      port,
      fixture.token,
      'GET',
      `/api/mobile/conversation?workspaceId=${encodeURIComponent(workspaceBId)}&conversationId=${encodeURIComponent(A_ONLY_ID)}`,
    );
    record(missingSnapshot.status === 404,
      'mobile workspace snapshot: a conversation outside the requested workspace returns 404',
      JSON.stringify(missingSnapshot.body));

    const branchCreate = await requestJson(port, fixture.token, 'POST', '/api/mobile/conversation-branch-create', {
      workspaceId: workspaceBId,
      conversationId: B_ONLY_ID,
      messageIndex: 0,
      editedText: 'B_ONLY_EDITED_MESSAGE',
      branchNodePath: [],
    });
    const branchGroup = Array.isArray(branchCreate.body.branchGroups) ? branchCreate.body.branchGroups[0] : null;
    const originalBranchId = String(branchGroup?.branches?.[0]?.id || '');
    const editedBranchId = String(branchCreate.body.activeBranchId || '');
    record(branchCreate.status === 200
      && branchGroup?.branches?.length === 2
      && !!originalBranchId
      && !!editedBranchId
      && branchCreate.body.runtimeBranchId === editedBranchId,
    'mobile conversation branches: editing a user message creates a two-page PC-normalized branch group',
    JSON.stringify(branchCreate.body));

    const branchInspect = await requestJson(port, fixture.token, 'POST', '/api/mobile/conversation-branch-inspect', {
      workspaceId: workspaceBId,
      conversationId: B_ONLY_ID,
      branchId: originalBranchId,
      branchGroupId: String(branchGroup?.id || ''),
    });
    record(branchInspect.status === 200
      && branchInspect.body.activeBranchId === originalBranchId
      && branchInspect.body.runtimeBranchId === editedBranchId
      && JSON.stringify(branchInspect.body.chatMessages || []).includes('B_ONLY_MESSAGE'),
    'mobile conversation branches: inspect changes only the viewed page and preserves the runtime branch',
    JSON.stringify(branchInspect.body));

    const branchActivate = await requestJson(port, fixture.token, 'POST', '/api/mobile/conversation-branch-activate', {
      workspaceId: workspaceBId,
      conversationId: B_ONLY_ID,
      branchId: originalBranchId,
      branchGroupId: String(branchGroup?.id || ''),
    });
    record(branchActivate.status === 200
      && branchActivate.body.activeBranchId === originalBranchId
      && branchActivate.body.runtimeBranchId === originalBranchId,
    'mobile conversation branches: activate explicitly aligns viewed and runtime branches before send',
    JSON.stringify(branchActivate.body));

    const crossWorkspaceBranch = await requestJson(port, fixture.token, 'POST', '/api/mobile/conversation-branch-inspect', {
      workspaceId: workspaceAId,
      conversationId: B_ONLY_ID,
      branchId: originalBranchId,
      branchGroupId: String(branchGroup?.id || ''),
    });
    record(crossWorkspaceBranch.status === 404,
      'mobile conversation branches: exact workspace membership rejects cross-workspace branch access',
      JSON.stringify(crossWorkspaceBranch.body));

    const duplicateRows = await getWorkspaceRows(port, fixture.token, fixture.workspaceB);
    record(!rows(duplicateRows).some(item => item.id === B_DUPLICATE_ID),
      'mobile workspace fixture: duplicate-content conversation is intentionally hidden from the deduplicated UI list',
      JSON.stringify(duplicateRows.body));
    const duplicateSnapshot = await requestJson(
      port,
      fixture.token,
      'GET',
      `/api/mobile/conversation?workspaceId=${encodeURIComponent(workspaceBId)}&conversationId=${encodeURIComponent(B_DUPLICATE_ID)}`,
    );
    record(duplicateSnapshot.status === 200
      && JSON.stringify(duplicateSnapshot.body.chatMessages || []).includes('B_ONLY_MESSAGE'),
    'mobile workspace snapshot: exact raw state-key membership can read a duplicate-content conversation hidden from the UI list',
    JSON.stringify(duplicateSnapshot.body));
    const duplicateArchive = await requestJson(port, fixture.token, 'POST', '/api/mobile/conversation-archive', {
      workspaceId: workspaceBId,
      conversationId: B_DUPLICATE_ID,
    });
    record(duplicateArchive.status === 200,
      'mobile workspace archive: exact raw state-key membership allows archiving a duplicate-content conversation hidden from the UI list',
      JSON.stringify(duplicateArchive.body));

    const reorderUnpinned = await requestJson(port, fixture.token, 'POST', '/api/mobile/conversation-reorder', {
      workspaceId: workspaceBId,
      conversationIds: [B_SCOPED_SEND_ID, B_ONLY_ID, SHARED_ID, B_ARCHIVE_ID],
    });
    record(reorderUnpinned.status === 200
      && rows(reorderUnpinned).map(item => item.id).slice(0, 4).join(',') === [B_SCOPED_SEND_ID, B_ONLY_ID, SHARED_ID, B_ARCHIVE_ID].join(','),
    'mobile workspace reorder: exact workspace unpinned group order is persisted and returned',
    JSON.stringify(reorderUnpinned.body));
    const rowsAAfterBReorder = await getWorkspaceRows(port, fixture.token, fixture.workspaceA);
    record(rows(rowsAAfterBReorder).map(item => item.id).join(',') === [SHARED_ID, A_ONLY_ID].join(','),
      'mobile workspace reorder: same-id rows in another workspace keep their order',
      JSON.stringify(rowsAAfterBReorder.body));

    const sse = collectMobileWorkEvents(port, fixture.token);
    await sse.ready;
    const scopedSendPromise = requestJson(port, fixture.token, 'POST', '/api/mobile/send', {
      workspaceId: workspaceBId,
      conversationId: B_SCOPED_SEND_ID,
      message: 'SCOPED_SEND_MESSAGE',
    });
    const startObserved = await Promise.race([
      waitUntil(() => sse.events.some(event => event.type === 'start'
        && event.workspaceId === workspaceBId
        && event.conversationId === B_SCOPED_SEND_ID), `Scoped mobile start event did not reach SSE: ${JSON.stringify(sse.events)}`).then(() => true),
      scopedSendPromise.then(response => {
        throw new Error(`Scoped mobile send completed before its start event: ${JSON.stringify(response)} events=${JSON.stringify(sse.events)}`);
      }),
    ]);
    if (!startObserved) throw new Error('Scoped mobile start event was not observed');
    const runningBranchMutation = await requestJson(port, fixture.token, 'POST', '/api/mobile/conversation-branch-create', {
      workspaceId: workspaceBId,
      conversationId: B_SCOPED_SEND_ID,
      messageIndex: 0,
      editedText: 'MUST_NOT_BRANCH_WHILE_RUNNING',
      branchNodePath: [],
    });
    record(runningBranchMutation.status === 423,
      'mobile conversation branches: a running target rejects branch creation with 423',
      JSON.stringify(runningBranchMutation.body));
    const rowsWhileScopedSend = await getWorkspaceRows(port, fixture.token, fixture.workspaceB);
    const runningScopedRow = rowById(rowsWhileScopedSend, B_SCOPED_SEND_ID);
    record(runningScopedRow?.active === true && runningScopedRow?.running === true && runningScopedRow?.runtimeStatus === 'running',
      'mobile scoped send: background target is active and running while its isolated Agent processes',
      JSON.stringify(rowsWhileScopedSend.body));
    const scopedSend = await scopedSendPromise;
    await waitUntil(() => sse.events.some(event => event.type === 'done'
      && event.workspaceId === workspaceBId
      && event.conversationId === B_SCOPED_SEND_ID), 'Scoped mobile done event did not reach SSE');
    sse.close();
    record(scopedSend.status === 200
      && scopedSend.body.response === 'MOCK_SCOPED_RESPONSE:SCOPED_SEND_MESSAGE'
      && sse.events.some(event => event.type === 'start' && event.workspaceId === workspaceBId)
      && sse.events.some(event => event.type === 'done' && event.workspaceId === workspaceBId),
    'mobile scoped send: response and start/done SSE events retain target workspace identity',
    JSON.stringify({ response: scopedSend.body, events: sse.events }));

    const archiveContext = await requestJson(port, fixture.token, 'POST', '/api/mobile/conversation-archive', {
      workspaceId: workspaceBId,
      conversationId: B_ARCHIVE_ID,
    });
    const archivePath = path.join(fixture.workspaceB.path, 'archive', String(archiveContext.body.fileName || ''));
    const archiveMarkdown = fs.existsSync(archivePath) ? fs.readFileSync(archivePath, 'utf-8') : '';
    const archiveManifest = fs.existsSync(`${archivePath}.conversation.json`)
      ? JSON.parse(fs.readFileSync(`${archivePath}.conversation.json`, 'utf-8'))
      : {};
    record(archiveContext.status === 200
      && archiveMarkdown.includes('**Mode**: goal')
      && archiveMarkdown.includes('**Model**: background-archive-model')
      && archiveMarkdown.includes(`**Goal**: ${BACKGROUND_GOAL}`)
      && !archiveMarkdown.includes(FOREGROUND_GOAL)
      && archiveManifest.entry?.mode === 'goal'
      && archiveManifest.entry?.modelSelection?.modelId === 'background-archive-model'
      && archiveManifest.entry?.goal?.objective === BACKGROUND_GOAL,
    'mobile workspace archive: markdown and manifest use the background conversation mode, model, and goal without foreground leakage',
    JSON.stringify({ archiveMarkdown, archiveManifest }));

    const missingWorkspaceRequests = [
      await requestJson(port, fixture.token, 'POST', '/api/mobile/conversation-create', { title: 'missing workspace' }),
      await requestJson(port, fixture.token, 'POST', '/api/mobile/conversation-rename', { conversationId: SHARED_ID, title: 'missing workspace' }),
      await requestJson(port, fixture.token, 'POST', '/api/mobile/conversation-pin', { conversationId: SHARED_ID, pinned: true }),
      await requestJson(port, fixture.token, 'POST', '/api/mobile/conversation-reorder', { conversationIds: [SHARED_ID, B_ONLY_ID] }),
      await requestJson(port, fixture.token, 'POST', '/api/mobile/conversation-archive', { conversationId: 'missing-workspace-archive-probe' }),
    ];
    record(missingWorkspaceRequests.every(response => response.status === 400),
      'mobile workspace mutations: create, rename, pin, reorder, and archive fail closed when workspaceId is missing',
      missingWorkspaceRequests.map(response => String(response.status)).join(','));

    const unknownWorkspaceId = 'workspace-unknown-mobile-api';
    const unknownWorkspaceRequests = [
      await requestJson(port, fixture.token, 'POST', '/api/mobile/conversation-create', { workspaceId: unknownWorkspaceId }),
      await requestJson(port, fixture.token, 'POST', '/api/mobile/conversation-rename', { workspaceId: unknownWorkspaceId, conversationId: SHARED_ID, title: 'unknown' }),
      await requestJson(port, fixture.token, 'POST', '/api/mobile/conversation-pin', { workspaceId: unknownWorkspaceId, conversationId: SHARED_ID, pinned: true }),
      await requestJson(port, fixture.token, 'POST', '/api/mobile/conversation-reorder', { workspaceId: unknownWorkspaceId, conversationIds: [SHARED_ID, B_ONLY_ID] }),
      await requestJson(port, fixture.token, 'POST', '/api/mobile/conversation-archive', { workspaceId: unknownWorkspaceId, conversationId: SHARED_ID }),
    ];
    record(unknownWorkspaceRequests.every(response => response.status === 404),
      'mobile workspace mutations: unknown workspaceId returns 404 for create, rename, pin, reorder, and archive',
      unknownWorkspaceRequests.map(response => String(response.status)).join(','));

    const wrongWorkspaceRequests = [
      await requestJson(port, fixture.token, 'POST', '/api/mobile/conversation-rename', { workspaceId: workspaceBId, conversationId: A_ONLY_ID, title: 'must not rename' }),
      await requestJson(port, fixture.token, 'POST', '/api/mobile/conversation-pin', { workspaceId: workspaceBId, conversationId: A_ONLY_ID, pinned: true }),
      await requestJson(port, fixture.token, 'POST', '/api/mobile/conversation-reorder', { workspaceId: workspaceBId, conversationIds: [B_ONLY_ID, A_ONLY_ID] }),
      await requestJson(port, fixture.token, 'POST', '/api/mobile/conversation-archive', { workspaceId: workspaceBId, conversationId: A_ONLY_ID }),
    ];
    record(wrongWorkspaceRequests.every(response => response.status === 404),
      'mobile workspace mutations: a conversation outside the requested workspace returns 404',
      wrongWorkspaceRequests.map(response => String(response.status)).join(','));

    const renameB = await requestJson(port, fixture.token, 'POST', '/api/mobile/conversation-rename', {
      workspaceId: workspaceBId,
      conversationId: SHARED_ID,
      title: 'B renamed safely',
    });
    const renameIds = rows(renameB).map(item => String(item.id || '')).sort();
    record(renameB.status === 200
      && rowById(renameB, SHARED_ID)?.title === 'B renamed safely'
      && renameIds.includes(B_ONLY_ID)
      && !renameIds.includes(A_ONLY_ID),
    'mobile workspace rename: response contains only the target workspace conversation rows',
    JSON.stringify(renameB.body));

    const rowsAAfterRename = await getWorkspaceRows(port, fixture.token, fixture.workspaceA);
    record(rowById(rowsAAfterRename, SHARED_ID)?.title === 'A shared title',
      'mobile workspace rename: same-id conversation in the other workspace is unchanged',
      JSON.stringify(rowsAAfterRename.body));

    const pinB = await requestJson(port, fixture.token, 'POST', '/api/mobile/conversation-pin', {
      workspaceId: workspaceBId,
      conversationId: SHARED_ID,
      pinned: true,
    });
    record(pinB.status === 200
      && rowById(pinB, SHARED_ID)?.pinned === true
      && rows(pinB).some(item => item.id === B_ONLY_ID)
      && !rows(pinB).some(item => item.id === A_ONLY_ID),
    'mobile workspace pin: response and persisted pin state belong only to the target workspace',
    JSON.stringify(pinB.body));

    const rowsAAfterPin = await getWorkspaceRows(port, fixture.token, fixture.workspaceA);
    record(rowById(rowsAAfterPin, SHARED_ID)?.pinned === false,
      'mobile workspace pin: same-id conversation in the other workspace remains unpinned',
      JSON.stringify(rowsAAfterPin.body));

    const crossGroupReorder = await requestJson(port, fixture.token, 'POST', '/api/mobile/conversation-reorder', {
      workspaceId: workspaceBId,
      conversationIds: [SHARED_ID, B_ONLY_ID],
    });
    record(crossGroupReorder.status === 409,
      'mobile workspace reorder: pinned and unpinned rows cannot cross groups',
      JSON.stringify(crossGroupReorder.body));

    const pinBOnly = await requestJson(port, fixture.token, 'POST', '/api/mobile/conversation-pin', {
      workspaceId: workspaceBId,
      conversationId: B_ONLY_ID,
      pinned: true,
    });
    const reorderPinned = await requestJson(port, fixture.token, 'POST', '/api/mobile/conversation-reorder', {
      workspaceId: workspaceBId,
      conversationIds: [SHARED_ID, B_ONLY_ID],
    });
    record(pinBOnly.status === 200 && reorderPinned.status === 200
      && rows(reorderPinned).filter(item => item.pinned).slice(0, 2).map(item => item.id).join(',') === [SHARED_ID, B_ONLY_ID].join(','),
    'mobile workspace reorder: same pinned group can be reordered without changing pin membership',
    JSON.stringify(reorderPinned.body));

    const createB = await requestJson(port, fixture.token, 'POST', '/api/mobile/conversation-create', {
      workspaceId: workspaceBId,
      title: 'B created conversation',
    });
    const createdId = String(createB.body.conversation?.id || '');
    record(createB.status === 200
      && !!createdId
      && rows(createB).some(item => item.id === createdId)
      && rows(createB).some(item => item.id === B_ONLY_ID)
      && !rows(createB).some(item => item.id === A_ONLY_ID),
    'mobile workspace create: mutation response contains the created row and only target-workspace conversations',
    JSON.stringify(createB.body));

    const archiveB = await requestJson(port, fixture.token, 'POST', '/api/mobile/conversation-archive', {
      workspaceId: workspaceBId,
      conversationId: SHARED_ID,
    });
    record(archiveB.status === 200
      && !rows(archiveB).some(item => item.id === SHARED_ID)
      && rows(archiveB).some(item => item.id === B_ONLY_ID)
      && rows(archiveB).some(item => item.id === createdId)
      && !rows(archiveB).some(item => item.id === A_ONLY_ID),
    'mobile workspace archive: response removes only the target row and returns only target-workspace conversations',
    JSON.stringify(archiveB.body));

    const finalA = await getWorkspaceRows(port, fixture.token, fixture.workspaceA);
    const finalB = await getWorkspaceRows(port, fixture.token, fixture.workspaceB);
    record(finalA.status === 200
      && rowById(finalA, SHARED_ID)?.title === 'A shared title'
      && rowById(finalA, SHARED_ID)?.pinned === false
      && rows(finalA).some(item => item.id === A_ONLY_ID),
    'mobile workspace archive: same-id conversation and sibling rows in the other workspace remain intact',
    JSON.stringify(finalA.body));
    record(finalB.status === 200 && !rows(finalB).some(item => item.id === SHARED_ID),
      'mobile workspace archive: archived same-id conversation is absent from the requested workspace',
      JSON.stringify(finalB.body));
  } finally {
    await stopServer(child);
    const resolvedRoot = path.resolve(fixture.root);
    const resolvedTemp = path.resolve(os.tmpdir());
    if (resolvedRoot.startsWith(resolvedTemp + path.sep) && path.basename(resolvedRoot).startsWith('newmark-mobile-workspace-api-')) {
      fs.rmSync(resolvedRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
}

async function main(): Promise<void> {
  let passed = 0;
  let failed = 0;
  await verifyMobileWorkspaceApi((condition, name, detail) => {
    if (condition) {
      passed += 1;
      console.log(`[PASS] ${name}`);
    } else {
      failed += 1;
      console.error(`[FAIL] ${name}${detail ? `: ${detail}` : ''}`);
    }
  });
  assertStrict.equal(failed, 0, `${failed} mobile workspace API regression assertion(s) failed`);
  console.log(`Mobile workspace API verification passed: ${passed} assertions`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
