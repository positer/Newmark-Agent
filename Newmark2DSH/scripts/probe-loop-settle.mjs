/**
 * SCRATCH PROBE — what the seam hands the model, and what the loop does with a failing tool.
 *
 * Not a gate. This exists to MEASURE, before any fix is written:
 *   1. the exact `GenerateOptions.messages` the seam passes to `ctx.llm.stream` on the turn
 *      after a tool call, so "does the failure reach the model, and in what shape" is a
 *      reading rather than a guess;
 *   2. the shape of `ToolCallBlock.arguments` in that request (`dsh-llm`'s published type says
 *      `arguments: string`, and the DeepSeek adapter's `toolInput()` does `JSON.parse(raw)`);
 *   3. what a fixture model that merely RETRIES on an uninformative failure does to the loop.
 *
 * Run: node Newmark2DSH/scripts/probe-loop-settle.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const componentDir = path.join(path.resolve(here, '..'), 'packages', 'newmark-core', 'components', 'agent-api');
const bust = `${Date.now()}`;
const url = (rel) => new URL(`file:///${path.join(componentDir, rel).replace(/\\/g, '/')}?probe=${bust}`).href;

const { createAgentApi } = await import(url('component.js'));
const { classifyToolResult } = await import(url('lib/contract.js'));

const line = (text) => console.log(text);

/* ---------------------------------------------- 1. the classifier, on the real store shape --- */

const storeValue = {
  ok: false,
  status: 'error',
  error: { code: 'NOT_FOUND', message: 'Memory component not found: ZZZ-No-Such-Component-1234', details: { selector: 'ZZZ-No-Such-Component-1234' } },
};
const classified = classifyToolResult('memory_lab_read', { isError: false, value: storeValue });
line('# what a memory tool failure is classified into');
line(JSON.stringify(classified));
line(`  message the model would be shown: ${JSON.stringify(classified.error)}`);
line('');

/* -------------------------------------- 2. the loop, over a fixture model that RETRIES a failure --- */

function turn({ text = '', toolCalls = [], reason = { kind: 'stop' } } = {}) {
  const chunks = [];
  let index = 0;
  if (text) {
    chunks.push({ type: 'block-start', index, blockType: 'text' });
    chunks.push({ type: 'text-delta', index, text });
    chunks.push({ type: 'block-end', index, block: { type: 'text', text } });
    index += 1;
  }
  for (const call of toolCalls) {
    chunks.push({ type: 'block-end', index, block: { type: 'tool-call', id: call.id, name: call.name, arguments: JSON.stringify(call.arguments ?? {}) } });
    index += 1;
  }
  chunks.push({ type: 'finish', reason });
  return chunks;
}

const seen = [];
const scripts = [];
const llm = {
  async listModels(provider) {
    return [{ provider, id: 'deepseek-flash', name: 'DeepSeek Flash' }];
  },
  stream(generate) {
    seen.push(generate);
    if (seen.length > 12) throw new Error('the fixture model refuses call > 12: the loop is not settling');
    const script = scripts.length > 0 ? scripts.shift() : turn({ text: '{"verdict":"ok"}' });
    return (async function* emit() {
      for (const chunk of script) yield chunk;
    })();
  },
};

const definitions = new Map();
const registry = {
  register(definition) {
    definitions.set(definition.name, definition);
    return () => definitions.delete(definition.name);
  },
  schemas: () => [...definitions.values()].map((d) => ({ name: d.name, description: d.description, parameters: d.parameters })),
  async execute(exec) {
    const definition = definitions.get(exec.name);
    if (!definition) return { isError: true, error: { message: `unknown tool ${exec.name}`, info: { code: 'UNKNOWN_TOOL' } } };
    try {
      const value = await definition.execute(exec.arguments, exec);
      return { isError: false, value };
    } catch (error) {
      return { isError: true, error: { message: String(error?.message ?? error), info: { code: 'TOOL_ERROR' } } };
    }
  },
};

/* A memory-shaped tool: it "succeeds" at the registry and answers with `ok: false`, which is
 * exactly what `memory_lab_read` does for a component that does not exist. */
registry.register({
  name: 'memory_lab_read',
  description: 'probe fixture: read a memory component, answering ok:false when it is absent',
  parameters: { type: 'object', properties: { component: { type: 'string' } }, required: [] },
  output: { schema: { type: 'object' }, render: () => [] },
  async execute() {
    return storeValue;
  },
});

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nma-probe-'));
const api = createAgentApi({
  root,
  services: () => ({ tools: registry, llm, core: { model: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) } }),
});
const sendTool = api.tools().find((t) => t.name === 'agent_api_send');

/* THE FIXTURE MODEL: it retries the same failing call while the failure it is shown carries no
 * information, and answers as soon as it is shown something it can act on. This is the model
 * behaviour the live measurement reported (rounds 3 and 4), written down as a rule so the loop's
 * response to it is measurable without spending tokens. */
scripts.push(turn({ toolCalls: [{ id: 'c1', name: 'memory_lab_read', arguments: { component: 'ZZZ' } }], reason: { kind: 'tool-calls' } }));
for (let n = 0; n < 10; n += 1) scripts.push(turn({ toolCalls: [{ id: `c${n + 2}`, name: 'memory_lab_read', arguments: { component: 'ZZZ' } }], reason: { kind: 'tool-calls' } }));

const answer = await sendTool.execute({ prompt: 'read the component ZZZ', max_steps: 5, workspace: path.join(root, 'Work') }, {});
line('# a failing tool call, five model turns of budget');
line(JSON.stringify({ exit: answer.exit, code: answer.code, error: answer.error }));
line('');

/* ---------------------------------------------------- 3. the request the model was handed --- */

const second = seen[1];
line('# the SECOND request this component handed to ctx.llm.stream');
if (second) {
  for (const message of second.messages) {
    const blocks = (message.content ?? []).map((block) => {
      if (block?.type === 'tool-call') {
        return { type: 'tool-call', id: block.id, name: block.name, arguments: block.arguments, argumentsType: typeof block.arguments };
      }
      if (block?.type === 'text') return { type: 'text', text: block.text };
      return { type: block?.type ?? String(block) };
    });
    line(
      `  role=${message.role} isError=${String(message.isError)} toolCallId=${String(message.toolCallId)} ${JSON.stringify(blocks)}`,
    );
  }
}
line('');
line('# the tool result text the model is shown, per turn');
for (const [index, generate] of seen.entries()) {
  const toolMessages = generate.messages.filter((m) => m.role === 'tool');
  if (toolMessages.length === 0) continue;
  line(`  request ${index + 1}: ${JSON.stringify(toolMessages.map((m) => ({ isError: m.isError ?? null, text: (m.content ?? []).map((b) => b.text).join('') })))}`);
}
fs.rmSync(root, { recursive: true, force: true });

const rule = turn({ toolCalls: [{ id: 'x', name: 'memory_lab_read', arguments: { component: 'ZZZ' } }], reason: { kind: 'tool-calls' } });
line('');
line(`# fixture sanity: a scripted tool-call turn is ${rule.length} chunks, the first is ${rule[0].type}`);
