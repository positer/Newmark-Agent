#!/usr/bin/env node

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { createHash } from 'crypto';
import { spawn } from 'child_process';
import { Agent } from './core/agent';
import { FlowEngine } from './core/flow';
import { runFlow } from './core/flow-runner';
import { CLI_COMMANDS, cliCommandHelp, cliHelpRequested, runCliCommand } from './cli-commands';
import { invalidTopLevelArgument, isVersionArgument, unknownTopLevelCommand } from './cli-discovery';
import { currentAppVersion } from './core/installUpdate';
import { newmarkEditHelpText, newmarkFlowHelpText, newmarkHelpText } from './cli-help';

const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;
const hasCliCommand = args.some(a => (CLI_COMMANDS as readonly string[]).includes(a));
const cliCommand = args.find(a => (CLI_COMMANDS as readonly string[]).includes(a));
const isEdit = args[0] === 'edit';
const editFile = isEdit ? args[1] : '';
const isFlow = args[0] === 'flow';
const isHelpArg = !hasCliCommand && (args.some(arg => ['--help', '-h'].includes(arg.toLowerCase())) || args[0]?.toLowerCase() === 'help');
const isVersionArg = !hasCliCommand && isVersionArgument(args);
const isReadOnlyValidation = hasCliCommand && args.includes('validate-models') && !args.includes('--persist');
const isTui = args.some(arg => arg.toLowerCase() === '--tui');
const isGui = args.some(arg => arg.toLowerCase() === '--gui');
const isCli = args.includes('--cli');
const isServer = args.includes('--server');

const invalidArgument = invalidTopLevelArgument(args);
if (invalidArgument) {
  console.error(`Invalid Newmark argument: ${invalidArgument}`);
  process.exit(2);
}

// Command help is a terminating, read-only discovery operation. Resolve it
// before first-run initialization or GUI forwarding so `Newmark.exe send
// --help` cannot accidentally enter Electron or instantiate an Agent.
if (hasCliCommand && cliCommand && cliHelpRequested(args)) {
  console.log(cliCommandHelp(cliCommand));
  process.exit(0);
}

function pathArgValue(values: string[], key: string): string | undefined {
  const prefix = `${key}=`;
  const inlineIdx = values.findIndex(a => a.startsWith(prefix));
  if (inlineIdx >= 0) {
    const parts = [values[inlineIdx].slice(prefix.length)];
    let best = fs.existsSync(parts[0]) ? parts[0] : '';
    for (let i = inlineIdx + 1; i < values.length; i++) {
      const arg = values[i];
      if (arg.startsWith('--')) break;
      parts.push(arg);
      const candidate = parts.join(' ');
      if (fs.existsSync(candidate)) best = candidate;
    }
    return best || parts.join(' ') || undefined;
  }
  const idx = values.indexOf(key);
  if (idx < 0 || idx + 1 >= values.length) return undefined;
  const parts: string[] = [];
  let best = '';
  for (let i = idx + 1; i < values.length; i++) {
    const arg = values[i];
    if (arg.startsWith('--')) break;
    parts.push(arg);
    const candidate = parts.join(' ');
    if (fs.existsSync(candidate)) best = candidate;
  }
  return best || parts.join(' ') || undefined;
}

function resolveTuiWorkspacePath(values: string[], root: string): string {
  const explicitWorkspace = pathArgValue(values, '--workspace');
  if (explicitWorkspace) return explicitWorkspace;
  // An explicitly isolated runtime must not silently register the caller's
  // cwd as an external workspace. Keep the opt-in --workspace escape hatch,
  // while making the safe one-argument form fully self-contained.
  return pathArgValue(values, '--root') ? root : process.cwd();
}

function userRuntimeRoot(): string {
  return path.join(os.homedir(), '.Newmark');
}

function legacyUserDataRoot(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'Newmark Agent');
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Newmark Agent');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Newmark Agent');
}

function isPathInside(parent: string, child: string): boolean {
  try {
    const rel = path.relative(path.resolve(parent), path.resolve(child));
    return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
  } catch {
    return false;
  }
}

function isProtectedInstallRoot(candidate: string): boolean {
  if (process.platform !== 'win32') return false;
  const roots = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.ProgramW6432,
  ].filter((value): value is string => !!value);
  return roots.some(rootDir => isPathInside(rootDir, candidate));
}

function canWriteDirectory(candidate: string): boolean {
  const probeName = `.newmark-write-test-${process.pid}-${Date.now()}`;
  const probePath = path.join(candidate, probeName);
  try {
    fs.mkdirSync(candidate, { recursive: true });
    fs.writeFileSync(probePath, 'ok', 'utf-8');
    fs.unlinkSync(probePath);
    return true;
  } catch {
    try { if (fs.existsSync(probePath)) fs.unlinkSync(probePath); } catch {}
    return false;
  }
}

