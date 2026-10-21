#!/usr/bin/env node
/**
 * verify-computeruse-hidden-route.mjs - the structural gate for the hidden-desktop ROUTE.
 *
 * =====================================================================================
 * WHY THIS GATE EXISTS
 * =====================================================================================
 *
 * The route that sends `computer_use` app actions to the resident hidden-desktop agent is one
 * branch in `lib/win32.js` plus the code that arms and ends it. Its behaviour needs a desktop,
 * a process and a person's machine to measure - `scripts/measure-cu-hidden-route.mjs` does
 * that - and a gate that needs all three cannot run unattended. What CAN run unattended, and
 * what the behavioural measurement cannot see, is whether the SHAPE still holds:
 *
 *   - no lane-side cross-desktop reach has crept back in. Three phases failed to build one, and
 *     the whole point of moving the caller ONTO the desktop is that the lane never needs it. A
 *     single `OpenDesktopW` in this file would be that road starting again.
 *   - no cleanup that names a process CLASS. Two cleanup mistakes were made on this path: one
 *     killed the user's own browser processes, one left an application behind. Both were a
 *     filter by name; every process this component owns is tracked by a pid its own create call
 *     returned.
 *   - the routing is one decision in one place, taken before any interactive-desktop branch.
 *   - the transport is the proven relay and not a second implementation of the pipe protocol.
 *   - the arm is declarable by a caller: the tool still publishes `desktop` and `launch` and the
 *     guide still tells a model the route exists.
 *   - the receipts of the route still promise no physical delivery and no real fallback.
 *
 * =====================================================================================
 * EVERY RULE IS MEASURED BY A PLANT THAT MUST TURN IT RED
 * =====================================================================================
 *
 * A rule that cannot fail is not a rule. Each assertion below has at least one mutation row
 * that plants a violation IN MEMORY - the repository is never written to - and the row passes
 * only when the named rule reports it. The comment-stripping is covered the same way: a plant
 * inside a comment must NOT fire (or the rule would go red on the sentence documenting it) and
 * the same plant in code must.
 *
 * Exit codes: 0 every rule held and every plant was caught; 1 a rule or a plant failed;
 *             2 the gate could not be armed (a file or an anchor is missing).
 *
 * Invoke: node Newmark2DSH/scripts/verify-computeruse-hidden-route.mjs
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const COMPONENT = path.join(REPO, 'packages', 'newmark-core', 'components', 'computeruse');
const WIN32 = path.join(COMPONENT, 'lib', 'win32.js');
const AGENT = path.join(COMPONENT, 'lib', 'hidden-agent.js');
const COMPONENT_JS = path.join(COMPONENT, 'component.js');
/** The released bytes of the lane file, recorded so a receipt says which baseline it read. */
const RELEASED_SHA256 = 'c780a63c59fbee7ac828b1ee49b91089247a88d3ea54290c1a77ccc6c229c4f6';

const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.join(REPO, 'evidence', 'computeruse-hidden-route', STAMP);
fs.mkdirSync(OUT, { recursive: true });

let passed = 0;
let failed = 0;
const RESULTS = [];
const say = (line = '') => process.stdout.write(`${String(line)}\n`);
function record(name, ok, detail) {
  RESULTS.push({ name, ok: ok === true, detail: String(detail) });
  if (ok === true) passed += 1; else failed += 1;
  say(`  [${ok === true ? 'PASS' : 'FAIL'}] ${name}${detail ? ` :: ${String(detail).slice(0, 400)}` : ''}`);
}
function refuse(reason) {
  say(`\nGATE COULD NOT BE ARMED: ${reason}`);
  process.exit(2);
}

/* ------------------------------------------------------------------ the comment stripper --- */

/**
 * Blank out JS comments, and mark which characters are code.
 *
 * Comments have to go before a rule about API names can run, because this file's own prose
 * names the API it must not call. A NAIVE stripper is worse than none: `lib/win32.js` is full
 * of template literals carrying PowerShell, and a `//` inside one of them would make a
 * line-comment stripper delete real code - the dangerous direction, because the rule would then
 * pass by having nothing left to inspect. So this tracks strings, template literals (with
 * `${}` nesting) and regex literals, and the gate asserts afterwards that the stripped text
 * still contains anchors from the start, the middle and the end of the file.
 */
