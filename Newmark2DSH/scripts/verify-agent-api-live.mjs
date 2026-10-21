#!/usr/bin/env node
/**
 * verify-agent-api-live.mjs — the **live acceptance gate** for the `agent-api` component.
 *
 * =====================================================================================
 * READ THIS FIRST: why this file exists, and why it is NOT in the release gate
 * =====================================================================================
 *
 * Every other gate in this repository runs out of process against fake contexts. That is
 * what makes them fast, and it is also exactly why none of them can tell you whether a
 * model call works. This gate exists to make the real call, spend real tokens, and report
 * what came back. It is slow, it costs money, and it is run deliberately by a person —
 * never enrolled in `verify-newmark-core.mjs` or any other aggregate gate.
 *
 * Invoke it by hand:
 *
 *     node scripts/verify-agent-api-live.mjs
 *
 * Exit codes:
 *   0  every round passed
 *   1  a round failed (the failing assertions are named and the real output is printed)
 *   2  the gate could not be armed (no credential / no store / the run itself threw)
 *   3  the byte-exact store backup could not be taken, so the rebuild was refused
 *
 * **Run it ONCE per acceptance.** Round 4 rewrites the live index's `updatedAt` on every
 * invocation, so a gate that is run repeatedly has rewritten the user's store repeatedly.
 * That is a real cost of a live gate, not a technicality: the before/after sha256 in the
 * receipt is how a reader sees exactly what each run did.
 *
 * **Every round makes its call once and reports what came back.** There is no retry loop
 * anywhere in this file, deliberately: a gate that retries until green measures nothing. Two
 * rounds failed transiently during this gate's own development — with the provider answering
 * `TRANSPORT` on an otherwise identical request that succeeded seconds later — and the honest
 * treatment is to report that, which the receipt does by carrying the failure chain rather
 * than only the wrapper message.
 *
 * =====================================================================================
 * WHAT EVERY ROUND DISPATCHES NOW, AND WHY IT IS NOT A DETAIL
 * =====================================================================================
 *
 * Rounds 2 and 3 used to call the component's tool `execute` **directly**. That is not how a
 * judgement reaches this component and not how a model reaches it either: both go through
 * `ctx.tools.execute`, and the registry is where DSH validates a tool's return value as LOSSLESS
 * JSON (`createSuccessResult` -> `snapshotToolValue` -> `snapshotJsonValue`,
 * `@deepseek-ai/dsh-tools/lib/types/index.js:1189-1190`, `:106-118`; rules at
 * `@deepseek-ai/dsh-util-values/lib/index.js:46-153`, and `:109`
 * `if (typeof current !== "object") return void 0` is where `undefined` dies).
 *
 * **So this gate had a hole exactly where this class of defect lives, and the hole cost a real
 * run.** On 0.2.8 the user pressed 重建索引; the Agent really ran, for real time and real tokens;
 * and the answer was thrown away at the boundary because one event in the envelope carried
 * `{ turn: undefined }`. The panel showed
 * `判定未完成：INVALID_TOOL_OUTPUT — tool "agent_api_send" returned invalid output: value is not
 * lossless JSON`. Round 4, which DOES dispatch through the registry, caught the same defect in
 * `memory_lab_reindex` (0.2.2) and not this one — because rounds 2 and 3 were not going through
 * the registry at all.
 *
 * Every round now reaches `agent_api_send` the way the caller does — `dispatchTool`, which is
 * `tools.execute` — and every round asserts the boundary result BEFORE it asserts anything about
 * the content, naming `INVALID_TOOL_OUTPUT` and the registry's own message when it fires. The
 * rule this file follows from here on: **a value a caller would never receive is not evidence
 * about a caller.** `verify-tool-output-boundary.mjs` holds the same line for all fifteen tools
 * the bundle registers, and checks that these two rounds still go through the registry.
 *
 * =====================================================================================
 * THE DESIGN DECISION, AND HOW IT WAS ESTABLISHED — read from the source, not assumed
 * =====================================================================================
 *
 * `agent-api`'s model seam is `ctx.llm.stream(options)`
 * (`components/agent-api/lib/llm-seam.js:208`), and `ctx.llm` is a DSH service that lives
 * inside the DSH process. The question this gate had to answer before it could exist is
 * which of three mechanisms is actually reachable.
 *
 * **CHOSEN — mechanism 1: a real LLM service constructed OUT OF PROCESS from the shipped
 * provider packages.** It is reachable, and the evidence is in the source:
 *
 *   - `@deepseek-ai/dsh-llm` exports the concrete service class, not only a Cordis plugin:
 *     `export { …, LlmRuntime, LlmRuntime as default, … }` (`dsh-llm/lib/index.js:2390`).
 *     `LlmRuntime` takes a Cordis context and nothing else —
 *     `constructor(ctx) { super(ctx, "llm"); }` (`dsh-llm/lib/index.js:1800-1802`).
 *   - `listModels(provider)` is exactly the shape this gate's round 1 asserts:
 *     `async listModels(provider)` returning detached
 *     `{ provider, id, name, description?, inputModalities? }`, throwing `LlmError` on a
 *     provider with no adapter and `INVALID_CATALOG` on a duplicate or mismatched id
 *     (`dsh-llm/lib/index.js:2073-2088`; the guard is the throw at `:2077`).
 *   - The transport is constructible the same way. `DeepSeekAdapter` is exported
 *     (`dsh-llm-deepseek/lib/index.js:2283`) and its constructor takes one dependencies
 *     object — `constructor(dependencies)` (`:2077-2081`); `stream(options)` is on the
 *     adapter itself (`:2107-2109`). The production plugin reaches it through exactly two
 *     calls: `new DeepSeekAdapter({ … })` (`:2251`) then
 *     `ctx.llm.registerAdapter([provider], adapter)` (`:2267`).
 *   - The only Cordis surface needed is therefore a context, and `@deepseek-ai/cordis`
 *     supplies one as a plain constructor: `new Context()`.
 *
 * So this gate boots a real Cordis context, constructs the **real** `LlmRuntime`, registers
 * the **real** `DeepSeekAdapter` with the profile's own credential, and mounts the **real**
 * `components/agent-api/index.js` `apply()` against it. The ported loop, both seams and the
 * envelope are all exercised for real.
 *
 * **REJECTED — mechanism 2, "run inside DSH".** Nothing in the installation offers
 * "execute this script with the live context": the profile's graph is composed by the
 * Desktop shell (`dsh-plugin-desktop`), and the SDK/headless packages are alternative
 * *hosts*, not script hosts for a caller that wants `ctx.llm`. Mechanism 2 would have meant
 * writing a Host — which is mechanism 1 with more of the graph attached. This is a
 * rejection on evidence, not a preference.
 *
 * **What is NOT rebuilt.** The tool half is mounted for real rather than stubbed: a real
 * `ToolRuntime` (`dsh-tools`), a real `LocalFileSystem` (`dsh-fs-local`), a real
 * `SystemPrompt` (`dsh-system-prompt`), the real `@deepseek-ai/dsh-tool-fs` plugin run
 * through its own `apply()`, and the real `components/memorylab` component registering its
 * real `memory_lab_*` tools. Every tool schema the model sees is one DSH produced, and
 * every tool call it makes executes DSH's own code.
 *
 * **The one approximation, stated plainly.** The provider route this gate registers is
 * `deepseek-official` (the api-key route), not `deepseek-account` (the route the profile's
 * patch selects). The account route resolves its credential through the live
 * `ctx.deepseekAccount` service — `dsh-llm-deepseek-account/lib/index.js:16-18` — which
 * only exists inside a running DSH; the signed-in grant in the credential store cannot be
 * replayed from a script, and this gate will not mint one. Both routes drive the same
 * `DeepSeekAdapter` over the same endpoint and expose the same catalog, which is why
 * `deepseek-flash` is the model that answers here either way.
 *
 * =====================================================================================
 * SECURITY RULES THIS FILE OBEYS, WITHOUT EXCEPTION
 * =====================================================================================
 *
 *   - Credentials are READ, never written, never copied, never printed — not truncated,
 *     not in a failure message. `redactSecrets()` is applied to everything this gate
 *     prints, as a belt over the braces.
 *   - Nothing is written under the Newmark root except through the plugin's own
 *     `memory_lab_*` tools. The gate's scratch workspace is a separate directory.
 *   - The Memory Lab index is backed up byte-exactly before the rebuild, and the before
 *     and after sha256 are both reported.
 */

