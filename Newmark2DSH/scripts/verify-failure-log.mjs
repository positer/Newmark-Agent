/**
 * Newmark Core — the **failure-log gate**.
 *
 * The user's instruction is one sentence and two obligations: 所有失败行为都要在.Newmark保存报错
 * 打印 — every failure behaviour is saved into `.Newmark` AND printed. This gate is what makes
 * that a property of the bundle rather than a claim about it, and it is deliberately about the
 * FAILING paths: every other gate in this repository drives the happy path or a refusal, and a
 * failure log is the one feature whose correctness cannot be seen from a passing run.
 *
 * ## What it asserts, and how each assertion can fail
 *
 *   - `lib/errors.js` itself: the line shape, the append (twice, and the first line is still
 *     there), a directory that does not exist yet, a root that cannot be written, a logger that
 *     throws, a message that cannot be serialised. Each one is driven, not restated.
 *   - **the core row**: a model write whose edit throws, a model write that returns but does not
 *     take, and — the other direction — a model write that SUCCEEDS and must therefore write
 *     nothing at all. That last one is the 0.2.4 defect written as an assertion: an operation
 *     that succeeded and reported failure is worse than a plain failure, because the obvious
 *     response is to do it again.
 *   - **composition**: a component that cannot be imported at all, in a copy of the package, so
 *     `core/compose` is reached by a real failed import rather than by reading the source.
 *   - **ComputerUse**: a backend that answers an error, recorded with the backend's own
 *     `error_code`; and a backend call that succeeds, recorded as nothing.
 *
 * ## What this gate no longer drives, and why
 *
 * It used to drive `core/preset-switch`: a refused profile-patch write, recorded under the
 * module's own refusal code (`selector_entry_absent`, `unparseable_source`, …) and compared
 * against the code the route answered with. The user removed that switch — 去除插件配置中的预设
 * dev preset插件开关行，不用插件配置页调控默认预设 — and the section went with it. It is not
 * replaced by a restatement: the property it held ("a recorded failure carries the caller's own
 * code, never a summary") is still held by `core/model-write` and `computeruse/backend` below,
 * each of which records a code the caller was given.
 *
 * ## The live root is never written
 *
 * Every failure below is driven against a `mkdtemp` root, because the log lives at
 * `<root>/errors.jsonl` and the user's real root is `~/.Newmark`. The live file is digested
 * before and after and the gate ABORTS if it changed — a test artefact in the user's home would
 * be a worse outcome than a red gate.
 *
 * Run: node Newmark2DSH/scripts/verify-failure-log.mjs
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mountCore, callRoute } from './lib/mount-newmark-core.mjs';
import {
  ERROR_LOG_FILENAME,
  causeChain,
  createErrorLog,
  errorLogPath,
} from '../packages/newmark-core/lib/errors.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(here, '..');
const packagesDir = path.join(workspace, 'packages');
const pkg = path.join(packagesDir, 'newmark-core');

const LIVE_ROOT = path.join(os.homedir(), '.Newmark');
const LIVE_LOG = path.join(LIVE_ROOT, ERROR_LOG_FILENAME);

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  const n = passed + failed + 1;
  if (condition) {
    passed += 1;
    console.log(`ok ${n} - ${name}`);
    return true;
  }
  failed += 1;
  failures.push(name);
  console.log(`not ok ${n} - ${name}`);
  if (detail !== undefined) console.log(`  ${detail}`);
  return false;
}

const digest = (file) => (fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : '(absent)');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nmc-faillog-'));
/**
 * The log's text, or `''` when there is no log.
 *
 * Read through a helper rather than straight off disk on purpose: this gate exists to run against
 * a BROKEN log as often as a working one, and a `readFileSync` that throws would end the run
 * instead of reporting the assertion that failed. A gate that crashes is not a report.
 */
const textOf = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
const lines = (file) =>
  textOf(file)
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

const liveBefore = digest(LIVE_LOG);

