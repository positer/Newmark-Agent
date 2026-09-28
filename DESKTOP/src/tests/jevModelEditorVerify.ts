/**
 * Current-model Auto decision policy contract + the Auto-off freeze rule.
 *
 * Two guarantees are pinned here:
 *
 *  1. GUI, TUI and CLI expose only current-model policy controls. They never
 *     expose a separate model/runtime or a deterministic selector fallback.
 *  2. When Auto is off, nothing may change a model: the editors refuse every
 *     write (`auto_disabled`), no decision engine is invoked, and the resolved
 *     deployment stays exactly where it was.
 */
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Agent } from '../core/agent';

type Check = { ok: boolean; label: string };

function ok(value: unknown, label: string, checks: Check[]): void {
  checks.push({ ok: !!value, label });
  console.log(`${value ? 'PASS' : 'FAIL'}: ${label}`);
}

function model(name: string, cost: number) {
  return {
    name,
    display: name,
    description: '',
    cost_per_1k_input: cost,
    cost_per_1k_output: cost,
    max_tokens: 128000,
    vision: false,
    thinking: false,
    image_output: false,
    speed_rating: 'fast',
    capability_rating: 'high',
    capabilities: ['text_input', 'text_output', 'tool_use', 'json_schema'],
    validation: {
      level: 'standard',
      status: 'verified',
      checked_at: new Date().toISOString(),
      capabilities: { text_input: true, text_output: true, tool_use: true, json_schema: true },
    },
    intelligence_tiers: { low: { description: 'Quick' }, medium: { description: 'Balanced' }, high: { description: 'Deep' } },
  };
}

function writeRoot(options: { autoSwitch: boolean; extra?: Record<string, unknown> } = { autoSwitch: true }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-jev-editor-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    models: {
      providers: { value: [{
        id: 'editor-provider',
        name: 'Editor',
        base_url: 'http://127.0.0.1:1/v1',
        api_key: 'editor-secret',
        protocol: 'openai',
        enabled: true,
        models: [model('editor-model-a', 0.1), model('editor-model-b', 0.2)],
      }] },
      default_model: { value: 'editor-model-a' },
      auto_switch: { value: options.autoSwitch },
      auto_switch_preference: { value: 'balanced' },
      auto_switch_scope: { value: 'all' },
      fallback_on_unavailable: { value: true },
      jev_enabled: { value: true },
      jev_timeout_ms: { value: 3000 },
      ...(options.extra || {}),
    },
    workspace: { auto_create_timestamp_workspace: { value: false } },
  }, null, 2));
  return root;
}

function storedConfig(root: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf-8')) as Record<string, any>;
}

function configValue(root: string, key: string): unknown {
  const models = storedConfig(root).models || {};
  const entry = models[key];
  return entry && typeof entry === 'object' && 'value' in entry ? entry.value : entry;
}

function runCli(args: string[], cwd: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [path.join(cwd, 'dist', 'launcher.js'), ...args], {
    cwd,
    encoding: 'utf-8',
    windowsHide: true,
  });
  return { status: result.status ?? -1, stdout: String(result.stdout || ''), stderr: String(result.stderr || '') };
}

