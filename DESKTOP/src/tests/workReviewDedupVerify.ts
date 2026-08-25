import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import { JSDOM } from 'jsdom';

/**
 * dev-0.5.7 work-review incremental upsert regression gate.
 *
 * Incremental snapshot refreshes re-enter the completed-run file review
 * renderer with evolving diffs and a provisional/canonical run-id handoff.
 * One logical Build must retain exactly one card and update it in place.
 */
function uiScriptSource(): string {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'ui', 'index.html'), 'utf-8');
  const match = html.match(/<script>([\s\S]*)<\/script>/);
  if (!match) throw new Error('UI script was not found');
  return match[1];
}

function functionSource(source: string, name: string): string {
  const file = ts.createSourceFile('newmark-ui.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let found = '';
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node.getText(file);
    if (!found) ts.forEachChild(node, visit);
  };
  visit(file);
  if (!found) throw new Error(`UI function not found: ${name}`);
  return found;
}

function check(condition: boolean, message: string): void {
  if (condition) console.log(`  [PASS] ${message}`);
  else console.log(`  [FAIL] ${message}`);
  assert.ok(condition, message);
}

function main(): void {
  const source = uiScriptSource();
  const addWorkReviewSrc = functionSource(source, 'addWorkReview');
  const workReviewRunIdsSrc = functionSource(source, 'workReviewRunIds');
  const upsertWorkReviewRecordSrc = functionSource(source, 'upsertWorkReviewRecord');

  const dom = new JSDOM('<!doctype html><html><body><div id="chat-area"></div></body></html>');
  const factory = new Function('window', 'document', `
    var els = { 'chat-area': document.getElementById('chat-area') };
    function t(value) { return String(value); }
    function esc(value) { return String(value == null ? '' : value); }
    function escAttr(value) { return esc(value).replace(/"/g, '&quot;'); }
    function iconSvg() { return '<svg></svg>'; }
    function normalizeWorkReviewDiffs(diffs) {
      if (!Array.isArray(diffs)) return [];
      return diffs.map(function(d) {
        return {
          path: String(d && d.path || ''),
          added: Number(d && d.added || 0),
          deleted: Number(d && d.deleted || 0),
        };
      });
    }
    function autoScrollIfAtBottom() {}
    ${workReviewRunIdsSrc}
    ${upsertWorkReviewRecordSrc}
    ${addWorkReviewSrc}
    return {
      addWorkReview: addWorkReview,
      upsertWorkReviewRecord: upsertWorkReviewRecord,
      chatArea: els['chat-area'],
      count: function() { return els['chat-area'].querySelectorAll('.work-review').length; },
    };
  `);
  const api = factory(dom.window, dom.window.document);
  const ui: { workReviews: Array<{ runId: string; diffs: unknown[] }> } = { workReviews: [] };

  const diffs = [
    { path: 'src/a.ts', added: 3, deleted: 1 },
    { path: 'src/b.ts', added: 5, deleted: 2 },
  ];

  // First call mounts the card.
  const first = api.addWorkReview(diffs, 'run-1');
  check(api.count() === 1, 'first addWorkReview mounts exactly one review card');
  check(!!first && first.getAttribute('data-files') === JSON.stringify([
    { path: 'src/a.ts', added: 3, deleted: 1 },
    { path: 'src/b.ts', added: 5, deleted: 2 },
  ]), 'mounted card carries the normalized data-files key');

  // Repeated incremental refreshes with identical diffs must not duplicate.
  api.addWorkReview(diffs, 'run-1');
  api.addWorkReview(diffs, 'run-1');
  api.addWorkReview(diffs, 'run-1');
  check(api.count() === 1, 'repeated identical addWorkReview calls keep a single card');

  const updated = api.addWorkReview([{ path: 'src/a.ts', added: 9, deleted: 4 }], 'run-1');
  check(api.count() === 1, 'a later diff snapshot for the same run updates instead of appending');
  check(updated.querySelector('.work-review-stats').textContent.includes('+9') && updated.querySelector('.work-review-stats').textContent.includes('-4'), 'same-run upsert refreshes the rendered totals');

  api.addWorkReview([{ path: 'src/a.ts', added: 10, deleted: 4 }], 'run-canonical', ['run-1']);
  check(api.count() === 1, 'canonical run id takes over the provisional review without duplication');
  check(updated.getAttribute('data-run-id') === 'run-canonical', 'provisional review is rebound to the canonical run id');

  api.upsertWorkReviewRecord(ui, diffs, 'run-provisional', []);
  api.upsertWorkReviewRecord(ui, [{ path: 'src/a.ts', added: 10, deleted: 4 }], 'run-canonical', ['run-provisional']);
  check(ui.workReviews.length === 1, 'retained review state replaces the provisional snapshot instead of appending');
  check(ui.workReviews[0].runId === 'run-canonical', 'retained review state adopts the canonical run id');

  // Identical file totals in a later Build are a distinct review and must not
  // be swallowed by the previous run's incremental-refresh guard.
  api.addWorkReview(diffs, 'run-2');
  check(api.count() === 2, 'identical diffs from a different run mount a separate review card');

  // A genuinely different diff set mounts a second card.
  api.addWorkReview([{ path: 'src/c.ts', added: 1, deleted: 0 }]);
  check(api.count() === 3, 'a different diff set mounts its own card');
}

main();
console.log('{"ok":true}');
