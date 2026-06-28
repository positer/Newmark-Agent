import * as readline from 'readline';
import { Agent, AgentMode } from './core/agent';
import { FlowEngine } from './core/flow';
import { runFlow } from './core/flow-runner';
import { handleFlowCommand } from './tools/flow-cli';

type ModeIdx = 0 | 1 | 2 | 3;
const MODES: AgentMode[] = ['build', 'plan', 'goal', 'flow'];

export async function runCli(root: string): Promise<void> {
  const agent = new Agent(root);
  const models = agent.allModelNames();

  console.log(`\nNewmark CLI v1.0 — ${agent.modeName()} | ${agent.model}\n`);
  console.log('[Enter] Send · [Tab] Switch Mode · [Ctrl+T] Guide/Next · [Ctrl+M] Cycle Model · [Ctrl+Q] Quit\n');

  let mi: ModeIdx = MODES.indexOf(agent.mode as never) as ModeIdx;
  if (mi < 0) mi = 0;
  let inputMode: 0 | 1 = 0; // 0=Guide, 1=Next
  let mmi = models.findIndex(n => n.endsWith(agent.model));
  if (mmi < 0) mmi = 0;
  let isWorking = false;
  let input = '';

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  process.stdin.setRawMode?.(true);
  process.stdin.on('keypress', (_str, key) => {
    if (!key) return;

    if (key.ctrl && key.name === 'q') {
      rl.close();
      process.exit(0);
    }

    if (key.ctrl && key.name === 't') {
      inputMode = inputMode === 0 ? 1 : 0;
      render(agent, input, inputMode, MODES[mi], models[mmi] || '', isWorking);
      return;
    }

    if (key.ctrl && key.name === 'm') {
      if (models.length > 0) {
        mmi = (mmi + 1) % models.length;
        agent.setModel(models[mmi]);
      }
      render(agent, input, inputMode, MODES[mi], models[mmi] || '', isWorking);
      return;
    }

    if (key.name === 'tab') {
      mi = ((mi + 1) % 4) as ModeIdx;
      agent.setMode(MODES[mi]);
      render(agent, input, inputMode, MODES[mi], models[mmi] || '', isWorking);
      return;
    }

    if (key.name === 'return') {
      if (key.shift) {
        input += '\n';
        render(agent, input, inputMode, MODES[mi], models[mmi] || '', isWorking);
        return;
      }
      const text = input.trim();
      if (!text || isWorking) return;

      input = '';
      render(agent, '', inputMode, MODES[mi], models[mmi] || '', true);

      if (inputMode === 1) {
        // Next mode
        agent.nextPrompt = text;
        console.log(`\n[Queued · ${MODES[mi]} · ${models[mmi]}]\n${text}\n`);
        render(agent, '', inputMode, MODES[mi], models[mmi] || '', false);
        return;
      }

      // Slash commands
      if (text.startsWith('/flow run ') || text.startsWith('/flow load ')) {
        const flowName = text.split(/\s+/).slice(2).join(' ');
        const flowDir = require('path').join(root, 'Flow');
        const workflow = FlowEngine.load(flowDir, flowName);
        if (!workflow) {
          const found = FlowEngine.findWorkflow(flowName, flowDir);
          if (!found) {
            console.log(`\n[Flow]\nWorkflow '${flowName}' not found.\n`);
            render(agent, '', inputMode, MODES[mi], models[mmi] || '', false);
            return;
          }
          const wf = FlowEngine.load(flowDir, found);
          if (!wf) {
            console.log(`\n[Flow]\nFailed to load '${found}'.\n`);
            render(agent, '', inputMode, MODES[mi], models[mmi] || '', false);
            return;
          }
          isWorking = true;
          render(agent, '', inputMode, MODES[mi], models[mmi] || '', true);
          runFlow(agent, wf).then(() => {
            console.log(`\n---\n`);
            isWorking = false;
            render(agent, '', inputMode, MODES[mi], models[mmi] || '', false);
          });
          return;
        }
        isWorking = true;
        render(agent, '', inputMode, MODES[mi], models[mmi] || '', true);
        runFlow(agent, workflow).then(() => {
          console.log(`\n---\n`);
          isWorking = false;
          render(agent, '', inputMode, MODES[mi], models[mmi] || '', false);
        });
        return;
      }
      if (text.startsWith('/flow ')) {
        const flowArgs = text.slice(6).trim().split(/\s+/);
        const result = handleFlowCommand(root, flowArgs);
        console.log(`\n[Flow]\n${result}\n`);
        render(agent, '', inputMode, MODES[mi], models[mmi] || '', false);
        return;
      }
      if (text === '/flow' || text === '/flow list' || text === '/flow ls') {
        const result = handleFlowCommand(root, ['list']);
        console.log(`\n[Flow]\n${result}\n`);
        render(agent, '', inputMode, MODES[mi], models[mmi] || '', false);
        return;
      }

      // Guide mode
      isWorking = true;
      agent.process(text).then(tokens => {
        process.stdout.write(`\n[Assistant · ${agent.modeName()} · ${agent.model}]\n`);
        for (const tok of tokens) {
          process.stdout.write(tok.text);
        }
        if (agent.fileDiffs.length > 0) {
          process.stdout.write('\n--- Edits ---\n');
          for (const d of agent.fileDiffs) {
            if (!d.oldContent) {
              process.stdout.write(`  + ${d.path} (new, ${d.newContent.length} chars)\n`);
            } else {
              const add = Math.max(0, d.newContent.length - d.oldContent.length);
              const rm = Math.max(0, d.oldContent.length - d.newContent.length);
              process.stdout.write(`  ${d.path} : ${add > 0 ? '+' + add : ''} ${rm > 0 ? '-' + rm : ''}\n`);
            }
          }
        }
        process.stdout.write('\n---\n');
        isWorking = false;
        render(agent, '', inputMode, MODES[mi], models[mmi] || '', false);
      }).catch(e => {
        process.stdout.write(`\n[Error] ${e.message}\n`);
        isWorking = false;
        render(agent, '', inputMode, MODES[mi], models[mmi] || '', false);
      });
      return;
    }

    if (key.name === 'backspace') {
      input = input.slice(0, -1);
    } else if (key.name === 'escape') {
      input = '';
    } else if (key.sequence && !key.ctrl && !key.meta && key.sequence.length === 1) {
      input += key.sequence;
    }

    render(agent, input, inputMode, MODES[mi], models[mmi] || '', isWorking);
  });

  render(agent, '', 0 as const, MODES[mi], models[mmi] || '', false);
}

function render(_agent: Agent, input: string, im: number, mode: string, model: string, working: boolean): void {
  process.stdout.write('\x1b[H\x1b[J'); // clear screen
  const imLabel = im === 1 ? 'Next' : 'Guide';
  process.stdout.write(`\n=== Newmark CLI v1.0 — ${mode} | ${imLabel} | ${model} ===\n`);
  if (working) process.stdout.write('Status: Working...\n\n');
  else process.stdout.write('Status: Ready\n\n');
  process.stdout.write(`> ${input}\n`);
  process.stdout.write('\n[Tab]Mode [Ctrl+T]G/N [Ctrl+M]Model [Esc]Clear [Ctrl+Q]Quit\n');
}
