const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function assert(condition, message) {
  if (!condition) throw new Error(`console wrapper boundary stress failed: ${message}`);
}

function run(executable, args, cwd, timeout = 120000) {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout,
    maxBuffer: 2 * 1024 * 1024,
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  assert(!result.error, `${args.join(' ')} spawn error: ${result.error?.message || 'unknown error'}`);
  return { result, output };
}

function stripAnsi(value) {
  return String(value || '')
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '');
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('console wrapper boundary stress skipped outside Windows');
    return;
  }
  const executable = path.resolve(process.env.NEWMARK_CONSOLE_STRESS_EXE
    || path.join(__dirname, '..', '..', 'release', 'win-unpacked', 'Newmark.exe'));
  assert(fs.existsSync(executable), `missing console executable: ${executable}`);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-wrapper-boundary-'));
  const root = path.join(temporaryRoot, 'Root With Spaces And Colon-safe Name');
  fs.mkdirSync(root, { recursive: true });
  try {
    const version = run(executable, ['--version'], root);
    assert(version.result.status === 0, `version exit=${version.result.status}; output=${version.output}`);
    assert(/0\.3\.12/.test(version.output), `version output mismatch: ${version.output}`);

    const helpWord = run(executable, ['help'], root, 30000);
    assert(helpWord.result.status === 0, `help-word exit=${helpWord.result.status}; output=${helpWord.output}`);
    assert(/Newmark|Usage|GUI|TUI/i.test(helpWord.output), `help-word output mismatch: ${helpWord.output}`);

    const colonPrompt = run(executable, [
      'send', 'hello: answer normally.', '--agent-only', '--root', root,
    ], root);
    assert(colonPrompt.result.status === 1, `colon prompt exit=${colonPrompt.result.status}; output=${colonPrompt.output}`);
    assert(/No LLM configured/i.test(colonPrompt.output), `colon prompt lost actionable provider error: ${colonPrompt.output}`);

    const state = run(executable, ['state', '--root', root], root);
    assert(state.result.status === 0, `state exit=${state.result.status}; output=${state.output}`);
    const parsed = JSON.parse(String(state.result.stdout || '').trim());
    assert(String(parsed.root || '').toLowerCase() === path.resolve(root).toLowerCase(), `state root mismatch: ${JSON.stringify(parsed)}`);
    console.log('CONSOLE_WRAPPER_BOUNDARY_STRESS_PASS version=0.3.12 helpWord=true colonPromptExit=1 rootWithSpaces=true electronArgBoundary=true');
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

try {
  main().catch(error => {
    console.error(error.stack || error.message || String(error));
    process.exit(1);
  });
} catch (error) {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
}
