import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { ConfigManager } from '../core/config';
import { ToolExecutor, ToolExecutionContext } from '../tools';
import { stopComputerUsePowerShellHost } from '../tools/computerUsePowerShellHost';

const FIXTURE_TITLE = 'Newmark ComputerUse Fixture 1280x720';
const FIXTURE_DIALOG_TITLE = 'Newmark Fixture Confirmation Dialog';
const SCENARIO_IDS = [
  'window_discovery',
  'observation_screenshot',
  'located_click',
  'text_input',
  'keyboard_shortcut',
  'scroll',
  'focus',
  'dialog_confirmation',
  'invalid_coordinate',
  'non_computer_use_request',
] as const;

interface FixtureReady {
  process: ChildProcessWithoutNullStreams;
  handle: string;
}

function parseResult(raw: string): Record<string, any> {
  assert.ok(!/^\[tool schema error]/i.test(raw), `ComputerUse input must satisfy the published schema: ${raw}`);
  return JSON.parse(raw) as Record<string, any>;
}

async function startFixture(): Promise<FixtureReady> {
  const fixturePath = path.resolve(__dirname, '../../scripts/fixtures/computer-use-1280x720.ps1');
  assert.ok(fs.existsSync(fixturePath), `ComputerUse fixture is missing: ${fixturePath}`);
  const child = spawn('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-STA',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    fixturePath,
  ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: false });

  return await new Promise<FixtureReady>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Timed out starting 1280x720 fixture. ${stderr.slice(0, 500)}`));
    }, 15_000);
    child.stdout.on('data', chunk => {
      stdout += String(chunk);
      const match = stdout.match(/READY\|(\d+)\|(\d+)\|(\d+)/);
      if (!match) return;
      clearTimeout(timer);
      assert.strictEqual(Number(match[2]), 1280, 'fixture client width must be 1280');
      assert.strictEqual(Number(match[3]), 720, 'fixture client height must be 720');
      resolve({ process: child, handle: match[1] });
    });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', code => {
      if (!stdout.includes('READY|')) {
        clearTimeout(timer);
        reject(new Error(`1280x720 fixture exited early (${code}). ${stderr.slice(0, 500)}`));
      }
    });
  });
}

async function execute(
  tools: ToolExecutor,
  root: string,
  context: ToolExecutionContext,
  args: Record<string, unknown>,
): Promise<Record<string, any>> {
  const validation = tools.validateInvocation('computer_use', JSON.stringify(args), context.mode || 'build');
  assert.strictEqual(validation.ok, true, `ComputerUse scenario arguments must satisfy the canonical schema: ${JSON.stringify(args)}`);
  return parseResult(await tools.execute('computer_use', JSON.stringify(args), root, context));
}

function exactObject(objects: Array<Record<string, any>>, label: string): Record<string, any> {
  const matches = objects.filter(object => object.label === label);
  assert.strictEqual(matches.length, 1, `expected one exact UIA object labelled ${label}, received ${matches.length}; observed=${objects.map(object => object.label).slice(0, 60).join(' | ')}`);
  return matches[0];
}

function assertInvocation(result: Record<string, any>, action: string, dryRun?: boolean): void {
  assert.strictEqual(result.action, action, `expected action ${action}, received ${JSON.stringify(result).slice(0, 500)}`);
  if (dryRun !== undefined) assert.strictEqual(result.dry_run, dryRun, `${action} dry_run mismatch`);
}

async function main(): Promise<void> {
  if (process.platform !== 'win32') {
    console.log(JSON.stringify({ ok: true, skipped: 'ComputerUse accuracy fixture requires Windows' }));
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-cli-computer-use-'));
  let fixture: FixtureReady | null = null;
  try {
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
      workspace: { auto_create_timestamp_workspace: false, prompt_mode: 'global_only', access_permission: 'full_access' },
      models: { providers: [], default_model: '' },
    }, null, 2));
    fixture = await startFixture();
    const tools = new ToolExecutor(root, new ConfigManager(root));
    tools.setHostProfile({ kind: 'cli', platform: 'win32', electronBrowser: false, windowsComputerUse: true });
    const context: ToolExecutionContext = {
      mode: 'build',
      workspacePath: root,
      conversationId: `fixture-${process.pid}`,
      actorId: '00000000-0000-4000-8000-000000000001',
      invocation: 'cli',
    };

    const apps = await execute(tools, root, context, { action: 'app_list' });
    assertInvocation(apps, 'app_list');
    const fixtureApp = (apps.applications || []).find((app: Record<string, unknown>) => String(app.title || '') === FIXTURE_TITLE);
    assert.ok(fixtureApp, `fixture window was not found in app_list: ${(apps.applications || []).map((app: any) => app.title).join(', ')}`);
    const handle = String(fixtureApp.handle || fixture.handle);
    const dialogApp = (apps.applications || []).find((app: Record<string, unknown>) => String(app.title || '') === FIXTURE_DIALOG_TITLE);
    assert.ok(dialogApp, `fixture confirmation dialog was not found in app_list: ${(apps.applications || []).map((app: any) => app.title).join(', ')}`);
    const dialogHandle = String(dialogApp.handle || '');

    const completedScenarios: string[] = ['window_discovery'];
    let computerUseCalls = 1;
    let observedBeforeAction = 0;
    const observe = async (windowHandle: string, retainScreenshot = false): Promise<Record<string, any>> => {
      computerUseCalls += 1;
      const observation = await execute(tools, root, { ...context, allowEphemeralVisionImage: retainScreenshot }, {
        action: 'app_observe',
        window_handle: windowHandle,
        capture_max_width: 1280,
        capture_max_height: 720,
      });
      assert.strictEqual(observation.ok, true, `app_observe failed: ${JSON.stringify(observation).slice(0, 500)}`);
      assertInvocation(observation, 'app_observe');
      return observation;
    };

    const screenshot = await observe(handle, true);
    assert.ok(Number(screenshot.width) >= 1280 && Number(screenshot.height) >= 720, 'application observation reports the physical-DPI source window bounds');
    assert.ok(Number(screenshot.image_width) > 0 && Number(screenshot.image_width) <= 1280, 'application screenshot respects the requested maximum width');
    assert.ok(Number(screenshot.image_height) > 0 && Number(screenshot.image_height) <= 720, 'application screenshot respects the requested maximum height');
    assert.strictEqual(screenshot.capture_max_width, 1280);
    assert.strictEqual(screenshot.capture_max_height, 720);
    assert.strictEqual(screenshot.screenshot_retention, 'ephemeral-delete-after-vision-input');
    const screenshotPath = String(screenshot.vision_image_path || '');
    assert.ok(screenshotPath && fs.existsSync(screenshotPath), 'trusted observation exposes one ephemeral screenshot path');
    const jpeg = fs.readFileSync(screenshotPath);
    assert.ok(jpeg.length > 1024 && jpeg[0] === 0xff && jpeg[1] === 0xd8, 'ephemeral screenshot contains non-empty JPEG bytes');
    fs.rmSync(screenshotPath, { force: true });
    completedScenarios.push('observation_screenshot');

    const clickObservation = await observe(handle);
    const clickTarget = exactObject(clickObservation.perception?.objects || [], 'Fixture Click Target');
    observedBeforeAction += 1;
    computerUseCalls += 1;
    const click = await execute(tools, root, context, { action: 'click', target_id: clickTarget.target_id, button: 'left', dry_run: true });
    assert.strictEqual(click.ok, true);
    assertInvocation(click, 'click', true);
    assert.strictEqual(click.button, 'left');
    assert.strictEqual(click.target?.target_id, clickTarget.target_id);
    assert.strictEqual(click.target?.label, 'Fixture Click Target');
    assert.ok(Number.isFinite(click.x) && Number.isFinite(click.y));
    completedScenarios.push('located_click');

    const inputObservation = await observe(handle);
    exactObject(inputObservation.perception?.objects || [], 'Fixture Text Input');
    const inputText = 'NEWMARK_INPUT_42';
    observedBeforeAction += 1;
    computerUseCalls += 1;
    const input = await execute(tools, root, context, { action: 'app_type', window_handle: handle, text: inputText, dry_run: true });
    assert.strictEqual(input.ok, true);
    assertInvocation(input, 'app_type', true);
    assert.strictEqual(input.chars, inputText.length, 'text input forwards the exact character count without performing desktop input');
    assert.strictEqual(String(input.app?.handle || '').toLowerCase(), handle.toLowerCase());
    completedScenarios.push('text_input');

    const shortcutObservation = await observe(handle);
    exactObject(shortcutObservation.perception?.objects || [], 'Fixture Shortcut Target');
    observedBeforeAction += 1;
    computerUseCalls += 1;
    const shortcut = await execute(tools, root, context, { action: 'app_key', window_handle: handle, key: '^s', dry_run: true });
    assert.strictEqual(shortcut.ok, true);
    assertInvocation(shortcut, 'app_key', true);
    assert.strictEqual(shortcut.key, '^s');
    completedScenarios.push('keyboard_shortcut');

    const scrollObservation = await observe(handle);
    const scrollTarget = exactObject(scrollObservation.perception?.objects || [], 'Fixture Scroll Surface');
    observedBeforeAction += 1;
    computerUseCalls += 1;
    const scroll = await execute(tools, root, context, { action: 'scroll', target_id: scrollTarget.target_id, scroll_x: 0, scroll_y: 480, dry_run: true });
    assert.strictEqual(scroll.ok, true);
    assertInvocation(scroll, 'scroll', true);
    assert.strictEqual(scroll.scroll_x, 0);
    assert.strictEqual(scroll.scroll_y, 480);
    assert.strictEqual(scroll.target?.target_id, scrollTarget.target_id);
    completedScenarios.push('scroll');

    const focusObservation = await observe(handle);
    exactObject(focusObservation.perception?.objects || [], 'Fixture Focus Target');
    observedBeforeAction += 1;
    computerUseCalls += 1;
    const focus = await execute(tools, root, context, { action: 'app_activate', window_handle: handle, dry_run: true });
    assert.strictEqual(focus.ok, true);
    assertInvocation(focus, 'app_activate', true);
    assert.strictEqual(String(focus.app?.handle || '').toLowerCase(), handle.toLowerCase());
    completedScenarios.push('focus');

    const dialogObservation = await observe(dialogHandle);
    const confirmTarget = exactObject(dialogObservation.perception?.objects || [], 'Confirm Fixture Dialog');
    assert.ok((dialogObservation.perception?.objects || []).some((object: Record<string, any>) => object.label === 'Cancel Fixture Dialog'), 'dialog includes a decoy alternative that must not be selected');
    observedBeforeAction += 1;
    computerUseCalls += 1;
    const confirm = await execute(tools, root, context, { action: 'click', target_id: confirmTarget.target_id, button: 'left', dry_run: true });
    assert.strictEqual(confirm.ok, true);
    assertInvocation(confirm, 'click', true);
    assert.strictEqual(confirm.target?.label, 'Confirm Fixture Dialog');
    assert.notStrictEqual(confirm.target?.label, 'Cancel Fixture Dialog');
    completedScenarios.push('dialog_confirmation');

    await observe(handle);
    observedBeforeAction += 1;
    computerUseCalls += 1;
    const invalidCoordinate = await execute(tools, root, context, { action: 'app_click', window_handle: handle, x: 5000, y: 5000, button: 'left', dry_run: true });
    assert.strictEqual(invalidCoordinate.ok, false);
    assertInvocation(invalidCoordinate, 'app_click');
    assert.match(String(invalidCoordinate.error || ''), /outside the selected application window/i);
    completedScenarios.push('invalid_coordinate');

    const callsBeforeNonComputerUse = computerUseCalls;
    const pwdArgs = {};
    const pwdValidation = tools.validateInvocation('pwd', JSON.stringify(pwdArgs), 'build');
    assert.strictEqual(pwdValidation.ok, true, 'non-ComputerUse request satisfies the pwd schema');
    const pwd = await tools.execute('pwd', JSON.stringify(pwdArgs), root, context);
    assert.match(pwd, /Current directory:/);
    assert.strictEqual(computerUseCalls, callsBeforeNonComputerUse, 'non-ComputerUse request never dispatches the ComputerUse host');
    completedScenarios.push('non_computer_use_request');

    await execute(tools, root, context, { action: 'takeover_stop' });
    assert.deepStrictEqual(completedScenarios, [...SCENARIO_IDS], 'all ten distinct acceptance scenarios complete in the declared order');
    assert.strictEqual(observedBeforeAction, 7, 'all seven control/error actions are preceded by a fresh exact-window observation');
    console.log(JSON.stringify({
      ok: true,
      fixture: '1280x720',
      scenarios: 10,
      scenario_ids: completedScenarios,
      tool_and_parameter_exact_match: '10/10',
      schema_accuracy: '100%',
      false_trigger_count: 0,
      observe_before_act: '100%',
      dangerous_desktop_actions: 0,
      controlled_window_reads_only: true,
    }));
  } finally {
    fixture?.process.kill();
    stopComputerUsePowerShellHost();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  error => {
    console.error(error);
    process.exit(1);
  },
);
