import assert from 'node:assert/strict';
import { verifyModelAvailable } from '../packages/newmark-core/components/agent-api/lib/core-model.js';
import { requireVision } from '../packages/newmark-core/components/agent-api/lib/visual.js';
import { createLlmStreamFn } from '../packages/newmark-core/components/agent-api/lib/llm-seam.js';
import { enumerateModelCatalog, selectionIsListed, resolveSelection } from '../packages/newmark-core/lib/model-selection.js';

let checks = 0;
const check = (name, test) => { assert.ok(test, name); checks++; console.log(`PASS ${name}`); };
const a = { ok: true, provider: 'account-A', model: 'same-model', reasoningEffort: 'low' };
const b = { ok: true, provider: 'account-B', model: 'same-model' };
const own = { provider: a.provider, id: a.model, name: 'Same display name', inputModalities: ['text'] };
const foreign = { provider: b.provider, id: b.model, name: own.name, inputModalities: ['text', 'image'] };
for (const models of [[foreign, own], [own, foreign]]) {
  const queried = [];
  const llm = { async listModels(provider) { queried.push(provider); return models; } };
  check('availability uses the selected pair', (await verifyModelAvailable(llm, a)).verified === true);
  await assert.rejects(requireVision({ llm, attachments: { saveImages() {} } }, a), { code: 'visual_model_unavailable' });
  checks++; console.log('PASS foreign image capability cannot authorise A');
  await requireVision({ llm, attachments: { saveImages() {} } }, b);
  check('B retains its own image capability', queried.at(-1) === b.provider);
}
for (const rows of [[foreign], [{ id: a.model, inputModalities: ['image'] }]]) {
  const llm = { listModels: async () => rows };
  check('foreign or unbound row cannot authorise availability', (await verifyModelAvailable(llm, a)).verified === false);
  await assert.rejects(requireVision({ llm, attachments: { saveImages() {} } }, a), { code: 'visual_model_unavailable' });
  checks++;
}
const catalogue = await enumerateModelCatalog({
  listProviders: () => [{ id: a.provider }, { id: b.provider }],
  listModels: async provider => provider === a.provider ? [own] : [foreign],
});
check('same ID and display name retain two providers', catalogue.models.length === 2);
check('A is selectable', selectionIsListed(catalogue, a.provider, a.model));
check('B is selectable', selectionIsListed(catalogue, b.provider, b.model));
const poisoned = await enumerateModelCatalog({
  listProviders: () => [{ id: a.provider }, { id: b.provider }],
  listModels: async provider => provider === a.provider ? [foreign] : [foreign],
});
check('catalogue never relabels foreign model as A', !selectionIsListed(poisoned, a.provider, a.model));
check('A catalogue failure does not suppress B', selectionIsListed(poisoned, b.provider, b.model));
check('A failure is explicitly unverified', resolveSelection(a, poisoned).selectedListed === null && poisoned.failures[0].id === a.provider);

const routed = [];
const llm = { stream(request) { routed.push(request); return (async function* () {
  if (routed.length === 1) throw Object.assign(new Error('retry'), { code: 'TRANSPORT' });
  yield { type: 'block-end', index: 0, block: { type: 'text', text: 'OK' } };
  yield { type: 'finish', reason: { kind: 'stop' } };
})(); } };
const mutable = { ...a };
const streamA = createLlmStreamFn(llm, mutable, { sessionId: 'run-A', retry: { maxAttempts: 2, initialDelayMs: 0, jitterRatio: 0 } });
mutable.provider = b.provider; mutable.reasoningEffort = 'high';
async function turn(stream) { const events = []; for await (const event of await stream(null, { messages: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }] })) events.push(event); return events; }
await turn(streamA); await turn(streamA);
check('retry and next turn stay bound to A', routed.length === 3 && routed.every(r => r.provider === a.provider && r.model === a.model && r.reasoningEffort === 'low' && r.sessionId === 'run-A'));
await turn(createLlmStreamFn(llm, b, { sessionId: 'run-B' }));
check('new B run routes to B with separate correlation', routed.at(-1).provider === b.provider && routed.at(-1).sessionId === 'run-B');
console.log(`${checks}/${checks} provider isolation checks passed`);
