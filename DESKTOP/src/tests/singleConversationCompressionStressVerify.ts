/**
 * dev-0.6.6 gate: one conversation, very many rounds, repeated context compression.
 *
 * The reported failure mode this must rule out: a single long-running
 * conversation that compresses its context again and again eventually loses
 * visible history, wedges the runtime (timestamps advance, no work happens,
 * new input never enters the queue), or grows memory without bound.
 *
 * The gate drives the **real** production path — `agent.process()` routes
 * through `runAgentKernel()` -> `transformContext()` -> `agent.maybeCompress()`
 * with `context.auto_compress` enabled — so every round can trigger the real
 * budget/threshold compaction, not a test-only shortcut. It asserts that, after
 * many automatic compactions:
 *   - every round completed, produced visible text, and produced no error;
 *   - the visible transcript (`chatMessages`) keeps every user/assistant turn —
 *     compaction only folds the internal context history, never the transcript;
 *   - the internal history and the provider request stay bounded by a constant
 *     that does not grow with the turn count;
 *   - folded content stays addressable (`status.cache`/`status.archive`) and
 *     `restore` brings it back, after which the conversation continues;
 *   - the conversation survives a reload from disk and keeps compressing;
 *   - heap stays bounded (no linear growth per compaction).
 *
 * Env overrides: NEWMARK_COMPRESSION_TURNS (default 30),
 * NEWMARK_COMPRESSION_MAX_TOKENS (96000), NEWMARK_COMPRESSION_TURN_CHARS (12000).
 * Run with `node --expose-gc dist/tests/singleConversationCompressionStressVerify.js`
 * to enable the settled-heap growth check.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'module';
import { Agent } from '../core/agent';
import type { StreamToken } from '../core/types';

const TURNS = Math.min(400, Math.max(6, Number(process.env.NEWMARK_COMPRESSION_TURNS) || 30));
const MAX_TOKENS = Math.max(8000, Number(process.env.NEWMARK_COMPRESSION_MAX_TOKENS) || 96000);
const TURN_TEXT_CHARS = Math.max(2000, Number(process.env.NEWMARK_COMPRESSION_TURN_CHARS) || 12_000);
const CONVERSATION_ID = 'compression-stress';
const SCRIPT_TURN_MARKER = 'COMPRESSION_STRESS_TURN';

// Bounds that must hold for a conversation of any length: the retained context
// is a fixed-size window, not a function of how many turns were executed.
const HISTORY_ENTRY_CEILING = Math.max(12, Number(process.env.NEWMARK_COMPRESSION_HISTORY_CEILING) || 24);
const REQUEST_KIB_CEILING = Math.max(128, Number(process.env.NEWMARK_COMPRESSION_REQUEST_KIB_CEILING) || 512);
const TURN_MS_CEILING = Math.max(5000, Number(process.env.NEWMARK_COMPRESSION_TURN_MS_CEILING) || 60_000);
const HEAP_CEILING_MIB = Number(process.env.NEWMARK_COMPRESSION_HEAP_CEILING_MIB) || 1024;
const SETTLED_GROWTH_CEILING_MIB = Number(process.env.NEWMARK_COMPRESSION_SETTLED_GROWTH_MIB) || 128;

interface CompressionStatus {
  historyLength: number;
  chatMessages: number;
  estimatedTokens: number;
  maxTokens: number;
  usagePercent: number;
  thresholdReached: boolean;
  cacheEntries: number;
  cacheIds: string[];
  cacheFoldedEntries: number;
  cacheFoldedChars: number;
  archiveEnabled: boolean;
  archiveEntries: number;
  archiveFoldedEntries: number;
  archiveFoldedChars: number;
  archiveRecentIds: string[];
  protectedStartIndex: number;
  lastCompressionAt: string;
  lastCompressionModel: string;
  lastCompressionFallback: boolean;
  /** Hot cache + cold archive: every fold this conversation ever performed. */
  compressions: number;
  foldedEntries: number;
  foldedChars: number;
}

interface TurnRecord {
  turn: number;
  ms: number;
  textChars: number;
  userTurns: number;
  transcriptEntries: number;
}

