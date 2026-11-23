/**
 * NewMate — the CORE MEMORY gate.
 *
 * The user's requirement was four things at once, and each one is asserted here against the code
 * that runs rather than against a restatement of it:
 *
 *   1. a core memory that holds the stable part of the person: 用户画像 / 对话风格 / 长期偏好 / 当前重点;
 *   2. a CODE-enforced ceiling of 5000 characters on what it puts into NewMate's context - a write
 *      that would cross it is refused with the numbers, and the renderer truncates even a hand-edited
 *      file, so the bound never depends on the model's cooperation;
 *   3. the nature and the expected move: 稳定、核心, and REPLACE a section as the person changes rather
 *      than append a new fact (there is no append operation at all);
 *   4. it is injected into NewMate and nowhere else - the store sits outside `Memory Lab/`, the
 *      payload readers carry its SHAPE and not its text, and the one tool that returns the text
 *      refuses outside a NewMate run.
 *
 * Run: node Newmark2DSH/scripts/verify-newmate-core-memory.mjs [--mutations]
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNewMate, NEWMATE_RUN_TOOLS } from '../packages/newmark-core/components/newmate/component.js';
import {
  createCoreMemory, coreMemoryDefinition, CORE_MEMORY_BUDGET_CHARS, CORE_SECTION_MAX_CHARS,
  CORE_MEMORY_SECTIONS, CORE_MEMORY_TOOL_NAME, CORE_MEMORY_RULE,
} from '../packages/newmark-core/components/newmate/lib/core-memory.js';
import { createMemoryContext } from '../packages/newmark-core/components/newmate/lib/memory-context.js';
import { createMemoryLab } from '../packages/newmark-core/components/memorylab/component.js';
import { newMateContext, withNewMateContext } from '../packages/newmark-core/lib/newmate-context.js';
import { hostTools } from './lib/host-call.mjs';

let passed = 0;
const failures = [];
const check = (label, value, detail) => {
  if (value) { passed += 1; console.log('ok ' + passed + ' - ' + label); return true; }
  failures.push(label);
  console.log('not ok ' + (passed + failures.length) + ' - ' + label);
  if (detail !== undefined) console.log('  ' + detail);
  return false;
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmate-core-memory-'));
const at = Date.parse('2026-11-23T10:00:00Z');
const now = () => at;
const MARKER = '用户偏好直接给结论';

/* ------------------------------------------------------------ the store --- */

const core = createCoreMemory(root, now);
check('the budget is the number the requirement named: 5000 characters', CORE_MEMORY_BUDGET_CHARS === 5000);
check('the core has four fixed sections, so there is no way to grow it by adding entries', CORE_MEMORY_SECTIONS.length === 4 && CORE_MEMORY_SECTIONS.map((section) => section.key).join(',') === 'profile,style,preference,focus');
check('the store lives outside Memory Lab, which is what keeps it out of every DSH conversation', !core.file.includes('Memory Lab') && core.file.includes(path.join('newMate', 'core-memory.json')), core.file);

const empty = core.render();
check('an empty core still renders its header and says it is empty, and costs less than the budget', empty.chars <= CORE_MEMORY_BUDGET_CHARS && empty.text.includes('核心记忆') && empty.text.includes('尚未写入'));

const firstWrite = core.save({ section: 'profile', content: MARKER + '，不要罗列权限清单。' });
check('the first write of a section succeeds and says it was the FIRST one (not a replacement)', firstWrite.ok === true && firstWrite.replaced === false && firstWrite.section.key === 'profile');
check('the write names the character cost and what is left', typeof firstWrite.chars === 'number' && firstWrite.chars <= CORE_MEMORY_BUDGET_CHARS && firstWrite.remaining + firstWrite.chars === CORE_MEMORY_BUDGET_CHARS);
check('the store is on disk as JSON under newMate/', fs.existsSync(core.file) && JSON.parse(fs.readFileSync(core.file, 'utf8')).sections.profile.content.includes(MARKER));