function scanJs(source) {
  const text = String(source);
  const length = text.length;
  const blanked = text.split('');
  const isCode = new Uint8Array(length).fill(1);
  const blank = (from, to) => {
    for (let i = from; i < to && i < length; i += 1) {
      if (text.charCodeAt(i) !== 10) blanked[i] = ' ';
      isCode[i] = 0;
    }
  };
  const opaque = (from, to) => {
    for (let i = from; i < to && i < length; i += 1) isCode[i] = 0;
  };
  let index = 0;
  let previous = '';
  while (index < length) {
    const here = text[index];
    const next = index + 1 < length ? text[index + 1] : '';
    if (here === '/' && next === '/') {
      let end = index;
      while (end < length && text.charCodeAt(end) !== 10) end += 1;
      blank(index, end);
      index = end;
      continue;
    }
    if (here === '/' && next === '*') {
      let end = index + 2;
      while (end < length && !(text[end] === '*' && text[end + 1] === '/')) end += 1;
      end = Math.min(length, end + 2);
      blank(index, end);
      index = end;
      continue;
    }
    if (here === "'" || here === '"') {
      let end = index + 1;
      while (end < length) {
        const character = text[end];
        if (character === '\\') { end += 2; continue; }
        if (character === here || character === '\n') { end += 1; break; }
        end += 1;
      }
      opaque(index, end);
      index = end;
      previous = here;
      continue;
    }
    if (here === '`') {
      let end = index + 1;
      let depth = 0;
      while (end < length) {
        const character = text[end];
        if (character === '\\') { end += 2; continue; }
        if (character === '$' && text[end + 1] === '{') { depth += 1; end += 2; continue; }
        if (character === '}' && depth > 0) { depth -= 1; end += 1; continue; }
        if (character === '`' && depth === 0) { end += 1; break; }
        end += 1;
      }
      opaque(index, end);
      index = end;
      previous = '`';
      continue;
    }
    /* A regex literal, recognised conservatively: only where a value may start. Without this a
     * `//` inside a regex would open a line comment and delete the rest of the line. */
    if (here === '/' && /[=(,:[!&|?{};+\-*%^~<>]/.test(previous)) {
      let end = index + 1;
      let inClass = false;
      while (end < length && text[end] !== '\n') {
        const character = text[end];
        if (character === '\\') { end += 2; continue; }
        if (character === '[') inClass = true;
        else if (character === ']') inClass = false;
        else if (character === '/' && !inClass) { end += 1; break; }
        end += 1;
      }
      opaque(index, end);
      index = end;
      previous = '/';
      continue;
    }
    if (!/\s/.test(here)) previous = here;
    index += 1;
  }
  return { blanked: blanked.join(''), isCode };
}

/**
 * The body of a named function, by brace matching over CODE characters only.
 *
 * The anchor must run up to and include the body's opening brace: the brace it ends on is where
 * the depth count starts, and an anchor that stopped at the signature would have this scanning
 * for the first NESTED block instead and answering with that block's body. Measured: the first
 * version did exactly that and reported three rules as violated in a file that satisfies them.
 */
function functionBody(blanked, isCode, anchor) {
  const start = blanked.indexOf(anchor);
  if (start < 0) return null;
  let index = start + anchor.length - 1;
  if (blanked[index] !== '{') {
    index = start + anchor.length;
    while (index < blanked.length && !(blanked[index] === '{' && isCode[index] === 1)) index += 1;
  }
  let depth = 0;
  const from = index;
  while (index < blanked.length) {
    if (isCode[index] === 1) {
      if (blanked[index] === '{') depth += 1;
      else if (blanked[index] === '}') {
        depth -= 1;
        if (depth === 0) return blanked.slice(from, index + 1);
      }
    }
    index += 1;
  }
  return null;
}

const occurrences = (haystack, needle) => (needle instanceof RegExp ? (String(haystack).match(needle) || []).length : String(haystack).split(needle).length - 1);

/* ------------------------------------------------------------------------------- the rules --- */

const REACH_APIS = ['OpenDesktopW', 'CreateDesktopW', 'OpenInputDesktop', 'SetThreadDesktop', 'EnumDesktopWindows', 'SwitchDesktop'];
/**
 * `AttachThreadInput` is deliberately NOT in the file-wide list.
 *
 * The shipped native helper declares it and uses it for focus and activation WITHIN this
 * desktop (`lib/win32.js:766,1082,1256`), which is pre-existing behaviour this change does not
 * touch. What would be the road back is cross-desktop input attachment from the ROUTING code,
 * so that one name is checked inside the routing section and nowhere else.
 */
const ROUTING_SECTION_REACH_APIS = ['AttachThreadInput', 'OpenDesktopW', 'SetThreadDesktop', 'OpenInputDesktop'];
const ROUTING_SECTION_FROM = 'const hiddenRoutes = new Map();';
const ROUTING_SECTION_TO = 'function stopHiddenAgentsSync(';
const NAMED_PROCESS_CLEANUP = ['Stop-Process', 'taskkill', 'pkill', 'Get-Process -Name', '-Name msedge', 'Get-Process msedge'];

/**
 * Every rule is a pure function of the three sources, so a plant can be run through exactly the
 * same code the shipped files are run through.
 */
/**
 * The routing decision: one branch, before every interactive branch.
 *
 * ---------------------------------------------------------------------------------------
 * WHAT THIS GATE DID NOT CATCH, AND WHY IT NOW CAN
 * ---------------------------------------------------------------------------------------
 *
 * A live test of the shipped 0.2.11 reported these 31 assertions GREEN while the running
 * application was wrong in two ways, and both of them were gaps in what this file READ rather
 * than in what it asserted:
 *
 *   1. `app_list` in the live application answered `ok: true, scope: "virtual-includes-occluded"`
 *      with 94 windows of the INTERACTIVE desktop while a hidden desktop was armed, and the
 *      agent's `requests_served` never moved. This file asserted that the routing branch EXISTS
 *      and sits before the interactive branches - which was true, and which says nothing about
 *      whether the branch is TAKEN. It was not: `hiddenRouteActive` looked the route up under
 *      the owner id the call declared, and the live call declared a different one (or none),
 *      because `owner_id` is optional and the guide mentions it only for `takeover_stop`. The
 *      branch was correct and unreachable. Rule 12 below is about reachability, and it reads
 *      the resolution itself rather than the branch's position.
 *   2. The teardown reported `all_processes_gone: true` with `pids_checked: [agent, agent]` -
 *      the agent's pid twice - while the application the session had launched was still
 *      running. Rule 8 asserted that `closeHiddenDesktop` CARRIES the four names
 *      `hiddenWaitForExit(`, `hiddenDesktopProbe(`, `desktop_gone:` and `all_processes_gone:`,
 *      and it did. It could not see that the pid LIST those names are computed over was built
 *      from the job's member list alone - a list that by construction cannot contain a process
 *      the job does not hold, which is exactly what the launched application was. Rules 13 and
 *      14 are about the list and the per-pid answer.
 *
 * The lesson is written into the rules rather than into this comment: a structural rule about
 * the EXISTENCE of a guard is not a rule about the guard, and a rule about a boolean is not a
 * rule about the list the boolean is computed from.
 */
function rules({ win32, agent, component }) {
  const scanned = scanJs(win32);
  const stripped = scanned.blanked;
  const { isCode } = scanned;
  const agentStripped = scanJs(agent).blanked;
  /* The anchors below include each signature UP TO its body brace on purpose: a default
   * parameter such as `extra = {}` would otherwise be mistaken for the body. */
  const hiddenHeaderBody = functionBody(stripped, isCode, 'function hiddenHeader(route, header, extra = {}) {');
  const armedBody = functionBody(stripped, isCode, 'async function closeHiddenDesktop(route = null, options = {}) {');
  const routingBody = functionBody(stripped, isCode, 'async function hiddenDesktopAction(action, options, mode, header, route) {');
  /* The routing DECISION, which is where rule 12 lives. */
  const decisionBody = functionBody(stripped, isCode, 'function hiddenRouteActive(options) {');
  const reportBody = functionBody(stripped, isCode, 'function hiddenRouteReport(route) {');
  const routingFrom = stripped.indexOf(ROUTING_SECTION_FROM);
  const routingTo = stripped.indexOf(ROUTING_SECTION_TO);
  const routingSection = routingFrom >= 0 && routingTo > routingFrom ? stripped.slice(routingFrom, routingTo) : '';
  const findings = [];
  const fail = (id, detail) => findings.push({ id, detail });

  /* 1. no cross-desktop reach, anywhere in the file or in the routing section. */
  const reach = REACH_APIS.filter((api) => stripped.includes(api));
  if (reach.length) fail('no_cross_desktop_reach', `the lane names ${reach.join(', ')}`);
  if (!routingSection) fail('no_cross_desktop_reach', 'the routing section could not be delimited, so it was not checked');
  else {
    const sectionReach = ROUTING_SECTION_REACH_APIS.filter((api) => routingSection.includes(api));
    if (sectionReach.length) fail('no_cross_desktop_reach', `the routing section names ${sectionReach.join(', ')}`);
  }

  /* 2. no cleanup that names a process class, and every liveness read is pid-exact. */
  const named = NAMED_PROCESS_CLEANUP.filter((token) => stripped.includes(token));
  if (named.length) fail('no_process_class_cleanup', `the lane names ${named.join(', ')}`);
  const getProcess = occurrences(stripped, 'Get-Process');
  const getProcessById = occurrences(stripped, 'Get-Process -Id');
  if (getProcess !== getProcessById) fail('no_process_class_cleanup', `${getProcess} Get-Process call(s), only ${getProcessById} of them address a pid`);

  /* 3. the agent module is loaded on first use, not at load time. */
  if (/import\s[^;]*from\s*'\.\/hidden-agent\.js'/.test(stripped)) fail('hidden_agent_loaded_on_first_use', "a static import of './hidden-agent.js' is present");

  /* 4. the routing decision: one branch, before every interactive branch. */
  const routeAnchor = 'const hiddenRoute = hiddenRouteActive(options);';
  const routeHits = occurrences(stripped, routeAnchor);
  if (routeHits !== 1) fail('routing_is_one_branch_before_the_rest', `${routeHits} occurrence(s) of the routing anchor`);
  const interactiveAnchors = [
    "if (action === 'observe') return await observeAction(",
    "if (action === 'app_list') return await appListAction(",
    "if (action === 'app_observe') return await appObserveAction(",
    "if (action === 'app_activate') return await appActivateAction(",
    "return await appPhysicalAction(action, options, mode, header);",
  ];
  if (routeHits === 1) {
    const at = stripped.indexOf(routeAnchor);
    const after = interactiveAnchors.filter((anchor) => {
      const where = stripped.indexOf(anchor);
      return where < 0 || where < at;
    });
    if (after.length) fail('routing_is_one_branch_before_the_rest', `the routing anchor does not precede: ${after.join(' , ')}`);
  }
  if (occurrences(stripped, 'if (hiddenRoute) {') !== 1) fail('routing_is_one_branch_before_the_rest', 'the routing guard is not a single branch');

  /* 5. the routed action set, exactly. */
  const routed = ['app_list', 'app_observe', 'app_activate', 'app_click', 'app_type', 'app_scroll', 'app_key'];
  if (!routingBody) fail('routed_action_set_is_exactly_the_app_actions', 'the routing switch could not be read');
  else {
    const missing = routed.filter((action) => !routingBody.includes(`'${action}'`));
    if (missing.length) fail('routed_action_set_is_exactly_the_app_actions', `the routing switch does not name ${missing.join(', ')}`);
    const compared = [...routingBody.matchAll(/action === '([a-z_]+)'/g)].map((match) => match[1]);
    const unexpected = compared.filter((action) => !routed.includes(action) && action !== 'app_drag');
    if (unexpected.length) fail('routed_action_set_is_exactly_the_app_actions', `the routing switch compares against ${unexpected.join(', ')}`);
  }

  /* 6. the arm is one place, and it hangs off takeover_start. */
  const desktopReads = occurrences(stripped, /\boptions\.desktop\b/g);
  const startBody = functionBody(stripped, isCode, 'function takeoverStart(options) {');
  const readsInStart = startBody ? occurrences(startBody, /\boptions\.desktop\b/g) : 0;
  if (desktopReads === 0 || readsInStart !== desktopReads) {
    fail('the_arm_is_one_place', `${desktopReads} read(s) of options.desktop in the file, ${readsInStart} of them inside takeoverStart`);
  }
  if (occurrences(stripped, 'await armHiddenDesktop(') !== 1) fail('the_arm_is_one_place', `${occurrences(stripped, 'await armHiddenDesktop(')} call(s) to armHiddenDesktop`);

  /* 7. the route receipts promise no physical delivery and no real fallback. */
  if (!hiddenHeaderBody) fail('route_receipts_promise_no_real_delivery', 'hiddenHeader could not be read');
  else {
    const promised = ['physical_delivery_used: false', 'system_cursor_moved: false', 'fallback_to_real_delivery: false'];
    const absent = promised.filter((line) => !hiddenHeaderBody.includes(line));
    if (absent.length) fail('route_receipts_promise_no_real_delivery', `hiddenHeader does not state ${absent.join(', ')}`);
  }
  if (!stripped.includes('function hiddenPosted(') || !stripped.includes('values.every((value) => value === true)')) {
    fail('route_receipts_promise_no_real_delivery', '`queued` is not derived from the post results the agent reported');
  }

  /* 8. the teardown measures, rather than assuming. */
  if (!armedBody) fail('teardown_is_measured', 'closeHiddenDesktop could not be read');
  else {
    for (const required of ['hiddenWaitForExit(', 'hiddenDesktopProbe(', 'desktop_gone:', 'all_processes_gone:']) {
      if (!armedBody.includes(required)) fail('teardown_is_measured', `closeHiddenDesktop does not carry ${required}`);
    }
    if (!armedBody.includes('process.kill(Number(route.agentPid))')) fail('teardown_is_measured', 'the fallback termination does not use the pid the agent reported');
  }
  if (!stripped.includes('const hidden = route ? await closeHiddenDesktop(route, options) : null;')) {
    fail('teardown_is_measured', 'takeover_stop does not end the route');
  }

  /* 9. the transport is the proven relay, not a second pipe implementation. */
  if (stripped.includes('NamedPipeClientStream')) fail('transport_is_the_proven_relay', 'the lane builds its own pipe client');
  if (!stripped.includes('relayThroughLane(')) fail('transport_is_the_proven_relay', 'the lane does not relay through the proven transport');
  const pipeClients = occurrences(agentStripped, 'NamedPipeClientStream');
  if (pipeClients !== 1) fail('transport_is_the_proven_relay', `${pipeClients} pipe client implementation(s) in hidden-agent.js, over comment-stripped text`);

  /* 10. a caller can declare the arm. */
  if (!/desktop:\s*\{\s*type:\s*'string'[^}]*enum:\s*\['hidden'\]/.test(component)) fail('the_arm_is_declarable', 'the tool does not declare `desktop` with the one value it accepts');
  if (!/launch:\s*\{\s*type:\s*'string'/.test(component)) fail('the_arm_is_declarable', 'the tool does not declare `launch`');
  if (!component.includes("desktop: \"hidden\"")) fail('the_arm_is_declarable', 'the operating guide never tells a model how to arm the route');

  /* 11. the stripper did not run away: anchors from the start, middle and end survive.
   *
   * The failure this guards is a stripper that deletes real code, after which every other rule
   * here would pass by having nothing to read. It is measurable in one direction only: a plant
   * that removes an anchor turns it red (the row below), while an unterminated comment cannot be
   * planted as a runaway on this file, because the file's own comment terminators close it. A
   * runaway and a missing anchor are indistinguishable to this rule, and that is the point: the
   * rule exists to notice that the text under inspection is no longer the text it was written
   * for. The limitation is stated rather than hidden. */
  for (const anchor of ['const LEASE_EXPIRY', 'function resolveApplication(', 'result_truncated: true']) {
    if (!stripped.includes(anchor)) fail('stripper_kept_the_code', `the stripped text lost ${JSON.stringify(anchor)}`);
  }
  if (stripped.length < win32.length * 0.5) fail('stripper_kept_the_code', `stripping removed ${(100 - Math.round((stripped.length / win32.length) * 100))}% of the file`);

  /* 12. THE BRANCH IS REACHED WITHOUT THE CALLER REPEATING AN OWNER ID.
   *
   * The live defect: the routing branch existed, sat before every interactive branch, and was
   * not taken, because the route was looked up under the owner id THIS CALL declared. A rule
   * that only asserts the branch's existence cannot see that, so this rule reads the decision's
   * own body: it must consult the LEASE HOLDER (`active.owner_id`) and must fall back to that
   * holder's route, and the receipt must state which owner was declared and which one served
   * the call. Removing the fallback, or removing the reporting, must turn this red. */
  if (!decisionBody) fail('route_survives_an_omitted_owner', 'hiddenRouteActive could not be read');
  else {
    if (!decisionBody.includes('active.owner_id')) fail('route_survives_an_omitted_owner', 'the routing decision never consults the lease holder');
    if (!/hiddenRouteFor\(active\.owner_id\)/.test(decisionBody)) fail('route_survives_an_omitted_owner', 'the routing decision has no fallback to the lease holder\'s route, so a call that does not repeat the owner id falls through to the interactive branch');
    if (!decisionBody.includes('resolvedFor')) fail('route_survives_an_omitted_owner', 'the routing decision does not record which owner was declared and which one served the call');
    if (!decisionBody.includes('skipLease')) fail('route_survives_an_omitted_owner', 'the routing decision does not exempt a caller that must not be moved by the lease (screen_capture)');
  }
  if (!hiddenHeaderBody) fail('route_survives_an_omitted_owner', 'hiddenHeader could not be read');
  else {
    for (const field of ['owner_id_declared:', 'owner_id_routed:', 'owner_resolved_from_lease:']) {
      if (!hiddenHeaderBody.includes(field)) fail('route_survives_an_omitted_owner', `a routed receipt does not carry ${field}`);
    }
  }

  /* 13. THE TEARDOWN ASKS ABOUT EVERY PID THE SESSION IS RESPONSIBLE FOR.
   *
   * The live defect: `pids_checked` was `[agent, agent]` while the launched application was
   * still running, because the list came from the job's member list alone and the application
   * was not in the job. The four sources below are the whole question; dropping any one of them
   * must turn this red. */
  if (!armedBody) fail('teardown_checks_every_pid_the_session_owns', 'closeHiddenDesktop could not be read');
  else {
    const required = [
      ['route.agentPid', 'the agent'],
      ['job-member', 'the job\'s own member list'],
      ['launched-this-session', 'every pid a launch of this session returned'],
      ['unheld-desktop-window', 'every pid the agent reported as on its desktop but not in the job'],
    ];
    const missing = required.filter(([token]) => !armedBody.includes(token)).map(([, what]) => what);
    if (missing.length) fail('teardown_checks_every_pid_the_session_owns', `the pid set is not built from ${missing.join(', ')}`);
    if (!/unheld_window_pids/.test(armedBody)) fail('teardown_checks_every_pid_the_session_owns', 'the teardown does not read the agent\'s unheld-window pids');
  }

  /* 14. THE ANSWER IS PER PID, AND THE BOOLEAN IS READ OFF THE ANSWERS.
   *
   * `all_processes_gone: true` beside `desktop.still_openable: true` is a contradiction a
   * reader had to notice for themselves. The record per pid, the count, and the derivation of
   * the boolean are all required, and each is planted below. */
  if (!armedBody) fail('teardown_answers_per_pid', 'closeHiddenDesktop could not be read');
  else {
    if (!armedBody.includes('pids_checked: pidChecks')) fail('teardown_answers_per_pid', 'pids_checked is not the per-pid record list');
    if (!armedBody.includes('pids_checked_count:')) fail('teardown_answers_per_pid', 'the receipt does not say how many pids were asked about');
    if (!armedBody.includes('sources: record.sources')) fail('teardown_answers_per_pid', 'a pid record does not carry why that pid is on the list');
    if (!/check\.running === true/.test(armedBody)) fail('teardown_answers_per_pid', 'nothing derives the survivor list from the per-pid answers');
    if (!armedBody.includes('all_processes_gone: allGone')) fail('teardown_answers_per_pid', 'all_processes_gone is not the derived answer');
    if (!/const allGone = .*alive\.length === 0.*unreadable\.length === 0/.test(armedBody)) fail('teardown_answers_per_pid', 'all_processes_gone is not false when a pid is alive or unreadable');
    if (!armedBody.includes('unaccounted_holder:') || !armedBody.includes('nothing_holds_the_desktop:')) fail('teardown_answers_per_pid', 'the receipt does not relate the pid answers to the desktop probe');
  }

  /* 15. THE LAUNCH MEASURES MEMBERSHIP INSTEAD OF ASSUMING INHERITANCE.
   *
   * The live defect: the arm reported `job_in_job: true` and the child it launched came back
   * outside the job, and the read that said so could not tell "not a member" from "the handle
   * would not open". The agent must read membership as a three-valued answer, must try to put
   * the child in the job, and must report what happened either way. */
  if (!agentStripped.includes('public static int PidMembership(')) fail('launch_membership_is_measured', 'the agent job primitive has no three-valued membership read');
  if (!agentStripped.includes('public static bool AssignPid(')) fail('launch_membership_is_measured', 'the agent job primitive cannot assign a pid after it was created');
  if (!agentStripped.includes('PidMembership($script:nmJob')) fail('launch_membership_is_measured', 'the launch op does not read membership');
  if (!agentStripped.includes('AssignPid($script:nmJob')) fail('launch_membership_is_measured', 'the launch op does not try to hold a child that inheritance missed');
  for (const field of ['held = [bool]$held', 'ownership = $ownership', 'member_listed = [bool]$memberListed', 'membership_before = [int]$membershipBefore']) {
    if (!agentStripped.includes(field)) fail('launch_membership_is_measured', `the launch answer does not carry ${field}`);
  }
  /* 15b. AND IT ONLY ADOPTS WHAT IT CREATED.
   *
   * A launch that hands its work to the shell's activation host can answer with a pid that was
   * already running. Adopting that would claim - and later kill - a process this route never made,
   * so the launch records when it began and refuses to hold a process that predates it. The
   * boundary and the two facts it produces are required; removing either turns this red. */
  if (!agentStripped.includes('$launchMarkTicks = [long][DateTime]::UtcNow.ToFileTimeUtc()')) {
    fail('launch_membership_is_measured', 'the launch does not record when it began, so a pid that answered cannot be told from a process it created');
  }
  if (!agentStripped.includes('if ([long]$startTicks -lt ([long]$launchMarkTicks - 50000000)) { $ours = $false }')) {
    fail('launch_membership_is_measured', 'the launch has no ownership boundary: it will adopt any pid that answers');
  }
  if (!agentStripped.includes('$maybe -and $ours')) fail('launch_membership_is_measured', 'the assignment does not respect the ownership boundary');
  for (const field of ['created_by_this_launch = [bool]$ours', 'started_before_this_launch = [bool](-not $ours)']) {
    if (!agentStripped.includes(field)) fail('launch_membership_is_measured', `the launch answer does not carry ${field}`);
  }
  if (!stripped.includes('started_before_this_launch: launched.started_before_this_launch === true')) {
    fail('launch_membership_is_measured', 'the arm does not carry the ownership boundary into the launch record');
  }

  /* 16. A LAUNCH THE JOB DOES NOT HOLD IS A REPORTED FACT, NOT AN ABSENCE. */
  if (!reportBody) fail('an_unheld_launch_is_reported', 'hiddenRouteReport could not be read');
  else {
    for (const field of ['unowned_launches:', 'unheld_desktop_pids:', 'ownership:']) {
      if (!reportBody.includes(field)) fail('an_unheld_launch_is_reported', `the arm route report does not carry ${field}`);
    }
  }
  if (!stripped.includes('route.unownedLaunches = route.unownedLaunches || []')) fail('an_unheld_launch_is_reported', 'the route has nowhere to record a launch that could not be held');
  if (!stripped.includes('route.unownedLaunches.push(')) fail('an_unheld_launch_is_reported', 'a launch that could not be held is not recorded on the route');
  if (!/reason: launched\.started_before_this_launch === true/.test(stripped)) fail('an_unheld_launch_is_reported', 'an unheld launch is recorded without the reason it was not held');
  if (!stripped.includes("held: started.value.held === true")) fail('an_unheld_launch_is_reported', 'the launch record does not carry whether the job holds it');

  return findings;
}

/* ------------------------------------------------------------------------------------ run --- */

const RULE_IDS = [
  'no_cross_desktop_reach', 'no_process_class_cleanup', 'hidden_agent_loaded_on_first_use',
  'routing_is_one_branch_before_the_rest', 'routed_action_set_is_exactly_the_app_actions',
  'the_arm_is_one_place', 'route_receipts_promise_no_real_delivery', 'teardown_is_measured',
  'transport_is_the_proven_relay', 'the_arm_is_declarable', 'stripper_kept_the_code',
  'route_survives_an_omitted_owner', 'teardown_checks_every_pid_the_session_owns',
  'teardown_answers_per_pid', 'launch_membership_is_measured', 'an_unheld_launch_is_reported',
];

const WIN32_SOURCE = fs.readFileSync(WIN32, 'utf8');
const AGENT_SOURCE = fs.readFileSync(AGENT, 'utf8');
const COMPONENT_SOURCE = fs.readFileSync(COMPONENT_JS, 'utf8');
const MEASURE_SOURCE = fs.readFileSync(path.join(REPO, 'scripts', 'measure-cu-hidden-route.mjs'), 'utf8');
const SHA = createHash('sha256').update(WIN32_SOURCE).digest('hex');

say('=== ComputerUse hidden-desktop route gate ===');
say(`evidence:        ${OUT}`);
say(`lib/win32.js:    ${WIN32_SOURCE.length} bytes, sha256 ${SHA}`);
say(`released bytes:  ${RELEASED_SHA256}${SHA === RELEASED_SHA256 ? ' (identical to the released copy)' : ' (this lane file carries the routing)'}`);

const sources = { win32: WIN32_SOURCE, agent: AGENT_SOURCE, component: COMPONENT_SOURCE };

say('\n--- the rules, over comment-stripped text ---');
const baseline = rules(sources);
for (const id of RULE_IDS) {
  const hits = baseline.filter((finding) => finding.id === id);
  record(`rule ${id}`, hits.length === 0, hits.length === 0 ? 'holds on the shipped files' : hits.map((finding) => finding.detail).join(' | '));
}

/* ------------------------------------------------------------------------------------ 17 --- */

/**
 * THE MEASUREMENT'S CALL SHAPE IS PART OF THE CONTRACT, AND IT IS CHECKED HERE.
 *
 * The 45/0 measurement was green because every call it made passed `owner_id` explicitly - the
 * `runSequence` loop does `tool.execute({ ...args, owner_id: ownerId })` - and the live model
 * does not, because nothing tells it to. A measurement that pins an optional argument on every
 * call cannot measure what happens without it, and this is the assertion that would have caught
 * the live defect at the gate: it reads the measurement and requires a step that OMITS the
 * owner id, and requires the no-job plant that makes the teardown's per-pid answer able to go
 * red. Both are string checks over the measurement's source, and both are planted below.
 */
function measurementRules(measure) {
  const text = String(measure);
  const findings = [];
  const fail = (id, detail) => findings.push({ id, detail });
  if (!text.includes('omitOwner: true')) fail('the_measurement_sends_what_the_application_sends', 'no sequence step omits owner_id, so the shape the live model sends is never exercised');
  if (!/const sent = omitOwner \? \{ \.\.\.args \} : \{ \.\.\.args, owner_id: ownerId \};/.test(text)) {
    fail('the_measurement_sends_what_the_application_sends', 'the omitted-owner step does not actually reach the tool without an owner_id');
  }
  if (!text.includes('function plantNoJob()')) fail('the_measurement_sends_what_the_application_sends', 'the measurement has no no-job plant, so the teardown check it adds has never been shown able to fail');
  if (!/runChildPhase\('no-job'\)/.test(text)) fail('the_measurement_sends_what_the_application_sends', 'the no-job plant is declared but no phase runs it');
  if (!/PHASE === 'no-job'/.test(text)) fail('the_measurement_sends_what_the_application_sends', 'the no-job phase cannot be run as a child process');
  if (!text.includes('all_processes_gone === false')) fail('the_measurement_sends_what_the_application_sends', 'the measurement never asserts that the teardown reports a survivor as surviving');
  if (!text.includes(".sources.includes('launched-this-session')")) fail('the_measurement_sends_what_the_application_sends', 'the measurement does not check that the pid this session launched is a per-pid record in the teardown answer, with that as its named source');
  if (!text.includes('desktop_gone === false')) fail('the_measurement_sends_what_the_application_sends', 'the measurement never asserts that a held desktop is reported as still held');
  return findings;
}

say('\n--- the measurement\'s own call shape ---');
const measurementBaseline = measurementRules(MEASURE_SOURCE);
for (const id of ['the_measurement_sends_what_the_application_sends']) {
  const hits = measurementBaseline.filter((finding) => finding.id === id);
  record(`rule ${id}`, hits.length === 0, hits.length === 0 ? 'holds on the shipped measurement' : hits.map((finding) => finding.detail).join(' | '));
}

/* ------------------------------------------------------------------- the mutation table --- */

/**
 * Each row plants a violation and names the rule that must report it.
 *
 * A row is not "the gate ran": it is "the rule went red on exactly this plant, and the plant
 * reached the code rather than a comment". Two rows deliberately invert that: a violation
 * inside a COMMENT must not fire, and a violation inside a template literal carrying PowerShell
 * MUST fire - those two together are what keep the stripper honest in both directions.
 */
const ROUTING_ANCHOR = 'const hiddenRoute = hiddenRouteActive(options);';
const MUTATIONS = [
  {
    id: 'lane-side-reach-planted-in-code',
    rule: 'no_cross_desktop_reach',
    plant: (source) => `${source}\nfunction __nmPlantedReach(name) { return NmHiddenMaker.OpenDesktopW(name); }\n`,
  },
  {
    id: 'lane-side-reach-planted-in-a-comment',
    rule: 'no_cross_desktop_reach',
    expectClean: true,
    plant: (source) => `${source}\n/* this comment names OpenDesktopW and AttachThreadInput and SetThreadDesktop */\n`,
  },
  {
    id: 'input-attachment-planted-in-the-routing-section',
    rule: 'no_cross_desktop_reach',
    plant: (source) => source.replace(
      'const hiddenRoutes = new Map();',
      'const hiddenRoutes = new Map();\nfunction __nmPlantedAttach(a, b) { return AttachThreadInput(a, b, true); }',
    ),
  },
  {
    id: 'cleanup-by-process-name-planted',
    rule: 'no_process_class_cleanup',
    plant: (source) => source.replace('Get-Process -Id $wantedPid', 'Get-Process -Name msedge'),
  },
  {
    id: 'stop-process-planted-in-code',
    rule: 'no_process_class_cleanup',
    plant: (source) => `${source}\nfunction __nmPlantedCleanup() { return runInLane('windows', 'Stop-Process -Force'); }\n`,
  },
  {
    id: 'stop-process-planted-in-a-comment',
    rule: 'no_process_class_cleanup',
    expectClean: true,
    plant: (source) => `${source}\n// a recorded mistake: Get-Process msedge | Stop-Process -Force killed the user's own windows\n`,
  },
  {
    id: 'static-agent-import-planted',
    rule: 'hidden_agent_loaded_on_first_use',
    plant: (source) => source.replace("import { overlayContractReport", "import { ledgerPath } from './hidden-agent.js';\nimport { overlayContractReport"),
  },
  {
    id: 'routing-anchor-removed',
    rule: 'routing_is_one_branch_before_the_rest',
    plant: (source) => source.replace(ROUTING_ANCHOR, 'const hiddenRoute = null;'),
  },
  {
    id: 'routing-anchor-duplicated',
    rule: 'routing_is_one_branch_before_the_rest',
    plant: (source) => source.replace(ROUTING_ANCHOR, `${ROUTING_ANCHOR}\n  ${ROUTING_ANCHOR}`),
  },
  {
    id: 'routing-moved-after-the-interactive-branches',
    rule: 'routing_is_one_branch_before_the_rest',
    plant: (source) => {
      const branch = `  const hiddenRoute = hiddenRouteActive(options);\n  if (hiddenRoute) {\n    const routed = await hiddenDesktopAction(action, options, mode, header, hiddenRoute);\n    if (routed) return routed;\n  }\n`;
      if (!source.includes(branch)) return source;
      const withoutBranch = source.replace(branch, '');
      const anchor = "  if (action === 'sequence') return await sequenceAction(action, options, mode, header);";
      return withoutBranch.replace(anchor, `${anchor}\n${branch}`);
    },
  },
  {
    id: 'routing-switch-widened-to-a-desktop-action',
    rule: 'routed_action_set_is_exactly_the_app_actions',
    plant: (source) => source.replace("  if (action === 'app_list') return await hiddenAppListAction(", "  if (action === 'sequence') return await hiddenAppListAction(\n  if (action === 'app_list') return await hiddenAppListAction("),
  },
  {
    id: 'second-desktop-read-planted',
    rule: 'the_arm_is_one_place',
    plant: (source) => `${source}\nfunction __nmPlantedSecondArm() { return String(options.desktop || ''); }\n`,
  },
  {
    id: 'receipt-promises-a-real-fallback',
    rule: 'route_receipts_promise_no_real_delivery',
    plant: (source) => {
      const body = '    physical_delivery_used: false,\n    system_cursor_moved: false,\n    fallback_to_real_delivery: false,\n    ...extra,';
      return source.replace(body, '    physical_delivery_used: false,\n    system_cursor_moved: false,\n    fallback_to_real_delivery: true,\n    ...extra,');
    },
  },
  {
    id: 'teardown-stops-measuring-the-desktop',
    rule: 'teardown_is_measured',
    plant: (source) => source.replace('const desktop = await hiddenDesktopProbe(route);', 'const desktop = { checked: false, still_openable: null };'),
  },
  {
    id: 'lane-builds-its-own-pipe-client',
    rule: 'transport_is_the_proven_relay',
    plant: (source) => `${source}\nfunction __nmPlantedPipe(name) { return new System.IO.Pipes.NamedPipeClientStream(name); }\n`,
  },
  {
    id: 'the-tool-stops-declaring-the-arm',
    rule: 'the_arm_is_declarable',
    component: (source) => source.replace(/desktop:\s*\{\s*type:\s*'string',\s*enum:\s*\['hidden'\][^}]*\},/, ''),
  },
  {
    id: 'the-guide-stops-naming-the-route',
    rule: 'the_arm_is_declarable',
    component: (source) => source.replace('desktop: "hidden"', 'the other desktop'),
  },
  {
    id: 'a-template-literal-is-swapped-for-a-line-comment',
    rule: 'stripper_kept_the_code',
    plant: (source) => source.replace('const READY_ID = ', 'const __nmPlantedUrl = "http://x"; // and a slash pair\nconst READY_ID = '),
    expectClean: true,
  },
  {
    id: 'an-anchor-is-gone-from-the-stripped-text',
    rule: 'stripper_kept_the_code',
    plant: (source) => source.replace('result_truncated: true', 'output_truncated: true'),
  },
  /* --- the five rows that cover what the live application got wrong --------------------- */
  {
    id: 'the-routing-loses-its-fallback-to-the-lease-holder',
    rule: 'route_survives_an_omitted_owner',
    plant: (source) => source.replace('const held = hiddenRouteFor(active.owner_id);', 'const held = null;'),
  },
  {
    id: 'the-routing-stops-recording-the-owner-it-resolved',
    rule: 'route_survives_an_omitted_owner',
    plant: (source) => source
      .replace('    declared.resolvedFor = { declared: declaredOwner, ownerId: declared.ownerId, fromLease: false };\n', '')
      .replace('  held.resolvedFor = { declared: declaredOwner || null, ownerId: held.ownerId, fromLease: declaredOwner !== held.ownerId };\n', ''),
  },
  {
    id: 'the-routing-receipt-stops-reporting-the-owner',
    rule: 'route_survives_an_omitted_owner',
    plant: (source) => source.replace('    owner_resolved_from_lease: resolved ? resolved.fromLease === true : false,\n', ''),
  },
  {
    id: 'the-teardown-stops-checking-the-launched-pids',
    rule: 'teardown_checks_every_pid_the_session_owns',
    plant: (source) => source.replace("  for (const entry of route.launches) addPid(entry && entry.pid, 'launched-this-session', entry && entry.start_time_ticks);\n", ''),
  },
  {
    id: 'the-teardown-stops-reading-the-unheld-desktop-pids',
    rule: 'teardown_checks_every_pid_the_session_owns',
    plant: (source) => source.split("'unheld-desktop-window'").join("'a-source-with-no-name'"),
  },
  {
    id: 'the-teardown-answers-one-boolean-over-the-list',
    rule: 'teardown_answers_per_pid',
    plant: (source) => source.replace('    all_processes_gone: allGone,\n', '    all_processes_gone: true,\n'),
  },
  {
    id: 'the-teardown-derives-nothing-from-the-per-pid-answers',
    rule: 'teardown_answers_per_pid',
    plant: (source) => source.replace('  const alive = pidChecks.filter((check) => check.running === true).map((check) => check.pid);', '  const alive = [];'),
  },
  {
    id: 'the-teardown-stops-carrying-a-record-per-pid',
    rule: 'teardown_answers_per_pid',
    plant: (source) => source.replace('    pids_checked: pidChecks,\n', '    pids_checked: pids,\n'),
  },
  {
    id: 'the-launch-stops-measuring-membership',
    rule: 'launch_membership_is_measured',
    plant: null,
    agent: (source) => source.split('PidMembership(').join('PidMembershipRENAMED('),
  },
  {
    id: 'the-launch-stops-trying-to-hold-the-child',
    rule: 'launch_membership_is_measured',
    plant: null,
    agent: (source) => source.replace('$assigned = [NmAgentJob]::AssignPid($script:nmJob, [int]$started, [ref]$assignError)', '$assigned = $false'),
  },
  {
    id: 'the-launch-stops-reporting-what-it-found',
    rule: 'launch_membership_is_measured',
    plant: null,
    agent: (source) => source.split('ownership = $ownership').join('ownershipRENAMED = $ownership'),
  },
  {
    id: 'the-launch-adopts-any-pid-that-answers',
    rule: 'launch_membership_is_measured',
    plant: null,
    agent: (source) => source.split('$maybe -and $ours').join('$maybe'),
  },
  {
    id: 'the-arm-stops-reporting-an-unheld-launch',
    rule: 'an_unheld_launch_is_reported',
    plant: (source) => source.replace('    unowned_launches: Array.isArray(route.unownedLaunches) ? route.unownedLaunches : [],\n', ''),
  },
  {
    id: 'the-arm-stops-recording-an-unheld-launch',
    rule: 'an_unheld_launch_is_reported',
    plant: (source) => source.replace('      route.unownedLaunches = route.unownedLaunches || [];\n', '      void 0;\n'),
  },
  {
    id: 'the-measurement-stops-omitting-the-owner',
    rule: 'the_measurement_sends_what_the_application_sends',
    measurement: (source) => source.replace('omitOwner: true', 'omitOwner: false'),
  },
  {
    id: 'the-measurement-loses-its-no-job-plant',
    rule: 'the_measurement_sends_what_the_application_sends',
    measurement: (source) => source.split('plantNoJob').join('plantedAgentWithoutAJob'),
  },
];

say('\n--- mutation table: every rule is planted with a violation and must go red ---');
for (const mutation of MUTATIONS) {
  const mutated = { ...sources };
  let measure = MEASURE_SOURCE;
  if (mutation.component) mutated.component = mutation.component(sources.component);
  else if (mutation.agent) mutated.agent = mutation.agent(sources.agent);
  else if (mutation.measurement) measure = mutation.measurement(MEASURE_SOURCE);
  else mutated.win32 = mutation.plant(sources.win32);
  const changed = mutated.win32 !== sources.win32 || mutated.component !== sources.component || mutated.agent !== sources.agent || measure !== MEASURE_SOURCE;
  const findings = mutation.measurement ? measurementRules(measure) : rules(mutated);
  const hits = findings.filter((finding) => finding.id === mutation.rule);
  if (mutation.expectClean) {
    record(`mutation ${mutation.id}: NOT reported (so the rule reads code, not prose)`, hits.length === 0,
      hits.length === 0 ? 'the plant is invisible to the rule, as it must be' : `REPORTED: ${hits.map((finding) => finding.detail).join(' | ')}`);
    continue;
  }
  record(`mutation ${mutation.id}: rule ${mutation.rule} goes RED on it`, changed && hits.length > 0,
    !changed ? 'THE PLANT DID NOT REACH THE FILE - this row cannot fail and means nothing' : (hits.length ? hits.map((finding) => finding.detail).join(' | ') : 'nothing was reported: this rule does not cover the plant'));
}
{
  const base = rules(sources);
  record('the unmutated files are green, so the mutations measure the rules and not the baseline', base.length === 0, base.map((finding) => `${finding.id}: ${finding.detail}`).join(' | ') || 'no findings');
  const measureBase = measurementRules(MEASURE_SOURCE);
  record('the unmutated measurement is green, so its rows measure the rule and not the baseline', measureBase.length === 0, measureBase.map((finding) => `${finding.id}: ${finding.detail}`).join(' | ') || 'no findings');
}

/* -------------------------------------------------------------------------------- receipt --- */

const receipt = {
  stamp: STAMP,
  script: 'scripts/verify-computeruse-hidden-route.mjs',
  component: COMPONENT,
  win32_sha256: SHA,
  released_sha256: RELEASED_SHA256,
  win32_bytes: WIN32_SOURCE.length,
  rules: [...RULE_IDS, 'the_measurement_sends_what_the_application_sends'],
  passed,
  failed,
  results: RESULTS,
};
fs.writeFileSync(path.join(OUT, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
say(`\nreceipt: ${path.join(OUT, 'receipt.json')}`);
say(`\nCOMPUTERUSE HIDDEN ROUTE: ${passed} passed, ${failed} failed (of ${passed + failed})`);
say(failed === 0 ? 'HIDDEN ROUTE GATE PASS' : 'HIDDEN ROUTE GATE FAIL');
process.exit(failed === 0 ? 0 : 1);
