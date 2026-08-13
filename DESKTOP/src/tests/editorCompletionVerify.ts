import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Agent } from '../core/agent';

type Assert = (condition: boolean, name: string, detail?: string) => void;

class FakeClassList {
  private readonly values = new Set<string>();

  add(...names: string[]): void { for (const name of names) this.values.add(name); }
  remove(...names: string[]): void { for (const name of names) this.values.delete(name); }
  contains(name: string): boolean { return this.values.has(name); }
}

interface FakeTextarea {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

function response(text: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function verifyEditorCompletionBackend(assert: Assert): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-editor-completion-'));
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; body: Record<string, any> }> = [];
  try {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(url),
        body: JSON.parse(String(init?.body || '{}')) as Record<string, any>,
      });
      return response('return left + right;');
    }) as typeof fetch;

    const agent = new Agent(root, { agentOnly: true });
    const copilotId = agent.config.upsertProvider('GitHub Copilot', 'https://models.github.ai', 'test-copilot-key', 'github_models');
    agent.config.addModelToProvider(copilotId, 'unavailable-copilot', 'Unavailable Copilot', 'fixture');
    const validProviderId = agent.config.upsertProvider('Editor Fixture', 'https://editor-fixture.invalid/v1', 'test-editor-key', 'openai');
    agent.config.addModelToProvider(validProviderId, 'editor-fast', 'Editor Fast', 'fixture');
    agent.config.updateModel(validProviderId, 'editor-fast', {
      validation: { level: 'standard', status: 'verified', checked_at: 'test', capabilities: { text: true } } as any,
    });
    agent.setModel('editor-fast');

    const deltas: string[] = [];
    const result = await agent.editorModelRequest({
      path: 'src/demo.ts',
      before: 'x'.repeat(9000),
      after: 'y'.repeat(2000),
      completion: true,
      preferCopilot: true,
      onTextDelta: delta => deltas.push(delta),
    });
    const request = requests[0];
    const prompt = String(request?.body?.messages?.at(-1)?.content || '');
    assert(result.ok && result.model === 'editor-fast', 'editor completion backend: unusable Copilot deployment falls back to the active usable model');
    assert(request?.body?.max_tokens === 96 && prompt.includes('x'.repeat(3200)) && !prompt.includes('x'.repeat(3201)), 'editor completion backend: request uses a small output budget and bounded cursor-local context');
    assert(!prompt.includes('y'.repeat(801)), 'editor completion backend: suffix context is bounded independently');
    assert(deltas.join('').includes('return left + right;') && request?.body?.stream === true, 'editor completion backend: streams the first provider text delta while retaining the bounded completion request');

    globalThis.fetch = (async () => response('   \n\t')) as typeof fetch;
    const empty = await agent.editorModelRequest({ path: 'src/demo.ts', before: 'return ', after: '', completion: true, preferCopilot: true });
    assert(!empty.ok && empty.text === '', 'editor completion backend: whitespace-only provider output becomes a quiet empty suggestion');

    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('fixture aborted')), { once: true });
    })) as typeof fetch;
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(new Error('superseded fixture request')), 20);
    const abortStarted = Date.now();
    const aborted = await agent.editorModelRequest({ path: 'src/demo.ts', before: 'return ', after: '', completion: true, preferCopilot: true }, controller.signal);
    clearTimeout(abortTimer);
    assert(!aborted.ok && Date.now() - abortStarted < 1000, 'editor completion backend: superseded requests settle promptly instead of waiting for the provider');
  } finally {
    globalThis.fetch = originalFetch;
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
  }
}

async function verifyEditorCompletionUi(uiHtml: string, assert: Assert): Promise<void> {
  const start = uiHtml.indexOf('function editorCompletionValueKey');
  const end = uiHtml.indexOf('// === Subagent List ===', start);
  assert(start >= 0 && end > start, 'editor completion UI: prediction implementation is discoverable');
  if (start < 0 || end <= start) return;

  const textarea: FakeTextarea = { value: 'x'.repeat(6200), selectionStart: 5000, selectionEnd: 5000 };
  const popup = { textContent: '', classList: new FakeClassList() };
  const ghost = { textContent: '', classList: new FakeClassList() };
  const els: Record<string, any> = { 'editor-textarea': textarea, 'editor-completion': popup, 'editor-ghost': ghost };
  const state: Record<string, any> = {
    editorPath: 'src/demo.ts',
    editorCompletionText: '',
    editorCompletionRequest: 0,
    editorCompletionAnchor: null,
    editorCompletionCache: [],
    editorCompletionInFlight: false,
    editorPredictionEnabled: true,
    editorCompletionTimer: null,
    editorCaretSignature: '',
  };
  const calls: Array<Record<string, string>> = [];
  let cancelCalls = 0;
  let nextResult: Record<string, any> = { ok: true, text: 'return true;' };
  const api: Record<string, any> = {
    editorComplete: async (request: Record<string, string>) => {
      calls.push(request);
      return nextResult;
    },
    editorCompleteCancel: async () => { cancelCalls++; return { ok: true }; },
  };
  const windowObject: Record<string, any> = {
    renderEditorGhostText: () => { ghost.textContent = state.editorCompletionText; },
  };
  const run = new Function('window', 'state', 'els', 'api', uiHtml.slice(start, end));
  run(windowObject, state, els, api);

  await windowObject.requestEditorCompletion();
  assert(calls.length === 1 && calls[0].before.length === 3200 && calls[0].after.length === 800, 'editor completion UI: sends exactly the bounded before/after windows');
  assert(state.editorCompletionText === 'return true;' && !popup.classList.contains('open'), 'editor completion UI: successful prediction renders a ghost without leaving a status popup open');

  await windowObject.requestEditorCompletion();
  assert(calls.length === 1, 'editor completion UI: identical cursor anchors are served from the short-lived cache');

  textarea.selectionStart = 1200;
  textarea.selectionEnd = 1200;
  nextResult = { ok: false, text: '', error: 'No completion' };
  await windowObject.requestEditorCompletion();
  assert(calls.length === 2 && !popup.classList.contains('open') && !state.editorCompletionText, 'editor completion UI: empty provider results stay quiet instead of flashing No completion');

  let resolveStale: ((value: Record<string, any>) => void) | undefined;
  api.editorComplete = (request: Record<string, string>) => {
    calls.push(request);
    return new Promise(resolve => { resolveStale = resolve; });
  };
  textarea.selectionStart = 2000;
  textarea.selectionEnd = 2000;
  const stale = windowObject.requestEditorCompletion();
  await Promise.resolve();
  state.editorCompletionRequest++;
  resolveStale?.({ ok: true, text: 'stale suggestion' });
  await stale;
  assert(state.editorCompletionText === '', 'editor completion UI: a superseded response cannot repopulate the current editor');
  windowObject.dismissEditorCompletion();
  await Promise.resolve();
  assert(cancelCalls === 1, 'editor completion UI: dismissing an in-flight prediction sends an immediate cancellation');
}

export async function verifyEditorCompletion(uiHtml: string, assert: Assert): Promise<void> {
  await verifyEditorCompletionBackend(assert);
  await verifyEditorCompletionUi(uiHtml, assert);
}
