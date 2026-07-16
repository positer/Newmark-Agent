import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Agent } from '../core/agent';
import { LLMProvider } from '../llm/provider';

let assertions = 0;
function ok(value: unknown, message: string): void {
  assert.ok(value, message);
  assertions += 1;
  console.log(`PASS: ${message}`);
}

function nonceFrom(value: unknown): string {
  return String(value || '').match(/NMK-[a-f0-9]+/i)?.[0] || '';
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-validation-agent-'));
  const originalChat = LLMProvider.prototype.chat;
  const originalStream = LLMProvider.prototype.chatStreamWithTools;
  const originalCatalog = LLMProvider.prototype.modelCatalog;
  const originalFetch = globalThis.fetch;
  let chatCalls = 0;
  let streamCalls = 0;
  const protocolBodies: Array<Record<string, any>> = [];
  try {
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
      models: {
        providers: { value: [{
          id: 'fixture-provider',
          name: 'Fixture',
          base_url: 'https://fixture.invalid/v1',
          api_key: 'fixture-secret',
          protocol: 'openai',
          enabled: true,
          models: [{ name: 'fixture-model', display: 'Fixture', vision: true }],
        }] },
        default_model: { value: 'fixture-model' },
        auto_switch: { value: true },
        auto_switch_preference: { value: 'balanced' },
        auto_switch_scope: { value: 'all' },
      },
      workspace: { auto_create_timestamp_workspace: { value: false } },
    }, null, 2));

    LLMProvider.prototype.modelCatalog = async function() {
      return [{ id: 'fixture-model', raw: { capabilities: ['vision', 'tools', 'json_schema'] } }];
    };
    LLMProvider.prototype.chat = async function(_model, messages) {
      chatCalls += 1;
      const content = messages[0]?.content;
      if (Array.isArray(content)) return '{"left":"red_square","right":"blue_circle","bottom":"green_triangle","marker":"NM7"}';
      const prompt = String(content || '');
      if (prompt.includes('NEWMARK_HEALTH_OK')) return 'NEWMARK_HEALTH_OK';
      const nonce = nonceFrom(prompt);
      if (prompt.includes('Schema:')) return JSON.stringify({ nonce });
      return nonce;
    };
    LLMProvider.prototype.chatStreamWithTools = async function*(_model, messages, _system, _temperature, _maxTokens, tools) {
      streamCalls += 1;
      const prompt = String(messages[0]?.content || '');
      const nonce = nonceFrom(prompt);
      const hasToolResult = messages.some(message => message.role === 'tool');
      if (hasToolResult) {
        yield { type: 'text' as const, text: nonce };
        return;
      }
      if (Array.isArray(tools) && tools.length) {
        yield {
          type: 'tool_call' as const,
          text: '',
          toolCall: { id: 'fixture-call', name: 'newmark_validation_echo', arguments: JSON.stringify({ nonce }) },
        };
        return;
      }
      yield { type: 'text' as const, text: nonce };
    };
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}')) as Record<string, any>;
      protocolBodies.push(body);
      const nonce = nonceFrom(JSON.stringify(body));
      const endpoint = String(url);
      if (body.output_config) {
        return new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ nonce }) }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (body.response_format) {
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ nonce }) } }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (body.stream === true) {
        if (endpoint.endsWith('/messages')) {
          return new Response([
            'event: content_block_delta',
            `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: nonce } })}`,
            '',
            'event: message_stop',
            `data: ${JSON.stringify({ type: 'message_stop' })}`,
            '',
          ].join('\n'), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        }
        if (endpoint.endsWith('/responses')) {
          return new Response([
            `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: nonce })}`,
            `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed' })}`,
            '',
          ].join('\n\n'), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        }
        return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: nonce } }] })}\n\ndata: [DONE]\n\n`, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }
      return new Response('unexpected validation transport', { status: 500 });
    }) as typeof fetch;

    const agent = new Agent(root, { agentOnly: true });
    const first = await agent.validateModels(['Fixture/fixture-model']);
    ok(first.length === 1 && first[0].status === 'verified', 'Agent validation maps the complete Standard probe suite to verified');
    const saved = agent.config.findDeployment({ providerId: 'fixture-provider', modelId: 'fixture-model' });
    ok(saved?.validation?.level === 'standard' && saved.validation.status === 'verified', 'Standard evidence is persisted separately from legacy evaluation');
    ok(saved?.validation?.capabilities?.image_input === true
      && saved.validation.capabilities.tool_use === true
      && saved.validation.capabilities.json_schema === true,
    'only actually probed vision, tool and strict-JSON capabilities are granted');
    const strictBody = protocolBodies.find(body => body.response_format);
    ok(strictBody?.response_format?.type === 'json_schema'
      && strictBody.response_format.json_schema?.strict === true
      && strictBody.response_format.json_schema?.schema?.additionalProperties === false,
    'strict JSON evidence comes from an OpenAI response_format/json_schema request');
    ok(protocolBodies.some(body => body.stream === true), 'streaming evidence comes from a real streaming transport request');
    const anthropic = new LLMProvider('AnthropicFixture', 'https://anthropic.fixture/v1', 'fixture-secret', 'anthropic');
    const anthropicStream = await anthropic.probeStreamCompletion(
      'claude-fixture',
      [{ role: 'user', content: 'Nonce: NMK-a11ce' }],
      null,
      0,
      32,
    );
    ok(anthropicStream.completionEvent === 'anthropic_message_stop' && anthropicStream.chunks.join('') === 'NMK-a11ce', 'Anthropic streaming requires message_stop and preserves text deltas');
    await anthropic.chatStrictJson(
      'claude-fixture',
      [{ role: 'user', content: 'Nonce: NMK-b0b' }],
      null,
      0,
      32,
      { type: 'object', additionalProperties: false, required: ['nonce'], properties: { nonce: { type: 'string' } } },
    );
    ok(protocolBodies.some(body => body.output_config?.format?.type === 'json_schema'), 'Anthropic strict JSON evidence uses output_config.format JSON Schema');
    const responses = new LLMProvider('ResponsesFixture', 'https://responses.fixture/v1', 'fixture-secret', 'openai', 'responses');
    const responsesStream = await responses.probeStreamCompletion(
      'responses-fixture',
      [{ role: 'user', content: 'Nonce: NMK-cafe' }],
      null,
      0,
      32,
    );
    ok(responsesStream.completionEvent === 'openai_response_completed' && responsesStream.chunks.join('') === 'NMK-cafe', 'Responses streaming requires response.completed and preserves output deltas');
    const candidate = (agent as any).autoRouteCandidates().find((item: any) => item.deployment.modelId === 'fixture-model');
    ok(candidate?.capabilities.includes('json_schema') && candidate.capabilities.includes('tool_use'), 'validated capability names remain canonical in Auto candidates');
    ok(candidate?.supportedProtocolParameters.includes('response_format')
      && candidate.supportedProtocolParameters.includes('json_schema')
      && candidate.supportedProtocolParameters.includes('tools')
      && candidate.supportedProtocolParameters.includes('tool_choice'),
    'strict-JSON and tool validation map to consistent OpenAI protocol parameters');
    ok(fs.existsSync(path.join(root, 'model-validation', 'records.json')), 'validation evidence is stored under the isolated Newmark root');

    const callsAfterFirst = chatCalls + streamCalls + protocolBodies.length;
    const second = await agent.validateModels(['Fixture/fixture-model']);
    ok(second[0].status === 'verified' && chatCalls + streamCalls + protocolBodies.length === callsAfterFirst, 'fresh seven-day validation evidence is reused without provider calls');

    agent.setModel('auto');
    ok(await agent.evaluateAndSwitch('Use a tool to inspect this screenshot'), 'a model joins Auto only after Standard validation succeeds');
  } finally {
    LLMProvider.prototype.chat = originalChat;
    LLMProvider.prototype.chatStreamWithTools = originalStream;
    LLMProvider.prototype.modelCatalog = originalCatalog;
    globalThis.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log(`model validation Agent integration passed (${assertions} assertions)`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