import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* ------------------------------------------------------------------ configuration --- */

/**
 * `fileURLToPath`, not `new URL(import.meta.url).pathname`.
 *
 * The pathname form is PERCENT-ENCODED, and the repo lives under `Newmark Agent` — so the
 * pathname arrives as `…/Newmark%20Agent/…`. The drive-letter fixup that was here handled the
 * leading slash and left the `%20` alone, so every filesystem path derived from it pointed at
 * a directory named `Newmark%20Agent`. That is why this gate armed its whole real runtime —
 * the Cordis context, the LlmRuntime, the DeepSeek adapter with the credential — and then died
 * on `Cannot find module …Newmark%20Agent…`, which reads like a missing file rather than a
 * mis-decoded URL.
 *
 * `fileURLToPath` decodes the escapes and handles the Windows drive form, which is what it is
 * for. Nothing in this file should reconstruct a path from a URL by hand.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const NEWMARK_CORE = process.env.NEWMARK_TEST_PACKAGE_ROOT || join(REPO, 'packages', 'newmark-core');

const DSH_APP_ROOT =
  process.env.DSH_APP_ROOT?.trim() || 'C:/Users/12252/AppData/Local/Programs/DSH Desktop/resources/app';
const DSH_MODULES = join(DSH_APP_ROOT, 'node_modules', '@deepseek-ai');
const DSH_HOME = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
const PROFILE_PATCH = join(DSH_HOME, 'profiles', 'desktop', 'cordis.patch.yml');
const CREDENTIALS_FILE = join(DSH_HOME, '.credentials.yaml');

/** The user's live store. Read for the backup; written ONLY through the memory_lab_* tools. */
const NEWMARK_ROOT = process.env.NEWMARK_ROOT?.trim() || join(homedir(), '.Newmark');
const MEMORY_INDEX = join(NEWMARK_ROOT, 'Memory Lab', 'index.json');

/** The gate's own scratch space — deliberately outside the store. */
const SCRATCH = join(REPO, 'evidence', 'agent-api-live', new Date().toISOString().replace(/[:.]/g, '-'));

/** The provider route this gate registers. See "the one approximation" above. */
const PROVIDER = 'deepseek-official';
/** The catalog id the user's own words name. DSH spells its display name DeepSeek-V41-Flash. */
const MODEL = 'deepseek-flash';

/* ------------------------------------------------------------------------ output --- */

