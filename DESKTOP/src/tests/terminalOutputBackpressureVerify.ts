import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { TerminalOutputBuffer } from '../core/terminalOutputBuffer';

const sent: Array<{ sessionId: string; text: string }> = [];
const buffer = new TerminalOutputBuffer((sessionId, text) => sent.push({ sessionId, text }), {
  flushIntervalMs: 60_000,
  historyLimit: 1024,
});

const expected = Array.from({ length: 10_000 }, (_, index) => `${index % 10}`).join('');
for (const char of expected) buffer.push('stress', char);
assert.equal(sent.length, 0, 'small PTY chunks must remain inside the batching window');
assert.equal(buffer.pendingChunkCount(), 10_000, 'all chunks remain ordered before flush');
buffer.flush('stress');
assert.equal(sent.length, 1, '10,000 small chunks must collapse into one IPC-sized flush');
assert.equal(sent[0].text, expected, 'batching must preserve exact output order and content');
assert.equal(buffer.history('stress'), expected.slice(-1024), 'retained terminal history must stay bounded');
assert.equal(buffer.hasScheduledFlush(), false, 'manual flush must not leave a timer behind');
buffer.push('stress', 'tail');
assert.equal(buffer.close('stress'), `${expected.slice(-1024)}tail`.slice(-1024));
assert.equal(buffer.hasScheduledFlush(), false, 'closing a session must clean up its timer');

const uiPath = path.resolve(__dirname, '../../src/ui/index.html');
const ui = fs.readFileSync(uiPath, 'utf8');
const terminalSection = ui.slice(ui.indexOf('var _terminalTakeoverRefreshToken'), ui.indexOf('// === Scroll to Bottom ==='));
assert.match(terminalSection, /requestAnimationFrame/, 'terminal rendering must be frame-batched');
assert.match(terminalSection, /appendTerminalOutput/, 'normal and takeover terminal paths must share the bounded appender');
assert.doesNotMatch(terminalSection, /output\.innerHTML\s*\+=/, 'terminal hot paths must not rebuild the full DOM with innerHTML +=');

console.log(JSON.stringify({ ok: true, chunks: 10_000, flushes: sent.length, retainedChars: buffer.history('stress').length }));
