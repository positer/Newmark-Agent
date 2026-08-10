import * as assert from 'assert';
import { ComputerUseSessionRegistry } from '../core/computerUseSession';

const scopeA = { runtimeKey: 'workspace-a::conversation:alpha', ownerLabel: 'conversation:alpha', workspacePath: process.cwd() };
const scopeB = { runtimeKey: 'workspace-a::conversation:beta', ownerLabel: 'conversation:beta', workspacePath: process.cwd() };

const registry = new ComputerUseSessionRegistry();
const first = registry.authorize('takeover_start', scopeA);
assert.strictEqual(first, null, 'first conversation can enable and acquire ComputerUse');
assert.strictEqual(registry.state(scopeA.runtimeKey).enabled, true, 'ComputerUse state is enabled for its owning conversation');

const blocked = registry.authorize('click', scopeB);
assert.ok(blocked && blocked.includes('computerUse occupied') && blocked.includes('conversation:alpha'), 'another conversation receives the occupied response');

registry.complete('click', scopeA);
assert.strictEqual(registry.state(scopeA.runtimeKey).occupied, true, 'Build/tool completion does not release the conversation ComputerUse lease');

const sameConversationActor = registry.authorize('observe', { ...scopeA, ownerLabel: 'conversation:alpha:subagent' });
assert.strictEqual(sameConversationActor, null, 'same conversation may continue through another actor');

const turnedOff = registry.setEnabled(scopeA, false);
assert.strictEqual(turnedOff.ok, true, 'explicit conversation toggle can disable ComputerUse');
assert.strictEqual(registry.state(scopeA.runtimeKey).enabled, false, 'toggle state is conversation-bound');
assert.strictEqual(registry.state(scopeA.runtimeKey).occupied, false, 'toggle-off releases the global lease');

const disabledAction = registry.authorize('click', scopeA);
assert.ok(disabledAction && disabledAction.includes('disabled'), 'disabled conversation cannot send a real desktop operation');
assert.strictEqual(registry.authorize('click', scopeA, true), null, 'dry-run validation remains available while disabled');
registry.complete('takeover_stop', scopeA);

assert.strictEqual(registry.setEnabled(scopeB, true).ok, true, 'another conversation can enable after the first releases');
assert.strictEqual(registry.authorize('observe', scopeB), null, 'new owner can observe after release');
registry.complete('takeover_stop', scopeB);
assert.strictEqual(registry.state(scopeB.runtimeKey).enabled, false, 'explicit takeover_stop turns the conversation state off');

console.log('COMPUTER_USE_SESSION_OK assertions=13');
