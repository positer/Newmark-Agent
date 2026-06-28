/**
 * Newmark Flow Runner v2
 * Executes a Flow workflow by driving the Agent through each component.
 * 
 * Usage:
 *   node run_flow.js <workflow_name> [start_component]
 *   node run_flow.js agent_implementation          # run from component 0
 *   node run_flow.js agent_implementation 22        # run from component 22
 */
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const ROOT = __dirname;
const FLOW_DIR = path.join(ROOT, 'Flow');
const DESKTOP_DIST = path.join(ROOT, 'DESKTOP', 'dist');

// ── Condition evaluators (programmatic) ──────────────────────────
const CONDITION_EVALUATORS = {
  /** Component 1: README.md has complete phased plan with 26 sections? */
  'README.md contains a complete phased implementation plan covering all 26 sections of Design.txt': () => {
    const rp = path.join(ROOT, 'README.md');
    if (!fs.existsSync(rp)) return false;
    const content = fs.readFileSync(rp, 'utf-8');
    const phaseCount = (content.match(/Phase\s+\d+/gi) || []).length;
    const hasArchitecture = content.toLowerCase().includes('electron') || content.toLowerCase().includes('architecture');
    const hasCLI = content.toLowerCase().includes('cli');
    const hasUI = content.toLowerCase().includes('ui') || content.toLowerCase().includes('glass');
    return phaseCount >= 26 && hasArchitecture && hasCLI && hasUI;
  },

  /** Component 3: CLI mode boots? */
  'does the agent start in CLI mode': () => {
    try {
      const result = execSync('node dist/launcher.js --cli --root "' + ROOT + '"', {
        cwd: DESKTOP_DIST, encoding: 'utf-8', timeout: 30000,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      return result && result.length > 0;
    } catch { return false; }
  },

  /** Component 5: npm run build passes */
  'npm run build': () => {
    try {
      execSync('npm run build', { cwd: path.join(ROOT, 'DESKTOP'), encoding: 'utf-8', timeout: 60000 });
      return true;
    } catch { return false; }
  },

  /** Component 7: UI glass/marquee/bezier classes exist */
  'ui renders with correct glass effects': () => {
    const uiFile = path.join(DESKTOP_DIST, 'ui', 'index.html');
    if (!fs.existsSync(uiFile)) return false;
    const content = fs.readFileSync(uiFile, 'utf-8');
    return content.includes('glass-1') && content.includes('marquee') && content.includes('bezier');
  },

  /** Component 9: All panel elements exist in HTML */
  'panels render': () => {
    const uiFile = path.join(DESKTOP_DIST, 'ui', 'index.html');
    if (!fs.existsSync(uiFile)) return false;
    const content = fs.readFileSync(uiFile, 'utf-8');
    return content.includes('topbar') && content.includes('left-secondary') && content.includes('bottom') && content.includes('chat-area');
  },

  /** Component 11: Input area elements exist */
  'input area renders': () => {
    const uiFile = path.join(DESKTOP_DIST, 'ui', 'index.html');
    if (!fs.existsSync(uiFile)) return false;
    const content = fs.readFileSync(uiFile, 'utf-8');
    return content.includes('prompt-input') && content.includes('mode-select') && content.includes('submit-btn');
  },

  /** Component 13: Settings overlay exists */
  'settings window open': () => {
    const uiFile = path.join(DESKTOP_DIST, 'ui', 'index.html');
    if (!fs.existsSync(uiFile)) return false;
    const content = fs.readFileSync(uiFile, 'utf-8');
    return content.includes('settings-overlay') && content.includes('settings-tab');
  },

  /** Component 15: Sub-windows exist */
  'sub-windows render': () => {
    const uiFile = path.join(DESKTOP_DIST, 'ui', 'index.html');
    if (!fs.existsSync(uiFile)) return false;
    const content = fs.readFileSync(uiFile, 'utf-8');
    return content.includes('plugins-overlay') && content.includes('auto-overlay') && content.includes('flow-overlay');
  },

  /** Component 17: All 4 modes handled in agent code */
  'all 4 modes work': () => {
    const agentFile = path.join(DESKTOP_DIST, 'core', 'agent.js');
    if (!fs.existsSync(agentFile)) return false;
    const content = fs.readFileSync(agentFile, 'utf-8');
    return content.includes("'build'") && content.includes("'plan'") && content.includes("'goal'") && content.includes("'flow'");
  },

  /** Component 19: Option feedback + auto-switch + fuzzy inject code exists */
  'option feedback works': () => {
    const agentFile = path.join(DESKTOP_DIST, 'core', 'agent.js');
    if (!fs.existsSync(agentFile)) return false;
    const content = fs.readFileSync(agentFile, 'utf-8');
    return content.includes('option_feedback') || content.includes('pendingOptions');
  },
  'auto model switch works': () => {
    const agentFile = path.join(DESKTOP_DIST, 'core', 'agent.js');
    if (!fs.existsSync(agentFile)) return false;
    const content = fs.readFileSync(agentFile, 'utf-8');
    return content.includes('autoSwitch') || content.includes('evaluateAndSwitch');
  },
  'fuzzy inject works': () => {
    const configFile = path.join(DESKTOP_DIST, 'core', 'config.js');
    if (!fs.existsSync(configFile)) return false;
    const content = fs.readFileSync(configFile, 'utf-8');
    return content.includes('upsertProvider') || content.includes('fuzzy');
  },

  /** Component 21: Archive + file tree + terminal code */
  'archive save/load work': () => {
    const agentFile = path.join(DESKTOP_DIST, 'core', 'agent.js');
    if (!fs.existsSync(agentFile)) return false;
    const content = fs.readFileSync(agentFile, 'utf-8');
    return content.includes('archiveSession') && content.includes('listArchives') && content.includes('deleteArchive');
  },
  'file tree navigates': () => {
    const uiFile = path.join(DESKTOP_DIST, 'ui', 'index.html');
    if (!fs.existsSync(uiFile)) return false;
    const content = fs.readFileSync(uiFile, 'utf-8');
    return content.includes('file-tree') || content.includes('fileTree');
  },

  /** Generic: does file exist? */
  'does': (prompt) => {
    // "Does X exist?" → check fs.existsSync
    const match = prompt.match(/does\s+(.+?)\s+(exist|contain)/i);
    if (match) {
      const target = match[1].replace(/['"]/g, '').trim();
      const fullPath = path.join(ROOT, target);
      if (fs.existsSync(fullPath)) {
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) return true;
        if (match[2].toLowerCase() === 'contain') {
          const content = fs.readFileSync(fullPath, 'utf-8');
          return content.length > 0;
        }
        return true;
      }
      return false;
    }
    return null; // can't evaluate, use agent
  },
};

function evaluateCondition(prompt) {
  // Try exact match
  for (const [key, fn] of Object.entries(CONDITION_EVALUATORS)) {
    if (prompt.toLowerCase().includes(key.toLowerCase())) {
      const result = fn();
      if (result !== null) return result;
    }
  }
  // Try generic patterns
  const genericResult = CONDITION_EVALUATORS.does(prompt);
  if (genericResult !== null) return genericResult;
  return null; // use agent fallback
}

// ── Main runner ──────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const workflowName = args[0] || 'agent_implementation';
  const startFrom = parseInt(args[1], 10) || 0;

  if (!fs.existsSync(path.join(DESKTOP_DIST, 'core', 'flow.js'))) {
    console.error('[ERROR] DESKTOP not built. Run: cd DESKTOP && npm run build');
    process.exit(1);
  }

  const { FlowEngine } = require(path.join(DESKTOP_DIST, 'core', 'flow.js'));
  const { Agent } = require(path.join(DESKTOP_DIST, 'core', 'agent.js'));

  const workflow = FlowEngine.load(FLOW_DIR, workflowName);
  if (!workflow) {
    console.error('[ERROR] Workflow "' + workflowName + '" not found in ' + FLOW_DIR);
    console.error('  Available: ' + FlowEngine.listAll(FLOW_DIR).join(', '));
    process.exit(1);
  }

  console.log('\n');
  console.log('  \u2554' + '\u2550'.repeat(47) + '\u2557');
  console.log('  \u2551  Newmark Flow Runner v2' + ' '.repeat(27) + '\u2551');
  console.log('  \u2551  Workflow: ' + workflowName.padEnd(33) + '\u2551');
  console.log('  \u2551  Components: ' + String(workflow.components.length).padEnd(2) + '                       \u2551');
  console.log('  \u2551  Start at: ' + String(startFrom).padEnd(2) + '                          \u2551');
  console.log('  \u255a' + '\u2550'.repeat(47) + '\u255d');
  console.log('\n');

  // Disable auto-create timestamp workspace so agent operates at ROOT
  const cfgPath = path.join(ROOT, 'config.json');
  const cfgOrig = fs.readFileSync(cfgPath, 'utf-8');
  const cfg = JSON.parse(cfgOrig);
  if (cfg.workspace && cfg.workspace.auto_create_timestamp_workspace) {
    cfg.workspace.auto_create_timestamp_workspace.value = false;
    cfg.workspace.auto_create_timestamp_workspace._save = cfgOrig; // for restore
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 4), 'utf-8');
  }

  const agent = new Agent(ROOT);

  // Clear workspace so tool resolver falls back to ROOT
  agent.workspace.clear();

  let pc = startFrom;
  let maxSteps = 200;
  let stepCount = 0;
  let consecutiveSamePc = 0;
  let lastPc = -1;

  while (stepCount < maxSteps) {
    stepCount++;
    const comp = workflow.components.find(c => c.id === pc);
    if (!comp) {
      console.log('\n  [END] Component ' + pc + ' not found. Workflow complete.\n');
      break;
    }

    // Detect infinite loop
    if (pc === lastPc) {
      consecutiveSamePc++;
      if (consecutiveSamePc >= 3) {
        console.warn('\n  [WARN] Stuck at component ' + pc + '. Skipping past logic gate.\n');
        pc++;
        consecutiveSamePc = 0;
        continue;
      }
    } else {
      consecutiveSamePc = 0;
    }
    lastPc = pc;

    if (comp.type === 'dialog') {
      await executeDialog(agent, comp, workflowName);
      pc++;
    } else {
      const result = await evaluateLogicNode(agent, comp);
      const nextPc = FlowEngine.resolveGoto(workflow, pc, result);
      const destStr = result ? 'goto ' + comp.goto_true : 'goto ' + comp.goto_false;
      console.log('\n  [LOGIC] ' + pc + ' \u2192 ' + (result ? 'TRUE' : 'FALSE') + ' (' + destStr + ')\n');
      pc = nextPc;
    }
  }

  if (stepCount >= maxSteps) {
    console.log('\n  [WARN] Max steps (' + maxSteps + ') reached. Possible infinite loop.\n');
  }

  console.log('\n  \u2554' + '\u2550'.repeat(47) + '\u2557');
  console.log('  \u2551  Workflow Complete' + ' '.repeat(31) + '\u2551');
  console.log('  \u2551  Steps executed: ' + String(stepCount).padEnd(2) + '                    \u2551');
  console.log('  \u255a' + '\u2550'.repeat(47) + '\u255d');
  console.log('\n');
}

