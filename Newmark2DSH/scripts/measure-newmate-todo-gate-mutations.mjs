// Mutation gate for the reminder delivery rule (2026-10-28).
//
// The rule the user asked for: a REMINDER waits only for (1) the companion switch and (2) NewMate
// being idle. Every other condition - a DSH session running elsewhere, the desktop, the keyboard,
// reading, drafts, quiet hours, snooze - must not hold the message. An ACTIVATION keeps the full
// attention gate. Each mutation below breaks exactly one half of that and must turn the verifier red.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const target = path.join(repo, 'packages/newmark-core/components/newmate/component.js');
const verifier = path.join(here, 'verify-newmate-todo.mjs');
const original = fs.readFileSync(target);

const run = () => {
  try {
    const out = execFileSync(process.execPath, [verifier], { cwd: repo, encoding: 'utf8', stdio: 'pipe' });
    return { ok: true, out };
  } catch (error) {
    return { ok: false, out: String(error.stdout || '') + String(error.stderr || '') };
  }
};

const mutations = [
  {
    name: 'the reminder gate consults the host again (the bug this change removes)',
    find: 'function reminderReady(){return store.read().settings.companion===true&&newmateIdle();}',
    replace: 'function reminderReady(){const env=environment();return store.read().settings.companion===true&&newmateIdle()&&!env.busy;}',
  },
  {
    name: 'the reminder gate starts honouring quiet hours',
    find: 'function reminderReady(){return store.read().settings.companion===true&&newmateIdle();}',
    replace: 'function reminderReady(){const s=store.read();return s.settings.companion===true&&newmateIdle()&&!isQuiet(s.settings,now());}',
  },
  {
    name: 'the reminder gate starts honouring the desktop and the keyboard',
    find: 'function reminderReady(){return store.read().settings.companion===true&&newmateIdle();}',
    replace: 'function reminderReady(){const env=environment();return store.read().settings.companion===true&&newmateIdle()&&env.ready!==false&&env.idleMs>=MINUTE;}',
  },
  {
    name: 'NewMate own queue is no longer consulted',
    find: "return store.read().tasks.some(t=>t.kind==='chat'&&['pending','running'].includes(t.status))?'newmate_busy':null;",
    replace: "return null;",
  },
  {
    name: 'the companion switch is no longer consulted for reminders',
    find: 'function reminderReady(){return store.read().settings.companion===true&&newmateIdle();}',
    replace: 'function reminderReady(){return newmateIdle();}',
  },
  {
    name: 'the activation gate loses its host check',
    find: 'if(env.busy)return \'host_busy\';',
    replace: '',
  },
  {
    name: 'the deferral reason is never written',
    find: 'if(t&&t.status===\'pending\')t.deferred={code,at:now(),reason:DEFERRAL[code]||code};',
    replace: 'if(t&&t.status===\'pending\')void code;',
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
    const line = (result.out.match(/AssertionError[^\n]*\n[^\n]*\n\s*\^?\s*\n?\s*at [^\n]*verify-newmate-todo\.mjs:\d+/) || [])[0] || '';
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
