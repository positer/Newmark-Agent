/**
 * The HOST-side tool-registry stub, in the shape DSH 0.2.2 actually uses.
 *
 * `tools.execute` is a BATCH call since 0.2.2 — `{calls: [{type:'tool-call', id, name, arguments}]}`
 * with `arguments` as JSON TEXT — and it answers `{results: [{callId, result}]}`. Every gate here
 * writes a fake registry, and until this helper existed those fakes answered the PRE-0.2.2 single-call
 * shape (`{isError, value}`), which `lib/tool-batch.js` no longer produces or reads. The measured
 * consequence: `executeOne` threw `tool batch returned no result for "agent_api_send"` before the
 * run started, so four NewMate gates (chat, initiative, short-memory/MCP, agent loop) had been RED
 * since the 0.2.2 transport change and their assertions had not run at all. A red gate is a negative
 * asset; a gate whose subject never runs is worse, because it reports a verdict about nothing.
 *
 * The two functions below are the whole adapter, so a gate body keeps speaking the single-call
 * vocabulary it was written in:
 *
 *   hostTools(async (call) => ({isError:false, value:{...}}))
 *
 * presents one `call` — `{name, arguments}` with the arguments PARSED, because that is what the
 * callbacks here reason about — and re-wraps the returned result into the batch answer the host
 * contract requires.
 */

/** The parsed first call of a batch input, in the pre-0.2.2 vocabulary gate bodies use. */
export function batchCall(input) {
  const call = Array.isArray(input?.calls) ? input.calls[0] : undefined;
  const raw = call?.arguments;
  let parsed = raw ?? {};
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch { parsed = {}; }
  }
  return { name: call?.name, id: call?.id, arguments: parsed ?? {}, signal: input?.signal, agent: input?.agent };
}

/** One result for every call in the batch, which is what `executeOne` reads back. */
export function batchReply(input, result) {
  const calls = Array.isArray(input?.calls) ? input.calls : [];
  return { results: calls.map((call) => ({ callId: call?.id, result })), additionalContexts: [], concluded: false };
}

/**
 * A fake registry whose handler is written in the single-call vocabulary.
 *
 * `register` is part of the fake because NewMate registers `newmate_ask` for the duration of one
 * interactive run (0.3.80 moved it out of the global catalog), so a stub without it fails every chat
 * turn before the dispatch. The registrations are kept in `definitions` so a gate can assert what a
 * run's disposer removed; the returned disposer is what the component calls in its `finally`.
 */
export function hostTools(handler) {
  const definitions = [];
  return {
    execute: async (input) => batchReply(input, await handler(batchCall(input))),
    ...(typeof handler.schemas === 'function' ? { schemas: handler.schemas } : {}),
    definitions,
    register(definition) {
      definitions.push(definition);
      return () => { const at = definitions.indexOf(definition); if (at >= 0) definitions.splice(at, 1); };
    },
  };
}
