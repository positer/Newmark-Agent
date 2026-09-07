// Actual Linux processes and production client/asyncProcess/helper; no providers.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const crypto = require('node:crypto');
const desktop = path.resolve(__dirname, '..');
const ts = require(path.join(desktop, 'node_modules/typescript'));
const esbuild = require(path.join(desktop, 'node_modules/esbuild'));
const { runAsyncProcess } = require(path.join(desktop, 'dist/core/asyncProcess.js'));
function loadSource(name, overrides = {}) {
  const source = path.join(desktop, 'src/core', name + '.ts');
  const filename = path.join(desktop, 'dist/core', name + '.js');
  const m = new Module(filename, module); m.filename = filename; m.paths = Module._nodeModulePaths(path.dirname(filename));
  m.require = id => Object.hasOwn(overrides, id) ? overrides[id] : Module.prototype.require.call(m, id);
  m._compile(ts.transpileModule(fs.readFileSync(source, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }, fileName: source }).outputText, filename);
  return m.exports;
}
const useBuilt = process.argv.includes('--built');
const tree = useBuilt ? require(path.join(desktop, 'dist/core/wslRuntimeProcessTree.js')) : loadSource('wslRuntimeProcessTree');
const { WslAgentClient, windowsDrivePathToWsl } = useBuilt ? require(path.join(desktop, 'dist/core/wslAgentClient.js')) : loadSource('wslAgentClient', { './wslRuntimeProcessTree': tree });
const { normalizeConversationTarget } = require(path.join(desktop, 'dist/core/conversationTarget.js'));
const distro = process.env.NEWMARK_TEST_WSL_DISTRO || 'Ubuntu-24.04';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const reports = [];
const clients = [];
let temp = '';
function skip(reason) {
  console.log('SKIP WSL process-tree verification: ' + reason);
  const index = process.argv.indexOf('--report');
  if (index >= 0) fs.writeFileSync(path.resolve(process.argv[index + 1]), JSON.stringify({ skipped: true, reason, passed: 0, total: 0 }));
}
async function check(name, fn) { await fn(); reports.push({ name, ok: true }); console.log('PASS ' + name); }
async function linuxPython(source, params = []) {
  const encoded = Buffer.from(source).toString('base64');
  return runAsyncProcess('wsl.exe', ['-d', distro, '--', 'python3', '-c', `import base64;exec(base64.b64decode('${encoded}'))`, ...params], { timeoutMs: 30000, windowsHide: true });
}
async function identitiesAlive(identities) {
  const result = await linuxPython("import sys,os,json\nout=[]\nfor row in json.loads(sys.argv[1]):\n try:\n  s=open('/proc/'+str(row['pid'])+'/stat').read().rsplit(')',1)[1].split()\n  out.append({'pid':row['pid'],'same':s[19]==row['startTimeTicks'],'state':s[0]})\n except FileNotFoundError: out.append({'pid':row['pid'],'same':False,'state':'absent'})\nprint(json.dumps(out))", [JSON.stringify(identities)]);
  assert.equal(result.status, 0, result.error || result.stderr); return JSON.parse(result.stdout.trim());
}
async function readyJson(file) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch {} await sleep(30); }
  throw Error('fixture identity not ready: ' + file);
}
function seed(client, identity) {
  const child = { killed: false, kill() { this.killed = true; return true; } };
  Object.assign(client, { child, childGeneration: 7, remotePid: identity.pid, remotePgid: identity.pgid, remoteSessionId: identity.sessionId, remoteStartTimeTicks: identity.startTimeTicks, remoteBootId: identity.bootId });
  return child;
}
async function main() {
  if (process.platform !== 'win32') { skip('Windows host required'); return; }
  const list = await runAsyncProcess('wsl.exe', ['-l', '-q'], { timeoutMs: 5000, windowsHide: true });
  if (list.timedOut || list.aborted || list.error) throw Error('WSL distro probe failed: ' + (list.error || list.stderr));
  if (list.status !== 0 || !list.stdout.replace(/\0/g, '').split(/\r?\n/).some(line => line.trim() === distro)) { skip('configured test distro unavailable'); return; }
  const capability = await linuxPython("import os,signal,json,shutil\nprint(json.dumps({'pidfd':hasattr(os,'pidfd_open') and hasattr(signal,'pidfd_send_signal'),'node':bool(shutil.which('node'))}))");
  if (capability.status !== 0) {
    if (!capability.timedOut && !capability.aborted && /(?:python3.*(?:not found|No such file)|execvpe\(python3\))/i.test(capability.stderr)) { skip('Python 3 unavailable'); return; }
    throw Error('WSL capability probe failed: ' + (capability.error || capability.stderr || String(capability.status)));
  }
  const caps = JSON.parse(capability.stdout.trim());
  if (!caps.pidfd || !caps.node) { skip('Python pidfd APIs or Node unavailable'); return; }
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-wsl-tree-verify-'));
  const hostFile = path.join(temp, 'fixture-host.bundle.cjs');
  const identityJs = "const f=fs.readFileSync('/proc/'+process.pid+'/stat','utf8').split(')').slice(1).join(')').trim().split(/\\s+/);return {pid:process.pid,pgid:Number(f[2]),sessionId:Number(f[3]),startTimeTicks:f[19],bootId:fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()};";
  const leaf = `const fs=require('fs'),path=require('path');const root=process.argv[1];function identity(){${identityJs}}fs.writeFileSync(path.join(root,'leaf.json'),JSON.stringify(identity()));setInterval(()=>fs.writeFileSync(path.join(root,'leaf.heartbeat'),String(Date.now())),40);`;
  const tool = `const fs=require('fs'),path=require('path'),{spawn}=require('child_process');const root=process.argv[1];function identity(){${identityJs}}fs.writeFileSync(path.join(root,'tool.json'),JSON.stringify(identity()));spawn(process.execPath,['-e',${JSON.stringify(leaf)},root],{detached:true,stdio:'ignore'}).unref();setInterval(()=>fs.writeFileSync(path.join(root,'tool.heartbeat'),String(Date.now())),40);`;
  const fixture = `import * as fs from 'fs';import * as path from 'path';import * as readline from 'readline';import {runAsyncProcess} from ${JSON.stringify(path.join(desktop, 'src/core/asyncProcess.ts'))};const root=process.env.NEWMARK_WSL_ROOT;function identity(){${identityJs}}const lines=readline.createInterface({input:process.stdin});lines.on('line',line=>{let q;try{q=JSON.parse(line);}catch{return;}let result;if(q.method==='ping')result=identity();else if(q.method==='shutdown'){if(!q.params?.supervisorTerminates)setTimeout(()=>process.exit(0),10);result=true;}else if(q.method==='prompt'){void runAsyncProcess(process.execPath,['-e',${JSON.stringify(tool)},root],{timeoutMs:60000});result={started:true};}else if(q.method==='snapshot')result={target:q.params.target};else result=true;process.stdout.write(JSON.stringify({id:q.id,ok:true,result})+'\\n');});`;
  esbuild.buildSync({ stdin: { contents: fixture, resolveDir: desktop, sourcefile: 'wsl-tree-fixture.ts', loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: hostFile });
  fs.writeFileSync(path.join(temp, 'typebox-compile.bundle.cjs'), 'module.exports = {};');
  async function start(name) {
    const runtimeRoot = path.join(temp, name); fs.mkdirSync(runtimeRoot);
    const target = normalizeConversationTarget({ workspaceId: 'same-workspace', conversationId: name, workspace: { id: 'same-workspace', name: 'same-workspace', path: runtimeRoot, isInternal: false, kind: 'local' } });
    const client = new WslAgentClient(distro, runtimeRoot, hostFile, target); clients.push(client);
    await client.start(); await client.request('prompt', { message: 'owned detached tool fixture' });
    const identities = [client.status(), await readyJson(path.join(runtimeRoot, 'tool.json')), await readyJson(path.join(runtimeRoot, 'leaf.json'))];
    await sleep(100); return { client, target, runtimeRoot, identities };
  }
  const [a, b] = await Promise.all([start('alpha'), start('beta')]);
  await check('two real client owners and actual asyncProcess detached child/grandchild identities are distinct', async () => {
    assert.notEqual(a.identities[0].pid, b.identities[0].pid);
    for (const fixture of [a, b]) {
      assert.equal(fixture.identities[0].pid, fixture.identities[0].pgid);
      assert.notEqual(fixture.identities[1].pgid, fixture.identities[0].pgid);
      assert.notEqual(fixture.identities[2].sessionId, fixture.identities[0].sessionId);
      assert.equal(new Set(fixture.identities.map(row => row.pid)).size, 3);
    }
  });
  await check('modeled reused birth is refused after original client exit, with no signal to the actual other owner', async () => {
    const stale = new WslAgentClient(distro, 'unused', hostFile, b.target);
    const child = seed(stale, { ...b.identities[0], startTimeTicks: String(BigInt(b.identities[0].startTimeTicks) + 1n) });
    const pending = stale.forceStopRuntimeGroup(); stale.handleExit(child, 0);
    await assert.rejects(() => pending, /identity mismatch/);
    assert.equal(stale.status().quarantined, true);
    await assert.rejects(() => stale.start(), /quarantined/);
    await assert.rejects(() => stale.forceRestartRuntimeGroup(), /quarantined/);
    await assert.rejects(() => stale.stop(), /quarantined/);
    await assert.rejects(() => stale.shutdownNow(), /quarantined/);
    await assert.rejects(() => stale.forceStopRuntimeGroup(), /quarantined/);
    assert.ok((await identitiesAlive(b.identities)).every(row => row.same && !['Z','T','t'].includes(row.state)));
  });
  await check('fresh force after observed owner exit never invokes a helper', async () => {
    let calls = 0; const c = new WslAgentClient(distro, 'unused', hostFile, a.target, async () => { calls++; throw Error('unexpected helper'); });
    const child = seed(c, a.identities[0]); c.handleExit(child, 0);
    await assert.rejects(() => c.forceStopRuntimeGroup(), /quarantined/); assert.equal(calls, 0);
    assert.equal(c.status().quarantined, true);
    await assert.rejects(() => c.start(), /quarantined/);
    await assert.rejects(() => c.stop(), /quarantined/);
  });
  await check('missing recorded birth identity fails closed before helper and prevents restart', async () => {
    let calls = 0; const c = new WslAgentClient(distro, 'unused', hostFile, a.target, async () => { calls++; throw Error('unexpected helper'); });
    seed(c, { ...a.identities[0], startTimeTicks: '' });
    await assert.rejects(() => c.forceStopRuntimeGroup(), /unverified.*birth identity/);
    assert.equal(calls, 0); assert.equal(c.status().quarantined, true);
    await assert.rejects(() => c.start(), /quarantined/);
  });
  await check('cancellation before dispatch does not pause any owner', async () => {
    const c = new WslAgentClient(distro, 'unused', hostFile, b.target); seed(c, b.identities[0]);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(() => c.forceStopRuntimeGroup(controller.signal), /aborted/);
    assert.ok((await identitiesAlive(b.identities)).every(row => row.same && !['Z','T','t'].includes(row.state)));
  });
  const betaBefore = fs.readFileSync(path.join(b.runtimeRoot, 'leaf.heartbeat'), 'utf8');
  await check('force-stop kills target root and detached descendants while another conversation continues', async () => {
    assert.equal(await a.client.forceStopRuntimeGroup(), 'terminated'); await sleep(100);
    assert.ok((await identitiesAlive(a.identities)).every(row => !row.same || row.state === 'Z'));
    assert.ok((await identitiesAlive(b.identities)).every(row => row.same && !['Z','T','t'].includes(row.state)));
    assert.notEqual(fs.readFileSync(path.join(b.runtimeRoot, 'leaf.heartbeat'), 'utf8'), betaBefore);
  });
  await check('abort after dispatch waits for bounded pidfd cleanup and leaves no frozen owner', async () => {
    const controller = new AbortController(); const pending = b.client.forceStopRuntimeGroup(controller.signal);
    controller.abort(); assert.equal(await pending, 'terminated');
    assert.ok((await identitiesAlive(b.identities)).every(row => !row.same || row.state === 'Z'));
  });
  await check('ordinary disposal keeps its leader until detached descendant identities are captured', async () => {
    await a.client.start(); await a.client.request('prompt', { message: 'owned detached disposal fixture' });
    const newRoot = a.client.status(); let disposalIdentities;
    const deadline = Date.now() + 10000;
    do {
      disposalIdentities = [newRoot, await readyJson(path.join(a.runtimeRoot, 'tool.json')), await readyJson(path.join(a.runtimeRoot, 'leaf.json'))];
      if (disposalIdentities.slice(1).every(row => BigInt(row.startTimeTicks) >= BigInt(newRoot.startTimeTicks))) break;
      await sleep(30);
    } while (Date.now() < deadline);
    assert.ok(disposalIdentities.slice(1).every(row => BigInt(row.startTimeTicks) >= BigInt(newRoot.startTimeTicks)));
    await a.client.stop(); assert.equal(a.client.status().connected, false);
    assert.ok((await identitiesAlive(disposalIdentities)).every(row => !row.same || row.state === 'Z'));
  });
  const report = { passed: reports.length, total: reports.length, mode: useBuilt ? 'built' : 'isolated-source', cases: reports, identities: { a: a.identities, b: b.identities }, helperSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(desktop, useBuilt ? 'dist/core/wslRuntimeProcessTree.js' : 'src/core/wslRuntimeProcessTree.ts'))).digest('hex'), boundary: 'Actual production client/helper and actual asyncProcess in a local protocol fixture host. No provider/GUI, no forced real PID reuse. Birth mismatch uses only controlled fixture identity; no unowned process is signalled.' };
  const reportArg = process.argv.indexOf('--report'); if (reportArg >= 0) fs.writeFileSync(path.resolve(process.argv[reportArg + 1]), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(async () => {
  for (const client of clients) { try { if (client.status().connected) await client.stop(); } catch (error) { console.error('owned fixture cleanup unconfirmed:', error.message); process.exitCode = 1; } }
  // Preserve files on a failed run for identity-specific cleanup and review.
  if (temp && !process.exitCode) {
    const resolved = path.resolve(temp);
    if (path.dirname(resolved).toLowerCase() !== path.resolve(os.tmpdir()).toLowerCase() || !path.basename(resolved).startsWith('newmark-wsl-tree-verify-')) {
      throw Error('Unexpected fixture cleanup path: ' + resolved);
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
