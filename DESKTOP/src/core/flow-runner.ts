import { Agent } from './agent';
import { FlowEngine, FlowWorkflow } from './flow';
import { AgentMode } from './types';

export interface FlowRunnerOptions {
  startInput?: string;
  startPc?: number;
  quiet?: boolean;
}

const MAX_VISITS = 300;

export async function runFlow(
  agent: Agent,
  workflow: FlowWorkflow,
  options: FlowRunnerOptions = {}
): Promise<void> {
  const startInput = options.startInput || '';
  let cur = options.startPc ?? 0;
  let input = startInput;
  const quiet = options.quiet ?? false;

  let totalChars = 0;
  const startTime = Date.now();
  const visitCounts = new Map<number, number>();

  if (!quiet) {
    console.log(`\n=== Flow: ${workflow.name} ===`);
    console.log(`Components: ${workflow.components.length}`);
    console.log(`Starting at: component ${cur}\n`);

    const cycleWarnings = FlowEngine.getCycleWarnings(workflow);
    if (cycleWarnings.length > 0) {
      for (const w of cycleWarnings) {
        console.log(`  ${w}`);
      }
      console.log();
    }
  }

  while (true) {
    const cid = cur;
    const visits = (visitCounts.get(cid) || 0) + 1;
    visitCounts.set(cid, visits);

    if (visits > MAX_VISITS) {
      if (!quiet) console.log(`[Flow] Cycle detected: component ${cid} visited ${visits} times, stopping.`);
      break;
    }

    const seq = FlowEngine.generateSequence(workflow, cur, input);
    if (seq.length === 0) {
      if (!quiet) console.log('[Flow] No more steps \u2014 complete.');
      break;
    }

    for (const step of seq) {
      if (step.isLogic) {
        if (!quiet) console.log(`\n[Logic #${step.id}] ${step.prompt}`);
        const resultTokens = await agent.process(
          `## Conditional Evaluation\n\n${step.prompt}\n\nRespond with ONLY "true" or "false" (lowercase).`
        );
        const resultText = resultTokens.map(t => t.text).join('').toLowerCase().trim();
        const cond = resultText === 'true';
        const nextGoto = FlowEngine.resolveGoto(workflow, step.id, cond);
        if (!quiet) console.log(`  \u2192 ${resultText} (${cond ? 'goto ' + step.gotoTrue : 'goto ' + step.gotoFalse})`);
        cur = nextGoto;
        break;
      } else {
        if (!quiet) console.log(`\n[Dialog #${step.id}] Mode: ${step.mode}`);
        if (!quiet) console.log(`  Prompt: ${step.prompt.slice(0, 200)}${step.prompt.length > 200 ? '...' : ''}`);
        const targetMode = (step.mode?.toLowerCase() === 'plan' ? 'plan' : step.mode?.toLowerCase() === 'goal' ? 'goal' : 'build') as AgentMode;
        agent.setMode(targetMode);
        const resultTokens = await agent.process(step.prompt);
        const resultText = resultTokens.map(t => t.text).join('');
        totalChars += resultText.length;

        if (!quiet) {
          if (resultText.includes('[LLM Error')) {
            console.log(`  \u26a0 ${resultText.slice(0, 300)}`);
          } else {
            const lines = resultText.trim().split('\n');
            const preview = lines.slice(0, 5).join('\n');
            console.log(`  \u2192 ${preview.slice(0, 300)}`);
            if (lines.length > 5 || preview.length > 300) console.log(`  ... (${resultText.length} chars)`);
          }
        }

        if (step.mode?.toLowerCase() === 'goal') {
          const checkPrompt = `Is the following goal achieved?\nGoal: ${step.prompt.slice(0, 200)}\nCompleted: ${resultText.slice(0, 200)}`;
          if (!quiet) console.log(`\n[Goal Verify] Checking if goal achieved...`);
          const checkTokens = await agent.process(
            `## Goal Verification\n\n${checkPrompt}\n\nRespond with ONLY "true" or "false" (lowercase).`
          );
          const checkText = checkTokens.map(t => t.text).join('').toLowerCase().trim();
          const achieved = checkText === 'true';
          if (!quiet) console.log(`  \u2192 Goal ${achieved ? 'ACHIEVED' : 'NOT achieved'}, ${achieved ? 'advancing' : 're-executing component ' + step.id}`);
          if (!achieved) {
            cur = step.id;
            break;
          }
        }

        cur = step.id + 1;
      }
    }

    if (cur >= workflow.components.length) {
      if (!quiet) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`\n=== Flow Complete (${elapsed}s, ${totalChars} chars) ===`);
      }
      break;
    }
  }
}
