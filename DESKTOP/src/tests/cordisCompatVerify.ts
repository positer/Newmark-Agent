/**
 * Cordis 核兼容性评测：用真实 DSH 工具层插件的 defineTool 定义样本，评测
 * Newmark 的 seedToolchainFromDefinitions（cordis 核的 ToolRegistry）能否无损接入。
 *
 * Run: npm run build && node dist/tests/cordisCompatVerify.js
 *
 * 背景：DSH 是插件式 harness，工具层插件通过 defineTool({name, description,
 * parameters, output}) 注册。其 ToolSchema 字段是 parameters（标准 JSON Schema），
 * 而源码层参数是 ParameterSchemaSpec（per-property required:true，需转顶层 required）。
 * 本评测只做只读元数据解析，绝不 import/execute DSH 插件代码。
 */
import assert from 'node:assert/strict';
import { seedToolchainFromDefinitions } from '../toolchain';

let assertions = 0;
function check(cond: boolean, name: string): void {
  assertions += 1;
  console.log('  ' + (cond ? '[PASS]' : '[FAIL]') + ' ' + name);
  assert.ok(cond, name);
}

/** 复刻 DSH parameterSchemaSpecToJsonSchema：per-property required:true -> 顶层 required 数组。 */
function parameterSchemaSpecToJsonSchema(spec: Record<string, any>): Record<string, unknown> {
  function convertProps(props: Record<string, any>): { props: Record<string, any>; required: string[] } {
    const out: Record<string, any> = {};
    const required: string[] = [];
    for (const [k, v] of Object.entries(props)) {
      const node = v as Record<string, any> | undefined;
      if (node && node.required === true) required.push(k);
      out[k] = convertNode(node as any);
    }
    return { props: out, required };
  }
  function convertNode(node: any): any {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(convertNode);
    const out: Record<string, any> = {};
    const required: string[] = [];
    for (const [k, v] of Object.entries(node)) {
      if (k === 'required') continue;
      if (k === 'properties' && v && typeof v === 'object') {
        const r = convertProps(v as Record<string, any>);
        out[k] = r.props;
        if (r.required.length) out.required = r.required;
        continue;
      }
      out[k] = convertNode(v);
    }
    return out;
  }
  // DSH 真实行为：把参数 map 包进 type:'object' + properties，required 为顶层数组。
  const r = convertProps(spec);
  return { type: 'object', properties: r.props, ...(r.required.length ? { required: r.required } : {}) };
}

// 真实 DSH 插件 defineTool 样本（只读提取自 _vendor/deepseek-harness/packages）
const DSH_TODO_WRITE = { name: 'todo_write', description: 'Record and update a structured task list for the current work.', parameters: { todos: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { content: { type: 'string', required: true }, status: { type: 'string', required: true, enum: ['pending', 'in_progress', 'completed'] } } } } } };
const DSH_GET_GOAL = { name: 'get_goal', description: 'Read the current same-session goal.', parameters: {} };
const DSH_UPDATE_GOAL = { name: 'update_goal', description: 'Update the exact current goal revision.', parameters: { goal_id: { type: 'string', required: true }, revision: { type: 'number', required: true }, action: { type: 'string', required: true, enum: ['edit', 'pause', 'resume', 'complete', 'blocked'] }, objective: { type: 'string' }, blocked_reason: { type: 'string' } } };
const DSH_PWSH = { name: 'pwsh', description: 'Execute a PowerShell command.', parameters: { command: { type: 'string', required: true } } };

