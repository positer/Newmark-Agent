#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const workerSource = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { Agent, markRuntimeLifecycleClean } = require(process.argv[2]);
const [role, root, workspacePath, conversationId, runId] = process.argv.slice(3);
const workspace = { id: 'workrun-merge', name: 'workrun-merge', path: workspacePath, isInternal: false, hostBinding: '', icon: '', kind: 'local' };
const agent = new Agent(root, { agentOnly: true });
agent.workspace.current = workspace;
function diskRun() {
  const directory = path.join(workspacePath, 'conversations');
  const index = JSON.parse(fs.readFileSync(path.join(directory, 'state.json'), 'utf8'));
  const entry = Object.entries(index.conversations || {}).find(([key]) => key.endsWith('-' + conversationId))?.[1];
  const shard = entry?.shard ? JSON.parse(fs.readFileSync(path.join(directory, 'shards', entry.shard), 'utf8')) : null;
  const run = shard?.workRuns?.find(item => item.runId === runId);
  return { status: run?.status, endedAt: run?.endedAt, updatedAt: entry?.updatedAt, workRunCount: entry?.workRunCount };
}
if (role === 'owner') {
  agent.setConversation(conversationId);
  agent.beginConversationWorkRun(runId, { workspaceId: workspace.id, conversationId }, '2026-09-26T00:00:00.000Z');
  agent.saveWorkspaceConversationState(true);
  console.log('READY ' + process.pid);
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    input += chunk;
    for (;;) {
      const newline = input.indexOf('\n');
      if (newline < 0) break;
      const command = input.slice(0, newline).trim();
      input = input.slice(newline + 1);
      if (command === 'SAVE') {
        const beforeSave = agent.workRuns.find(run => run.runId === runId);
        if (beforeSave?.status !== 'running') throw new Error('stale owner no longer holds a running snapshot: ' + beforeSave?.status);
        console.log('STALE_INPUT ' + JSON.stringify({ status: beforeSave.status, sequence: beforeSave.sequence, eventCount: beforeSave.events.length, disk: diskRun() }));
        agent.chatMessages.push({ messageId: 'stale-peer-independent-update', role: 'user', content: 'Independent conversation update', mode: 'chat', model: '', timestamp: new Date().toISOString() });
        agent.history.push({ role: 'user', content: 'Independent conversation update' });
        agent.saveWorkspaceConversationState(true);
        console.log('STALE_DISK_AFTER ' + JSON.stringify(diskRun()));
        console.log('STALE_SAVED');
      } else if (command === 'METADATA_ONLY') {
        agent.chatMessages = [];
        agent.history = [];
        agent.saveWorkspaceConversationState(true);
        console.log('METADATA_ONLY_SAVED');
      } else if (command === 'EXIT') {
        try { markRuntimeLifecycleClean(root, 'main'); } catch {}
        process.exit(0);
      }
    }
  });
} else if (role === 'finisher') {
  agent.setConversationFromStorage(conversationId);
  const before = agent.getConversationSnapshot(conversationId).workRuns.find(run => run.runId === runId);
  if (before?.status !== 'running') throw new Error('finisher did not load the active run: ' + before?.status);
  if (!agent.finishConversationWorkRun(runId, 'completed', new Date().toISOString())) throw new Error('finisher rejected terminal transition');
  console.log('FINISHED ' + process.pid);
  try { markRuntimeLifecycleClean(root, 'main'); } catch {}
  process.exit(0);
} else {
  throw new Error('unknown worker role: ' + role);
}
`;

function waitForLine(child, prefix, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => done(new Error(`Timed out waiting for ${prefix}; output=${buffer.slice(-1000)}`)), timeoutMs);
    const onData = chunk => {
      buffer += chunk.toString();
      const line = buffer.split(/\r?\n/).find(item => item.startsWith(prefix));
      if (line) done(null, line);
    };
    const onExit = (code, signal) => done(new Error(`Worker exited before ${prefix}: code=${code}, signal=${signal}, output=${buffer.slice(-1000)}`));
    const onError = error => done(error);
    function done(error, line) {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.off('exit', onExit);
      child.off('error', onError);
      if (error) reject(error); else resolve(line);
    }
    child.stdout.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

function waitForExit(child, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    const timer = setTimeout(() => reject(new Error('Worker failed to exit')), timeoutMs);
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
}

function readPersistedConversation(workspacePath, conversationId) {
  const directory = path.join(workspacePath, 'conversations');
  const index = JSON.parse(fs.readFileSync(path.join(directory, 'state.json'), 'utf8'));
  const [key, entry] = Object.entries(index.conversations || {}).find(([candidate]) => candidate.endsWith('-' + conversationId)) || [];
  assert.ok(key && entry?.shard, 'conversation index contains the expected shard');
  return JSON.parse(fs.readFileSync(path.join(directory, 'shards', entry.shard), 'utf8'));
}

function readPersistedRun(root, workspacePath, conversationId, runId) {
  return readPersistedConversation(workspacePath, conversationId).workRuns.find(run => run.runId === runId);
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-cross-process-workrun-'));
  const workspacePath = path.join(root, 'workspace');
  const conversationId = 'parallel-conversation';
  const runId = 'parallel-work-run';
  const modulePath = path.resolve(__dirname, '..', 'dist', 'core', 'agent.js');
  const workerPath = path.join(root, 'worker.cjs');
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.writeFileSync(workerPath, workerSource, 'utf8');
  let owner;
  let finisher;
  try {
    owner = spawn(process.execPath, [workerPath, modulePath, 'owner', root, workspacePath, conversationId, runId], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const ownerErrors = [];
    let ownerOutput = '';
    owner.stdout.on('data', chunk => { ownerOutput += chunk.toString(); });
    owner.stderr.on('data', chunk => ownerErrors.push(chunk.toString()));
    await waitForLine(owner, 'READY ');

    finisher = spawn(process.execPath, [workerPath, modulePath, 'finisher', root, workspacePath, conversationId, runId], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const finisherErrors = [];
    finisher.stderr.on('data', chunk => finisherErrors.push(chunk.toString()));
    await waitForLine(finisher, 'FINISHED ');
    assert.equal(await waitForExit(finisher), 0, 'finisher exits successfully after committing completed state');
    if (finisherErrors.length) throw new Error(finisherErrors.join(''));
    assert.equal(readPersistedRun(root, workspacePath, conversationId, runId)?.status, 'completed',
      'the terminal owner state reaches disk before the stale writer resumes');

    await new Promise(resolve => setTimeout(resolve, 10));
    owner.stdin.write('SAVE\n');
    await waitForLine(owner, 'STALE_SAVED');
    const afterStaleSaveShard = readPersistedConversation(workspacePath, conversationId);
    const afterStaleSave = afterStaleSaveShard.workRuns.find(run => run.runId === runId);
    assert.match(ownerOutput, /STALE_INPUT \{"status":"running"/, 'the competing writer retains its stale running ledger');
    assert.equal(afterStaleSave?.status, 'completed',
      'a separate process with an older same-count ledger cannot overwrite a terminal run with running');
    assert.ok(afterStaleSave?.endedAt, 'the terminal timestamp survives the cross-process merge');
    assert.ok(afterStaleSaveShard.chatMessages.some(message => message.messageId === 'stale-peer-independent-update'),
      'the newer independent transcript update is retained alongside the protected terminal status');

    owner.stdin.write('METADATA_ONLY\n');
    await waitForLine(owner, 'METADATA_ONLY_SAVED');
    const afterMetadataOnlySave = readPersistedConversation(workspacePath, conversationId);
    const afterMetadataOnlyRun = afterMetadataOnlySave.workRuns.find(run => run.runId === runId);
    assert.equal(afterMetadataOnlyRun?.status, 'completed',
      'a transcript-free metadata save also preserves the persisted terminal ledger');
    assert.ok(afterMetadataOnlySave.chatMessages.some(message => message.messageId === 'stale-peer-independent-update'),
      'a transcript-free metadata save keeps the shard-backed transcript intact');
    if (ownerErrors.length) throw new Error(ownerErrors.join(''));

    owner.stdin.write('EXIT\n');
    assert.equal(await waitForExit(owner), 0, 'stale owner exits cleanly');
    console.log('cross-process work-run persistence verification passed');
    console.log(ownerOutput.trim());
  } finally {
    for (const child of [finisher, owner]) {
      if (child && child.exitCode === null) child.kill();
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
