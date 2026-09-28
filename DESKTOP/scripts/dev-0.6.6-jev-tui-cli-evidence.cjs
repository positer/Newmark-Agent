#!/usr/bin/env node
/**
 * Current-model JEV policy evidence for the TUI + CLI settings surfaces.
 *
 * The GUI has a screenshot monitor (`dev-0.6.6-jev-settings-ui-monitor.cjs`);
 * the terminal surfaces get the equivalent artifact here: the real TUI renders
 * its JEV settings section from the production adapter (Auto on, then Auto off)
 * and the CLI prints its editor output, all captured into the archive folder.
 *
 * Usage: node scripts/dev-0.6.6-jev-tui-cli-evidence.cjs
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const desktop = path.resolve(__dirname, '..');
const repoRoot = path.dirname(desktop);
const tui = path.join(repoRoot, 'TUI');
const outDir = path.join(repoRoot, 'archive', '20260927-pc-gui-fps-optimization', 'jev-tui-cli');

const { createCoreRuntimeAdapter } = require(path.join(tui, 'src', 'adapters', 'core-runtime-adapter'));
const { render, stripAnsi } = require(path.join(tui, 'src', 'render'));
const { createState, moveFocusHorizontal, moveSelection, switchView, toggleSelected } = require(path.join(tui, 'src', 'state'));
const { SETTINGS_CATEGORIES } = require(path.join(tui, 'src', 'settings-schema'));

const checks = [];
function check(name, passed, detail) {
  checks.push({ name, passed: !!passed, ...(passed ? {} : { detail }) });
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}${passed ? '' : ` :: ${JSON.stringify(detail).slice(0, 400)}`}`);
}

function writeConfig(root, autoSwitch) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    models: {
      providers: [{
        id: 'jev-evidence-provider',
        name: 'JevEvidence',
        base_url: 'https://jev-evidence.invalid/v1',
        api_key: 'evidence-key',
        protocol: 'openai',
        enabled: true,
        models: [{ name: 'jev-evidence-model', display: 'jev-evidence-model', max_tokens: 128000 }],
      }],
      default_model: 'jev-evidence-model',
      agent_engine: 'builtin',
      auto_switch: autoSwitch,
      auto_switch_scope: 'all',
      jev_enabled: true,
      jev_timeout_ms: 3000,
      jev_fallback_strategy: 'configured_model',
    },
    agent: { default_mode: 'build' },
    general: { language: 'en' },
    workspace: { auto_create_timestamp_workspace: false },
  }, null, 2), 'utf8');
}

function renderJevSettings(root, workspacePath) {
  const adapter = createCoreRuntimeAdapter({ root, workspacePath, desktopDist: path.join(desktop, 'dist') });
  try {
    // createState takes adapter options; the standalone demo's default adapter
    // is the mock, which would hide the current-model JEV settings.
    const state = createState({ adapter });
    switchView(state, 'settings');
    moveFocusHorizontal(state, 1);
    const jevIndex = SETTINGS_CATEGORIES.findIndex((category) => category.id === 'jev');
    const currentIndex = SETTINGS_CATEGORIES.findIndex((category) => category.id === state.settingsTab);
    moveSelection(state, jevIndex - currentIndex);
    moveFocusHorizontal(state, 1);
    return { state, adapter, text: stripAnsi(render(state, 120, 40)) };
  } finally {
    // The adapter stays open for the caller (edit checks) and is closed there.
  }
}

function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-jev-tui-'));
  const workspacePath = path.join(root, 'workspace');
  fs.mkdirSync(workspacePath, { recursive: true });
  try {
    // Auto on: policy timeout is editable; decision source, no-thinking mode,
    // and strict-JSON output are fixed to the current eligible conversation model.
    writeConfig(root, true);
    const unlocked = renderJevSettings(root, workspacePath);
    fs.writeFileSync(path.join(outDir, 'tui-jev-section-auto-on.txt'), `${unlocked.text}\n`, 'utf8');
    check('TUI renders current-model JEV policy and keeps protocol invariants locked',
      unlocked.text.includes('Auto decision policy settings')
      && unlocked.text.includes('Current-model decision')
      && unlocked.text.includes('On')
      && unlocked.text.includes('Current eligible model')
      && unlocked.text.includes('Thinking mode')
      && unlocked.text.includes('Off LOCKED')
      && unlocked.text.includes('Strict JSON Schema')
      && unlocked.text.includes('LOCKED')
      && unlocked.text.includes('3000 ms')
      && unlocked.text.includes('Auto routing'),
      unlocked.text.slice(0, 600));

    // The TUI row action reaches the shared config through the adapter.
    const edited = unlocked.adapter.saveConfig({ jevDecisionModel: { timeoutMs: 5000 } });
    const stored = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).models;
    check('TUI decision-model edits persist through the shared config',
      edited.ok === true
      && (stored.jev_timeout_ms && stored.jev_timeout_ms.value) === 5000
      && !Object.hasOwn(stored, 'jev_fallback_strategy')
      && !Object.hasOwn(stored, 'jev_model_id')
      && !Object.hasOwn(stored, 'jev_model_path'),
      { edited, timeout: stored.jev_timeout_ms, legacyKeys: Object.keys(stored).filter(key => /^jev_(fallback|model_id|model_path)/.test(key)) });
    unlocked.adapter.close();

    // Auto off: same current-model policy section, locked, and edits are refused.
    writeConfig(root, false);
    const locked = renderJevSettings(root, workspacePath);
    fs.writeFileSync(path.join(outDir, 'tui-jev-section-auto-off.txt'), `${locked.text}\n`, 'utf8');
    check('TUI shows the decision-model section as LOCKED while Auto is off',
      locked.text.includes('LOCKED') && locked.text.includes('Auto routing')
      && locked.text.includes('Off'),
      locked.text.slice(0, 600));
    const refused = locked.adapter.saveConfig({ jevDecisionModel: { timeoutMs: 1000 } });
    const storedAfter = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).models;
    check('TUI refuses a decision-model edit while Auto is off',
      refused.ok === false && refused.reason === 'auto_disabled'
      && (storedAfter.jev_timeout_ms === 3000 || storedAfter.jev_timeout_ms?.value === 3000)
      && !Object.hasOwn(storedAfter, 'jev_runtime')
      && !Object.hasOwn(storedAfter, 'jev_model_id')
      && !Object.hasOwn(storedAfter, 'jev_model_path'),
      { refused, timeout: storedAfter.jev_timeout_ms });
    locked.adapter.close();

    // CLI evidence.
    const cliRoot = path.join(root, 'cli');
    writeConfig(cliRoot, true);
    const show = spawnSync(process.execPath, [path.join(desktop, 'dist', 'launcher.js'), 'jev', '--json', '--root', cliRoot], { encoding: 'utf8', windowsHide: true });
    fs.writeFileSync(path.join(outDir, 'cli-jev-show.json'), String(show.stdout || ''), 'utf8');
    check('CLI prints current-model, no-thinking and strict-schema settings as JSON',
      show.status === 0
      && String(show.stdout).includes('"decisionModel": "current_eligible_model"')
      && String(show.stdout).includes('"thinkingMode": "off"')
      && String(show.stdout).includes('"outputFormat": "strict_json_schema"')
      && String(show.stdout).includes('"locked": false')
      && !String(show.stdout).includes('"runtime"'),
      { status: show.status, stdout: String(show.stdout).slice(0, 300) });

    const edit = spawnSync(process.execPath, [
      path.join(desktop, 'dist', 'launcher.js'), 'jev', '--timeout', '5000', '--json', '--root', cliRoot,
    ], { encoding: 'utf8', windowsHide: true });
    fs.writeFileSync(path.join(outDir, 'cli-jev-edit.txt'), String(edit.stdout || ''), 'utf8');
    check('CLI edits only the bounded current-model decision timeout',
      edit.status === 0
      && String(edit.stdout).includes('"timeoutMs": 5000')
      && String(edit.stdout).includes('"decisionModel": "current_eligible_model"')
      && String(edit.stdout).includes('"thinkingMode": "off"')
      && String(edit.stdout).includes('"outputFormat": "strict_json_schema"')
      && !String(edit.stdout).includes('"modelId"'),
      { status: edit.status, stdout: String(edit.stdout).slice(0, 300) });

    writeConfig(cliRoot, false);
    const refusedCli = spawnSync(process.execPath, [path.join(desktop, 'dist', 'launcher.js'), 'jev', '--disable', '--root', cliRoot], { encoding: 'utf8', windowsHide: true });
    fs.writeFileSync(path.join(outDir, 'cli-jev-refused.txt'), `${refusedCli.stdout || ''}${refusedCli.stderr || ''}`, 'utf8');
    check('CLI refuses a decision-model edit while Auto is off',
      refusedCli.status === 2 && String(refusedCli.stderr).includes('Auto routing is off'),
      { status: refusedCli.status, stderr: String(refusedCli.stderr).slice(0, 300) });

    fs.writeFileSync(path.join(outDir, 'TUI-CLI-REPORT.json'), JSON.stringify({
      at: new Date().toISOString(),
      checks,
      failed: checks.filter((entry) => !entry.passed).length,
    }, null, 2), 'utf8');
  } finally {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try { fs.rmSync(root, { recursive: true, force: true }); break; } catch { /* retry */ }
    }
  }
  const failed = checks.filter((entry) => !entry.passed);
  console.log(`[jev-tui-cli] ${checks.length - failed.length}/${checks.length} checks passed; artifacts in ${outDir}`);
  if (failed.length) process.exitCode = 1;
}

main();
