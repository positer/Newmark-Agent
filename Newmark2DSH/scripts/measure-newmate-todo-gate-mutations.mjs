// Mutation gate for the due-item delivery rule (2026-10-29).
//
// The rule the user asked for, in their words: a todo that activates a NewMate conversation
// "应该和 dsh 本体的会话没有任何关系，只需要投递给 newMate 并激活 newMate 的对话即可". So BOTH due
// modes wait for exactly two things - the companion switch and NewMate being idle - and nothing
// else: not a DSH session, not quiet hours, not the desktop, not the keyboard, not reading, not a
// draft. Each mutation below puts one of those back (or removes one of the two that remain) and
// must turn the verifier red.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const target = path.join(repo, 'packages/newmark-core/components/newmate/component.js');
const verifiers = ['verify-newmate-todo.mjs', 'verify-newmate-todo-activation.mjs'].map((name) => path.join(here, name));
const original = fs.readFileSync(target);

const run = () => {
  try {
    // BOTH verifiers: the due-item gate and the activation end-to-end behaviour are one contract.
    let out = '';
    for (const script of verifiers) {
      try {
        out += execFileSync(process.execPath, [script], { cwd: repo, encoding: 'utf8', stdio: 'pipe' });
      } catch (error) {
        return { ok: false, out: String(error.stdout || '') + String(error.stderr || '') };
      }
    }
    return { ok: true, out };
  } catch (error) {
    return { ok: false, out: String(error.stdout || '') + String(error.stderr || '') };
  }
};

const GATE = "  function deliveryBlocker(){\n    if(store.read().settings.companion!==true)return 'companion_off';\n    return newmateBusyReason();\n  }";
const QUEUE = "return store.read().tasks.some(t=>t.kind==='chat'&&['pending','running'].includes(t.status))?'newmate_busy':null;";

const mutations = [
  {
    name: 'the gate consults the DSH host again (the bug this change removes)',
    find: 'return newmateBusyReason();',
    replace: "const env=environment();if(env.busy)return 'host_busy';return newmateBusyReason();",
  },
  {
    name: 'the gate starts honouring quiet hours again',
    find: 'return newmateBusyReason();',
    replace: "if(isQuiet(store.read().settings,now()))return 'quiet_hours';return newmateBusyReason();",
  },
  {
    name: 'the gate starts honouring the desktop and the keyboard again',
    find: 'return newmateBusyReason();',
    replace: "const env=environment();if(env.ready===false)return 'desktop_unavailable';if(!(env.idleMs>=MINUTE))return 'input';return newmateBusyReason();",
  },
  {
    name: 'the activation branch re-checks the reading ladder (the old asymmetry)',
    find: "    if(item.mode==='conversation'){\n      const claimedTodo=",
    replace: "    if(item.mode==='conversation'){\n      if(environment().readerFocused||readingUntil>now()){defer(item,'reading');return;}\n      const claimedTodo=",
  },
  {
    name: 'NewMate own queue is no longer consulted',
    find: QUEUE,
    replace: 'return null;',
  },
  {
    name: 'the companion switch is no longer consulted',
    find: "if(store.read().settings.companion!==true)return 'companion_off';",
    replace: '',
  },
  {
    name: 'a pause on a DSH conversation starves the queue again (the 2026-10-29 audit counterexample)',
    find: "        continue;\n      }\n      task = candidate;",
    replace: "        return;\n      }\n      task = candidate;",
  },
  {
    name: 'the answer to a scheduled activation is format-gated again',
    find: "unsolicited=task.kind!=='chat'&&!report&&!delegated;",
    replace: "unsolicited=task.kind!=='chat'&&!report;",
  },
  {
    name: 'a refusal before anything was attempted burns the scheduled item again',
    find: '        if(nothingAttempted){',
    replace: '        if(false){',
  },
  {
    name: 'a full task queue returns silently again',
    find: "{defer(candidate,'queue_full');continue;}",
    replace: "{return;}",
  },
  {
    name: 'the deferral reason is never written',
    find: "if(t&&t.status==='pending')t.deferred={code,at:now(),reason:DEFERRAL[code]||code};",
    replace: "if(t&&t.status==='pending')void code;",
  },
];

let failed = 0;
const baseline = run();
if (!baseline.ok) {
  console.log('baseline verifier is already red; aborting');
  console.log(baseline.out.slice(-2000));
  process.exit(1);
}
console.log('baseline: ' + (baseline.out.match(/PASS \d+/) || ['PASS'])[0]);

for (const m of mutations) {
  const text = original.toString('utf8');
  if (!text.includes(m.find)) {
    console.log('SKIP (anchor not found) - ' + m.name);
    failed += 1;
    continue;
  }
  fs.writeFileSync(target, text.replace(m.find, m.replace), 'utf8');
  const result = run();
  fs.writeFileSync(target, original);
  if (result.ok) {
    console.log('MISS (verifier stayed green) - ' + m.name);
    failed += 1;
  } else {
    const first = result.out.split('\n').find((l) => l.includes('ok ') === false && l.trim().startsWith('AssertionError')) || 'assertion failed';
    console.log('ok - red as expected - ' + m.name + '  [' + first.replace(/AssertionError \[ERR_ASSERTION\]: /, '') + ']');
  }
}

if (fs.readFileSync(target).compare(original) !== 0) {
  console.log('RESTORE FAILED: component.js does not match the original bytes');
  process.exit(1);
}
console.log(failed === 0 ? 'PASS ' + mutations.length + ' mutations, every one red, source restored byte-for-byte' : 'FAIL ' + failed + ' mutation(s) did not turn the verifier red');
process.exit(failed === 0 ? 0 : 1);
