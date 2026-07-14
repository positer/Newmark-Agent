type Assert = (condition: boolean, name: string, detail?: string) => void;

class FakeClassList {
  private readonly values = new Set<string>();

  add(...names: string[]): void { for (const name of names) this.values.add(name); }
  remove(...names: string[]): void { for (const name of names) this.values.delete(name); }
  contains(name: string): boolean { return this.values.has(name); }
  toggle(name: string, force?: boolean): boolean {
    const enabled = force === undefined ? !this.values.has(name) : force;
    if (enabled) this.values.add(name);
    else this.values.delete(name);
    return enabled;
  }
}

interface FakeElement {
  value: string;
  textContent: string;
  innerHTML: string;
  style: Record<string, string>;
  classList: FakeClassList;
  replaceChildren: () => void;
}

function element(): FakeElement {
  const result: FakeElement = {
    value: '',
    textContent: '',
    innerHTML: '',
    style: {},
    classList: new FakeClassList(),
    replaceChildren: () => {
      result.textContent = '';
      result.innerHTML = '';
    },
  };
  return result;
}

export async function verifyEditorLifecycle(uiHtml: string, assert: Assert): Promise<void> {
  const start = uiHtml.indexOf('window.requestEditorAssist = async function');
  const end = uiHtml.indexOf('// === Subagent List ===', start);
  assert(start >= 0 && end > start, 'editor lifecycle: executable lifecycle block is discoverable');
  if (start < 0 || end <= start) return;

  const main = element();
  const preview = element();
  const toggle = element();
  const textarea = element();
  const filename = element();
  const assist = element();
  const els: Record<string, FakeElement> = {
    'editor-md-preview': preview,
    'editor-md-toggle': toggle,
    'editor-textarea': textarea,
    'editor-filename': filename,
    'editor-assist': assist,
  };
  const state: Record<string, any> = {
    editorPath: '',
    editorOriginal: '',
    editorToken: '',
    editorRevision: '',
    editorEncoding: 'utf8',
    editorPreview: false,
    editorUndo: [],
    editorRedo: [],
    editorVimPending: '',
    editorCaretSignature: '',
    editorCompletionTimer: null,
    editorOpenGeneration: 0,
    editorAssistRequest: 0,
    editorTransitionPromise: null,
    browserPreviewToken: '',
    browserPreviewUrl: '',
  };
  const closedTokens: string[] = [];
  const closedPreviewTokens: string[] = [];
  const savedContents: string[] = [];
  let decision = 'discard';
  let saveResult: Record<string, any> = { ok: true, revision: 'saved-revision', token: 'saved-token' };
  let openWorkspaceFile: (path: string) => Promise<Record<string, any>> = async path => ({
    kind: 'editor', path, token: `${path}-token`, revision: `${path}-revision`, encoding: 'utf8', content: path,
  });
  let editorAssist: (request: Record<string, unknown>) => Promise<Record<string, any>> = async () => ({ ok: true, text: 'assist' });
  const api = {
    confirmEditorClose: async () => decision,
    closeWorkspaceFile: async (token: string) => { closedTokens.push(token); return { ok: true }; },
    closeWorkspacePreview: async (token: string) => { closedPreviewTokens.push(token); return { ok: true }; },
    saveWorkspaceFile: async (_token: string, content: string) => { savedContents.push(content); return saveResult; },
    openWorkspaceFile: (path: string) => openWorkspaceFile(path),
    editorAssist: (request: Record<string, unknown>) => editorAssist(request),
  };
  let rightTab = 'editor';
  let browserUrl = '';
  let promptValue = 'cancel';
  const windowObject: Record<string, any> = {
    dismissEditorCompletion: () => undefined,
    renderNativeEditor: () => undefined,
    switchRightTab: (tab: string) => { rightTab = tab; },
    navigateBrowser: (url: string) => { browserUrl = url; },
    editorLanguageForPath: (filePath: string) => /\.(?:md|markdown)$/i.test(filePath) ? 'markdown' : 'text',
    scheduleEditorCompletion: () => undefined,
    editorSetValue: (value: string) => { textarea.value = value; },
    prompt: () => promptValue,
  };
  const documentObject = { getElementById: (id: string) => id === 'native-editor-main' ? main : null };
  const messages: string[] = [];
  const run = new Function('window', 'state', 'els', 'api', 'document', 'currentLang', 't', 'addMsg', uiHtml.slice(start, end));
  run(windowObject, state, els, api, documentObject, () => 'en', (key: string) => key, (_role: string, text: string) => messages.push(text));

  const loadMarkdown = (value: string, original = 'original') => {
    state.editorPath = 'document.md';
    state.editorOriginal = original;
    state.editorToken = 'markdown-token';
    state.editorRevision = 'markdown-revision';
    state.editorEncoding = 'utf8';
    state.editorPreview = true;
    textarea.value = value;
    filename.textContent = 'document.md';
    main.style.display = 'none';
    preview.textContent = 'rendered markdown';
    preview.innerHTML = '<p>rendered markdown</p>';
    preview.classList.add('open');
    toggle.classList.add('visible');
  };

  loadMarkdown('changed');
  decision = 'discard';
  const discarded = await windowObject.requestEditorTransition();
  assert(discarded === true && !state.editorPath && closedTokens.includes('markdown-token'), 'editor lifecycle: Discard closes and revokes the owning edit token');
  assert(main.style.display === 'grid' && !preview.classList.contains('open') && !preview.textContent && !toggle.classList.contains('visible'), 'editor lifecycle: reset restores editor grid and clears Markdown preview DOM');

  loadMarkdown('changed');
  decision = 'cancel';
  const cancelled = await windowObject.requestEditorTransition();
  assert(cancelled === false && state.editorPath === 'document.md' && textarea.value === 'changed' && preview.classList.contains('open'), 'editor lifecycle: Cancel preserves the complete dirty editor surface');

  loadMarkdown('save this');
  decision = 'save';
  saveResult = { ok: true, revision: 'saved-revision', token: 'markdown-token' };
  const saved = await windowObject.requestEditorTransition();
  assert(saved === true && savedContents.at(-1) === 'save this' && !state.editorPath, 'editor lifecycle: Save awaits a successful write before closing');

  loadMarkdown('conflicting change');
  decision = 'save';
  saveResult = { ok: false, error: 'File changed on disk', conflict: true };
  const conflicted = await windowObject.requestEditorTransition();
  assert(conflicted === false && state.editorPath === 'document.md' && textarea.value === 'conflicting change', 'editor lifecycle: failed or conflicting Save keeps the dirty editor open');

  loadMarkdown('original', 'original');
  windowObject.applyWorkspaceFileOpenResult('plain.txt', {
    kind: 'editor', path: 'plain.txt', token: 'plain-token', revision: 'plain-revision', encoding: 'utf8', content: 'plain text',
  });
  assert(state.editorPath === 'plain.txt' && textarea.value === 'plain text' && main.style.display === 'grid'
    && !preview.classList.contains('open') && !preview.textContent && !toggle.classList.contains('visible'),
  'editor lifecycle: applying a non-Markdown file cannot retain the prior Markdown reader');

  let resolveAssist: ((value: Record<string, any>) => void) | undefined;
  editorAssist = () => new Promise(resolve => { resolveAssist = resolve; });
  promptValue = 'review old file';
  const staleAssist = windowObject.requestEditorAssist();
  await Promise.resolve();
  windowObject.applyWorkspaceFileOpenResult('new.txt', { kind: 'editor', path: 'new.txt', token: 'new-token', revision: 'new-revision', encoding: 'utf8', content: 'new content' });
  resolveAssist?.({ ok: true, text: 'OLD FILE SUGGESTION' });
  await staleAssist;
  assert(!assist.innerHTML.includes('OLD FILE SUGGESTION') && !assist.textContent.includes('OLD FILE SUGGESTION'), 'editor lifecycle: delayed Assist cannot repopulate a replaced editor surface');

  windowObject.applyWorkspaceFileOpenResult('manual.pdf', { kind: 'browser', url: 'http://127.0.0.1:1234/pdf/token/manual.pdf', previewToken: 'pdf-preview-token' });
  assert(rightTab === 'browser' && browserUrl.startsWith('http://127.0.0.1:') && state.browserPreviewToken === 'pdf-preview-token', 'editor lifecycle: browser result resets the editor and tracks its revocable PDF capability');

  const slowDeferred: { resolve?: (value: Record<string, any>) => void } = {};
  const openedPaths: string[] = [];
  openWorkspaceFile = path => {
    openedPaths.push(path);
    if (path === 'slow.txt') return new Promise(resolve => { slowDeferred.resolve = resolve; });
    return Promise.resolve({ kind: 'editor', path, token: `${path}-token`, revision: `${path}-revision`, encoding: 'utf8', content: 'fast content' });
  };
  const slow = windowObject.openWorkspacePath('slow.txt');
  for (let i = 0; i < 5 && !openedPaths.includes('slow.txt'); i++) await Promise.resolve();
  const fast = windowObject.openWorkspacePath('fast.txt');
  await fast;
  slowDeferred.resolve?.({ kind: 'editor', path: 'slow.txt', token: 'slow-token', revision: 'slow-revision', encoding: 'utf8', content: 'slow content' });
  await slow;
  await Promise.resolve();
  assert(state.editorPath === 'fast.txt' && textarea.value === 'fast content' && closedTokens.includes('slow-token') && closedPreviewTokens.includes('pdf-preview-token'), 'editor lifecycle: request generation ignores stale opens and replacing a PDF revokes its capability');

  const slowPdfDeferred: { resolve?: (value: Record<string, any>) => void } = {};
  openWorkspaceFile = path => {
    openedPaths.push(path);
    if (path === 'slow.pdf') return new Promise(resolve => { slowPdfDeferred.resolve = resolve; });
    return Promise.resolve({ kind: 'editor', path, token: `${path}-token`, revision: `${path}-revision`, encoding: 'utf8', content: 'newest text' });
  };
  const slowPdf = windowObject.openWorkspacePath('slow.pdf');
  for (let i = 0; i < 5 && !openedPaths.includes('slow.pdf'); i++) await Promise.resolve();
  await windowObject.openWorkspacePath('newest.txt');
  slowPdfDeferred.resolve?.({ kind: 'browser', url: 'http://127.0.0.1:1234/pdf/stale/slow.pdf', previewToken: 'stale-pdf-preview-token' });
  await slowPdf;
  await Promise.resolve();
  assert(state.editorPath === 'newest.txt' && textarea.value === 'newest text' && closedPreviewTokens.includes('stale-pdf-preview-token'), 'editor lifecycle: a stale PDF capability is revoked when a newer text open wins');

  textarea.value = 'newest text';
  state.editorOriginal = 'newest text';
  const closed = await windowObject.closeEditor();
  assert(closed === true && rightTab === 'file-tree' && !state.editorPath, 'editor lifecycle: clean close exits the editor tab and clears the current file');
}
