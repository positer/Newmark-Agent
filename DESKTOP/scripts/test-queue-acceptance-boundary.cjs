'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadProduction } = require('./test-queue-continuation-identity.cjs');

const tick = () => new Promise(resolve => setImmediate(resolve));
async function waitFor(predicate) {
  for (let i = 0; i < 200 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  if (!predicate()) throw Error('Acceptance fixture did not reach its expected boundary');
}

async function run(options = {}) {
  const loadedAgent = loadProduction('core/agent.ts', options.agentSource);
  const loadedKernel = loadProduction('core/conversationKernel.ts', options.kernelSource);
  const { Agent } = loadedAgent.exports;
  const { ConversationKernel } = loadedKernel.exports;
  const report = {
    boundary: 'Actual source Kernel scheduling and Agent durable persistence. Attachment validation and user/title gates use actual Agent.process. Title provider responses and formal execution are controlled; no external request, desktop state or dist write.',
    agentSha256: loadedAgent.sha256, kernelSha256: loadedKernel.sha256, checks: [], captures: [],
  };
  const check = (name, passed, detail) => {
    report.checks.push({ name, passed: !!passed, ...(!passed ? { detail } : {}) });
    console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`);
  };

  async function scenario(pathKind, failure) {
    const prefix = path.join(os.tmpdir(), 'newmark-queue-acceptance-');
    const directory = fs.mkdtempSync(prefix);
    const target = { workspaceId: 'fixture', conversationId: 'acceptance', workspace: {
      id: 'fixture', name: 'fixture', path: path.join(directory, 'workspace'), isInternal: false, kind: 'local',
    } };
    fs.mkdirSync(target.workspace.path, { recursive: true });
    const submittedAt = '2026-09-06T00:00:00Z';
    let kernel, runner, releaseInitial, rejectHeld, queueCalls = 0, recover = false;
    let titleAttempts = 0, formalAttempts = 0, attachmentTokens;
    const notifications = [], events = [];
    const isTitle = failure === 'actual-title-gate';
    class Probe extends Agent {
      modelIsUnavailable() { return false; }
      activeModelName() { return 'fixture-model'; }
      engineModel() {
        if (!isTitle) throw Error('No external model access is permitted by this fixture');
        return { name: 'controlled-title-provider' };
      }
      async startFirstInputConversationTitle() { titleAttempts++; return false; }
      async processOpencode() { formalAttempts++; throw Error('Fixture forbids formal provider execution'); }
      notifyAgentKernelUserMessageStart(content, id) {
        if (content !== 'initial fixture') notifications.push({ content, id: id || null });
        return super.notifyAgentKernelUserMessageStart(content, id);
      }
      abortActiveKernelRun(reason) {
        if (rejectHeld) { const reject = rejectHeld; rejectHeld = null; reject(Error(`Fixture cancellation: ${reason}`)); }
        return true;
      }
      async process(message) {
        const text = typeof message === 'string' ? message : message.text;
        if (text === 'initial fixture') {
          this.notifyAgentKernelUserMessageStart(text);
          return new Promise(resolve => { releaseInitial = () => resolve([]); });
        }
        queueCalls++;
        if (isTitle) return super.process(message);
        if (recover) {
          this.notifyAgentKernelUserMessageStart(text, typeof message === 'string' ? undefined : message.clientMessageId);
          return [];
        }
        if (failure === 'resolve-before-accept') return [{ type: 'text', text: 'Controlled pre-acceptance rejection' }];
        if (failure === 'actual-attachment-rejection') {
          const input = typeof message === 'string' ? { text: message } : message;
          attachmentTokens = await super.process({ ...input, attachments: [{
            id: 'invalid-fixture-reference', origin: 'user', name: 'missing.png', mimeType: 'image/png',
            sha256: 'not-a-sha256', assetPath: 'does-not-exist', byteLength: 1, width: 1, height: 1, createdAt: submittedAt,
          }] });
          return attachmentTokens;
        }
        if (failure === 'foreign-guide-notification') {
          this.notifyAgentKernelUserMessageStart(text, 'unrelated-guide-id');
          throw Error('Controlled failure before this queue row was accepted');
        }
        if (failure === 'stop-after-accept' || failure === 'error-after-accept') {
          this.notifyAgentKernelUserMessageStart(text, typeof message === 'string' ? undefined : message.clientMessageId);
        }
        if (failure === 'error-after-accept') throw Error('Controlled provider error after acceptance');
        return new Promise((_, reject) => { rejectHeld = reject; });
      }
    }
    const capture = () => ({
      queueCalls, titleAttempts, formalAttempts,
      pendingIds: kernel.queueItems(target).map(item => item.id),
      durableIds: runner.conversationContinuations().map(item => item.clientMessageId),
      paused: kernel.snapshot(target).queuePaused,
      notifications: notifications.slice(),
      users: runner.chatMessages.filter(item => item.role === 'user').map(item => ({
        messageId: item.messageId, clientMessageId: item.clientMessageId, content: item.content,
      })),
    });
    const label = `${pathKind}/${failure}`;
    try {
      const host = new Agent(directory, { agentOnly: true });
      kernel = new ConversationKernel(directory, host, null, { createRunner: () => (runner = new Probe(directory, { agentOnly: true })) });
      kernel.subscribe(event => { if (event.type === 'queue_update') events.push(structuredClone(event)); });
      const work = kernel.prompt('initial fixture', target, {
        mode: 'build', model: 'fixture-model', intelligence: 'medium', inputMode: 'next', engine: 'opencode',
      }).catch(error => ({ error: error.message }));
      await waitFor(() => !!releaseInitial);
      kernel.queueAction(target, 'set_pause', { paused: pathKind === 'scheduled' });
      kernel.queueAction(target, 'enqueue', { id: 'original-id', text: 'same user input', requestedMode: 'build', createdAt: submittedAt });
      const observers = runner.agentKernelUserMessageStartSubscribers.length;
      releaseInitial();
      if (pathKind === 'scheduled') { await work; kernel.queueAction(target, 'set_pause', { paused: false }); }
      await waitFor(() => queueCalls >= 1);
      if (failure === 'archive-before-accept') { await kernel.prepareForArchive(target); kernel.finishArchive(target, false); }
      if (failure === 'stop-before-accept' || failure === 'stop-after-accept') kernel.requestStop(target);
      await waitFor(() => !kernel.isRunning(target));
      await work; await tick(); await tick();
      const first = capture();
      const accepted = failure === 'stop-after-accept' || failure === 'error-after-accept';
      const expectedIds = accepted ? [] : ['original-id'];
      check(`${label}: pending and durable agree on actual acceptance`,
        JSON.stringify(first.pendingIds) === JSON.stringify(expectedIds) && JSON.stringify(first.durableIds) === JSON.stringify(expectedIds), first);
      if (!accepted) {
        check(`${label}: unaccepted input remains paused and manageable`, first.paused && queueCalls === 1, first);
        const row = kernel.queueItems(target)[0];
        check(`${label}: recovery retains submission metadata`, row?.text === 'same user input' && row?.createdAt === submittedAt && row?.requestedMode === 'build', row);
        const published = events.at(-1);
        check(`${label}: recovery is published to consumers`, published?.queuePaused
          && JSON.stringify(published.queueItems?.map(item => item.id)) === '["original-id"]', published);
      }
      check(`${label}: temporary acceptance observers are released`, runner.agentKernelUserMessageStartSubscribers.length === observers);
      if (failure === 'actual-attachment-rejection') {
        check(`${label}: actual Agent rejects invalid durable attachment before acceptance`,
          attachmentTokens?.some(token => token.text?.includes('[Attachment rejected]')) && !notifications.length && !formalAttempts, attachmentTokens);
      }
      if (failure === 'foreign-guide-notification') {
        check(`${label}: same text under another Guide id cannot accept this row`, notifications.length === 1 && notifications[0].id === 'unrelated-guide-id', notifications);
      }
      recover = true;
      kernel.queueAction(target, 'set_pause', { paused: false });
      await tick(); await waitFor(() => !kernel.isRunning(target));
      if (!isTitle) {
        // A Next row now starts a fresh deferred Build after the previous one
        // settles; wait for the authoritative queue projection to drain.
        for (let wait = 0; wait < 200 && kernel.queueItems(target).length > 0; wait += 1) {
          await new Promise(resolve => setTimeout(resolve, 5));
        }
      }
      await tick(); await tick();
      const final = capture();
      if (isTitle) {
        check(`${label}: each explicit retry reaches the title gate and starts no formal request`, titleAttempts === 2 && formalAttempts === 0 && queueCalls === 2, final);
        check(`${label}: retry preserves one stable ordinary user message`, first.users.length === 1 && final.users.length === 1 && first.users[0].messageId === final.users[0].messageId, { first, final });
        check(`${label}: repeated title failure keeps the same durable input`, final.paused && JSON.stringify(final.pendingIds) === '["original-id"]' && JSON.stringify(final.durableIds) === '["original-id"]', final);
      } else {
        const blockedByCancel = failure === 'stop-before-accept' || failure === 'archive-before-accept';
        const resumeOk = blockedByCancel
          ? queueCalls === 1 && JSON.stringify(final.pendingIds) === '["original-id"]' && JSON.stringify(final.durableIds) === '["original-id"]'
          : queueCalls === (accepted ? 1 : 2) && !final.pendingIds.length && !final.durableIds.length;
        check(`${label}: resume never replays accepted input; an unaccepted row runs once or stays blocked by an explicit cancel`, resumeOk, final);
        check(`${label}: resume leaves no temporary observer behind`, runner.agentKernelUserMessageStartSubscribers.length === observers);
      }
      report.captures.push({ label, first, final });
    } catch (error) {
      check(`${label}: fixture reaches all required boundaries`, false, error.stack || String(error));
    } finally {
      releaseInitial?.(); rejectHeld?.(Error('Fixture cleanup')); await tick(); kernel?.flushPersistence();
      const resolved = path.resolve(directory);
      if (!resolved.startsWith(prefix)) throw Error('Refusing unexpected fixture cleanup path');
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
  for (const pathKind of ['scheduled', 'inline']) {
    for (const failure of [
      'resolve-before-accept', 'actual-attachment-rejection', 'stop-before-accept', 'stop-after-accept',
      'archive-before-accept', 'foreign-guide-notification', 'error-after-accept', 'actual-title-gate',
    ]) await scenario(pathKind, failure);
  }

  // A canonical ordinary submission may retain the transport id as well as
  // the explicit user id. It must still pass the ordinary first-title gate.
  const ordinaryPrefix = path.join(os.tmpdir(), 'newmark-ordinary-acceptance-');
  const ordinaryDirectory = fs.mkdtempSync(ordinaryPrefix);
  let ordinaryKernel, ordinaryRunner, titleAttempts = 0, formalAttempts = 0, acceptedNotifications = 0;
  try {
    const target = { workspaceId: 'ordinary', conversationId: 'identity', workspace: {
      id: 'ordinary', name: 'ordinary', path: path.join(ordinaryDirectory, 'workspace'), isInternal: false, kind: 'local',
    } };
    fs.mkdirSync(target.workspace.path, { recursive: true });
    class OrdinaryProbe extends Agent {
      modelIsUnavailable() { return false; }
      activeModelName() { return 'fixture-model'; }
      engineModel() { return { name: 'controlled-title-provider' }; }
      async startFirstInputConversationTitle() { titleAttempts++; return false; }
      async processOpencode() { formalAttempts++; throw Error('Fixture forbids formal provider execution'); }
      notifyAgentKernelUserMessageStart(content, id) { acceptedNotifications++; return super.notifyAgentKernelUserMessageStart(content, id); }
    }
    ordinaryKernel = new ConversationKernel(ordinaryDirectory, new Agent(ordinaryDirectory, { agentOnly: true }), null, {
      createRunner: () => (ordinaryRunner = new OrdinaryProbe(ordinaryDirectory, { agentOnly: true })),
    });
    const runOptions = { mode: 'build', model: 'fixture-model', intelligence: 'medium', inputMode: 'next', engine: 'opencode' };
    const errors = [];
    const send = async id => {
      try { await ordinaryKernel.prompt({ text: 'same ordinary text', clientMessageId: id, userMessageId: id }, target, runOptions); }
      catch (error) { errors.push(error.message); }
    };
    await send('ordinary-id'); await send('ordinary-id');
    const retriedUsers = ordinaryRunner.chatMessages.filter(item => item.role === 'user');
    const retriedHistory = ordinaryRunner.history.filter(item => item.role === 'user' && item.user_message_id === 'ordinary-id');
    check('ordinary dual identity: both retries reach the title gate before formal acceptance', titleAttempts === 2 && formalAttempts === 0 && acceptedNotifications === 0 && errors.length === 2, { titleAttempts, formalAttempts, acceptedNotifications, errors });
    check('ordinary dual identity: explicit retry upserts one ordinary user and history entry', retriedUsers.length === 1 && retriedUsers[0].messageId === 'ordinary-id' && !retriedUsers[0].clientMessageId && retriedHistory.length === 1, { retriedUsers, retriedHistory });
    await send('different-submission-id');
    const distinctUsers = ordinaryRunner.chatMessages.filter(item => item.role === 'user');
    check('ordinary dual identity: identical text under different submission ids remains distinct', distinctUsers.length === 2 && new Set(distinctUsers.map(item => item.messageId)).size === 2 && titleAttempts === 3 && formalAttempts === 0, { distinctUsers, titleAttempts, formalAttempts });
    report.captures.push({ label: 'ordinary-dual-identity', titleAttempts, formalAttempts, acceptedNotifications, users: distinctUsers });
  } catch (error) {
    check('ordinary dual identity: fixture reaches all required boundaries', false, error.stack || String(error));
  } finally {
    await tick(); ordinaryKernel?.flushPersistence();
    if (!path.resolve(ordinaryDirectory).startsWith(ordinaryPrefix)) throw Error('Refusing unexpected fixture cleanup path');
    fs.rmSync(ordinaryDirectory, { recursive: true, force: true });
  }
  report.checksPassed = report.checks.filter(item => item.passed).length;
  report.checksFailed = report.checks.length - report.checksPassed;
  report.passed = report.checksFailed === 0;
  if (options.reportPath) fs.writeFileSync(options.reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, checksPassed: report.checksPassed, checksFailed: report.checksFailed }));
  if (!report.passed) throw Error('Queue acceptance boundary regression failed');
  return report;
}
module.exports = { run };
if (require.main === module) {
  const args = process.argv.slice(2);
  const value = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  run({ reportPath: value('--report'), agentSource: value('--agent-source'), kernelSource: value('--kernel-source') })
    .catch(error => { console.error(error.stack || error); process.exitCode = 1; });
}
