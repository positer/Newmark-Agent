import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { appendRuntimeDiagnostic } from '../core/runtimeDiagnostics';

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-runtime-diagnostics-'));
  try {
    appendRuntimeDiagnostic(root, {
      event: 'utility_host_rpc_failed',
      level: 'error',
      runtimeKey: 'workspace:secret-path::conversation:fixture',
      generation: 3,
      pid: 42,
      requestId: 'utility-host-tool-fixture',
      tool: 'browser_use',
      stage: 'running',
      durationMs: 1234,
      error: 'C:\\Users\\developer\\private.pdf Authorization: Bearer secret-token',
    });
    const file = path.join(root, '.newmark-runtime', 'runtime-events.jsonl');
    const line = fs.readFileSync(file, 'utf-8').trim();
    const event = JSON.parse(line);
    assert.equal(event.event, 'utility_host_rpc_failed');
    assert.equal(event.requestId, 'utility-host-tool-fixture');
    assert.equal(event.tool, 'browser_use');
    assert.equal(event.stage, 'running');
    assert.equal(event.durationMs, 1234);
    assert.match(event.runtime, /^[a-f0-9]{16}$/);
    assert.ok(!line.includes('workspace:secret-path'));
    assert.ok(!line.includes('C:\\Users\\developer'));
    assert.ok(!line.includes('secret-token'));
    console.log('runtime diagnostics verification passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