function migrateLegacyRuntimeRoot(root: string): void {
  const targetRoot = path.resolve(root);
  const legacyRoot = path.resolve(legacyUserDataRoot());
  if (targetRoot === legacyRoot || !fs.existsSync(legacyRoot)) return;
  const items = ['config.json', 'agent.md', 'PC_Hash.config', 'Work', 'Flow', 'skills', 'archive', 'Memory Lab', 'Roots'];
  for (const item of items) {
    const from = path.join(legacyRoot, item);
    const to = path.join(targetRoot, item);
    try {
      if (fs.existsSync(from) && !fs.existsSync(to)) fs.cpSync(from, to, { recursive: true, errorOnExist: false });
    } catch {}
  }
}
function shadowRootFor(candidate: string): string {
  const resolved = path.resolve(candidate || userRuntimeRoot());
  const base = path.basename(resolved).replace(/[^A-Za-z0-9._-]+/g, '_') || 'root';
  const hash = createHash('sha256').update(resolved.toLowerCase()).digest('hex').slice(0, 16);
  return path.join(userRuntimeRoot(), 'Roots', `${base}-${hash}`);
}

function writableRuntimeRoot(candidate: string): string {
  const resolved = path.resolve(candidate);
  const installRoot = path.dirname(process.execPath);
  if (isPathInside(installRoot, resolved)) return userRuntimeRoot();
  if (isProtectedInstallRoot(resolved)) return shadowRootFor(resolved);
  if (!canWriteDirectory(resolved)) return shadowRootFor(resolved);
  return resolved;
}

const explicitRoot = pathArgValue(args, '--root');
const root = explicitRoot ? writableRuntimeRoot(explicitRoot) : userRuntimeRoot();

if (isHelpArg) {
  console.log(isFlow ? newmarkFlowHelpText() : isEdit ? newmarkEditHelpText() : newmarkHelpText(currentAppVersion()));
  process.exit(0);
}
if (isVersionArg) {
  console.log(currentAppVersion());
  process.exit(0);
}
const unknownCommand = !hasCliCommand && !isTui && !isGui && !isCli && !isServer && !isFlow && !isEdit
  ? unknownTopLevelCommand(args)
  : undefined;
if (unknownCommand) {
  console.error(`Unknown Newmark command or argument: ${unknownCommand}. Run --help to see the supported entrypoints.`);
  process.exit(2);
}

function firstRunInit(r: string, options: { readOnly?: boolean } = {}): void {
  fs.mkdirSync(r, { recursive: true });
  // Legacy AppData migration is only valid for the canonical user runtime.
  // An explicit --root is an isolation boundary (tests, portable roots, and
  // caller-selected workspaces) and must never inherit the user's sessions,
  // archives, providers, or workspaces.
  if (path.resolve(r) === path.resolve(userRuntimeRoot())) migrateLegacyRuntimeRoot(r);
  const { ensureRootConfig } = require('./core/config');
  ensureRootConfig(r, options);
  if (!fs.existsSync(path.join(r, 'agent.md'))) {
    fs.writeFileSync(path.join(r, 'agent.md'), '# Newmark Agent\n\nYou are a powerful coding assistant.\n', 'utf-8');
  }
  if (!fs.existsSync(path.join(r, 'PC_Hash.config'))) {
    fs.writeFileSync(path.join(r, 'PC_Hash.config'), `${require('os').hostname()}|${process.platform}|${process.arch}`, 'utf-8');
  }
  const fm = path.join(r, 'Flow', 'Flow.md');
  fs.mkdirSync(path.join(r, 'Flow'), { recursive: true });
  if (!fs.existsSync(fm)) {
    fs.writeFileSync(fm, `# Newmark Flow Format Guide\n\nA Flow workflow is saved as name.Flow.json in the Flow/ folder.\n\n## Component Types\n### dialog - id, type:"dialog", mode:"build"/"plan"/"goal", prompt (use {#prompt#} placeholder)\n### logic - id, type:"logic", prompt, goto_true, goto_false\n\nComponents execute in order unless logic redirects.`, 'utf-8');
  }
  for (const d of ['skills', 'Work', 'Flow', 'archive']) fs.mkdirSync(path.join(r, d), { recursive: true });
  for (const fn of ['Local.json', 'External.json']) {
    const p = path.join(r, 'Work', fn);
    if (!fs.existsSync(p)) fs.writeFileSync(p, '[]', 'utf-8');
  }
}

function isTerminal(): boolean {
  return !!process.stdin.isTTY && !!process.stdout.isTTY;
}