const secondWrite = core.save({ section: '用户画像', content: '用户是 Newmark 的维护者，偏好可验证的结论。' });
check('writing the same section again REPLACES it - the Chinese title resolves to the same section', secondWrite.ok === true && secondWrite.replaced === true && secondWrite.section.key === 'profile');
check('a replacement does not accumulate: the old text is gone from the render', !core.render().text.includes(MARKER) && core.render().text.includes('Newmark 的维护者'));

core.save({ section: 'style', content: '中文回答，先结论后理由。' });
check('both written sections render with their Chinese titles', core.render().text.includes('· 用户画像：') && core.render().text.includes('· 对话风格：'));

const cleared = core.save({ section: 'style', content: '' });
check('an empty write clears a section instead of storing an empty line', cleared.ok === true && !core.render().text.includes('· 对话风格：'));

const unknown = core.save({ section: '心情', content: '不应该存在' });
check('an unknown section is refused by name, with the sections that do exist', unknown.ok === false && unknown.code === 'core_memory_unknown_section' && unknown.sections.join(',') === 'profile,style,preference,focus');
const notString = core.save({ section: 'profile', content: 42 });
check('a non-string body is refused rather than stringified', notString.ok === false && notString.code === 'core_memory_content_required');
const tooLong = core.save({ section: 'profile', content: 'x'.repeat(CORE_SECTION_MAX_CHARS + 1) });
check('one section cannot eat the whole budget: a section over its own ceiling is refused with the numbers', tooLong.ok === false && tooLong.code === 'core_memory_section_too_long' && tooLong.limit === CORE_SECTION_MAX_CHARS && tooLong.got === CORE_SECTION_MAX_CHARS + 1);

/* --------------------------------------------------------- the 5k ceiling --- */

core.save({ section: 'profile', content: 'p'.repeat(CORE_SECTION_MAX_CHARS) });
core.save({ section: 'focus', content: 'f'.repeat(CORE_SECTION_MAX_CHARS) });
const beforeRefusal = core.render().rawChars;
const overBudget = core.save({ section: 'preference', content: 'p'.repeat(CORE_SECTION_MAX_CHARS) });
check('a write that would cross 5000 characters is REFUSED, not truncated', overBudget.ok === false && overBudget.code === 'core_memory_budget_exceeded');
check('the refusal carries the budget, the size it would become and what it is now', overBudget.budget === 5000 && overBudget.next > 5000 && overBudget.current <= 5000, JSON.stringify(overBudget).slice(0, 200));
check('the refusal names the largest section, which is what the model must shorten', Boolean(overBudget.largest?.title) && overBudget.largest.chars > 0);
check('a refused write leaves the store exactly as it was', core.render().rawChars === beforeRefusal, String(core.render().rawChars) + ' vs ' + String(beforeRefusal));

// Exactly at the ceiling: the last characters of headroom are usable, one more is not.
core.save({ section: 'style', content: '' });
const lineCost = '· 对话风格：'.length + 1; // the section line plus its newline
const room = CORE_MEMORY_BUDGET_CHARS - core.render().rawChars;
const exact = core.save({ section: 'style', content: 's'.repeat(Math.max(0, room - lineCost)) });
check('a write that lands exactly on 5000 is accepted', exact.ok === true && core.render().rawChars === CORE_MEMORY_BUDGET_CHARS, JSON.stringify({ ok: exact.ok, code: exact.code, raw: core.render().rawChars, room }));
const oneMore = core.save({ section: 'style', content: 's'.repeat(Math.max(1, room - lineCost + 1)) });
check('one character past the ceiling is refused', oneMore.ok === false && oneMore.code === 'core_memory_budget_exceeded');