const secrets = [];
/** Replace every secret this run has read with a fixed marker. Applied to every printed line. */
function redactSecrets(text) {
  let out = String(text ?? '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 8) out = out.split(secret).join('<redacted>');
  }
  return out;
}
function say(line = '') {
  process.stdout.write(redactSecrets(line) + '\n');
}
const ROUNDS = [];
function record(name, ok, detail) {
  ROUNDS.push({ name, ok: Boolean(ok), detail: String(detail ?? '') });
  say(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`);
  if (detail) say(`         ${redactSecrets(String(detail))}`);
}

/* ------------------------------------------------------------------- DSH imports --- */

/** Import one file that lives under the DSH installation's `@deepseek-ai` scope. */
const dshUrl = (rel) => pathToFileURL(join(DSH_MODULES, rel)).href;
const dshImport = (rel) => import(dshUrl(rel));
/** Import one of this repository's own modules. */
const repoImport = (rel) => import(pathToFileURL(join(REPO, rel)).href);

/* ----------------------------------------------------------------- credentials --- */

/** The credential reference the profile's api-key provider would resolve. */
const CREDENTIAL_REF = 'DEEPSEEK_API_KEY';

/** `undefined` when unset or empty — the same rule `dsh-credentials-local` applies. */
function fromProcessEnv(ref) {
  const value = process.env[ref];
  return typeof value === 'string' && value.length > 0 ? { value, source: 'inherited environment' } : undefined;
}

/** A var from a dotenv-style file, read without ever putting it in the environment. */
function fromDotenvFile(path, ref) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    if (at < 1) continue;
    if (line.slice(0, at).trim() !== ref) continue;
    const value = line.slice(at + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
    if (value.length > 0) return { value, source: `dotenv file ${path}` };
  }
  return undefined;
}

/**
 * Read the credential the profile already holds, honouring the same precedence the shipped
 * provider does (`dsh-credentials-local/lib/index.js:16-21`):
 * inherited environment > `$DSH_HOME/.credentials.yaml` > project `.env` > `$DSH_HOME/.env`.
 *
 * The document is `<CredentialRef> -> string` (`:40-45`), and that string is either the
 * credential itself or the key of a `records` entry that carries it (`:191-209`). Both are
 * handled, and from the moment either is read it is registered as a secret.
 */
async function resolveCredential(ref) {
  const inherited = fromProcessEnv(ref);
  if (inherited) return inherited;

  let document = { refs: {}, records: {} };
  if (existsSync(CREDENTIALS_FILE)) {
    try {
      const YAML = await dshImport('../yaml/dist/index.js');
      const parsed = (YAML.default ?? YAML).parseDocument(readFileSync(CREDENTIALS_FILE, 'utf8'), {
        prettyErrors: true,
        uniqueKeys: true,
      });
      if (parsed.errors.length > 0) {
        say(`  ! the credentials document has ${parsed.errors.length} parse error(s); not reading it`);
      } else {
        const root = parsed.toJS() ?? {};
        document = { refs: root.refs ?? {}, records: root.records ?? {} };
      }
    } catch (error) {
      say(`  ! the credentials document could not be parsed (${error?.message ?? error}); not reading it`);
    }
  }

  const refValue = document.refs[ref];
  if (typeof refValue === 'string' && refValue.length > 0) {
    const record = document.records[refValue];
    if (record === undefined) return { value: refValue, source: `${CREDENTIALS_FILE} (ref, inline value)` };
    if (typeof record.key === 'string' && record.key.length > 0) {
      return { value: record.key, source: `${CREDENTIALS_FILE} (record ${refValue})` };
    }
    const envName = Object.keys(record.env ?? {})[0];
    if (typeof envName === 'string') {
      const named = document.refs[envName] ?? process.env[envName];
      if (typeof named === 'string' && named.length > 0) {
        return { value: named, source: `${CREDENTIALS_FILE} (record ${refValue} -> env ${envName})` };
      }
    }
    return {
      value: undefined,
      source: '',
      unusable:
        `the reference "${ref}" resolves to record "${refValue}" of kind "${record.kind}", which carries no inline ` +
        `key and no resolvable env value. If that record is a signed-in account grant, this gate cannot use it out ` +
        `of process and will not try to mint one.`,
    };
  }

  const projectEnv = fromDotenvFile(join(process.cwd(), '.env'), ref);
  if (projectEnv) return projectEnv;
  const homeEnv = fromDotenvFile(join(DSH_HOME, '.env'), ref);
  if (homeEnv) return homeEnv;

  return {
    value: undefined,
    source: '',
    unusable:
      `no credential could be resolved for "${ref}" (checked the inherited environment, ${CREDENTIALS_FILE}, ` +
      `./.env and $DSH_HOME/.env)`,
  };
}

/* --------------------------------------------------------- the profile's selection --- */

/**
 * Read the provider/model/reasoningEffort the user's own profile patch selects, so the gate
 * describes the same selection the live Host uses rather than one this file invented. A
 * small reader on purpose: reading three keys must not require parsing a whole patch.
 */
function readProfileSelection() {
  const selection = { provider: '', model: '', reasoningEffort: '' };
  let text;
  try {
    text = readFileSync(PROFILE_PATCH, 'utf8');
  } catch {
    return selection;
  }
  let inAgentDefaultModel = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    if (/^\s*-\s+id:\s*agent-default-model\s*$/.test(line)) {
      inAgentDefaultModel = true;
      continue;
    }
    if (inAgentDefaultModel && /^\s*-\s+id:\s*/.test(line)) break;
    if (!inAgentDefaultModel) continue;
    const match = /^\s+(provider|model|reasoningEffort):\s*(\S+)\s*$/.exec(line);
    if (match) selection[match[1]] = match[2];
  }
  return selection;
}

/* ------------------------------------------------------------------- sha256 facts --- */

function sha256File(path) {
  if (!existsSync(path)) return null;
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
function fileFacts(path) {
  if (!existsSync(path)) return { path, exists: false };
  const stat = statSync(path);
  return { path, exists: true, bytes: stat.size, sha256: sha256File(path) };
}
function randomInt(maxExclusive) {
  return Math.floor(Math.random() * maxExclusive);
}

/* ------------------------------------------------------------- calling the tools --- */

/**
 * Execute one registered tool through the real registry, the way a ToolRuntime dispatch
 * does, and answer a fact sheet rather than a formatted view — the gate prints the facts.
 *
 * `exec` carries a signal and no agent, which is exactly what the loop hands a run's tools
 * (`components/agent-api/component.js:576-581`).
 */
async function dispatchTool(tools, name, args) {
  const started = Date.now();
  let outcome;
  let threw = null;
  try {
    outcome = await tools.execute({
      callId: `agent-api-live:${name}:${randomUUID().slice(0, 8)}`,
      name,
      arguments: args ?? {},
      signal: new AbortController().signal,
    });
  } catch (error) {
    threw = `${error?.constructor?.name ?? 'Error'}: ${error?.message ?? error}`;
  }
  return {
    name,
    args,
    ms: Date.now() - started,
    threw,
    isError: outcome?.isError ?? null,
    value: outcome?.value ?? null,
    /* The registry's own failure detail. Without this a failed dispatch reads as a bare
     * `isError: true`, which is exactly the shape that hides a real defect. */
    errorMessage: String(outcome?.error?.message ?? ''),
    errorCode: String(outcome?.error?.info?.code ?? ''),
    errorName: String(outcome?.error?.info?.name ?? ''),
    contentText: Array.isArray(outcome?.content)
      ? outcome.content
          .filter((block) => block?.type === 'text')
          .map((block) => String(block.text ?? ''))
          .join('\n')
      : null,
  };
}

/**
 * The whole failure chain as one line. The adapter wraps transport faults, so the useful
 * sentence is usually in `cause` rather than in `message` — reporting only the wrapper is
 * what makes "transport failed" useless.
 */
function describeError(error) {
  const parts = [];
  let current = error;
  for (let depth = 0; current !== undefined && current !== null && depth < 6; depth++) {
    const code = current.code !== undefined ? ` (${current.code})` : '';
    parts.push(`${current.name ?? current.constructor?.name ?? 'Error'}${code}: ${current.message ?? String(current)}`);
    current = current.cause;
  }
  return parts.join('  <-  ');
}

/** The agent-api tools answer an envelope directly; a registry tool answers `{isError, content}`. */
function unwrap(result) {
  if (result.value && typeof result.value === 'object') return result.value;
  if (typeof result.contentText === 'string') {
    try {
      return JSON.parse(result.contentText);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * The boundary fact for one dispatch, said once so every round says it the same way.
 *
 * `call.value` is already the registry's own snapshot, so re-walking it here would be a check
 * that cannot fail. What can fail — and did — is the registry's verdict on the value the tool
 * body returned: `isError`, the `INVALID_TOOL_OUTPUT` code, and the registry's own sentence.
 */
function boundaryDetail(call) {
  const boundary = call.isError === false && call.errorCode !== 'INVALID_TOOL_OUTPUT' && call.threw === null;
  return {
    ok: boundary,
    detail:
      `isError=${call.isError} code=${call.errorCode || '-'} name=${call.errorName || '-'}` +
      `${call.errorMessage ? ` :: ${call.errorMessage}` : ''}${call.threw ? ` threw=${call.threw}` : ''}`,
  };
}

/* `callAgentApiTool` used to live here: it reached into `api.tools()` and called the definition's
 * `execute` directly, which is precisely the call that never meets the registry's output boundary.
 * Rounds 2 and 3 now use `dispatchTool` above. Nothing in this file may call a tool definition's
 * `execute` again — `verify-tool-output-boundary.mjs` fails if this identifier comes back. */

/* =====================================================================================
 * ROUND 1 — read the available models
 * ===================================================================================== */

async function round1ListModels(runtime) {
  say('\n=== ROUND 1 — read the available models (ctx.llm.listModels) ===');

  /* The documented refusal for an unregistered provider, checked FIRST: a gate that only
   * asserted "the call resolved" would pass against a service that answers [] for
   * everything. */
  let unregistered;
  try {
    await runtime.listModels(`no-such-provider-${randomUUID().slice(0, 8)}`);
    unregistered = { threw: false };
  } catch (error) {
    unregistered = {
      threw: true,
      name: error?.constructor?.name,
      code: error?.code,
      message: String(error?.message ?? error),
    };
  }
  record(
    'listModels throws LlmError with NO_ADAPTER for an unregistered provider',
    unregistered.threw === true && unregistered.code === 'NO_ADAPTER' && unregistered.name === 'LlmError',
    `got ${unregistered.name ?? 'no throw'} code=${unregistered.code ?? '-'} :: ${unregistered.message ?? 'resolved'}`,
  );

  const models = await runtime.listModels(PROVIDER);
  record('listModels returns an array', Array.isArray(models), `typeof=${Array.isArray(models) ? 'array' : typeof models}`);
  record(
    'every entry carries the documented detached shape',
    models.every(
      (entry) =>
        typeof entry?.provider === 'string' &&
        entry.provider === PROVIDER &&
        typeof entry?.id === 'string' &&
        entry.id.length > 0 &&
        typeof entry?.name === 'string' &&
        entry.name.length > 0 &&
        (entry.description === undefined || typeof entry.description === 'string'),
    ),
    `${models.length} ${models.length === 1 ? 'entry' : 'entries'}`,
  );

  /* THE ASSERTION THAT MATTERS: a list that does not CONTAIN the model is the failure. */
  const hit = models.find((entry) => entry.id === MODEL);
  record(
    `"${MODEL}" is actually present in the catalog`,
    hit !== undefined,
    hit
      ? `provider=${hit.provider} id=${hit.id} name=${JSON.stringify(hit.name)} inputModalities=${(hit.inputModalities ?? []).join('+')}`
      : `the catalog does not contain ${MODEL}; it contains: ${models.map((entry) => entry.id).join(', ') || '(nothing)'}`,
  );

  say(`  catalog: ${models.map((entry) => `${entry.id} (${entry.name})`).join(', ')}`);
  return { models, hit: hit ?? null };
}

/* =====================================================================================
 * ROUND 2 — one conversation round
 * ===================================================================================== */

async function round2Conversation(tools, api) {
  say('\n=== ROUND 2 — one conversation round (agent_api_send, dispatched through the registry) ===');

  const prompt =
    'Compute (137 * 941) + 12. Reply with the integer value and nothing else — no words, no punctuation.';
  const expected = 137 * 941 + 12;

  /* `dispatchTool`, not the definition's `execute`: this is the call a judgement makes and the
   * call a model makes, and it is the only one that meets DSH's output boundary. */
  const call = await dispatchTool(tools, 'agent_api_send', { prompt, max_steps: 2, timeout_ms: 180000 });
  const envelope = unwrap(call);

  /* THE BOUNDARY FIRST, before any assertion about the content. A run whose value was rejected
   * did not fail — it answered and the answer was thrown away, which is a different incident and
   * must read as one. */
  const boundary = boundaryDetail(call);
  record(
    "the registry ACCEPTED the run's value (DSH's output boundary: no INVALID_TOOL_OUTPUT)",
    boundary.ok,
    boundary.detail,
  );

  if (envelope === null) {
    record(
      'agent_api_send answered an envelope',
      false,
      `no parseable envelope; threw=${call.threw} value=${JSON.stringify(call.value)?.slice(0, 500)}`,
    );
    return { call, envelope: null, prompt, expected, output: '' };
  }

  say(
    `  envelope: ${JSON.stringify({ ok: envelope.ok, tool: envelope.tool, route: envelope.route, exit: envelope.exit, code: envelope.code ?? undefined })}`,
  );
  say(`  model:    ${JSON.stringify(envelope.model ?? null)}`);
  if (envelope.error) say(`  error:    ${envelope.error}`);

  record('envelope.ok is true', envelope.ok === true, `ok=${envelope.ok} exit=${envelope.exit} class=${envelope.class} route=${envelope.route}`);
  record('the run really went through the loop', envelope.route === 'loop', `route=${envelope.route}`);
  record('exit is 0 and class is ok', envelope.exit === 0 && envelope.class === 'ok', `exit=${envelope.exit} class=${envelope.class}`);
  record(
    'the envelope names the model that answered',
    envelope.model?.provider === PROVIDER && envelope.model?.model === MODEL,
    JSON.stringify(envelope.model ?? null),
  );

  const output = String(envelope.result?.output ?? '');
  say(`  model output: ${JSON.stringify(output)}`);

  /** ASSERTING ON THE CONTENT, not merely on `ok: true`. */
  record('the run produced non-empty output', output.trim().length > 0, `output=${JSON.stringify(output)}`);
  record(
    `the output is the correct answer (${expected})`,
    output.trim() === String(expected),
    output.trim() === String(expected)
      ? `output equals ${expected}`
      : `output=${JSON.stringify(output.trim())} but ${expected} was expected — the model answered and the answer is wrong`,
  );
  record('the run used exactly one assistant turn', Number(envelope.result?.turns) === 1, `turns=${envelope.result?.turns}`);
  record(
    'the run made no tool call, which is what this round is for',
    Number(envelope.result?.tool_calls) === 0,
    `tool_calls=${envelope.result?.tool_calls}`,
  );
  record('stop_reason is a clean stop', envelope.result?.stop_reason === 'stop', `stop_reason=${envelope.result?.stop_reason}`);
  record(
    'the temporary conversation was released',
    envelope.result?.context?.released === true,
    JSON.stringify(envelope.result?.context ?? null),
  );

  return { call, envelope, prompt, expected, output };
}

/* =====================================================================================
 * ROUND 3 — one full tool-call round over the widened tool set
 * ===================================================================================== */

async function round3ToolCall(tools, api) {
  say('\n=== ROUND 3 — one full tool-call round (widened tool set, tools.allow = ["*"]) ===');

  /* A file whose contents the model cannot know, in the gate's own scratch directory.
   * Reading it is the only way to answer, so "the model answered from its own knowledge"
   * is excluded by construction rather than by inspection. */
  const digits = String(randomInt(900) + 100);
  const token = `NM-GATE-${randomUUID().slice(0, 8).toUpperCase()}`;
  const marker = `LIVE-GATE-${randomUUID().slice(0, 8).toUpperCase()}`;
  const filePath = join(SCRATCH, 'tool-round.txt');
  mkdirSync(SCRATCH, { recursive: true });
  writeFileSync(
    filePath,
    [
      'Newmark agent-api live gate — tool-call round fixture.',
      `marker = ${marker}`,
      `token = ${token}`,
      `code = ${digits}`,
      'Nothing else in this file is meaningful.',
      '',
    ].join('\n'),
    'utf8',
  );
  const product = [...digits].reduce((acc, digit) => acc * Number(digit), 1);

  say(`  fixture:  ${filePath} (${statSync(filePath).size} bytes on disk)`);
  say(`  expects:  token ${token}, code ${digits}, digit product ${product}`);

  const prompt =
    `Read the file at ${filePath} using your read tool. It contains a line beginning "token = " and a line ` +
    `beginning "code = ". Report the token exactly, then the product of the digits of the code. Answer as exactly ` +
    `two lines: the token on the first line, the product on the second. Do not guess: if you have not read the ` +
    `file you do not know either value.`;

  const callsBefore = Number(api.counters?.toolCalls ?? 0);
  const call = await dispatchTool(tools, 'agent_api_send', {
    prompt,
    tools: { allow: ['*'] },
    max_steps: 4,
    timeout_ms: 240000,
  });
  const envelope = unwrap(call);
  const callsAfter = Number(api.counters?.toolCalls ?? 0);

  /* The boundary first, for the same reason as round 2 — and this round is the one that also
   * proves the run's own nested dispatches went through the registry, since `counters.toolCalls`
   * is only moved by a real `tools.execute`. */
  const boundary = boundaryDetail(call);
  record(
    "the registry ACCEPTED the run's value (DSH's output boundary: no INVALID_TOOL_OUTPUT)",
    boundary.ok,
    boundary.detail,
  );

  if (envelope === null) {
    record(
      'agent_api_send answered an envelope',
      false,
      `no parseable envelope; threw=${call.threw} value=${JSON.stringify(call.value)?.slice(0, 800)}`,
    );
    return { envelope: null, token, product, digits, marker, filePath, output: '', toolNames: [] };
  }

  say(
    `  envelope: ${JSON.stringify({ ok: envelope.ok, route: envelope.route, exit: envelope.exit, code: envelope.code ?? undefined })}`,
  );
  if (envelope.error) say(`  error:    ${envelope.error}`);
  say(`  model:    ${JSON.stringify(envelope.model ?? null)}`);

  const output = String(envelope.result?.output ?? '');
  const toolNames = Array.isArray(envelope.result?.tool_names) ? envelope.result.tool_names : [];

  say(`  widened tool set (${toolNames.length}): ${toolNames.join(', ')}`);
  say(`  tool_calls reported: ${envelope.result?.tool_calls}; counters.toolCalls ${callsBefore} -> ${callsAfter}`);
  say(`  usage: ${JSON.stringify(envelope.result?.usage ?? null)}`);
  say(`  model output:\n${output.split('\n').map((line) => '    | ' + line).join('\n')}`);

  record('envelope.ok is true', envelope.ok === true, `ok=${envelope.ok} exit=${envelope.exit} class=${envelope.class} route=${envelope.route}`);
  record('the run really went through the loop', envelope.route === 'loop', `route=${envelope.route}`);
  record(
    'exit is 0 and class is ok',
    envelope.exit === 0 && envelope.class === 'ok',
    `exit=${envelope.exit} class=${envelope.class} code=${envelope.code ?? '-'}`,
  );
  /* The widening has to be visible as a FACT about the offered set, not as a claim: the
   * default set is `memory_lab_*` only, so a filesystem tool in the list is the widening. */
  record(
    'the widening reached the loop: the run was offered more than the memory tools',
    toolNames.includes('read') && toolNames.some((name) => String(name).startsWith('memory_lab_')),
    `offered ${toolNames.length}: ${toolNames.join(', ') || '(none)'} — the default is memory_lab_* only`,
  );
  /* THE ASSERTION THAT EXCLUDES THE FAILURE MODE: a tool was really invoked, counted by the
   * component's own counter rather than merely offered. */
  record(
    'a tool was ACTUALLY invoked (the component counted it)',
    Number(envelope.result?.tool_calls) >= 1 && callsAfter > callsBefore,
    `tool_calls=${envelope.result?.tool_calls}, counters.toolCalls ${callsBefore} -> ${callsAfter}`,
  );
  /* And that its result REACHED THE MODEL: the token exists only in the file, so the token
   * appearing in the final answer can only have travelled through the tool result. */
  record(
    'the tool result REACHED the model (the token exists only in the fixture)',
    output.includes(token),
    output.includes(token)
      ? `the answer contains the fixture token ${token}`
      : `the answer does not contain ${token}; output=${JSON.stringify(output)}`,
  );
  record(
    'the model used the tool result correctly (digit product computed)',
    output.includes(String(product)),
    output.includes(String(product))
      ? `the answer contains the correct digit product ${product} of ${digits}`
      : `the answer does not contain ${product} (product of the digits of ${digits}); output=${JSON.stringify(output)}`,
  );
  record('stop_reason is a clean stop', envelope.result?.stop_reason === 'stop', `stop_reason=${envelope.result?.stop_reason}`);
  record(
    'the temporary conversation was released',
    envelope.result?.context?.released === true,
    JSON.stringify(envelope.result?.context ?? null),
  );

  return { call, envelope, token, product, digits, marker, filePath, output, toolNames };
}

/* =====================================================================================
 * ROUND 4 — one complete MemoryLab index rebuild, from the MemoryLab entry point
 * ===================================================================================== */

function backupMemoryIndex() {
  const dir = join(SCRATCH, 'memory-backup');
  mkdirSync(dir, { recursive: true });
  const backup = { dir, taken: [], missing: [] };
  for (const source of [MEMORY_INDEX, `${MEMORY_INDEX}.bak`]) {
    if (!existsSync(source)) {
      backup.missing.push(source);
      continue;
    }
    const target = join(dir, source === MEMORY_INDEX ? 'index.json' : 'index.json.bak');
    /* Byte-exact: copyFileSync, no re-encoding, no parsing, no normalization. */
    copyFileSync(source, target);
    const before = fileFacts(source);
    const after = fileFacts(target);
    if (before.sha256 !== after.sha256) {
      throw new Error(
        `the backup of ${source} does not match the original (${before.sha256} vs ${after.sha256})`,
      );
    }
    backup.taken.push({ source, target, bytes: before.bytes, sha256: before.sha256 });
  }
  return backup;
}

async function round4MemoryRebuild(tools) {
  say('\n=== ROUND 4 — one complete MemoryLab index rebuild, from the MemoryLab entry point ===');

  const indexBefore = fileFacts(MEMORY_INDEX);
  const bakBefore = fileFacts(`${MEMORY_INDEX}.bak`);
  say(`  index.json     before: exists=${indexBefore.exists} bytes=${indexBefore.bytes ?? '-'} sha256=${indexBefore.sha256 ?? '-'}`);
  say(`  index.json.bak before: exists=${bakBefore.exists} bytes=${bakBefore.bytes ?? '-'} sha256=${bakBefore.sha256 ?? '-'}`);

  if (!indexBefore.exists) {
    record('the live store exists to be rebuilt', false, `${MEMORY_INDEX} does not exist; nothing was rebuilt`);
    return { indexBefore, indexAfter: null, bakBefore, bakAfter: null, call: null };
  }

  /* THE BACKUP, taken before anything is invoked. If it cannot be taken the rebuild is
   * refused: damaging real memory is far worse than a gate that did not run. */
  let backup;
  try {
    backup = backupMemoryIndex();
  } catch (error) {
    say(`  ! the byte-exact backup FAILED: ${error?.message ?? error}`);
    say('  ! REFUSING to run the rebuild. The store is untouched.');
    record('a byte-exact backup of index.json (+ .bak) was taken first', false, String(error?.message ?? error));
    return { indexBefore, indexAfter: null, bakBefore, bakAfter: null, call: null, refused: true };
  }
  record(
    'a byte-exact backup of index.json (+ .bak) was taken first',
    backup.taken.length > 0,
    backup.taken.length > 0
      ? backup.taken.map((entry) => `${entry.source} -> ${entry.target} (${entry.bytes} bytes, sha256 ${entry.sha256})`).join('; ')
      : 'the store had no index.json to back up',
  );
  say(`  backup dir: ${backup.dir}`);
  for (const entry of backup.taken) say(`    ${entry.source}\n      -> ${entry.target}  bytes=${entry.bytes}  sha256=${entry.sha256}`);
  for (const path of backup.missing) say(`    (absent, nothing to back up: ${path})`);

  /* THE ENTRY POINT: `memory_lab_reindex`, registered by the real MemoryLab component and
   * reached through the real tool registry — not a direct call into the store. */
  const reindexTool = tools.schemas().find((tool) => tool.name === 'memory_lab_reindex');
  record(
    'the MemoryLab component registered memory_lab_reindex',
    reindexTool !== undefined,
    reindexTool ? 'registered through ctx.tools.register by components/memorylab' : 'not registered',
  );
  if (!reindexTool) return { indexBefore, indexAfter: null, bakBefore, bakAfter: null, call: null, backup };

  const call = await dispatchTool(tools, 'memory_lab_reindex', {});
  const envelope = unwrap(call);
  /* The MemoryLab tools carry their result AT THE TOP LEVEL of what they return — there is no
   * `result` wrapper to unwrap.
   *
   * `class`/`exit`/`result` is the **agent-api** envelope, produced by `agent_api_*`. This round
   * dispatches `memory_lab_reindex`, a MemoryLab tool, whose published shape is
   * `{ ok, action, relationshipVersion, components, tags, judge, warnings, receipt }`. Reading
   * it as an agent-api envelope made this round fail on a tool that had answered correctly:
   * `ok=true class=undefined exit=undefined`, with `result: null` because there is no `result`.
   *
   * The assertions below are the ones that matter and they are unchanged in strictness — a
   * rebuild that did not verify, or did not report its counts, still fails. What changed is the
   * contract they are checked against: MemoryLab's, not agent-api's. */
  const value = envelope?.result ?? envelope;

  say(
    `  dispatch: ${
      call.threw
        ? `threw=${call.threw}`
        : `isError=${call.isError} in ${call.ms} ms${call.errorCode ? ` code=${call.errorCode} name=${call.errorName}` : ''}`
    }`,
  );
  if (call.errorMessage) say(`  registry error: ${call.errorMessage}`);
  if (call.contentText) say(`  registry content: ${call.contentText.slice(0, 400)}`);
  say(
    `  reindex envelope: ${
      envelope === null
        ? 'null'
        : JSON.stringify({ ok: envelope.ok, exit: envelope.exit, class: envelope.class, code: envelope.code ?? undefined })
    }`,
  );
  say(`  result: ${JSON.stringify(value)}`);
  if (envelope?.error) say(`  error: ${String(envelope.error)}`);

  const indexAfter = fileFacts(MEMORY_INDEX);
  const bakAfter = fileFacts(`${MEMORY_INDEX}.bak`);
  say(`  index.json     after:  exists=${indexAfter.exists} bytes=${indexAfter.bytes ?? '-'} sha256=${indexAfter.sha256 ?? '-'}`);
  say(`  index.json.bak after:  exists=${bakAfter.exists} bytes=${bakAfter.bytes ?? '-'} sha256=${bakAfter.sha256 ?? '-'}`);

  record(
    'the reindex tool answered an ok envelope',
    // `ok` plus the tool's OWN discriminators. `class`/`exit` belonged to agent-api's envelope
    // and asserting them here demanded a field MemoryLab does not define and should not.
    envelope?.ok === true && envelope?.action === 'REINDEX' && envelope?.receipt?.rebuilt === true,
    `ok=${envelope?.ok} action=${envelope?.action} rebuilt=${envelope?.receipt?.rebuilt}${
      envelope?.error ? ` error=${envelope.error}` : ''
    }${call.errorCode ? ` registry=${call.errorCode}: ${call.errorMessage}` : ''}`,
  );
  record(
    'the tool reported a completed, verified rebuild',
    value?.receipt?.rebuilt === true && value?.receipt?.verified === true && value?.ok === true,
    JSON.stringify(value?.receipt ?? null),
  );
  record(
    'the rebuild reported components and tags',
    Number.isFinite(Number(value?.components)) && Number.isFinite(Number(value?.tags)),
    `components=${value?.components} tags=${value?.tags} relationshipVersion=${value?.relationshipVersion}`,
  );
  record(
    'index.json still exists and is non-empty after the rebuild',
    indexAfter.exists && Number(indexAfter.bytes) > 0,
    `bytes=${indexAfter.bytes}`,
  );
  /* The write protocol promises this in so many words
   * (`components/memorylab/lib/memory-store.js:846-848, 858-868`). */
  record(
    'the previous index was preserved as index.json.bak',
    bakAfter.exists && bakAfter.sha256 === indexBefore.sha256,
    bakAfter.sha256 === indexBefore.sha256
      ? `.bak now holds exactly the pre-rebuild index (sha256 ${bakAfter.sha256})`
      : `.bak sha256=${bakAfter.sha256 ?? '-'} but the pre-rebuild index was ${indexBefore.sha256 ?? '-'}`,
  );

  const changed = indexBefore.sha256 !== indexAfter.sha256;
  say(`  sha256 ${changed ? 'CHANGED' : 'unchanged'}: ${indexBefore.sha256} -> ${indexAfter.sha256}`);

  /* What changed, in the only terms that are honest without diffing the user's memory: the
   * counts the tool reported, the counts the backup held, and whether anything OTHER than
   * the timestamp moved.
   *
   * The v2 index keys `components` by slug and `tags` by name, so both are OBJECT MAPS —
   * reading `.length` on them answers `undefined`, which is the bug that once made this
   * gate print `components=null` for a store holding 18 of them. */
  const countEntries = (container) =>
    Array.isArray(container)
      ? container.length
      : container && typeof container === 'object'
        ? Object.keys(container).length
        : null;
  const readIndexCounts = (path) => {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      return {
        components: countEntries(parsed?.components),
        tags: countEntries(parsed?.tags),
        relationshipVersion: parsed?.relationshipVersion ?? null,
        updatedAt: parsed?.updatedAt ?? null,
        preferredLanguage: parsed?.preferredLanguage ?? null,
      };
    } catch (error) {
      return { error: String(error?.message ?? error) };
    }
  };
  const beforeCounts = readIndexCounts(join(backup.dir, 'index.json'));
  const afterCounts = readIndexCounts(MEMORY_INDEX);
  const reported = {
    components: value?.components ?? null,
    tags: value?.tags ?? null,
    relationshipVersion: value?.relationshipVersion ?? null,
  };
  say(`  counts before (from the backup): ${JSON.stringify(beforeCounts)}`);
  say(`  counts after  (from the index):  ${JSON.stringify(afterCounts)}`);
  say(`  counts the tool reported:        ${JSON.stringify(reported)}`);
  if (Array.isArray(value?.warnings) && value.warnings.length > 0) {
    say(`  rebuild warnings (${value.warnings.length}): ${value.warnings.join('; ')}`);
  }
  /* Does the rebuild really still fit in the mutated container the v2 index uses? Parsed and
   * compared, not assumed: only `updatedAt` should now differ from the backup. */
  try {
    const a = JSON.parse(readFileSync(join(backup.dir, 'index.json'), 'utf8'));
    const b = JSON.parse(readFileSync(MEMORY_INDEX, 'utf8'));
    const onlyTimestampChanged = JSON.stringify({ ...a, updatedAt: '' }) === JSON.stringify({ ...b, updatedAt: '' });
    record(
      'the rebuild moved nothing but the index timestamp',
      onlyTimestampChanged,
      onlyTimestampChanged
        ? `every other top-level field is identical to the pre-rebuild copy (updatedAt ${a.updatedAt} -> ${b.updatedAt})`
        : 'the rebuild changed index content beyond updatedAt; compare the backup in the receipt',
    );
  } catch (error) {
    record('the pre/post indexes could be compared', false, String(error?.message ?? error));
  }

  return { indexBefore, indexAfter, bakBefore, bakAfter, call, envelope, value, backup, beforeCounts, afterCounts, changed };
}

/* =====================================================================================
 * main
 * ===================================================================================== */

async function main() {
  say('Newmark Core — agent-api LIVE acceptance gate');
  say('=============================================');
  say(`repo:      ${REPO}`);
  say(`dsh app:   ${DSH_APP_ROOT}`);
  say(`dsh home:  ${DSH_HOME}`);
  say(`newmark:   ${NEWMARK_ROOT}`);
  say(`scratch:   ${SCRATCH}`);
  say(`started:   ${new Date().toISOString()}`);
  say('This gate makes REAL model calls and spends REAL tokens. It is not part of the release gate.');

  mkdirSync(SCRATCH, { recursive: true });

  const profileSelection = readProfileSelection();
  say(
    `profile selection (${PROFILE_PATCH}): provider=${profileSelection.provider || '-'} model=${profileSelection.model || '-'} reasoningEffort=${profileSelection.reasoningEffort || '-'}`,
  );

  /* ---- the credential ---- */
  const credential = await resolveCredential(CREDENTIAL_REF);
  if (typeof credential.value === 'string') secrets.push(credential.value);
  say(`credential ref:    ${CREDENTIAL_REF}`);
  say(`credential source: ${credential.source || '(none)'}`);
  if (credential.value === undefined) {
    say(`\nThe gate cannot be armed: ${credential.unusable}`);
    say('Nothing was called and nothing was written. Report this rather than working around it.');
    process.exit(2);
  }
  say('credential:        <held, never printed>');

  /* ---- the real LLM service, on a real Cordis context (mechanism 1) ---- */
  const cordis = await dshImport('cordis/lib/index.js');
  const llmModule = await dshImport('dsh-llm/lib/index.js');
  const deepseek = await dshImport('dsh-llm-deepseek/lib/index.js');

  const ctx = new cordis.Context();
  const runtime = new llmModule.LlmRuntime(ctx);

  /* The provider's own resolve step, called exactly as the shipped plugin calls it
   * (`dsh-llm-deepseek-account/lib/index.js:13`). */
  const connection = deepseek.resolveAdapterOptions({}, undefined);
  connection.baseURL = deepseek.PUBLIC_BASE_URL;

  const adapter = new deepseek.DeepSeekAdapter({
    options: () => connection,
    resolveAuth: async () => ({ headers: { 'x-api-key': credential.value } }),
    providerName: 'DeepSeek',
    discoverModels: async (provider) => connection.models.map((model) => deepseek.catalogModelInfo(provider, model)),
    resolveUserId: () => 'newmark-agent-api-live-gate',
    /* Exactly the fallback `registerDeepSeekProvider` uses when no extension service is
     * mounted (`dsh-llm-deepseek/lib/index.js:2262-2265`). */
    prepareExtensions: () => Promise.resolve({ fields: {}, accept: () => Promise.resolve() }),
  });
  runtime.registerAdapter([PROVIDER], adapter);
  say(`\nllm service: real LlmRuntime on a real Cordis context; route "${PROVIDER}" registered`);
  say(`adapter:     real DeepSeekAdapter; endpoint ${connection.baseURL}`);

  /* ---- the real tool chain ---- */
  const { ToolRuntime } = await dshImport('dsh-tools/lib/index.js');
  const { LocalFileSystem } = await dshImport('dsh-fs-local/lib/index.js');
  const { SystemPrompt } = await dshImport('dsh-system-prompt/lib/index.js');
  const toolFs = await dshImport('dsh-tool-fs/lib/index.js');

  const systemPrompt = new SystemPrompt(ctx, {});
  const fileSystem = new LocalFileSystem(ctx, { cwd: SCRATCH, diffBasisMaxBytes: 8 * 1024 * 1024 });
  const tools = new ToolRuntime(ctx, {});
  toolFs.apply(ctx, { readLimit: 2000, readMaxLineLength: 2000, readMaxBytes: 262144, readStreamMinSize: 65536 });
  say(
    `tools:       real ToolRuntime; fs=${fileSystem.constructor.name}; prompt=${systemPrompt.constructor.name}; dsh-tool-fs apply() ran`,
  );

  /* ---- the real MemoryLab component, for its tools ---- */
  const effects = [];
  const memoryHost = {
    logger: {
      info: (...args) => say(`  [memorylab] ${args.map(String).join(' ')}`),
      warn: (...args) => say(`  [memorylab:warn] ${args.map(String).join(' ')}`),
      error: (...args) => say(`  [memorylab:error] ${args.map(String).join(' ')}`),
      debug: () => {},
    },
    tools,
    webServer: {
      register: (route) => {
        say(`  [memorylab] registered route ${route?.path ?? '(unnamed)'} (not served by this gate)`);
        return () => {};
      },
      tapIndex: () => () => {},
    },
    effect: (factory, label) => {
      effects.push({ label, dispose: factory() });
      return () => {};
    },
    get: () => undefined,
  };
  const memorylab = await repoImport('packages/newmark-core/components/memorylab/index.js');
  memorylab.apply(memoryHost, { root: NEWMARK_ROOT, language: 'auto', reindexOnRender: false });
  const registered = tools.schemas().map((tool) => tool.name);
  say(`memorylab:   real component apply() ran; the registry now exposes ${registered.length} tools: ${registered.join(', ')}`);

  /* ---- the real agent-api component, mounted with a real llm in its context ---- */
  const agentApiModule = await repoImport('packages/newmark-core/components/agent-api/index.js');
  /** The core row's service, in the two-accessor shape `readCoreSelection` reads. */
  const coreService = {
    root: () => NEWMARK_ROOT,
    model: () => ({
      provider: PROVIDER,
      model: MODEL,
      ...(profileSelection.reasoningEffort ? { reasoningEffort: profileSelection.reasoningEffort } : {}),
    }),
  };
  const agentApiHost = {
    logger: {
      info: (...args) => say(`  [agent-api] ${args.map(String).join(' ')}`),
      warn: (...args) => say(`  [agent-api:warn] ${args.map(String).join(' ')}`),
      error: (...args) => say(`  [agent-api:error] ${args.map(String).join(' ')}`),
      debug: () => {},
    },
    tools,
    webServer: { register: () => () => {}, tapIndex: () => () => {} },
    effect: (factory, label) => {
      effects.push({ label, dispose: factory() });
      return () => {};
    },
    /* The documented optional reads (`components/agent-api/index.js:157, 170-175`). */
    get: (name) => (name === 'llm' ? runtime : name === 'newmarkComponents' ? coreService : undefined),
  };
  const api = agentApiModule.apply(agentApiHost, {
    root: NEWMARK_ROOT,
    workspace: SCRATCH,
    timeoutMs: 180000,
    maxSteps: 8,
  });
  say(`agent-api:   real apply() returned its instance; registered: ${api.tools().map((tool) => tool.name).join(', ')}`);
  const stateProbe = api.stateEnvelope();
  say(
    `agent-api:   stateEnvelope -> model=${JSON.stringify(stateProbe.profile?.model ?? null)} catalog=${stateProbe.result?.catalog?.count ?? '-'}`,
  );

  /* ============================== the four rounds ==============================
   *
   * `AGENT_API_LIVE_ROUNDS=1,2` runs a subset. It exists for developing the gate and for a
   * person re-checking one round after a change; a FULL run is the gate, and the receipt
   * records which rounds actually ran so a subset can never be mistaken for one. */
  const wanted = String(process.env.AGENT_API_LIVE_ROUNDS ?? '1,2,3,4')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const wants = (round) => wanted.includes(String(round));
  say(`\nrounds selected: ${wanted.join(',')}${wanted.length === 4 ? ' (full gate)' : ' (SUBSET — not a full gate run)'}`);

  const r1 = wants(1) ? await round1ListModels(runtime) : { models: [], hit: null };
  /* Rounds 2 and 3 dispatch through the real `ToolRuntime` — the same call a judgement makes —
   * so every value they judge has been through DSH's output boundary. `api` is still passed for
   * the component's own counters, which only a real registry dispatch moves. */
  const r2 = wants(2) ? await round2Conversation(tools, api) : { envelope: null, prompt: '', expected: null, output: '' };
  const r3 = wants(3) ? await round3ToolCall(tools, api) : { envelope: null, toolNames: [], output: '' };
  const r4 = wants(4) ? await round4MemoryRebuild(tools) : { indexBefore: null, indexAfter: null };

  /* ================================= summary ================================= */

  say('\n=== SUMMARY ===');
  const failed = ROUNDS.filter((entry) => !entry.ok);
  const passed = ROUNDS.length - failed.length;
  for (const entry of ROUNDS) say(`  ${entry.ok ? 'PASS' : 'FAIL'}  ${entry.name}`);

  say('\n=== ROUND ARTEFACTS (the real output, not a summary) ===');
  say(`round 1 catalog:        ${r1.models.map((model) => model.id).join(', ')}`);
  say(`round 1 model entry:    ${JSON.stringify(r1.hit)}`);
  say(`round 2 prompt:         ${JSON.stringify(r2.prompt)}`);
  say(`round 2 expected:       ${r2.expected}`);
  say(`round 2 model output:   ${JSON.stringify(r2.output ?? '')}`);
  say(`round 2 usage:          ${JSON.stringify(r2.envelope?.result?.usage ?? null)}`);
  say(`round 3 fixture:        token=${r3.token} code=${r3.digits} digit-product=${r3.product}`);
  say(`round 3 offered tools:  [${(r3.toolNames ?? []).join(', ')}]`);
  say(`round 3 tool_calls:     ${r3.envelope?.result?.tool_calls ?? '-'}`);
  say(`round 3 model output:   ${JSON.stringify(r3.output ?? '')}`);
  say(`round 3 usage:          ${JSON.stringify(r3.envelope?.result?.usage ?? null)}`);
  say(`round 4 sha256 before:  ${r4.indexBefore?.sha256 ?? '-'}`);
  say(`round 4 sha256 after:   ${r4.indexAfter?.sha256 ?? '-'}`);
  say(`round 4 .bak sha256:    ${r4.bakAfter?.sha256 ?? '-'}`);
  say(`round 4 changed:        ${r4.changed === undefined ? '-' : r4.changed}`);

  const receipt = {
    gate: 'verify-agent-api-live',
    finishedAt: new Date().toISOString(),
    provider: PROVIDER,
    model: MODEL,
    profileSelection,
    passed,
    failed: failed.map((entry) => entry.name),
    rounds: ROUNDS,
    round1: { catalog: r1.models, model: r1.hit },
    round2: {
      prompt: r2.prompt,
      expected: r2.expected,
      output: r2.output,
      envelopeModel: r2.envelope?.model ?? null,
      usage: r2.envelope?.result?.usage ?? null,
    },
    round3: {
      token: r3.token,
      digits: r3.digits,
      product: r3.product,
      fixture: r3.filePath,
      output: r3.output,
      toolNames: r3.toolNames ?? [],
      toolCalls: r3.envelope?.result?.tool_calls ?? null,
      usage: r3.envelope?.result?.usage ?? null,
    },
    round4: {
      indexBefore: r4.indexBefore,
      indexAfter: r4.indexAfter,
      bakBefore: r4.bakBefore,
      bakAfter: r4.bakAfter,
      changed: r4.changed ?? null,
      beforeCounts: r4.beforeCounts ?? null,
      afterCounts: r4.afterCounts ?? null,
      result: r4.value ?? null,
      backupDir: r4.backup?.dir ?? null,
      backups: r4.backup?.taken ?? [],
      missing: r4.backup?.missing ?? [],
    },
  };
  const receiptPath = join(SCRATCH, 'receipt.json');
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), 'utf8');

  for (const entry of effects.slice().reverse()) {
    try {
      entry.dispose?.();
    } catch {
      /* a disposal failure is not a gate failure */
    }
  }

  say(`\n${passed} passed, ${failed.length} failed`);
  say(`receipt: ${receiptPath}`);
  if (failed.length > 0) {
    say(`FAILED: ${failed.map((entry) => entry.name).join(' | ')}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((error) => {
  say(`\nthe gate itself failed: ${error?.constructor?.name ?? 'Error'}: ${error?.message ?? error}`);
  say(String(error?.stack ?? '').split('\n').slice(0, 12).join('\n'));
  process.exit(2);
});
