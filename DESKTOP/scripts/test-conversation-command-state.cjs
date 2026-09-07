'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), Module = require('node:module');
const assert = require('node:assert/strict'), ts = require('typescript');
function run() {
  const filename = path.resolve(__dirname, '../dist/core/conversationCommandState.js');
  const source = fs.readFileSync(path.resolve(__dirname, '../src/core/conversationCommandState.ts'), 'utf8');
  const item = new Module(filename, module); item.filename = filename; item.paths = Module._nodeModulePaths(path.dirname(filename));
  item._compile(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, filename);
  const { ConversationCommandStateStore: Store } = item.exports;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-command-state-test-'));
  let count = 0;
  const check = (name, action) => { action(); count++; console.log('PASS ' + name); };
  try {
    const store = new Store(root), file = path.join(root, 'conversation-command-state.json');
    check('missing state does not create or rewrite a file', () => { assert.equal(store.get('A'), undefined); assert.equal(fs.existsSync(file), false); });
    store.set('A', { mode: 'goal', inputMode: 'next', queuePaused: true });
    store.set('B', { mode: 'plan', inputMode: 'guide', queuePaused: false });
    check('restart restores each target mode and pause independently', () => { const reopened = new Store(root); assert.deepEqual(reopened.get('A'), { mode: 'goal', inputMode: 'next', queuePaused: true }); assert.equal(reopened.get('B').queuePaused, false); });
    check('partial patch preserves the other fields', () => { store.set('A', { queuePaused: false }); assert.deepEqual(store.get('A'), { mode: 'goal', inputMode: 'next', queuePaused: false }); });
    check('returned state cannot mutate the durable owner', () => { const copy = store.get('A'); copy.mode = 'chat'; assert.equal(store.get('A').mode, 'goal'); });
    check('repeated snapshot events perform no redundant writes', () => {
      const original = fs.fsyncSync; fs.fsyncSync = () => { throw Error('Unexpected fsync'); };
      try { store.set('A', { mode: 'goal', queuePaused: false }); } finally { fs.fsyncSync = original; }
    });
    check('failed replacement preserves both previous disk data and live state', () => {
      const bytes = fs.readFileSync(file), original = fs.renameSync;
      fs.renameSync = () => { throw Error('Injected replacement failure'); };
      try { assert.throws(() => store.set('A', { mode: 'build' }), /Injected replacement failure/); }
      finally { fs.renameSync = original; }
      assert.deepEqual(fs.readFileSync(file), bytes); assert.equal(store.get('A').mode, 'goal');
      assert.deepEqual(fs.readdirSync(root), ['conversation-command-state.json']);
    });
    check('invalid patch cannot corrupt a valid target', () => { assert.throws(() => store.set('A', { queuePaused: 'false' })); assert.equal(store.get('A').queuePaused, false); });
    check('deleting a target persists without changing another target', () => { store.delete('A'); const reopened = new Store(root); assert.equal(reopened.get('A'), undefined); assert.equal(reopened.get('B').mode, 'plan'); });
    check('malformed stored state is not silently replaced or truncated', () => { fs.writeFileSync(file, '{broken'); assert.throws(() => new Store(root)); assert.equal(fs.readFileSync(file, 'utf8'), '{broken'); });
    console.log(JSON.stringify({ passed: true, checks: count }));
  } finally {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('newmark-command-state-test-')) throw Error('Cleanup path guard failed');
    fs.rmSync(root, { recursive: true, force: true });
  }
}
module.exports = { run };
if (require.main === module) { try { run(); } catch (error) { console.error(error.stack || error); process.exitCode = 1; } }
