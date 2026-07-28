import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MemoryLabManager } from '../core/memoryLab';
import { evaluateToolPolicy } from '../core/toolPolicy';

function lines(filePath: string): Array<Record<string, unknown>> {
  return fs.readFileSync(filePath, 'utf-8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

async function run(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-memory-policy-'));
  let assertions = 0;
  try {
    const memory = new MemoryLabManager(root, 'en');
    const created = memory.update(memory.prepareUpdate({
      name: 'Quantum Memory Policy',
      description: 'Agent memory control policy',
      tags: ['#Agent', '#Memory'],
      tagPaths: [['#Agent', '#Memory']],
      content: 'Use bounded retrieval and reject stale durable memory writes.',
      reason: 'Capture the accepted memory policy.',
      source: 'memory-policy-test',
    }));
    assert.equal(created.component?.revision, 1, 'ADD starts revision history at one'); assertions++;
    assert.ok(fs.existsSync(memory.policyLogPath), 'ADD creates the append-only Policy log'); assertions++;
    assert.equal(lines(memory.policyLogPath)[0]?.operation, 'add', 'ADD records an explicit Policy action'); assertions++;

    const firstUpdatedAt = created.component?.updatedAt || '';
    assert.throws(() => memory.update(memory.prepareUpdate({
      name: 'Quantum Memory Policy',
      tags: ['#Agent', '#Memory'],
      content: 'A stale writer must not replace this memory.',
      expectedUpdatedAt: '2000-01-01T00:00:00.000Z',
    })), /changed since it was read/, 'stale UPDATE fails closed'); assertions++;

    const updated = memory.update(memory.prepareUpdate({
      name: 'Quantum Memory Policy',
      description: 'Agent memory control policy',
      tags: ['#Agent', '#Memory'],
      tagPaths: [['#Agent', '#Memory']],
      content: 'Use adaptive bounded retrieval, versioned updates, and recoverable deletion.',
      expectedUpdatedAt: firstUpdatedAt,
      reason: 'Correct and strengthen the policy.',
      source: 'memory-policy-test',
    }));
    assert.equal(updated.component?.revision, 2, 'valid UPDATE advances the revision'); assertions++;
    assert.ok(fs.readdirSync(memory.archiveDir).some(name => name.includes('quantum-memory-policy-r1')), 'UPDATE archives the prior revision'); assertions++;
    assert.deepEqual(lines(memory.policyLogPath).map(item => item.operation), ['add', 'update'], 'Policy log preserves ADD then UPDATE order'); assertions++;

    memory.update(memory.prepareUpdate({
      name: 'Cooking Notes',
      description: 'Unrelated kitchen preferences',
      tags: ['#Cooking'],
      content: 'Use less salt.',
    }));
    memory.update(memory.prepareUpdate({
      name: 'Agent Retrieval Distractor',
      description: 'An older generic agent note',
      tags: ['#Agent'],
      content: 'Generic tooling note without the durable memory policy details.',
    }));
    const query = memory.query({ query: 'adaptive durable memory policy', limit: 5, maxChars: 1200 });
    assert.equal(query.hits[0]?.slug, 'quantum-memory-policy', 'bounded RETRIEVE ranks the relevant component first'); assertions++;
    assert.ok(!query.hits.some(hit => hit.slug === 'cooking-notes'), 'FILTER excludes an unrelated component'); assertions++;
    assert.ok(query.selected <= 5 && query.hits.reduce((sum, hit) => sum + hit.content.length, 0) <= 1200, 'RETRIEVE respects count and character budgets'); assertions++;
    assert.ok(query.hits[0]?.matchedBy.includes('content') || query.hits[0]?.matchedBy.includes('description'), 'RETRIEVE explains its relevance fields'); assertions++;
    const visualization = memory.visualizationSnapshot();
    const repeatedVisualization = memory.visualizationSnapshot();
    assert.equal(visualization.componentContents['quantum-memory-policy'], 'Use adaptive bounded retrieval, versioned updates, and recoverable deletion.', 'visualization snapshot preloads component content once for memory-only interaction'); assertions++;
    assert.equal(visualization.relationVersion, repeatedVisualization.relationVersion, 'unchanged visualization relationships keep a stable version'); assertions++;
    assert.equal(Object.keys(visualization.componentContents).length, 3, 'visualization snapshot includes every indexed component without click-time reads'); assertions++;

    const currentUpdatedAt = updated.component?.updatedAt || '';
    assert.throws(() => memory.delete('Quantum Memory Policy', { expectedUpdatedAt: firstUpdatedAt }), /changed since it was read/, 'stale DELETE fails closed'); assertions++;
    const deleted = memory.delete('Quantum Memory Policy', {
      expectedUpdatedAt: currentUpdatedAt,
      reason: 'Explicitly forget obsolete test memory.',
      source: 'memory-policy-test',
    });
    assert.equal(deleted.rebuildReceipt?.operation, 'delete', 'DELETE returns a verified completion receipt'); assertions++;
    assert.ok(!deleted.index.components['quantum-memory-policy'], 'DELETE removes the active component from retrieval'); assertions++;
    assert.ok(fs.readdirSync(memory.archiveDir).filter(name => name.includes('quantum-memory-policy')).length >= 2, 'DELETE preserves the final revision in cold archive'); assertions++;
    assert.deepEqual(lines(memory.policyLogPath).filter(item => item.slug === 'quantum-memory-policy').map(item => item.operation), ['add', 'update', 'delete'], 'Policy log makes the full mutation chain replayable'); assertions++;
    const afterDeleteVisualization = memory.visualizationSnapshot();
    assert.ok(!Object.prototype.hasOwnProperty.call(afterDeleteVisualization.componentContents, 'quantum-memory-policy')
      && afterDeleteVisualization.relationVersion !== visualization.relationVersion, 'DELETE invalidates cached content and visualization relationships'); assertions++;

    assert.equal(evaluateToolPolicy({ name: 'memory_lab_query', mode: 'plan' }).allowed, true, 'Plan mode permits read-only bounded retrieval'); assertions++;
    assert.equal(evaluateToolPolicy({ name: 'memory_lab_delete', mode: 'plan' }).allowed, false, 'Plan mode blocks durable memory deletion'); assertions++;

    console.log(JSON.stringify({ ok: true, assertions, policy: ['add', 'update', 'delete'], boundedRetrieval: true }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
