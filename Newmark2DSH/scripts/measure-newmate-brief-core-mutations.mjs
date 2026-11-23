/**
 * Mutation probe for this round's two features: does the new gate content actually FIRE?
 *
 * A gate that cannot go red is a paragraph, not an assertion. This plants one regression per
 * guarantee, runs the gate that owns it, and restores the file byte-for-byte. Every mutation must be
 * DETECTED (the gate exits non-zero) and every restore must be exact, or this probe fails.
 *
 * Run: node Newmark2DSH/scripts/measure-newmate-brief-core-mutations.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(here, '..');
const node = process.env.NEWMARK_NODE || (process.platform === 'win32' ? 'C:\\Program Files\\nodejs\\node.exe' : process.execPath);

const COMPONENT = path.join(workspace, 'packages/newmark-core/components/newmate/component.js');
const CORE = path.join(workspace, 'packages/newmark-core/components/newmate/lib/core-memory.js');
const CONTEXT = path.join(workspace, 'packages/newmark-core/components/newmate/lib/memory-context.js');
const PERSONA = path.join(workspace, 'packages/newmark-core/components/newmate/lib/persona.js');
const WORKSPACE = path.join(workspace, 'packages/newmark-core/components/newmate/lib/workspace-diff.js');
const DIGEST = path.join(workspace, 'packages/newmark-core/components/newmate/lib/change-digest.js');
const DSHDIGEST = path.join(workspace, 'packages/newmark-core/components/newmate/lib/dsh-digest.js');

const MUTATIONS = [
  {
    id: 'M1',
    claim: 'the check-in prompt is built from the survey (the brief block, not the old one-liner)',
    file: COMPONENT,
    gate: 'verify-newmate-initiative.mjs',
    find: '${briefBlock(task,dsh)}当前任务：',
    replace: '工作区最近变动（稀疏监控的浅层事实）：${store.read().watch?.lastDescription||\'（本机尚无对比结果）\'}\n当前任务：',
  },
  {
    id: 'M2',
    claim: 'the prompt states the three-step order (通读概览 → 整理判断 → 写提醒)',
    file: COMPONENT,
    gate: 'verify-newmate-initiative.mjs',
    find: '处理顺序（这就是这次主动联系的机制）：①先通读上面的工作区变动概览',
    replace: '处理顺序：①先看下面的信息',
  },
  {
    id: 'M3',
    claim: 'a core-memory write that would cross 5000 characters is refused',
    file: CORE,
    gate: 'verify-newmate-core-memory.mjs',
    find: 'if (rendered.rawChars > CORE_MEMORY_BUDGET_CHARS) {',
    replace: 'if (false) {',
  },
  {
    id: 'M4',
    claim: 'the renderer caps a hand-edited file at the budget instead of trusting the file',
    file: CORE,
    gate: 'verify-newmate-core-memory.mjs',
    find: "text = text.slice(0, CORE_MEMORY_BUDGET_CHARS - 1) + '…';",
    replace: 'text = text;',
  },
  {
    id: 'M5',
    claim: 'the payload readers carry the core memory SHAPE and never its text',
    file: CONTEXT,
    gate: 'verify-newmate-core-memory.mjs',
    find: 'coreMemory: core ? { budget: core.budget ?? null,',
    replace: 'coreMemory: core ? { text: core.text, budget: core.budget ?? null,',
  },
  {
    id: 'M7',
    claim: 'the monitor\'s visibility defaults are the raised ones (depth 6 / 512 dirs / 4096 files)',
    file: WORKSPACE,
    gate: 'verify-newmate-workspace-diff.mjs',
    find: '  maxDirectories: 512,',
    replace: '  maxDirectories: 8,',
  },
  {
    id: 'M8',
    claim: 'a parent workspace does not descend into a nested workspace (carve-out, not collapse)',
    file: WORKSPACE,
    gate: 'verify-newmate-workspace-diff.mjs',
    find: '    .map((root) => ({ root, skip: unique.filter((other) => !samePath(other, root) && insidePath(other, root)) }))',
    replace: '    .map((root) => ({ root, skip: [] }))',
  },
  {
    id: 'M9',
    claim: 'a partly walked workspace says so in the brief',
    file: DIGEST,
    gate: 'verify-newmate-workspace-diff.mjs',
    find: "  const partial = (entry) => Boolean(entry?.coverage && (entry.coverage.omittedDirectories || entry.coverage.omittedFiles));",
    replace: '  const partial = (entry) => false;',
  },
  {
    id: 'M13',
    claim: 'the check-in prompt carries the last-ten-conversations digest and asks for a suggestion',
    file: COMPONENT,
    gate: 'verify-newmate-dsh-digest.mjs',
    find: "    if(dsh)lines.push('- '+dsh.text);",
    replace: "    if(false&&dsh)lines.push('- '+dsh.text);",
  },
  {
    id: 'M14',
    claim: 'a quoted message is clipped instead of carried whole into the prompt',
    file: DSHDIGEST,
    gate: 'verify-newmate-dsh-digest.mjs',
    find: "export const DSH_DIGEST_DEFAULTS = Object.freeze({\n  maxSessions: 10,\n  excerptMessages: 2,\n  excerptChars: 90,",
    replace: "export const DSH_DIGEST_DEFAULTS = Object.freeze({\n  maxSessions: 10,\n  excerptMessages: 2,\n  excerptChars: 100000,",
  },
  {
    id: 'M11',
    claim: 'only a turn a person started may publish an interim sentence',
    file: COMPONENT,
    gate: 'verify-newmate-interim.mjs',
    find: "if (task.kind !== 'chat') return { ok: false, code: 'interim_not_conversational'",
    replace: "if (false) return { ok: false, code: 'interim_not_conversational'",
  },
  {
    id: 'M12',
    claim: 'an interim sentence is never the reply (its id is derived from the task, not equal to it)',
    file: COMPONENT,
    gate: 'verify-newmate-interim.mjs',
    find: "const id = task.id + ':interim:' + (sentSoFar.length + 1);",
    replace: "const id = task.id;",
  },
  {
    id: 'M10',
    claim: 'a silent round still records the model\'s brief on the task receipt',
    file: COMPONENT,
    gate: 'verify-newmate-initiative.mjs',
    find: 'if(t){t.suppressed=suppression;if(reply.brief)t.brief=reply.brief;}',
    replace: 'if(t)t.suppressed=suppression;',
  },
  {
    id: 'M6',
    claim: 'the persona states the core memory nature and the replace rule',
    file: PERSONA,
    gate: 'verify-newmate-core-memory.mjs',
    find: '它的性质是「稳定、核心」',
    replace: '它的性质是「一份普通记录」',
  },
];

const run = (gate) => spawnSync(node, [path.join(workspace, 'scripts', gate)], { cwd: workspace, encoding: 'utf8', timeout: 600000 });

let detected = 0;
let unprotected = [];
for (const mutation of MUTATIONS) {
  const original = fs.readFileSync(mutation.file, 'utf8');
  if (!original.includes(mutation.find)) {
    unprotected.push(mutation.id + ' (anchor not found: ' + mutation.find.slice(0, 60) + ')');
    console.log('not ok - ' + mutation.id + ' anchor not found; the mutation proves nothing');
    continue;
  }
  fs.writeFileSync(mutation.file, original.replace(mutation.find, mutation.replace));
  let result;
  try { result = run(mutation.gate); }
  finally { fs.writeFileSync(mutation.file, original); }
  const restored = fs.readFileSync(mutation.file, 'utf8') === original;
  const red = result && result.status !== 0;
  if (red && restored) { detected += 1; console.log('ok - ' + mutation.id + ' detected (' + mutation.claim + ') [' + mutation.gate + ']'); }
  else { unprotected.push(mutation.id + (red ? ' (restore not exact)' : ' (gate stayed green)')); console.log('not ok - ' + mutation.id + ' ' + (red ? 'restore not exact' : 'NOT detected') + ' (' + mutation.claim + ')'); }
}

console.log('');
console.log('SUMMARY mutations=' + MUTATIONS.length + ' detected=' + detected + ' unprotected=' + (unprotected.length ? unprotected.join('; ') : 'none'));
if (unprotected.length) process.exit(1);
console.log('PASS');
