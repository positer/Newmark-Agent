'use strict';
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { getEventListeners } = require('node:events');
const arg = (k, d) => process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d;
const filename = path.resolve(__dirname, '../dist/llm/provider.js');
if (arg('--source', '')) {
  const Module = require('node:module'), ts = require('typescript');
  const item = new Module(filename, module); item.filename = filename; item.paths = Module._nodeModulePaths(path.dirname(filename));
  item._compile(ts.transpileModule(fs.readFileSync(path.resolve(arg('--source')), 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText, filename); require.cache[filename] = item;
}
const { LLMProvider } = require(filename), report = { samples: [], warnings: [], requests: 0 };
process.on('warning', w => report.warnings.push({ name: w.name, message: w.message }));
const sockets = new Set(), server = http.createServer(async (req, res) => {
  for await (const ignored of req) { /* consume only fixture request */ }
  report.requests++; res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ type: 'message', stop_reason: 'end_turn', content: [{ type: 'text', text: 'owner-release-ok' }], usage: { input_tokens: 10, output_tokens: 3 } }));
});
server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const provider = new LLMProvider('fixture', `http://127.0.0.1:${server.address().port}/v1`, '', 'anthropic', 'chat_stream', true, 0, undefined, { enabled: false });
  const controller = new AbortController();
  try {
    for (let i = 0; i < 40; i++) {
      let reply = '';
      for await (const token of provider.chatStreamWithTools('fixture', [{ role: 'user', content: 'test' }], null, 0, 32, [], controller.signal)) if (token.type === 'text') reply += token.text;
      await new Promise(r => setImmediate(r));
      report.samples.push({ turn: i + 1, abortListeners: getEventListeners(controller.signal, 'abort').length, replyCorrect: reply === 'owner-release-ok', heapUsed: process.memoryUsage().heapUsed });
    }
    report.beforeGcListeners = getEventListeners(controller.signal, 'abort').length;
    if (global.gc) { global.gc(); await new Promise(r => setTimeout(r, 100)); report.afterGcListeners = getEventListeners(controller.signal, 'abort').length; }
  } finally {
    controller.abort(); for (const s of sockets) s.destroy(); await new Promise(r => server.close(r));
    report.passed = report.requests === 40 && report.samples.every(s => s.abortListeners === 0 && s.replyCorrect);
    report.boundary = '40 actual HTTP requests sharing one long-lived Build cancellation signal. GC is a separate diagnostic, not the acceptance cleanup mechanism.';
    fs.writeFileSync(path.resolve(arg('--out', 'provider-owner-release.json')), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ passed: report.passed, requests: report.requests, beforeGc: report.beforeGcListeners, afterGc: report.afterGcListeners, maxListeners: Math.max(...report.samples.map(s => s.abortListeners)) }));
    if (!report.passed) process.exitCode = 1;
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