interface Sample {
  turn: number;
  historyEntries: number;
  transcriptKiB: number;
  transcriptEntries: number;
  compressions: number;
  compressionEvents: number;
  hot: number;
  cold: number;
  foldedEntries: number;
  foldedChars: number;
  requestKiB: number;
  heapMiB: number;
  settledHeapMiB: number;
  rssMiB: number;
}

function fixtureModel(name: string) {
  return {
    name,
    display: name,
    description: 'Compression stress fixture.',
    max_tokens: MAX_TOKENS,
    vision: false,
    thinking: false,
    speed_rating: 'fast',
    capability_rating: 'high',
    evaluation: { status: 'degraded' },
    validation: {
      level: 'standard',
      status: 'degraded',
      checked_at: new Date().toISOString(),
      capabilities: { text_input: true, text_output: true, tool_use: true },
    },
    capabilities: ['text_input', 'text_output', 'tool_use'],
  };
}

function writeConfig(root: string): void {
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    models: {
      providers: {
        value: [{
          id: 'compression-stress',
          name: 'Compression Stress',
          base_url: 'https://compression-stress.invalid/v1',
          api_key: 'fixture',
          protocol: 'openai',
          enabled: true,
          models: [fixtureModel('compression-stress-model')],
        }],
      },
      default_model: { value: '' },
      auto_switch: { value: false },
      fallback_on_unavailable: { value: false },
    },
    context: {
      auto_compress: { value: true },
      keep_recent_messages: { value: 4 },
    },
    general: { language: { value: 'en' } },
    workspace: { auto_create_timestamp_workspace: { value: false } },
  }, null, 2), 'utf-8');
}

function attachWorkspace(agent: Agent, workspace: string): void {
  agent.workspace.current = {
    id: CONVERSATION_ID, name: CONVERSATION_ID, path: workspace, isInternal: false,
    hostBinding: '', conversationStatePrefix: CONVERSATION_ID, icon: '', kind: 'local',
  };
  agent.config.clearWorkspaceOverrides();
}

/**
 * `context_history_manage` reports compaction state under `cache` (hot folded
 * segments) and `archive` (cold segments evicted from the hot cache) — reading
 * the top level silently reports zero compressions for a long conversation,
 * which is exactly how a wedged compaction can look healthy in a report.
 */
function compressionStatus(agent: Agent): CompressionStatus {
  const result = (agent as unknown as { handleContextHistoryManage(args: string): { ok: boolean; output: string } })
    .handleContextHistoryManage(JSON.stringify({ action: 'status' }));
  assert.ok(result && result.ok, `context_history_manage status failed: ${result && result.output}`);
  const parsed = JSON.parse(result.output) as Record<string, unknown>;
  const cache = (parsed.cache || {}) as Record<string, unknown>;
  const archive = (parsed.archive || {}) as Record<string, unknown>;
  const protectedZone = (parsed.protectedZone || {}) as Record<string, unknown>;
  const lastCompression = (parsed.lastCompression || null) as Record<string, unknown> | null;
  const stringList = (value: unknown) => (Array.isArray(value) ? value.map(String) : []);
  const cacheIds = stringList(cache.ids);
  const archiveRecentIds = stringList(archive.recentIds);
  const cacheEntries = Number(cache.entries || 0);
  const archiveEntries = Number(archive.entries || 0);
  const cacheFoldedEntries = Number(cache.totalFoldedEntries || 0);
  const archiveFoldedEntries = Number(archive.totalFoldedEntries || 0);
  const cacheFoldedChars = Number(cache.totalFoldedChars || 0);
  const archiveFoldedChars = Number(archive.totalFoldedChars || 0);
  return {
    historyLength: Number(parsed.historyLength || 0),
    chatMessages: Number(parsed.chatMessages || 0),
    estimatedTokens: Number(parsed.estimatedTokens || 0),
    maxTokens: Number(parsed.maxTokens || 0),
    usagePercent: Number(parsed.usagePercent || 0),
    thresholdReached: Boolean(parsed.thresholdReached),
    cacheEntries,
    cacheIds,
    cacheFoldedEntries,
    cacheFoldedChars,
    archiveEnabled: Boolean(archive.enabled),
    archiveEntries,
    archiveFoldedEntries,
    archiveFoldedChars,
    archiveRecentIds,
    protectedStartIndex: parsed.protectedZone ? Number(protectedZone.protectedStartIndex ?? -1) : -1,
    lastCompressionAt: String(lastCompression?.at || ''),
    lastCompressionModel: String(lastCompression?.model || ''),
    lastCompressionFallback: Boolean(lastCompression?.fallback),
    compressions: cacheEntries + archiveEntries,
    foldedEntries: cacheFoldedEntries + archiveFoldedEntries,
    foldedChars: cacheFoldedChars + archiveFoldedChars,
  };
}

