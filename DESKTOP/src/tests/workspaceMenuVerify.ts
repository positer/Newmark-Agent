import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';

function uiScriptSource(): string {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'ui', 'index.html'), 'utf-8');
  const match = html.match(/<script>([\s\S]*)<\/script>/);
  if (!match) throw new Error('UI script was not found');
  return match[1];
}

function assignedFunctionSource(source: string, memberName: string): string {
  const file = ts.createSourceFile('newmark-ui.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let found = '';
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && node.left.getText(file) === `window.${memberName}`
      && (ts.isFunctionExpression(node.right) || ts.isArrowFunction(node.right))) {
      found = node.right.getText(file);
      return;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(file);
  if (!found) throw new Error(`UI assignment was not found: window.${memberName}`);
  return found;
}

async function main(): Promise<void> {
  const source = uiScriptSource();
  const switchWorkspaceSource = assignedFunctionSource(source, 'switchToWorkspace');
  const layoutCalls: string[] = [];
  let backendSelections = 0;
  const state: Record<string, unknown> = {
    currentWorkspaceId: 'workspace-focus',
    workspaceSwitchInFlight: '',
    workspaceSwitchGeneration: 9,
    activeConversationId: 'focus',
  };
  const windowObject: Record<string, unknown> = {
    setLeftCollapsed: (collapsed: boolean) => layoutCalls.push(`left:${collapsed}`),
    setLeftSecondaryOpen: (open: boolean) => layoutCalls.push(`secondary:${open}`),
    requestEditorTransition: async () => true,
  };
  const api = {
    selectWorkspace: async () => {
      backendSelections += 1;
      return null;
    },
  };
  const install = new Function('window', 'state', 'api', `window.switchToWorkspace = ${switchWorkspaceSource};`);
  install(windowObject, state, api);

  const result = await (windowObject.switchToWorkspace as (reference: string) => Promise<unknown>)('workspace-focus');

  assert.equal(result, null, 'focused workspace reselect remains a backend no-op');
  assert.equal(backendSelections, 0, 'focused workspace reselect does not invoke backend selection/reset');
  assert.deepEqual(layoutCalls, ['left:true', 'secondary:true'], 'focused workspace reselect opens its conversation secondary menu');
  assert.equal(state.workspaceSwitchGeneration, 9, 'focused workspace reselect does not invalidate an unrelated switch generation');
  assert.equal(state.activeConversationId, 'focus', 'focused workspace reselect preserves the focused conversation');

  const switchCalls: Array<{ reference: string; snapshot: unknown }> = [];
  const coldState: Record<string, unknown> = {
    currentWorkspaceId: 'workspace-old',
    workspaceSwitchInFlight: '',
    workspaceSwitchGeneration: 0,
  };
  const coldSnapshot = { conversationId: 'conversation-restored', chatMessages: [{ role: 'user', content: 'persisted' }] };
  const coldWindow: Record<string, unknown> = {
    requestEditorTransition: async () => true,
    selectWorkspace: (reference: string, snapshot: unknown) => switchCalls.push({ reference, snapshot }),
    clearUiNotice: () => undefined,
    showUiNotice: () => undefined,
  };
  const coldApi = {
    selectWorkspace: async () => ({ id: 'workspace-new', name: 'New', conversationSnapshot: coldSnapshot }),
  };
  const coldInstall = new Function('window', 'state', 'api', 'workspaceIdentity', 't', 'clearUiNotice', 'showUiNotice', `window.switchToWorkspace = ${switchWorkspaceSource};`);
  coldInstall(coldWindow, coldState, coldApi, (workspace: { id?: string }) => workspace?.id || '', (value: string) => value, () => undefined, () => undefined);
  await (coldWindow.switchToWorkspace as (reference: string) => Promise<unknown>)('workspace-new');

  assert.deepEqual(switchCalls, [{ reference: 'workspace-new', snapshot: coldSnapshot }], 'cold workspace paints the selection response snapshot without a second activation IPC');
  assert.equal(coldState.currentWorkspaceId, 'workspace-new', 'cold workspace updates its stable identity before painting the snapshot');

  console.log('Workspace focus menu verification passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