// Defence in depth: the FILE is the untrusted input, the RENDERER is the last place the bound holds.
const raw = JSON.parse(fs.readFileSync(core.file, 'utf8'));
raw.sections.profile.content = 'y'.repeat(9000);
fs.writeFileSync(core.file, JSON.stringify(raw));
const handEdited = core.render();
check('a hand-edited file cannot enlarge the injected block: the render is capped at 5000', handEdited.chars <= CORE_MEMORY_BUDGET_CHARS && handEdited.chars === CORE_MEMORY_BUDGET_CHARS);
check('the truncation is reported instead of hidden', handEdited.truncated === true);
const snapshot = core.snapshot();
check('the read surface reports the injected size, the real usage and that it is over budget', snapshot.chars === CORE_MEMORY_BUDGET_CHARS && snapshot.used > CORE_MEMORY_BUDGET_CHARS && snapshot.overBudget === true);
check('the read surface states the rule it enforces: replace, do not append', snapshot.rule.includes('更替') && snapshot.rule.includes('5000') && CORE_MEMORY_RULE.includes('不是流水账'));

/* --------------------------------------------------- injected into NewMate --- */

const mateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'newmate-core-memory-mate-'));
const seeded = createCoreMemory(mateRoot, now);
seeded.save({ section: 'profile', content: MARKER });
let runContext = null;
const mate = createNewMate({
  root: mateRoot, now, agents: () => null,
  tools: hostTools(async () => { runContext = newMateContext(); return { isError: false, value: { ok: true, result: { output: '好' } } }; }),
});
mate.chat('你好');
await mate.tick();
const prompt = String(runContext?.prefix || '');
check('the run prompt carries the core memory text', prompt.includes('核心记忆') && prompt.includes(MARKER));
check('the prompt also states its nature and the replace-not-append rule', prompt.includes('稳定、核心') && prompt.includes('更替') && prompt.includes('5000'));
check('the injected core block is within the 5000-character budget', mate.memoryContext().coreMemory.chars <= CORE_MEMORY_BUDGET_CHARS);
check('the block header states that it is NewMate-only', prompt.includes('只在 NewMate 中注入'));

/* --------------------------------------------- the text stays in NewMate --- */

const publicContext = mate.memoryContext();
check('the payload readers carry the SHAPE (budget, chars, sections) of the core memory', publicContext.coreMemory?.budget === 5000 && Array.isArray(publicContext.coreMemory.sections) && publicContext.coreMemory.sections.some((section) => section.key === 'profile'));
check('and NOT its text - this payload answers any conversation that calls the tool', !JSON.stringify(publicContext.coreMemory).includes(MARKER));
check('the companion state does not carry the text either', !JSON.stringify(mate.state()).includes(MARKER));

const lab = createMemoryLab({ root: mateRoot, tools: { schemas: () => [], register: () => () => {}, get: () => undefined, execute: async () => ({}) } });
const query = lab.tools().find((definition) => definition.name === 'memory_lab_query');
const hits = await query.execute({ query: MARKER });
check('no MemoryLab tool can return it: the query matches no component', Array.isArray(hits.matches) && hits.matches.length === 0 && !(hits.matches || []).some((match) => JSON.stringify(match).includes(MARKER)), JSON.stringify(hits).slice(0, 160));
const labIndexPath = path.join(mateRoot, 'Memory Lab', 'index.json');
const labIndexText = fs.existsSync(labIndexPath) ? fs.readFileSync(labIndexPath, 'utf8') : '';
check('and the Memory Lab index does not know the core memory file at all', !labIndexText.includes(MARKER) && !labIndexText.includes('core-memory'), labIndexText.slice(0, 120));

/* ------------------------------------------------ the one tool, and its door --- */