async function main(): Promise<void> {
  console.log('cordisCompatVerify');

  // 1. ParameterSchemaSpec -> JSON Schema 转换正确性
  const todoJson = parameterSchemaSpecToJsonSchema(DSH_TODO_WRITE.parameters) as any;
  check(todoJson.type === 'object' && !!todoJson.properties, 'spec: 外层 type:object + properties 包装');
  check(Array.isArray(todoJson.required) && todoJson.required.includes('todos'), 'spec: root required 聚合为顶层 required 数组');
  const todoItems = (todoJson.properties as any)?.todos?.items as any;
  check(!!todoItems && !!todoItems.properties?.content, 'spec: 嵌套 items 保留');
  check(Array.isArray(todoItems?.required) && todoItems.required.includes('content') && todoItems.required.includes('status'), 'spec: 嵌套对象 required 聚合');

  // 2. DSH 插件接入 cordis 核（seedToolchainFromDefinitions）
  const dshDefs = [
    { name: 'todo_write', description: DSH_TODO_WRITE.description, inputSchema: parameterSchemaSpecToJsonSchema(DSH_TODO_WRITE.parameters) },
    { name: 'get_goal', description: DSH_GET_GOAL.description, inputSchema: { type: 'object', properties: {}, required: [] } },
    { name: 'update_goal', description: DSH_UPDATE_GOAL.description, inputSchema: parameterSchemaSpecToJsonSchema(DSH_UPDATE_GOAL.parameters) },
    { name: 'pwsh', description: DSH_PWSH.description, inputSchema: parameterSchemaSpecToJsonSchema(DSH_PWSH.parameters) },
  ];
  const seeded = seedToolchainFromDefinitions(dshDefs, { namespace: 'dsh-plugins', version: '1.0.0' });
  const registry = seeded.core.registry;
  const todoReg = registry.get('todo_write');
  check(!!todoReg, 'DSH todo_write 接入 registry');
  check(!!todoReg && !!todoReg.fullDescription && todoReg.fullDescription.includes('structured task list'), 'DSH todo_write description 保留');
  check(!!todoReg && Array.isArray((todoReg.inputSchema as any)?.required) && (todoReg.inputSchema as any).required.includes('todos'), 'DSH todo_write required 保留');
  check(!!registry.get('get_goal') && registry.get('get_goal')!.riskLevel === 'read', 'DSH get_goal 推断 read');
  check(!!registry.get('update_goal') && registry.get('update_goal')!.riskLevel === 'write', 'DSH update_goal 推断 write');
  check(!!registry.get('pwsh') && registry.get('pwsh')!.idempotency === 'non_idempotent', 'DSH pwsh 推断 non_idempotent');

  // 3. 字段名兼容：DSH ToolSchema 用 parameters 字段（非 inputSchema）
  const dshToolSchemaShaped = [{ name: 'todo_write', description: DSH_TODO_WRITE.description, parameters: parameterSchemaSpecToJsonSchema(DSH_TODO_WRITE.parameters) }];
  const shapedSeed = seedToolchainFromDefinitions(dshToolSchemaShaped, { namespace: 'dsh-toolschema', version: '1.0.0' });
  const shapedTodo = shapedSeed.core.registry.get('todo_write');
  check(!!shapedTodo && Array.isArray((shapedTodo.inputSchema as any)?.required) && (shapedTodo.inputSchema as any).required.includes('todos'), 'DSH ToolSchema(parameters 字段) 接入保留 required（字段名兼容）');


  // 4. 功能承载：DSH ToolDefinition（含 execute + isConcurrencySafe）接入后真正可执行
  const executeCalls: string[] = [];
  const dshFunctionalDefs = [{
    name: 'todo_write',
    description: DSH_TODO_WRITE.description,
    parameters: parameterSchemaSpecToJsonSchema(DSH_TODO_WRITE.parameters),
    execute: (args: { todos: Array<{ content: string; status: string }> }) => {
      executeCalls.push('called');
      return { count: args.todos.length, ok: true };
    },
    isConcurrencySafe: () => false,
  }];
  const functionalSeed = seedToolchainFromDefinitions(dshFunctionalDefs, { namespace: 'dsh-functional', version: '1.0.0' });
  const functionalTodo = functionalSeed.core.registry.get('todo_write');
  check(!!functionalTodo && typeof functionalTodo.execute === 'function', 'cordis 核承载 execute 函数（功能不断链）');
  // 真正执行：调用 registry 里的 execute，验证功能实现接入成功
  const result = (functionalTodo!.execute as any)({ todos: [{ content: 'a', status: 'pending' }, { content: 'b', status: 'completed' }] }, { signal: undefined });
  const resolved = result && typeof (result as any).then === 'function' ? await (result as Promise<any>) : result;
  check(!!resolved && resolved.count === 2 && resolved.ok === true, 'cordis 核 execute 真正执行并返回正确值');
  check(executeCalls.length === 1 && executeCalls[0] === 'called', 'execute 函数体真实被调用（功能实现）');
  check(typeof functionalTodo!.isConcurrencySafe === 'function' && functionalTodo!.isConcurrencySafe({}) === false, 'cordis 核承载 isConcurrencySafe 运行时分类');
  // 5. 完整官方 ToolDefinition 契约承载（output.render/presentationMeta、finalizeContent、timeoutMs、present*）
  const fullContractDefs = [{
    name: 'web_fetch',
    description: 'Fetch and extract URL content.',
    parameters: { url: { type: 'string', required: true } },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      render: (_args: unknown, value: any) => ({ type: 'text', text: value.text }),
      presentationMeta: (_args: unknown, value: any) => ({ truncated: value.text.length > 8000 }),
    },
    execute: async (args: any) => ({ text: 'fetched ' + args.url }),
    finalizeContent: () => undefined,
    timeoutMs: 30000,
    presentCall: (args: any) => ({ card: 'generic', title: 'fetch ' + args.url }),
    presentResult: (_args: unknown, result: any) => ({ card: 'generic', title: 'done' }),
  }];
  const fullSeed = seedToolchainFromDefinitions(fullContractDefs, { namespace: 'dsh-full', version: '1.0.0' });
  const full = fullSeed.core.registry.get('web_fetch');
  check(!!full && !!full.outputSchema, '官方契约：output.schema 提取为 outputSchema');
  check(!!full && typeof full.render === 'function', '官方契约：output.render 承载');
  check(!!full && typeof full.presentationMeta === 'function', '官方契约：output.presentationMeta 承载');
  check(!!full && typeof full.finalizeContent === 'function', '官方契约：finalizeContent 承载');
  check(!!full && full.timeoutMs === 30000, '官方契约：timeoutMs 承载');
  check(!!full && typeof full.presentCall === 'function', '官方契约：presentCall 承载');
  check(!!full && typeof full.presentResult === 'function', '官方契约：presentResult 承载');
  // render 真正可调用并投影值
  const rendered = (full!.render as any)({ url: 'x' }, { text: 'hello' });
  check(!!rendered && (rendered as any).text === 'hello', '官方契约：render 真正投影值');
  // presentationMeta 真正投影回放状态
  const meta = (full!.presentationMeta as any)({ url: 'x' }, { text: 'a'.repeat(9000) });
  check(!!meta && (meta as any).truncated === true, '官方契约：presentationMeta 真正投影回放状态');

  console.log('');
  console.log('  total assertions: ' + assertions);
  console.log('  PASS');
}

main().catch((error) => { console.error('FAIL', error); process.exit(1); });
