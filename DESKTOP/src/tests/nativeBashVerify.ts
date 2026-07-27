import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { executeWorkspaceBash, NativeBashSession, planNativeBash } from '../core/nativeBash';

async function main(): Promise<void> {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-native-bash-'));
  try {
    const nativePlan = planNativeBash('printf "alpha\\nbeta\\n" | grep beta | tr a-z A-Z');
    assert.strictEqual(nativePlan.engine, 'native');
    assert.deepStrictEqual(nativePlan.unsupportedCommands, []);

    const hostPlan = planNativeBash('git status --short');
    assert.strictEqual(hostPlan.engine, 'host');
    assert.deepStrictEqual(hostPlan.unsupportedCommands, ['git']);

    const pipeline = await executeWorkspaceBash(
      'printf "alpha\\nbeta\\n" | grep beta | tr a-z A-Z > result.txt; cat result.txt',
      workspace,
      { allowHostFallback: false },
    );
    assert.strictEqual(pipeline.engine, 'native-bash');
    assert.strictEqual(pipeline.exitCode, 0);
    assert.strictEqual(pipeline.stdout.trim(), 'BETA');
    assert.strictEqual(fs.readFileSync(path.join(workspace, 'result.txt'), 'utf-8').trim(), 'BETA');

    const session = new NativeBashSession(workspace);
    const makeAndMove = await session.execute('mkdir -p nested; cd nested; pwd');
    assert.strictEqual(makeAndMove.exitCode, 0);
    assert.strictEqual(makeAndMove.stdout.trim(), '/nested');
    assert.strictEqual(session.getCwd(), '/nested');
    const persistentCwd = await session.execute('pwd; echo session > state.txt');
    assert.strictEqual(persistentCwd.stdout.trim(), '/nested');
    assert.strictEqual(fs.readFileSync(path.join(workspace, 'nested', 'state.txt'), 'utf-8').trim(), 'session');

    const unsupported = await session.execute('git status');
    assert.strictEqual(unsupported.exitCode, 127);
    assert.match(unsupported.error || '', /Unsupported native Bash command: git/);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20).unref();
    const aborted = await executeWorkspaceBash('sleep 5; echo should-not-run', workspace, {
      allowHostFallback: false,
      signal: controller.signal,
      timeoutMs: 5_000,
    });
    assert.strictEqual(aborted.aborted, true);
    assert.strictEqual(aborted.stdout.includes('should-not-run'), false);

    console.log('nativeBashVerify: PASS');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
