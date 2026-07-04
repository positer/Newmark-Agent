import * as path from 'path';
import * as fs from 'fs';
import { Agent } from './core/agent';
import { FlowEngine } from './core/flow';
import { runFlow } from './core/flow-runner';
import { CLI_COMMANDS, runCliCommand } from './cli-commands';

const args = process.argv.slice(2);
const isCli = args.includes('--cli');
const isServer = args.includes('--server');
const isEdit = args[0] === 'edit';
const editFile = isEdit ? args[1] : '';
const isFlow = args[0] === 'flow';
const hasCliCommand = args.some(a => (CLI_COMMANDS as readonly string[]).includes(a));
const root = args.includes('--root') ? args[args.indexOf('--root') + 1] : process.cwd();

function firstRunInit(r: string): void {
  fs.mkdirSync(r, { recursive: true });
  const { ensureRootConfig } = require('./core/config');
  ensureRootConfig(r);
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

firstRunInit(root);

if (hasCliCommand) {
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
