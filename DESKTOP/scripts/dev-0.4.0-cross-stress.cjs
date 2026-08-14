'use strict';

/**
 * dev-0.4.0 全维度交叉压力测试编排器（开发端）。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const appRoot = path.resolve(__dirname, '..');
const distTests = path.join(appRoot, 'dist', 'tests');

const DIMENSIONS = [
  { id: 'cache-hit-long', label: 'cache-hit long conversation', cmds: [
    ['node', ['dist/tests/normalChatRegressionVerify.js']],
    ['node', ['dist/tests/performanceOptimizationVerify.js']],
  ] },
  { id: 'cache-hit-post-compress', label: 'post-compress + compression cache hit', cmds: [
    ['node', ['dist/tests/contextCompressionApiVerify.js']],
    ['node', ['dist/tests/compressionFidelityVerify.js']],
    ['node', ['scripts/compression-pressure-stress.cjs']],
  ] },
  { id: 'conversation-persistence', label: 'long conversation mode switch + resume', cmds: [
    ['node', ['dist/tests/normalChatRegressionVerify.js']],
    ['node', ['scripts/mode-conversation-state-stress.cjs']],
    ['node', ['dist/tests/conversationBranchStressVerify.js']],
  ] },
  { id: 'next-guide-interrupt', label: 'Next/Guide + interrupt', cmds: [
    ['node', ['dist/tests/guideWorkRunVerify.js']],
    ['node', ['dist/tests/guideUiReconcileVerify.js']],
    ['node', ['dist/tests/tuiStopRaceVerify.js']],
  ] },
  { id: 'flow-pause-resume', label: 'Flow pause/resume', cmds: [
    ['node', ['scripts/flow-pause-stop-draft-stress.cjs']],
  ] },
  { id: 'archive-response', label: 'archive rapid + click latency', cmds: [
    ['node', ['dist/tests/conversationArchiveConcurrencyVerify.js']],
    ['node', ['dist/tests/conversationArchiveRuntimeVerify.js']],
  ] },
  { id: 'copilot', label: 'copilot latency + cache hit', cmds: [
    ['node', ['dist/tests/editorCompletionVerify.js']],
    ['node', ['dist/tests/editorLifecycleVerify.js']],
  ] },
  { id: 'browseruse-computeruse', label: 'BrowserUse + ComputerUse stability', cmds: [
    ['node', ['dist/tests/browserUseVerify.js']],
    ['node', ['dist/tests/computerUseSessionVerify.js']],
    ['node', ['dist/tests/computerUsePerformanceVerify.js']],
  ] },
  { id: 'new-tools', label: 'new tools persistence + stability (incl. goal_manage/conversation_rename)', cmds: [
    ['node', ['dist/tests/toolConcurrencyVerify.js']],
    ['node', ['dist/tests/toolProcessVerify.js']],
    ['node', ['dist/tests/toolProvisioningVerify.js']],
    ['node', ['dist/tests/toolchainExposureV2Verify.js']],
    ['node', ['dist/tests/goalConversationToolVerify.js']],
  ] },
  { id: 'history-read', label: 'build_history_query bounded historical read (cache-friendly)', cmds: [
    ['node', ['dist/tests/goalConversationToolVerify.js']],
  ] },
  { id: 'web-reachability', label: 'WebFetch reachability + concrete web search task (real network)', cmds: [
    ['node', ['dist/tests/webReachabilityVerify.js']],
  ] },
  { id: 'conversation-switch-id', label: 'conversation switch + id tracking', cmds: [
    ['node', ['dist/tests/conversationBranchStressVerify.js']],
    ['node', ['dist/tests/queueAttachmentIsolationVerify.js']],
  ] },
  { id: 'branch-runtime', label: 'branch runtime switching + continuation position correctness', cmds: [
    ['node', ['dist/tests/branchRuntimeSwitchingVerify.js']],
    ['node', ['dist/tests/branchStressComprehensiveVerify.js']],
    ['node', ['dist/tests/branchContinuationPositionVerify.js']],
  ] },
  { id: 'branch-communication', label: 'branch communication mode + branch create/send/read/list + deferred history unload', cmds: [
    ['node', ['dist/tests/branchStressComprehensiveVerify.js']],
    ['node', ['dist/tests/verify.js']],
  ] },
  { id: 'gui-tui-cli', label: 'GUI-TUI-CLI shared backend + concurrency', cmds: [
    ['node', ['dist/tests/guiTuiCliSharedBackendStressVerify.js']],
    ['node', ['dist/tests/tuiLauncherVerify.js']],
  ] },
  { id: 'cold-start', label: 'cold start conversation flow + perf', cmds: [
    ['node', ['dist/tests/startupPrewarmVerify.js']],
    ['node', ['dist/tests/runtimePoolCapacityVerify.js']],
  ] },
  { id: 'subagent', label: 'SubAgent persistence/binding/communication', cmds: [
    ['node', ['dist/tests/dev008-subagent.js']],
    ['node', ['dist/tests/dev018ModeSubagentStressVerify.js']],
  ] },
];

const onlySet = new Set(String(process.env.ONLY || '').split(',').map(s => s.trim()).filter(Boolean));
const results = [];

function runCmd(cmd, args) {
  const start = Date.now();
  const r = spawnSync(cmd, args, { cwd: appRoot, encoding: 'utf8', timeout: 300000, windowsHide: true });
  return { ok: r.status === 0, elapsed: Date.now() - start, status: r.status, out: (r.stdout || ''), err: (r.stderr || '') };
}

function main() {
  console.log('dev-0.4.0 cross-stress (dev side, mock provider)');
  console.log('====================================================');
  if (!fs.existsSync(distTests)) {
    console.error('dist/tests not found: ' + distTests + ' — run npm run build first.');
    process.exit(2);
  }
  let passCount = 0, failCount = 0;
  for (const dim of DIMENSIONS) {
    if (onlySet.size && !onlySet.has(dim.id)) continue;
    console.log('\n### [' + dim.id + '] ' + dim.label);
    let dimOk = true;
    for (const [cmd, args] of dim.cmds) {
      const name = args.join(' ');
      const r = runCmd(cmd, args);
      console.log('  ' + (r.ok ? 'PASS' : 'FAIL') + ' ' + name + ' (' + (r.elapsed/1000).toFixed(1) + 's)' + (r.ok ? '' : ' status=' + r.status));
      if (!r.ok) {
        dimOk = false;
        const detail = (r.err || r.out || '').split('\n').filter(l => /fail|error|assert|actual|expected/i.test(l)).slice(0, 6).join('\n');
        if (detail) console.log('      ' + detail.split('\n').join('\n      '));
      }
    }
    results.push({ id: dim.id, label: dim.label, ok: dimOk });
    if (dimOk) passCount++; else failCount++;
  }
  console.log('\n\n========== summary ==========');
  for (const r of results) console.log('  ' + (r.ok ? 'PASS' : 'FAIL') + '  [' + r.id + '] ' + r.label);
  console.log('\ndimensions: ' + passCount + ' pass / ' + failCount + ' fail / ' + results.length + ' total');
  if (failCount > 0) { console.log('\nfailed:'); results.filter(r => !r.ok).forEach(r => console.log('  - [' + r.id + '] ' + r.label)); process.exit(1); }
  console.log('\nall dimensions passed');
}

main();