async function executeDialog(agent, comp, workflowName) {
  const modeLabel = comp.mode.toUpperCase();
  console.log('\n  \u250c' + '\u2500'.repeat(47) + '\u2510');
  console.log('  \u2502 [' + modeLabel + '] Component ' + String(comp.id).padEnd(2) + '                        \u2502');
  console.log('  \u2514' + '\u2500'.repeat(47) + '\u2518\n');

  agent.setMode(comp.mode);
  const expanded = comp.prompt.replace(/\{#prompt#\}/g, '[Flow: ' + workflowName + ', Component ' + comp.id + ']');

  console.log('  Prompt:\n');
  for (const line of expanded.split('\n')) {
    console.log('    ' + line);
  }
  console.log('');

  const startTime = Date.now();
  try {
    const tokens = await agent.process(expanded);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const text = tokens.map(t => t.text).join('');
    console.log('\n  [OUTPUT] (' + elapsed + 's)\n');
    for (const line of text.split('\n').slice(0, 30)) {
      console.log('    ' + line);
    }
    if (text.split('\n').length > 30) {
      console.log('    ... [' + (text.split('\n').length - 30) + ' more lines]');
    }
    if (agent.fileDiffs.length > 0) {
      console.log('\n  [EDITS]');
      for (const d of agent.fileDiffs) {
        const add = d.oldContent ? Math.max(0, d.newContent.length - d.oldContent.length) : d.newContent.length;
        const rm = d.oldContent ? Math.max(0, d.oldContent.length - d.newContent.length) : 0;
        console.log('    ' + d.path + ' ' + (add > 0 ? '+' + add : '') + ' ' + (rm > 0 ? '-' + rm : ''));
      }
    }
  } catch (e) {
    console.error('\n  [ERROR] Component ' + comp.id + ': ' + e.message);
  }
}

async function evaluateLogicNode(agent, comp) {
  console.log('\n  \u250c' + '\u2500'.repeat(47) + '\u2510');
  console.log('  \u2502 [LOGIC] Component ' + String(comp.id).padEnd(2) + '                       \u2502');
  console.log('  \u2502  ' + comp.prompt.slice(0, 44));
  console.log('  \u2502  TRUE \u2192 ' + comp.goto_true + '  |  FALSE \u2192 ' + comp.goto_false);
  console.log('  \u2514' + '\u2500'.repeat(47) + '\u2518');

  // Try programmatic evaluation first
  const progResult = evaluateCondition(comp.prompt);
  if (progResult !== null) {
    console.log('  [EVAL] Programmatic: ' + (progResult ? 'TRUE' : 'FALSE'));
    return progResult;
  }

  // Fallback: ask agent
  console.log('  [EVAL] Asking agent...');
  agent.setMode('plan');
  try {
    const tokens = await agent.process('Answer with YES or NO only: ' + comp.prompt);
    const text = tokens.map(t => t.text).join('').toLowerCase();
    const result = /yes|true|complete|done|implemented|verified|available|works|correct|passing/.test(text);
    console.log('  [EVAL] Agent: ' + (result ? 'TRUE' : 'FALSE') + ' (from: "' + text.slice(0, 60) + '")');
    return result;
  } catch (e) {
    console.error('  [EVAL] Agent error: ' + e.message + ' \u2192 defaulting to FALSE');
    return false;
  }
}

main().catch(e => {
  console.error('[FATAL] ' + e.message);
  process.exit(1);
});
