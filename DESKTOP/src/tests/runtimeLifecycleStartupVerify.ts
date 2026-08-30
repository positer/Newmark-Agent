import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beginRuntimeLifecycle, markRuntimeLifecycleClean, prepareRuntimeLifecycle } from '../core/runtimeLifecycle';

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-runtime-lifecycle-startup-'));
  const directory = path.join(root, '.newmark-runtime');
  fs.mkdirSync(directory, { recursive: true });
  for (let index = 0; index < 1000; index += 1) {
    fs.writeFileSync(path.join(directory, `lifecycle-main-clean-${index}.json`), JSON.stringify({
      role: 'main', ownerId: `clean-${index}`, pid: 0, active: false,
    }));
  }
  fs.writeFileSync(path.join(directory, 'lifecycle-main-crashed.json'), JSON.stringify({
    role: 'main', ownerId: 'crashed', pid: 2147483647, active: true,
  }));

  await prepareRuntimeLifecycle(root, 'main');
  const remaining = fs.readdirSync(directory).filter(file => file.startsWith('lifecycle-main'));
  assert.deepStrictEqual(remaining, ['lifecycle-main-crashed.json']);

  const state = beginRuntimeLifecycle(root, 'main');
  assert.strictEqual(state.unexpectedExit, true);
  assert.strictEqual(state.previousOwnerAlive, false);
  markRuntimeLifecycleClean(root, 'main');
  assert.strictEqual(fs.existsSync(path.join(directory, `lifecycle-main-${state.ownerId}.json`)), false);
  fs.rmSync(root, { recursive: true, force: true });
  console.log('runtime lifecycle startup verification passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