export async function verifyJevModelEditor(): Promise<Check[]> {
  const checks: Check[] = [];
  const cwd = process.cwd();
  const source = (relative: string): string => fs.readFileSync(path.join(cwd, relative), 'utf-8');

  // ---- Defaults and validation ------------------------------------------
  const root = writeRoot({ autoSwitch: true });
  try {
    const agent = new Agent(root, { agentOnly: true, conversationId: 'jev-editor' });
    const initial = agent.jevDecisionModelState();
    ok(initial.autoEnabled && !initial.locked && initial.enabled
      && initial.decisionModel === 'current_eligible_model'
      && initial.thinkingMode === 'off' && initial.outputFormat === 'strict_json_schema'
      && initial.timeoutMs === 3000,
    'JEV state identifies the current model, no-thinking mode, strict schema and timeout', checks);

    for (const [patch, label] of [
      [{ runtime: 'quantum' }, 'the removed runtime slot field'],
      [{ timeoutMs: 0 }, 'a zero decision budget'],
      [{ timeoutMs: 99_999 }, 'an out-of-range decision budget'],
      [{ modelId: '' }, 'the removed model identity field'],
      [{ fallbackStrategy: 'first_eligible', fallbackProviderId: 'p', fallbackModelId: 'm' }, 'retired selector fallback fields'],
    ] as Array<[Record<string, unknown>, string]>) {
      const before = fs.readFileSync(path.join(root, 'config.json'));
      const rejected = agent.updateJevDecisionModel(patch as never);
      ok(!rejected.ok && rejected.reason === 'invalid_value'
        && Buffer.compare(before, fs.readFileSync(path.join(root, 'config.json'))) === 0,
      `decision-model editor rejects ${label} without touching the stored config`, checks);
    }

    const applied = agent.updateJevDecisionModel({ timeoutMs: 5000 });
    ok(applied.ok && applied.state.decisionModel === 'current_eligible_model' && applied.state.timeoutMs === 5000
      && configValue(root, 'jev_model_id') === undefined
      && configValue(root, 'jev_runtime') === undefined
      && configValue(root, 'jev_model_path') === undefined
      && configValue(root, 'jev_timeout_ms') === 5000
      && configValue(root, 'jev_fallback_strategy') === undefined
      && configValue(root, 'jev_fallback_provider_id') === undefined
      && configValue(root, 'jev_fallback_model_id') === undefined,
    'current-model JEV policy persists timeout and has no external selector fields', checks);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  // ---- Auto off: the editor and the routing path are both frozen ---------
  const lockedRoot = writeRoot({ autoSwitch: false });
  try {
    const agent = new Agent(lockedRoot, { agentOnly: true, conversationId: 'jev-locked' });
    const locked = agent.jevDecisionModelState();
    ok(locked.locked && locked.lockReason === 'auto_disabled' && locked.autoEnabled === false,
      'Auto off reports current-model JEV policy as locked to every editor', checks);

    const before = fs.readFileSync(path.join(lockedRoot, 'config.json'));
    const refused = agent.updateJevDecisionModel({ timeoutMs: 500 });
    ok(!refused.ok && refused.reason === 'auto_disabled'
      && refused.state.decisionModel === 'current_eligible_model'
      && Buffer.compare(before, fs.readFileSync(path.join(lockedRoot, 'config.json'))) === 0,
    'Auto off refuses every current-model policy edit and leaves the config byte-identical', checks);

    const switched = await agent.evaluateAndSwitch('Explain the result with Auto disabled');
    const deploymentBefore = JSON.stringify(agent.activeDeployment());
    ok(switched === false
      && agent.lastRouteDecision === null
      && deploymentBefore === JSON.stringify({ providerId: 'editor-provider', modelId: 'editor-model-a' }),
    'Auto off invokes no decision engine, records no decision and leaves the selected model untouched', checks);
  } finally {
    fs.rmSync(lockedRoot, { recursive: true, force: true });
  }

  // ---- Auto on, current-model JEV disabled: fail closed -----------------
  for (const [label, extra, expectedReason] of [
    ['current-model JEV is switched off', { jev_enabled: { value: false } }, 'disabled'],
  ] as Array<[string, Record<string, unknown>, string]>) {
    const frozenRoot = writeRoot({ autoSwitch: true, extra });
    try {
      // Disabling current-model decisions must not select another deployment.
      const agent = new Agent(frozenRoot, { agentOnly: true, conversationId: 'jev-frozen' });
      agent.setModel('auto');
      const first = await agent.evaluateAndSwitch('Explain the result');
      const resolvedBefore = JSON.stringify(agent.activeDeployment());
      const second = await agent.evaluateAndSwitch('Explain the result again');
      const decision = agent.lastRouteDecision;
      ok(second === false
        && decision?.finalStatus === 'no_candidate'
        && decision?.decisionSource === 'jev'
        && String(decision?.decisionError || '').includes(expectedReason)
        && decision?.resolvedDeployment === undefined
        && JSON.stringify(agent.activeDeployment()) === resolvedBefore
        && first === false,
      `when ${label}, Auto resolves no model and the previous deployment is preserved`, checks);
    } finally {
      fs.rmSync(frozenRoot, { recursive: true, force: true });
    }
  }

  // ---- GUI entry point ---------------------------------------------------
  const ui = source(path.join('src', 'ui', 'index.html'));
  ok(ui.includes('id="jev-decision-model-card"')
    && ui.includes('function jevDecisionModelSettingsHtml()')
    && ui.includes("data-jev-locked=")
    && ['enabled', 'timeout-ms']
      .every(field => ui.includes(`data-jev-field="${field}"`))
    && !ui.includes('data-jev-field="fallback-strategy"')
    && !ui.includes('data-jev-field="fallback-provider"')
    && !ui.includes('data-jev-field="fallback-model"')
    && ui.includes('data-jev-model="current-eligible-model"')
    && ui.includes('data-jev-thinking="off"')
    && ui.includes('data-jev-output="strict-json-schema"')
    && !ui.includes('data-jev-field="runtime"')
    && !ui.includes('data-jev-field="model-id"')
    && !ui.includes('data-jev-field="model-path"'),
  'GUI exposes the current-model no-thinking strict-schema policy without a fallback selector', checks);
  ok(ui.includes("window.setJevDecisionModel = function(patch)")
    && ui.includes("api.setJevDecisionModel(patch || {})")
    && ui.includes("result.reason === 'auto_disabled'")
    && ui.includes("var disabled = locked ? ' disabled' : ''"),
  'GUI editor refuses Auto-off edits, disables every control and reports the lock', checks);
  ok(ui.includes("'model.jevTitle': 'Auto decision policy'")
    && ui.includes("'model.jevTitle': 'Auto 决策策略'")
    && ui.includes("'model.jevLocked'"),
  'GUI editor ships bilingual labels for current-model JEV and its lock state', checks);
  ok(source(path.join('src', 'preload.ts')).includes("ipcRenderer.invoke('agent:setJevDecisionModel', request)")
    && source(path.join('src', 'main.ts')).includes("ipcMain.handle('agent:setJevDecisionModel'")
    && source(path.join('src', 'main.ts')).includes('jevDecisionModel: agent.jevDecisionModelState()'),
  'desktop IPC exposes the decision-model editor and publishes its state to the renderer', checks);

  // ---- TUI entry point ---------------------------------------------------
  const tuiSchema = source(path.join('..', 'TUI', 'src', 'settings-schema.js'));
  const tuiState = source(path.join('..', 'TUI', 'src', 'state.js'));
  const tuiAdapter = source(path.join('..', 'TUI', 'src', 'adapters', 'core-runtime-adapter.js'));
  const tuiRender = source(path.join('..', 'TUI', 'src', 'render.js'));
  ok(tuiSchema.includes('id: "jev"') && tuiSchema.includes('Auto decision policy')
    && tuiSchema.includes('jev-toggle-enabled') && tuiSchema.includes('jev-report-current-model')
    && tuiSchema.includes('jev-cycle-timeout') && !tuiSchema.includes('jev-cycle-fallback')
    && tuiSchema.includes('Strict JSON Schema') && tuiSchema.includes('Thinking mode')
    && !tuiSchema.includes('jev-cycle-runtime')
    && !tuiSchema.includes('Deterministic fallback') && tuiSchema.includes('Locked (Auto off)'),
  'TUI settings expose current-model JEV policy, fixed output mode and timeout only', checks);
  ok(tuiAdapter.includes('jevDecisionModel: agent.jevDecisionModelState()')
    && tuiAdapter.includes('case "jevDecisionModel"')
    && tuiAdapter.includes('agent.updateJevDecisionModel(value || {})'),
  'TUI adapter routes decision-model edits through the Agent contract', checks);
  ok(tuiState.includes('function applyJevDecisionRow')
    && tuiState.includes('Auto is off: current-model decision settings are locked')
    && tuiRender.includes('LOCKED'),
  'TUI reports the Auto-off lock instead of applying a blocked edit', checks);

  // ---- CLI entry point (real process) ------------------------------------
  const cliRoot = writeRoot({ autoSwitch: false });
  try {
    const help = runCli(['jev', '--help', '--root', cliRoot], cwd);
    ok(help.status === 0 && help.stdout.includes('current-model Auto routing policy'),
      'CLI documents the current-model JEV policy editor', checks);

    const beforeLocked = fs.readFileSync(path.join(cliRoot, 'config.json'));
    const lockedWrite = runCli(['jev', '--timeout', '500', '--json', '--root', cliRoot], cwd);
    ok(lockedWrite.status === 2
      && lockedWrite.stdout.includes('auto_disabled')
      && Buffer.compare(beforeLocked, fs.readFileSync(path.join(cliRoot, 'config.json'))) === 0,
    'CLI refuses a decision-model edit while Auto is off (exit 2, config untouched)', checks);

    const lockedRead = runCli(['jev', '--json', '--root', cliRoot], cwd);
    ok(lockedRead.status === 0 && lockedRead.stdout.includes('"locked": true')
      && lockedRead.stdout.includes('"decisionModel": "current_eligible_model"')
      && lockedRead.stdout.includes('"thinkingMode": "off"')
      && lockedRead.stdout.includes('"outputFormat": "strict_json_schema"'),
      'CLI reports the locked current-model JEV state read-only', checks);
  } finally {
    fs.rmSync(cliRoot, { recursive: true, force: true });
  }

  const cliWriteRoot = writeRoot({ autoSwitch: true });
  try {
    const written = runCli([
      'jev', '--timeout', '5000', '--json', '--root', cliWriteRoot,
    ], cwd);
    ok(written.status === 0
      && written.stdout.includes('"decisionModel": "current_eligible_model"')
      && written.stdout.includes('"thinkingMode": "off"')
      && written.stdout.includes('"outputFormat": "strict_json_schema"')
      && written.stdout.includes('"timeoutMs": 5000')
      && configValue(cliWriteRoot, 'jev_model_id') === undefined
      && configValue(cliWriteRoot, 'jev_runtime') === undefined
      && configValue(cliWriteRoot, 'jev_model_path') === undefined
      && configValue(cliWriteRoot, 'jev_timeout_ms') === 5000
      && configValue(cliWriteRoot, 'jev_fallback_strategy') === undefined,
    'CLI applies a current-model policy patch and prints the strict-format state', checks);
  } finally {
    fs.rmSync(cliWriteRoot, { recursive: true, force: true });
  }

  return checks;
}

if (require.main === module) {
  verifyJevModelEditor().then(checks => {
    const failed = checks.filter(check => !check.ok);
    console.log(`\nJEV decision-model editor verification: ${checks.length - failed.length}/${checks.length} passed`);
    if (failed.length) process.exitCode = 1;
  }).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