function textChunk(text: string): StreamToken {
  return { type: 'text', text };
}

function turnPayload(index: number): string {
  return `detail ${index} ` + 'long running conversation context line. '.repeat(Math.ceil(TURN_TEXT_CHARS / 37));
}

function settledHeapMiB(): number {
  if (typeof globalThis.gc === 'function') globalThis.gc();
  return Number((process.memoryUsage().heapUsed / 1024 ** 2).toFixed(1));
}

/**
 * Conversation state is persisted by rewriting the whole store document. That
 * makes per-turn write volume grow with the conversation length, which is a
 * long-run cost vector the context window cannot hide: measure it rather than
 * assume it.
 */
function instrumentConversationStateWrites(): () => { calls: number; bytes: number; shardCalls: number; shardBytes: number } {
  // The TypeScript `import * as fs` namespace exposes getter-only bindings, so
  // patch the real CommonJS module object instead.
  const nodeFs = createRequire(__filename)('fs') as { writeFileSync: (...args: unknown[]) => unknown };
  const original = nodeFs.writeFileSync;
  let calls = 0;
  let bytes = 0;
  let shardCalls = 0;
  let shardBytes = 0;
  nodeFs.writeFileSync = (...args: unknown[]) => {
    const data = args[1];
    // Shards are written through a file handle, so classify by content shape.
    if (typeof data === 'string' && data.startsWith('{"version":1,"key":')) {
      shardCalls += 1;
      shardBytes += Buffer.byteLength(data, 'utf8');
    }
    if (typeof data === 'string' && data.includes('"conversations"')) {
      calls += 1;
      bytes += Buffer.byteLength(data, 'utf8');
    }
    return original.apply(nodeFs, args);
  };
  const stop = () => {
    nodeFs.writeFileSync = original;
    return { calls, bytes, shardCalls, shardBytes };
  };
  return stop;
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-compression-stress-'));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  writeConfig(root);

  const agent = new Agent(root, { agentOnly: true, workspaceRegistryMode: 'detached', conversationId: CONVERSATION_ID });
  attachWorkspace(agent, workspace);

  const roundMarkers: string[] = [];
  const samples: Sample[] = [];
  const turns: TurnRecord[] = [];
  const emptyTurns: number[] = [];
  const slowTurns: number[] = [];
  const compressionStamps = new Set<string>();
  let providerCalls = 0;
  let scriptedTurns = 0;
  let summarizerCalls = 0;
  let lastRequestBytes = 0;
  let maxRequestBytes = 0;
  let maxHistoryEntries = 0;
  let exploratoryFolds = 0;
  let exploratoryFoldSkips = 0;
  let turnIndex = 0;

  const recordSample = (requestBytes: number): void => {
    const status = compressionStatus(agent);
    const heap = process.memoryUsage();
    const settled = typeof globalThis.gc === 'function' ? settledHeapMiB() : Number((heap.heapUsed / 1024 ** 2).toFixed(1));
    if (status.lastCompressionAt) compressionStamps.add(status.lastCompressionAt);
    maxHistoryEntries = Math.max(maxHistoryEntries, agent.history.length);
    maxRequestBytes = Math.max(maxRequestBytes, requestBytes);
    lastRequestBytes = requestBytes;
    samples.push({
      turn: turnIndex,
      historyEntries: agent.history.length,
      transcriptKiB: Math.round(Buffer.byteLength(JSON.stringify(agent.chatMessages), 'utf8') / 1024),
      transcriptEntries: agent.chatMessages.length,
      compressions: status.compressions,
      compressionEvents: compressionStamps.size,
      hot: status.cacheEntries,
      cold: status.archiveEntries,
      foldedEntries: status.foldedEntries,
      foldedChars: status.foldedChars,
      requestKiB: Math.round(requestBytes / 1024),
      heapMiB: Number((heap.heapUsed / 1024 ** 2).toFixed(1)),
      settledHeapMiB: settled,
      rssMiB: Number((heap.rss / 1024 ** 2).toFixed(1)),
    });
  };

  const provider = {
    intelligenceConfig: () => ({ temperature: 0, maxTokens: 256, reasoningEffort: 'medium' }),
    async *chatStreamWithTools(_model: string, messages: Array<Record<string, unknown>>): AsyncGenerator<StreamToken> {
      providerCalls += 1;
      const requestBytes = Buffer.byteLength(JSON.stringify(messages || []), 'utf8');
      // A post-compression turn ends with the continuation-anchor system
      // message, so the current user instruction is not necessarily last.
      // Classify by content: the summarizer prompt is unique and carries the
      // folded prefix (which itself contains older turn markers).
      const flatText = messages
        .map(message => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '')))
        .join('\n');
      const isSummarizer = flatText.includes('Compress the following conversation segment into a structured checkpoint');
      const carriesTurnMarker = messages.some(message => typeof message.content === 'string'
        && message.content.includes(SCRIPT_TURN_MARKER));
      const isScriptedTurn = !isSummarizer && carriesTurnMarker;
      if (!isScriptedTurn) {
        // Provider-side summarizer calls (automatic compaction, model-switch
        // compaction, titles) always receive plain text: feeding tool calls here
        // would spin the summarizer's retry loop instead of completing a turn.
        summarizerCalls += 1;
        yield textChunk('## Active Or Unfinished Work\ncompression summary placeholder for the folded segment.');
        return;
      }
      scriptedTurns += 1;
      const marker = `TURN_${turnIndex}_${Math.random().toString(16).slice(2, 8)}`;
      roundMarkers.push(marker);
      // A realistically large assistant answer: this is what grows the context.
      yield textChunk(`${turnPayload(turnIndex)} turn ${turnIndex} ${marker} done`);
      recordSample(requestBytes);
    },
    async chat(): Promise<string> { return '## Active Or Unfinished Work\ncompression summary placeholder from chat().'; },
  };
  (agent as unknown as { forcedProvider: unknown }).forcedProvider = provider;

  let failure: unknown = null;
  const stopStateWriteCounter = instrumentConversationStateWrites();
  try {
    for (turnIndex = 1; turnIndex <= TURNS; turnIndex += 1) {
      const startedAt = Date.now();
      const tokens = await agent.process(`${SCRIPT_TURN_MARKER} ${turnIndex} ${turnPayload(turnIndex)}`);
      const elapsed = Date.now() - startedAt;
      const text = (tokens || []).map(token => token.text || '').join('');
      turns.push({
        turn: turnIndex,
        ms: elapsed,
        textChars: text.length,
        userTurns: agent.chatMessages.filter(message => String(message.role || '') === 'user').length,
        transcriptEntries: agent.chatMessages.length,
      });
      if (!text.trim()) emptyTurns.push(turnIndex);
      if (elapsed > TURN_MS_CEILING) slowTurns.push(turnIndex);
      if (!samples.some(sample => sample.turn === turnIndex)) recordSample(0);
      // The model can also fold history explicitly through the production tool
      // path; do it deterministically every few turns, but never inside the
      // protected tail zone (that is what `dangerous:true` would be for).
      if (turnIndex % 3 === 0) {
        const status = compressionStatus(agent);
        const foldTo = Math.min(12, status.protectedStartIndex - 1);
        if (foldTo >= 2) {
          const folded = (agent as unknown as { handleContextHistoryManage(args: string): { ok: boolean; output: string } })
            .handleContextHistoryManage(JSON.stringify({ action: 'summarize', position: 1, to: foldTo, dangerous: false }));
          if (folded.ok) exploratoryFolds += 1; else exploratoryFoldSkips += 1;
        } else {
          exploratoryFoldSkips += 1;
        }
      }
    }
  } catch (error) {
    failure = error;
  }
  const stateWrites = stopStateWriteCounter();

  const status = compressionStatus(agent);
  const autoCompressions = compressionStamps.size;
  const peakHeap = Math.max(...samples.map(sample => sample.heapMiB), process.memoryUsage().heapUsed / 1024 ** 2);
  const userTurns = agent.chatMessages.filter(message => String(message.role || '') === 'user').length;
  const transcriptText = agent.chatMessages.map(message => String(message.content || '')).join('\n');
  const missingMarkers = roundMarkers.filter(marker => !transcriptText.includes(marker));
  const errorMessages = agent.chatMessages.filter(message => /\[error\]|Agent run failed/i.test(String(message.content || '')));
  const totalTranscriptKiB = Math.round(Buffer.byteLength(transcriptText, 'utf8') / 1024);
  const settledSamples = samples.filter(sample => sample.compressionEvents > 0).map(sample => sample.settledHeapMiB);
  const settledDrift = settledSamples.length >= 4
    ? Math.max(...settledSamples.slice(-Math.ceil(settledSamples.length / 3)))
      - Math.min(...settledSamples.slice(0, Math.ceil(settledSamples.length / 3)))
    : 0;
  // The visible transcript legitimately grows with every turn; the internal
  // context does not. Retained memory must therefore be explainable by the
  // transcript itself, not by the number of compactions.
  const compressedSamples = samples.filter(sample => sample.compressionEvents > 0);
  const transcriptGrowthKiB = compressedSamples.length >= 2
    ? compressedSamples[compressedSamples.length - 1].transcriptKiB - compressedSamples[0].transcriptKiB
    : 0;
  const settledGrowthBoundMiB = (transcriptGrowthKiB / 1024) * 3 + Number(process.env.NEWMARK_COMPRESSION_SETTLED_SLACK_MIB || 32);

  console.log(`turns=${turnIndex - 1} transcriptEntries=${agent.chatMessages.length} historyEntries=${agent.history.length}`);
  console.log(`autoCompressions=${autoCompressions} folds=${status.compressions} (hot=${status.cacheEntries} cold=${status.archiveEntries} archiveEnabled=${status.archiveEnabled})`);
  console.log(`foldedEntries=${status.foldedEntries} foldedChars=${status.foldedChars} exploratoryFolds=${exploratoryFolds} skipped=${exploratoryFoldSkips}`);
  console.log(`userTurns=${userTurns} providerCalls=${providerCalls} scriptedTurns=${scriptedTurns} summarizerCalls=${summarizerCalls}`);
  console.log(`maxHistoryEntries=${maxHistoryEntries} maxRequestKiB=${Math.round(maxRequestBytes / 1024)} lastRequestKiB=${Math.round(lastRequestBytes / 1024)}`);
  console.log(`transcriptKiB=${totalTranscriptKiB} peakHeapMiB=${peakHeap.toFixed(1)} settledDriftMiB=${settledDrift.toFixed(1)}`);
  console.log(`transcriptGrowthKiB=${transcriptGrowthKiB} settledGrowthBoundMiB=${settledGrowthBoundMiB.toFixed(1)}`);
  console.log(`compressionModel=${status.lastCompressionModel} fallback=${status.lastCompressionFallback} lastCompressionAt=${status.lastCompressionAt}`);
  console.log(`maxTurnMs=${Math.max(...turns.map(turn => turn.ms), 0)} meanTurnMs=${Math.round(turns.reduce((sum, turn) => sum + turn.ms, 0) / Math.max(1, turns.length))}`);
  console.log(`agentStatus=${agent.status} workRuns=${agent.workRuns.length} historyEntries=${agent.history.length}`);
  console.log(`indexWrites=${stateWrites.calls} indexMiB=${(stateWrites.bytes / 1024 ** 2).toFixed(2)} indexCallsPerTurn=${(stateWrites.calls / Math.max(1, TURNS)).toFixed(2)}`
    + ` | shardWrites=${stateWrites.shardCalls} shardMiB=${(stateWrites.shardBytes / 1024 ** 2).toFixed(2)} shardCallsPerTurn=${(stateWrites.shardCalls / Math.max(1, TURNS)).toFixed(2)}`);
  console.log('turn\thistory\thot\tcold\tfolds\tfoldedEntries\tsettledMiB\treqKiB');
  const stride = Math.max(1, Math.floor(samples.length / 12));
  const printed = samples.filter((sample, index) => index % stride === 0 || index === samples.length - 1);
  for (const sample of printed) {
    console.log(`${sample.turn}\t${sample.historyEntries}\t${sample.hot}\t${sample.cold}\t${sample.compressions}\t${sample.foldedEntries}\t${sample.settledHeapMiB}\t${sample.requestKiB}`);
  }

  assert.equal(failure, null, `the run must complete without throwing: ${failure instanceof Error ? failure.message : String(failure)}`);
  assert.equal(turnIndex, TURNS + 1, `all ${TURNS} turns must execute (executed ${turnIndex - 1})`);
  assert.equal(emptyTurns.length, 0, `every turn must produce visible text (empty turns: ${emptyTurns.join(',')})`);
  assert.equal(slowTurns.length, 0, `no turn may wedge past ${TURN_MS_CEILING}ms (slow turns: ${slowTurns.join(',')})`);
  assert.equal(scriptedTurns, TURNS, `every scripted turn must reach the provider (reached ${scriptedTurns})`);
  assert.equal(errorMessages.length, 0, `no error message may be persisted (found ${errorMessages.length})`);

  // Automatic compaction must actually happen, repeatedly, through the real
  // budget/threshold path — not only through the explicit tool call.
  assert.ok(autoCompressions >= Math.max(3, Math.floor(TURNS / 10)),
    `the conversation must compress repeatedly (automatic compressions=${autoCompressions})`);
  assert.ok(status.compressions >= autoCompressions,
    `status must account for every fold (status=${status.compressions}, automatic=${autoCompressions})`);
  assert.ok(status.foldedEntries > 0 && status.foldedChars > 0,
    `compactions must record what they folded (entries=${status.foldedEntries}, chars=${status.foldedChars})`);

  // Transcript integrity: compaction folds the internal context history only.
  assert.equal(userTurns, TURNS, `every user turn stays visible (expected ${TURNS}, found ${userTurns})`);
  assert.equal(missingMarkers.length, 0,
    `no assistant turn may be dropped from the visible transcript (missing ${missingMarkers.length} of ${roundMarkers.length})`);
  for (const turn of turns) {
    assert.equal(turn.transcriptEntries, turn.turn * 2,
      `turn ${turn.turn} must append exactly one user and one assistant message (transcript=${turn.transcriptEntries})`);
  }

  // Bounded context: the retained window is a constant, not a function of the
  // number of turns, and the provider request never grows with the transcript.
  assert.ok(maxHistoryEntries <= HISTORY_ENTRY_CEILING,
    `internal history must stay bounded by compaction (max entries=${maxHistoryEntries}, ceiling=${HISTORY_ENTRY_CEILING})`);
  assert.ok(maxRequestBytes <= REQUEST_KIB_CEILING * 1024,
    `the provider request must stay bounded (max=${Math.round(maxRequestBytes / 1024)}KiB, ceiling=${REQUEST_KIB_CEILING}KiB)`);
  assert.ok(maxRequestBytes < Buffer.byteLength(transcriptText, 'utf8'),
    `compaction must keep requests below the raw transcript (request=${Math.round(maxRequestBytes / 1024)}KiB, transcript=${totalTranscriptKiB}KiB)`);
  assert.ok(peakHeap < HEAP_CEILING_MIB, `heap must stay bounded across the run (peak=${peakHeap.toFixed(1)} MiB)`);
  if (typeof globalThis.gc === 'function') {
    assert.ok(settledDrift < SETTLED_GROWTH_CEILING_MIB,
      `settled heap must not grow with the number of compactions (drift=${settledDrift.toFixed(1)} MiB)`);
    assert.ok(settledDrift <= settledGrowthBoundMiB,
      `settled heap growth must stay explainable by the visible transcript, not by compaction count (+${settledDrift.toFixed(1)} MiB against a ${settledGrowthBoundMiB.toFixed(1)} MiB bound)`);
  }
  assert.equal(agent.status, 'idle', `the conversation must settle back to idle instead of staying wedged (status=${agent.status})`);

  // Folded content must stay addressable and restorable.
  const restoreId = status.cacheIds[status.cacheIds.length - 1] || status.archiveRecentIds[status.archiveRecentIds.length - 1];
  assert.ok(!!restoreId, 'status must expose at least one restore id');
  const beforeRestore = agent.history.length;
  const restoreResult = (agent as unknown as { handleContextHistoryManage(args: string): { ok: boolean; output: string } })
    .handleContextHistoryManage(JSON.stringify({ action: 'restore', restore_id: restoreId }));
  assert.ok(restoreResult.ok, `restore must succeed: ${restoreResult.output.slice(0, 200)}`);
  assert.ok(agent.history.length > beforeRestore,
    `restore must return folded entries to the context (before=${beforeRestore}, after=${agent.history.length})`);

  // The conversation must keep working — and keep compressing — after a restore.
  const foldsBeforeRestoreContinuation = status.compressions;
  turnIndex = TURNS + 1;
  let continuedText = '';
  try {
    const continued = await agent.process(`${SCRIPT_TURN_MARKER} ${turnIndex} ${turnPayload(turnIndex)} resume after restore`);
    continuedText = (continued || []).map(token => token.text || '').join('');
  } catch (error) {
    failure = error;
  }
  assert.equal(failure, null, `the conversation must continue after a restore: ${failure instanceof Error ? failure.message : String(failure)}`);
  assert.ok(continuedText.trim().length > 0, 'the conversation must continue after a restore');
  const afterRestoreStatus = compressionStatus(agent);
  assert.ok(afterRestoreStatus.compressions >= 1, 'compression state must remain inspectable after restore');
  for (let extra = 0; extra < 6; extra += 1) {
    turnIndex += 1;
    await agent.process(`${SCRIPT_TURN_MARKER} ${turnIndex} ${turnPayload(turnIndex)} keep compressing after restore`);
  }
  const postRestoreStatus = compressionStatus(agent);
  assert.equal(agent.status, 'idle', `the restored conversation must settle back to idle (status=${agent.status})`);
  assert.ok(postRestoreStatus.compressions >= Math.min(foldsBeforeRestoreContinuation, afterRestoreStatus.compressions),
    'post-restore compaction must keep working in the same direction');
  assert.ok(postRestoreStatus.foldedEntries > 0,
    'post-restore compaction must keep recording folded content');

  const persistedPath = path.join(workspace, 'conversations', 'state.json');
  assert.ok(fs.existsSync(persistedPath), `the conversation must be persisted to disk (${persistedPath})`);
  const persisted = JSON.parse(fs.readFileSync(persistedPath, 'utf-8')) as {
    conversations?: Record<string, {
      history?: unknown[]; chatMessages?: unknown[]; compressionCache?: unknown[];
      shard?: string; shardBytes?: number; messageCount?: number; historyCount?: number; workRunCount?: number;
    }>;
  };
  const persistedEntry = persisted.conversations
    ? Object.values(persisted.conversations).find(entry => Number(entry?.messageCount || 0) > 0
      || (Array.isArray(entry?.chatMessages) && entry.chatMessages.length > 0))
    : undefined;
  assert.ok(persistedEntry, 'the persisted state must contain this conversation');
  const persistedHistory = Number(persistedEntry?.historyCount ?? persistedEntry?.history?.length ?? 0);
  const persistedMessages = Number(persistedEntry?.messageCount ?? persistedEntry?.chatMessages?.length ?? 0);
  assert.ok(persistedHistory <= HISTORY_ENTRY_CEILING,
    `the persisted history must be bounded (entries=${persistedHistory})`);
  assert.ok(persistedMessages >= TURNS,
    `the persisted transcript must keep the turns (entries=${persistedMessages})`);
  // The heavy payload must live in a per-conversation shard so the workspace
  // index stays small enough to rewrite cheaply on every turn.
  assert.ok(typeof persistedEntry?.shard === 'string' && !!persistedEntry.shard,
    'the persisted conversation must be sharded out of the workspace index');
  const shardPath = path.join(workspace, 'conversations', 'shards', String(persistedEntry?.shard));
  assert.ok(fs.existsSync(shardPath), `the conversation shard must exist (${shardPath})`);
  const shardPayload = JSON.parse(fs.readFileSync(shardPath, 'utf-8')) as { chatMessages?: unknown[]; history?: unknown[] };
  assert.ok((shardPayload.chatMessages?.length || 0) >= TURNS,
    `the shard must carry the transcript (entries=${shardPayload.chatMessages?.length})`);
  assert.ok((shardPayload.history?.length || 0) <= HISTORY_ENTRY_CEILING,
    `the shard must carry the bounded context history (entries=${shardPayload.history?.length})`);
  const indexKiB = fs.statSync(persistedPath).size / 1024;
  const shardKiB = fs.statSync(shardPath).size / 1024;
  console.log(`persisted layout: indexKiB=${indexKiB.toFixed(1)} shardKiB=${shardKiB.toFixed(1)} messages=${persistedMessages}`);
  assert.ok(indexKiB < shardKiB / 4,
    `the workspace index must stay far smaller than the transcript shard (index=${indexKiB.toFixed(1)}KiB, shard=${shardKiB.toFixed(1)}KiB)`);
  // Growth vectors outside the context window are measured, not asserted: the
  // visible transcript and the per-turn Build records are meant to persist, so
  // their size is reported for the long-run memory/state budget.
  const stateKiB = Math.round(fs.statSync(persistedPath).size / 1024);
  const workRunBytes = Buffer.byteLength(JSON.stringify(agent.workRuns), 'utf8');
  const workRunKiB = Math.round(workRunBytes / 1024);
  console.log(`persisted: stateKiB=${stateKiB} transcriptKiB=${totalTranscriptKiB} workRuns=${agent.workRuns.length} workRunsKiB=${workRunKiB}`);
  console.log(`persisted per-turn: stateKiB/turn=${(stateKiB / Math.max(1, turnIndex)).toFixed(1)} workRunsKiB/turn=${(workRunKiB / Math.max(1, agent.workRuns.length)).toFixed(1)}`);

  // Reload the conversation from disk in a fresh Agent and keep going: repeated
  // compaction must not leave the persisted conversation unusable.
  const reloaded = new Agent(root, { agentOnly: true, workspaceRegistryMode: 'detached', conversationId: CONVERSATION_ID });
  attachWorkspace(reloaded, workspace);
  reloaded.setConversationFromStorage(CONVERSATION_ID);
  (reloaded as unknown as { forcedProvider: unknown }).forcedProvider = provider;
  const reloadedStatus = compressionStatus(reloaded);
  const reloadedUserTurns = reloaded.chatMessages.filter(message => String(message.role || '') === 'user').length;
  assert.ok(reloadedUserTurns >= TURNS,
    `the reloaded conversation must keep every user turn (expected ${TURNS}, found ${reloadedUserTurns})`);
  assert.ok(reloadedStatus.historyLength <= HISTORY_ENTRY_CEILING,
    `the reloaded history must stay bounded (entries=${reloadedStatus.historyLength})`);
  assert.ok(reloadedStatus.compressions >= 1,
    `the reloaded conversation must keep its folded segments addressable (folds=${reloadedStatus.compressions})`);
  turnIndex += 1;
  const afterReload = await reloaded.process(`${SCRIPT_TURN_MARKER} ${turnIndex} ${turnPayload(turnIndex)} continue after reload`);
  const afterReloadText = (afterReload || []).map(token => token.text || '').join('');
  assert.ok(afterReloadText.trim().length > 0, 'the reloaded conversation must be able to run another turn');
  assert.equal(reloaded.status, 'idle', `the reloaded conversation must settle back to idle (status=${reloaded.status})`);
  console.log(`reload: userTurns=${reloadedUserTurns} history=${reloadedStatus.historyLength} folds=${reloadedStatus.compressions} autoCompressions=${compressionStamps.size}`);

  const settled = process.memoryUsage();
  console.log(`post-run transcriptKiB=${totalTranscriptKiB} historyEntries=${reloaded.history.length} settledHeapMiB=${(settled.heapUsed / 1024 ** 2).toFixed(1)}`);

  fs.rmSync(root, { recursive: true, force: true });
  console.log('singleConversationCompressionStressVerify: all checks passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