try {
  /* ============================================ the shared module, on its own === */

  console.log('# lib/errors.js — the one implementation every half reaches');

  const moduleSource = fs.readFileSync(path.join(pkg, 'lib', 'errors.js'), 'utf8');
  check(
    'the log is placed by the root rule, never by a literal path',
    errorLogPath(path.join(scratch, 'user')) === path.join(scratch, 'user', ERROR_LOG_FILENAME) &&
      !/12252/.test(moduleSource) &&
      !/[A-Za-z]:\\+Users/.test(moduleSource) &&
      moduleSource.includes("path.join(path.resolve(root), ERROR_LOG_FILENAME)"),
    'a literal path would work on exactly one machine, and a redirected NEWMARK_USER_ROOT must move the log with the store',
  );
  check(
    'a root that is empty names no path rather than guessing one',
    errorLogPath('') === '' && errorLogPath('   ') === '' && errorLogPath(undefined) === '',
    JSON.stringify([errorLogPath(''), errorLogPath('   '), errorLogPath(undefined)]),
  );

  const unitRoot = path.join(scratch, 'unit');
  const printed = [];
  const log = createErrorLog({ root: unitRoot, logger: { error: (message) => printed.push(String(message)) } });
  check(
    'the file is <root>/errors.jsonl, beside the store rather than inside it',
    log.path === path.join(unitRoot, ERROR_LOG_FILENAME) && path.basename(log.path) === 'errors.jsonl',
    log.path,
  );

  const firstWrite = log.record({
    where: 'memorylab/judgement',
    code: 'run_timeout',
    message: '运行在 300000 ms 内没有结束，已被中止',
    detail: 'Error: the run did not settle <- Error: the bound fired',
    fields: { status: 'timeout', exit: null, turns: 0 },
  });
  check(
    'the directory did not exist and was created: the write still lands',
    firstWrite.ok === true && fs.existsSync(log.path),
    JSON.stringify(firstWrite),
  );
  const firstText = textOf(log.path);
  const firstLine = lines(log.path)[0] ?? {};
  check(
    'a line carries at, where, code and message — and detail with the cause chain where there is one',
    typeof firstLine.at === 'string' &&
      !Number.isNaN(Date.parse(firstLine.at)) &&
      firstLine.where === 'memorylab/judgement' &&
      firstLine.code === 'run_timeout' &&
      firstLine.message === '运行在 300000 ms 内没有结束，已被中止' &&
      firstLine.detail === 'Error: the run did not settle <- Error: the bound fired',
    JSON.stringify(firstLine),
  );
  check(
    'the caller’s own fields ride along, so the run’s exit and status need no second lookup',
    firstLine.status === 'timeout' && firstLine.exit === null && firstLine.turns === 0,
    JSON.stringify(firstLine),
  );
  check(
    'the four required keys cannot be overwritten by the caller’s fields',
    (() => {
      const spoof = createErrorLog({ root: path.join(scratch, 'spoof') });
      spoof.record({ where: 'a/b', code: 'c', message: 'm', fields: { where: 'somewhere/else', code: 'not_this' } });
      const written = lines(path.join(scratch, 'spoof', ERROR_LOG_FILENAME))[0];
      return written.where === 'a/b' && written.code === 'c';
    })(),
    'a caller able to rename `where` could make a failure say it happened somewhere else',
  );
  check(
    'and the same failure is PRINTED through ctx.logger.error, with its own code and no summary',
    printed.length === 1 && printed[0].includes('where=memorylab/judgement') && printed[0].includes('code=run_timeout') && printed[0].includes(log.path),
    JSON.stringify(printed),
  );

  log.record({ where: 'core/model-write', code: 'write_failed', message: 'the second failure' });
  const secondText = textOf(log.path);
  check(
    'a second failure is APPENDED: the first line is byte-for-byte where it was',
    secondText.startsWith(firstText) &&
      lines(log.path).length === 2 &&
      lines(log.path)[0].code === 'run_timeout' &&
      lines(log.path)[1].code === 'write_failed',
    JSON.stringify(lines(log.path).map((entry) => entry.code)),
  );

  /* A ROOT THAT CANNOT BE WRITTEN. The parent of the log's directory is a FILE, so both the
   * append and the `mkdirSync` after it fail — which is the case rule 1 exists for: the failure
   * being reported must not become a second failure. */
  const blocker = path.join(scratch, 'blocker');
  fs.writeFileSync(blocker, 'this is a file, not a directory', 'utf8');
  const blockedPrinted = [];
  const blockedLog = createErrorLog({ root: path.join(blocker, 'sub'), logger: { error: (message) => blockedPrinted.push(String(message)) } });
  let blockedThrew = null;
  let blockedAnswer = null;
  try {
    blockedAnswer = blockedLog.record({ where: 'core/preset-switch', code: 'write_failed', message: 'the patch could not be replaced' });
  } catch (error) {
    blockedThrew = error;
  }
  check(
    'a log that cannot be written does not throw, and says so instead',
    blockedThrew === null && blockedAnswer?.ok === false && typeof blockedAnswer.error === 'string' && blockedAnswer.error.length > 0,
    JSON.stringify({ threw: String(blockedThrew?.message ?? ''), answer: blockedAnswer }),
  );
  check(
    'and the failure is still printed, with the reason the file could not take it',
    blockedPrinted.length === 2 &&
      blockedPrinted[0].includes('code=write_failed') &&
      blockedPrinted[1].includes('could not be written') &&
      blockedPrinted[1].includes('the failure above is printed only'),
    JSON.stringify(blockedPrinted),
  );

  /* A LOGGER THAT THROWS. `ctx.logger` belongs to the host, and a host logger that is itself
   * broken must not take the operation down — that is the whole of rule 1's second half. */
  const hostileLoggerRoot = path.join(scratch, 'hostile-logger');
  const hostileLog = createErrorLog({
    root: hostileLoggerRoot,
    logger: {
      error() {
        throw new Error('the host logger is down');
      },
    },
  });
  let loggerThrew = null;
  let loggerAnswer = null;
  try {
    loggerAnswer = hostileLog.record({ where: 'memorylab/rebuild', code: 'rebuild_failed', message: 'the index could not be written' });
  } catch (error) {
    loggerThrew = error;
  }
  check(
    'a logger that throws takes nothing down, and the failure is still written',
    loggerThrew === null && loggerAnswer?.ok === true && lines(path.join(hostileLoggerRoot, ERROR_LOG_FILENAME))[0]?.code === 'rebuild_failed',
    JSON.stringify({ threw: String(loggerThrew?.message ?? ''), answer: loggerAnswer }),
  );

  check(
    'with no root at all the failure is PRINTED only, and nothing is invented',
    (() => {
      const orphan = createErrorLog({ root: '' });
      const answer = orphan.record({ where: 'computeruse/backend', code: 'backend_unavailable', message: 'no backend' });
      return answer.ok === false && answer.error === 'no_root' && answer.path === '' && !fs.existsSync(path.join(workspace, ERROR_LOG_FILENAME));
    })(),
    'writing errors.jsonl into whatever the process’s working directory happens to be would be worse than not writing it',
  );

  check(
    'a message that cannot be converted does not throw the log call',
    (() => {
      const hostile = { toString() { throw new Error('no string for you'); } };
      const hostileRoot = path.join(scratch, 'hostile-value');
      const answer = createErrorLog({ root: hostileRoot }).record({ where: hostile, code: hostile, message: hostile, detail: hostile, fields: { payload: hostile } });
      const written = lines(path.join(hostileRoot, ERROR_LOG_FILENAME))[0];
      return answer.ok === true && written.where === 'unknown' && written.code === 'unknown' && typeof written.message === 'string';
    })(),
    'a log call that throws on a hostile value would take down the operation it was describing',
  );

  check(
    'a value that defeats the serialiser still produces a line, and a cycle does not throw',
    (() => {
      const cyclic = { name: 'cycle' };
      cyclic.self = cyclic;
      const cyclicRoot = path.join(scratch, 'cyclic');
      const answer = createErrorLog({ root: cyclicRoot }).record({ where: 'core/model-write', code: 'write_failed', message: 'm', fields: { cyclic, big: 1n } });
      const written = lines(path.join(cyclicRoot, ERROR_LOG_FILENAME))[0];
      return answer.ok === true && written.cyclic?.self === '[circular]' && written.big === '1';
    })(),
    'a run’s own result object is not this module’s to trust',
  );

  check(
    'the cause chain is read through `cause`, outermost first',
    causeChain(new Error('the write was refused', { cause: new Error('EACCES: permission denied') })) ===
      'Error: the write was refused <- Error: EACCES: permission denied',
    causeChain(new Error('a', { cause: new Error('b') })),
  );

  /* ======================================= the shared module is REACHED by every half === */

  console.log('');
  console.log('# one implementation, reached by the core row and by each component');

  const halves = {
    'core row': ['index.js', (source) => /from '\.\/lib\/errors\.js'/.test(source) && source.includes('createErrorLog({ root, logger: ctx.logger })')],
    'memorylab component': [
      'components/memorylab/component.js',
      (source) => /from '\.\.\/\.\.\/lib\/errors\.js'/.test(source) && source.includes('const failures = createErrorLog({ root, logger });'),
    ],
    'memorylab row': [
      'components/memorylab/index.js',
      // The row shares the component's log rather than building a second one: one file, one path.
      (source) => /from '\.\.\/\.\.\/lib\/errors\.js'/.test(source) && source.includes('memorylab.failures.record({'),
    ],
    'computeruse component': [
      'components/computeruse/component.js',
      (source) => /from '\.\.\/\.\.\/lib\/errors\.js'/.test(source) && source.includes('const failures = createErrorLog({ root, logger });'),
    ],
    'computeruse row': [
      'components/computeruse/index.js',
      (source) => /from '\.\/lib\/root\.js'/.test(source) && source.includes('resolveRoot(config)') && source.includes('createComputerUse({ root,'),
    ],
  };
  for (const [label, [file, predicate]] of Object.entries(halves)) {
    const source = fs.readFileSync(path.join(pkg, file), 'utf8');
    check(`${label} reaches the shared implementation rather than growing its own`, predicate(source) === true, file);
  }
  check(
    'the log has exactly ONE writer: no other module names the file in its code',
    (() => {
      const offenders = [];
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const absolute = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(absolute);
          else if (entry.name.endsWith('.js') && absolute !== path.join(pkg, 'lib', 'errors.js')) {
            // Comments are stripped first, so a module may SAY where the log is without being
            // able to write it — the distinction is the whole check.
            const code = fs
              .readFileSync(absolute, 'utf8')
              .split('\n')
              .filter((line) => {
                const trimmed = line.trim();
                return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*');
              })
              .join('\n');
            if (/errors\.jsonl|ERROR_LOG_FILENAME/.test(code)) offenders.push(path.relative(pkg, absolute));
          }
        }
      };
      walk(pkg);
      return offenders.length === 0;
    })(),
    'a second writer is how two halves come to own two logs',
  );

  /* ================================================== the core row: model write === */

  console.log('');
  console.log('# core/model-write');

  const modelRoute = (mount) => mount.routes.find((route) => route.path === '/newmark-core/components');

  /** Mount the core row alone, with a Loader entry and a config editor the caller controls. */
  async function mountModelRow(edit) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nmc-faillog-model-'));
    const entry = { options: { config: { root: '', compose: false, model: '', modelProvider: '' } } };
    const mount = await mountCore({
      packagesDir,
      root,
      compose: false,
      services: { configEditor: { edit } },
      fiber: { entry },
    });
    return { root, entry, mount, logPath: path.join(root, ERROR_LOG_FILENAME) };
  }

  const appliedEditor = async (row, change) => {
    row.options.config = { ...change(row.options.config) };
  };

  const throwingRow = await mountModelRow(async () => {
    throw new Error('the profile patch is read-only', { cause: new Error('EACCES: permission denied') });
  });
  const throwingAnswer = await callRoute(modelRoute(throwingRow.mount), 'POST', {
    component: 'model',
    provider: 'deepseek-official',
    model: 'deepseek-flash',
  });
  const throwingLines = lines(throwingRow.logPath);
  check(
    'a model write whose edit throws is recorded as core/model-write, with its cause chain',
    throwingAnswer.status === 500 &&
      throwingLines.length === 1 &&
      throwingLines[0].where === 'core/model-write' &&
      throwingLines[0].code === 'write_failed' &&
      throwingLines[0].detail.includes('the profile patch is read-only') &&
      throwingLines[0].detail.includes('EACCES'),
    JSON.stringify({ status: throwingAnswer.status, lines: throwingLines }),
  );
  check(
    'and the caller still gets the answer it always got: the record is added, never substituted',
    throwingAnswer.json?.error === 'handler_failed',
    JSON.stringify(throwingAnswer.json),
  );
  await throwingRow.mount.dispose();
  fs.rmSync(throwingRow.root, { recursive: true, force: true });

  const silentRow = await mountModelRow(async () => {
    /* An editor that returns without writing. This is the read-back's whole reason for
     * existing, and it is the shape a stale read used to disguise. */
  });
  const silentAnswer = await callRoute(modelRoute(silentRow.mount), 'POST', {
    component: 'model',
    provider: 'deepseek-official',
    model: 'deepseek-flash',
  });
  const silentLines = lines(silentRow.logPath);
  check(
    'a model write that returns without taking is recorded as write_not_verified, not as success',
    silentAnswer.status === 400 &&
      silentLines.length === 1 &&
      silentLines[0].where === 'core/model-write' &&
      silentLines[0].code === 'write_not_verified' &&
      silentLines[0].message.includes('did not take'),
    JSON.stringify({ status: silentAnswer.status, lines: silentLines }),
  );
  await silentRow.mount.dispose();
  fs.rmSync(silentRow.root, { recursive: true, force: true });

  const goodRow = await mountModelRow(appliedEditor);
  const goodAnswer = await callRoute(modelRoute(goodRow.mount), 'POST', {
    component: 'model',
    provider: 'deepseek-official',
    model: 'deepseek-flash',
  });
  check(
    'a model write that TAKES writes nothing to the failure log — a success reported as a failure is its own defect',
    goodAnswer.status === 200 &&
      goodAnswer.json?.ok === true &&
      goodRow.entry.options.config.model === 'deepseek-flash' &&
      !fs.existsSync(goodRow.logPath),
    JSON.stringify({ status: goodAnswer.status, body: goodAnswer.json?.detail, logged: fs.existsSync(goodRow.logPath) }),
  );
  await goodRow.mount.dispose();
  fs.rmSync(goodRow.root, { recursive: true, force: true });

  /* ================================================ the core row: preset switch === */

  /* ========================================================= composition === */

  console.log('');
  console.log('# core/compose');

  /* A COPY OF THE PACKAGE with one component replaced by a module that cannot be imported. A
   * source assertion would say the catch records the failure; this makes the catch run, which is
   * the difference between a wiring claim and a measurement. The copy keeps the real package
   * untouched, and everything below happens under %TEMP%. */
  const brokenRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nmc-faillog-compose-'));
  const brokenPackages = path.join(brokenRoot, 'packages');
  fs.mkdirSync(brokenPackages, { recursive: true });
  fs.cpSync(pkg, path.join(brokenPackages, 'newmark-core'), { recursive: true, dereference: true });
  fs.writeFileSync(
    path.join(brokenPackages, 'newmark-core', 'components', 'computeruse', 'index.js'),
    'throw new Error("this component cannot be imported at all");\n',
    'utf8',
  );
  const brokenStoreRoot = path.join(brokenRoot, 'user');
  const brokenMount = await mountCore({ packagesDir: brokenPackages, root: brokenStoreRoot });
  const brokenLines = lines(path.join(brokenStoreRoot, ERROR_LOG_FILENAME));
  check(
    'a component that cannot be composed is recorded as core/compose, with the import’s own message',
    brokenLines.some(
      (entry) =>
        entry.where === 'core/compose' &&
        entry.code === 'compose_failed' &&
        entry.message.includes('computerUse') &&
        entry.detail.includes('cannot be imported at all'),
    ),
    JSON.stringify(brokenLines),
  );
  check(
    'and the components that CAN be composed are still mounted: one failure does not spread',
    brokenMount.composed.includes('memoryLab') && brokenMount.composed.includes('agentApi') && !brokenMount.composed.includes('computerUse'),
    JSON.stringify(brokenMount.composed),
  );
  await brokenMount.dispose();
  fs.rmSync(brokenRoot, { recursive: true, force: true });

  /* ============================================ ComputerUse: the backend === */

  console.log('');
  console.log('# computeruse/backend');

  const cuRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nmc-faillog-cu-'));
  const cuMount = await mountCore({ packagesDir, root: cuRoot, components: { memoryLab: false } });
  const cuTool = cuMount.tools.get('computer_use');
  const cuLogPath = path.join(cuRoot, ERROR_LOG_FILENAME);

  /* A target id that was never handed out. The backend refuses before it touches a lane, a
   * pointer, a window or the lease — `lib/win32.js` resolves the id first — so this drives a
   * real backend failure with no side effect on the desktop. */
  const refused = await cuTool.execute({ action: 'click', target_id: 'newmark-gate-no-such-target', x: 1, y: 1 });
  const refusedCode = String(refused?.code || refused?.error_code || '');
  const cuLines = lines(cuLogPath);
  check(
    'a backend that answers an error is recorded with the backend’s OWN code, not a summary of it',
    refused?.ok === false &&
      refusedCode.length > 0 &&
      cuLines.length === 1 &&
      cuLines[0].where === 'computeruse/backend' &&
      cuLines[0].code === refusedCode &&
      cuLines[0].message === String(refused.error),
    JSON.stringify({ refused, lines: cuLines }),
  );
  check(
    'and it is printed as well as saved, through the host logger the row was given',
    cuMount.logs.some((line) => line.includes('newmark-core/failure:') && line.includes('where=computeruse/backend') && line.includes(refusedCode)),
    JSON.stringify(cuMount.logs.slice(-3)),
  );

  /* The other direction, on the same mount: a backend call that SUCCEEDS must add no line. */
  const reported = await cuTool.execute({ action: 'mode_report' });
  check(
    'a backend call that succeeds writes nothing: the log is for failures, not for activity',
    reported?.ok === true && lines(cuLogPath).length === 1,
    JSON.stringify({ ok: reported?.ok, lines: lines(cuLogPath).length }),
  );
  await cuMount.dispose();
  fs.rmSync(cuRoot, { recursive: true, force: true });
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
  const liveAfter = digest(LIVE_LOG);
  if (liveAfter !== liveBefore) {
    console.log('');
    console.log(`ABORT: the gate wrote into the user's own failure log (${liveBefore.slice(0, 16)} -> ${liveAfter.slice(0, 16)})`);
    process.exit(2);
  }
}

check(`the user's own failure log at ${LIVE_LOG} was not written by this gate`, digest(LIVE_LOG) === liveBefore, `${liveBefore.slice(0, 16)} -> ${digest(LIVE_LOG).slice(0, 16)}`);

console.log('');
console.log(`SUMMARY passed=${passed} failed=${failed} total=${passed + failed}`);
if (failed > 0) {
  console.log(`FAILED: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('PASS');