check('the tool is part of NewMate\'s own run group', NEWMATE_RUN_TOOLS.includes(CORE_MEMORY_TOOL_NAME));
check('the tool description says replace and says there is no add', /replace/i.test(coreMemoryDefinition({}).description) && /no \"add entry\" operation/i.test(coreMemoryDefinition({}).description));
const toolRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'newmate-core-memory-tool-'));
const toolCore = createCoreMemory(toolRoot, now);
const definition = coreMemoryDefinition({ services: { core: () => ({ snapshot: () => toolCore.snapshot(), save: (args) => toolCore.save(args) }) } });
check('the tool refuses outside a NewMate run, so a DSH agent cannot read the core memory through it', definition.execute({ action: 'read' }).code === 'core_memory_outside_newmate');
const noStore = await withNewMateContext({ session: { id: 's' } }, async () => coreMemoryDefinition({}).execute({ action: 'read' }));
check('inside a run but with no store reachable it refuses instead of pretending to read', noStore.ok === false && noStore.code === 'core_memory_unavailable');
const inside = await withNewMateContext({ session: { id: 's' } }, async () => definition.execute({ action: 'read' }));
check('inside a NewMate run the same tool reads the sections', inside.ok === true && inside.sections.length === 4 && inside.budget === 5000);
const wrote = await withNewMateContext({ session: { id: 's' } }, async () => definition.execute({ action: 'write', section: 'style', content: '中文，先结论。' }));
check('and writes through the same budget, reporting a replacement', wrote.ok === true && typeof wrote.chars === 'number');

/* -------------------------------------- the mounted row keeps it private --- */

const rowRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'newmate-core-memory-row-'));
const registered = new Map();
const routes = new Map();
const disposers = [];
const services = {};
const row = await import(new URL('../packages/newmark-core/components/newmate/index.js', import.meta.url).href + '?mount=core-memory-gate');
const ctx = {
  effect(callback) { const disposer = callback(); if (typeof disposer === 'function') disposers.push(disposer); return disposer; },
  tools: { register(definition) { registered.set(definition.name, definition); return () => registered.delete(definition.name); }, schemas: () => [], execute: async () => ({ results: [] }) },
  webServer: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); }, tapIndex() {} },
  get(name) { return name === 'newmarkComponents' ? services : undefined; },
  logger: { warn() {}, error() {} },
};
row.apply(ctx, { root: rowRoot });
const mounted = globalThis[Symbol.for('newmark.newmate.privateTools')] || {};
check('the mounted row publishes the core-memory tool PRIVATELY', mounted[CORE_MEMORY_TOOL_NAME]?.name === CORE_MEMORY_TOOL_NAME);
check('and does NOT register it in the shared tool registry, so no DSH catalog lists it', !registered.has(CORE_MEMORY_TOOL_NAME));
check('the mounted tool refuses a caller that is not a NewMate run', mounted[CORE_MEMORY_TOOL_NAME].execute({ action: 'read' }).code === 'core_memory_outside_newmate');
for (const dispose of disposers.reverse()) { try { dispose(); } catch { /* a gate's teardown must not mask its verdict */ } }

/* ------------------------------------------------------ and the persona says so --- */

const persona = fs.readFileSync(new URL('../packages/newmark-core/components/newmate/lib/persona.js', import.meta.url), 'utf8');
check('the persona states its nature, its budget and the replace rule', persona.includes('它的性质是「稳定、核心」') && persona.includes('默认动作是更替') && persona.includes('5000 字符') && persona.includes('只有某个核心维度确实缺失时才第一次写入'));
check('the persona keeps it out of MemoryLab and out of other conversations', persona.includes('不属于 MemoryLab') && persona.includes('不会出现在别的对话里'));
const context = createMemoryContext(mateRoot, now)();
check('the initialization header introduces it as section 0, before the tag tree', context.prefix.indexOf('0) coreMemory') > 0 && context.prefix.indexOf('0) coreMemory') < context.prefix.indexOf('"tree"'));

console.log('');
console.log('SUMMARY passed=' + passed + ' failed=' + failures.length + ' total=' + (passed + failures.length));
if (failures.length) { console.log('FAILED: ' + failures.join('; ')); process.exit(1); }
console.log('PASS');