async function drainCliNetworkHandles(): Promise<void> {
  try {
    const { stopComputerUsePowerShellHost } = require('./tools/computerUsePowerShellHost');
    stopComputerUsePowerShellHost();
  } catch {}
  try {
    const undici = require('undici');
    const dispatcher = undici.getGlobalDispatcher?.();
    if (dispatcher?.close) {
      await Promise.race([
        dispatcher.close(),
        new Promise(resolve => setTimeout(resolve, 500)),
      ]);
    }
  } catch {
    // Older Electron/Node builds may not expose undici as a require-able module.
  }
}

function exitCli(code: number): void {
  drainCliNetworkHandles()
    .catch(() => undefined)
    .finally(() => process.exit(code));
}

function nativeGuiCandidates(): string[] {
  const configured = String(process.env.NEWMARK_GUI_EXECUTABLE || '').trim();
  if (process.platform === 'win32') {
    return [
      configured,
      process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Newmark Agent', 'Newmark Agent.exe') : '',
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Newmark Agent', 'Newmark Agent.exe') : '',
    ].filter(Boolean);
  }
  if (process.platform === 'darwin') {
    return [configured, '/Applications/Newmark Agent.app/Contents/MacOS/Newmark Agent'].filter(Boolean);
  }
  return [configured, '/opt/Newmark Agent/newmark-agent', '/usr/bin/newmark-agent', '/usr/local/bin/newmark-agent'].filter(Boolean);
}

function launchGui(): never {
  const forwarded = args.filter(arg => arg.toLowerCase() !== '--gui');
  const nativeExecutable = nativeGuiCandidates().find(candidate => fs.existsSync(candidate));
  if (nativeExecutable) {
    const child = spawn(nativeExecutable, forwarded, { cwd: process.cwd(), detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', error => console.error(`Unable to start Newmark GUI: ${error.message}`));
    child.unref();
    process.exit(0);
  }
  try {
    const electronExecutable = require('electron') as string;
    if (typeof electronExecutable === 'string' && fs.existsSync(electronExecutable)) {
      const applicationRoot = path.resolve(__dirname, '..');
      const child = spawn(electronExecutable, [applicationRoot, ...forwarded], { cwd: process.cwd(), detached: true, stdio: 'ignore', windowsHide: false });
      child.once('error', error => console.error(`Unable to start Newmark GUI: ${error.message}`));
      child.unref();
      process.exit(0);
    }
  } catch {}
  console.error('Unable to locate the Newmark GUI runtime. Reinstall newmark-agent with optional dependencies enabled, or install a Newmark desktop package.');
  process.exit(1);
}

firstRunInit(root, { readOnly: isReadOnlyValidation });

if (isGui) {
  launchGui();
} else if (isTui) {
  const { start } = require('./tui/src/app');
  start({ root, workspacePath: resolveTuiWorkspacePath(args, root), desktopDist: __dirname });
} else if (hasCliCommand) {
  runCliCommand(root, args).then(handled => {
    const code = typeof process.exitCode === 'number' ? process.exitCode : 0;
    exitCli(handled ? code : 1);
  }).catch((e: Error) => {
    console.error('CLI command error:', e.message);
    exitCli(1);
  });
} else if (isFlow) {
  const flowDir = path.join(root, 'Flow');
  const flowName = args[1];
  if (!flowName) {
    console.log('Usage: newmark flow <workflow-name> [start-pc] [--input "text"]');
    console.log('Available flows:');
    FlowEngine.listAll(flowDir).forEach((n: string) => console.log(`  ${n}`));
    process.exit(1);
  }

  const workflow = FlowEngine.load(flowDir, flowName);
  if (!workflow) {
    console.error(`Flow '${flowName}' not found in ${flowDir}`);
    process.exit(1);
  }

  const agent = new Agent(root);
  const startPc = (args[2] && !args[2].startsWith('--')) ? parseInt(args[2], 10) : 0;
  const inputIdx = args.indexOf('--input');
  const startInput = inputIdx >= 0 ? args[inputIdx + 1] || '' : '';

  runFlow(agent, workflow, { startPc, startInput }).then(() => {
    process.exit(0);
  }).catch((e: Error) => {
    console.error('Flow error:', e.message);
    process.exit(1);
  });
} else if (isEdit) {
  if (!editFile) {
    console.error('Usage: newmark edit <file.txt|.json|.tex|.md>');
    process.exit(1);
  }
  const { runCliEditor } = require('./cli-editor');
  runCliEditor(editFile);
} else if (isCli || (!isServer && isTerminal())) {
  // CLI mode
  const { runCli } = require('./cli');
  runCli(root);
} else {
  // Server mode - start HTTP server and open browser
  const { runServer } = require('./server');
  runServer(root);
  if (!args.includes('--no-browser')) {
    const { exec } = require('child_process');
    const port = 47890;
    const cmd = process.platform === 'win32'
      ? `start http://localhost:${port}`
      : process.platform === 'darwin'
      ? `open http://localhost:${port}`
      : `xdg-open http://localhost:${port}`;
    exec(cmd);
  }
}
