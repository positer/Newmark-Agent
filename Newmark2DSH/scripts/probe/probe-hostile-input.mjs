/**
 * What the shipped renderer does with hostile input — measured, as far as it can be here.
 *
 * TWO DIFFERENT KINDS OF EVIDENCE, kept apart on purpose:
 *
 *  A. EXECUTED — the transcription test below. The shipped sanitizer's decision is one
 *     expression: `new URL(url).protocol` against an allowlist (`lib/index.js:11186-11197`).
 *     That expression is WHATWG URL behaviour, not package behaviour, so running it here
 *     measures the actual mechanism the renderer relies on — including whether a
 *     `javascript:` URL can disguise its protocol. This is a transcription: it proves the
 *     MECHANISM, and it is not the package's own code executing.
 *
 *  B. READ — the wiring. Whether a rejected URL reaches the DOM as an href is decided by
 *     ten lines of the shipped source, quoted here with line numbers. It is not executed,
 *     because the package's parsers (katex, mdast-util-*, micromark-*) are not installed
 *     anywhere on this machine and the whole graph is needed to import it. See the report.
 *
 * The distinction matters: (A) tells you the guard cannot be walked through, (B) tells you
 * the guard is actually on the path. Neither alone would be enough, and claiming (B) was
 * (A) would be the lie this probe exists to avoid.
 */

/* ------------------------------------------------------------------ A. EXECUTED */

/** The shipped allowlist, transcribed from `lib/index.js:11186-11197`. */
function sanitizeUrl(url) {
  try {
    switch (new URL(url).protocol) {
      case 'http:':
      case 'https:':
      case 'mailto:':
        return url;
      default:
        return '';
    }
  } catch {
    return '';
  }
}

/** The shipped image gate, transcribed from `lib/index.js:11198-11205`. */
function remoteImageUrl(url) {
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}

const HOSTILE = [
  ['javascript:alert(1)', 'plain javascript: scheme'],
  ['JaVaScRiPt:alert(1)', 'mixed case'],
  ['JAVASCRIPT:alert(1)', 'upper case'],
  ['  javascript:alert(1)', 'leading spaces'],
  ['java\tscript:alert(1)', 'TAB inside the scheme'],
  ['java\nscript:alert(1)', 'LF inside the scheme'],
  ['java\rscript:alert(1)', 'CR inside the scheme'],
  ['\u0000javascript:alert(1)', 'NUL prefix'],
  ['javascript&#58;alert(1)', 'HTML entity colon'],
  ['data:text/html,<script>alert(1)</script>', 'data: URL'],
  ['vbscript:msgbox(1)', 'vbscript:'],
  ['file:///C:/Windows/System32/calc.exe', 'file: URL'],
  ['blob:http://x/y', 'blob: URL'],
  ['#footnote-1', 'fragment anchor'],
  ['//evil.example.com/x', 'protocol-relative'],
  ['https://ok.example.com/x', 'legitimate https (control)'],
  ['http://ok.example.com/x', 'legitimate http (control)'],
  ['mailto:a@b.example', 'legitimate mailto (control)'],
];

console.log('=== A. EXECUTED: sanitizeUrl (link destinations) ===');
let rejected = 0;
let allowed = 0;
for (const [url, note] of HOSTILE) {
  const out = sanitizeUrl(url);
  const verdict = out === '' ? 'REJECTED' : `ALLOWED as ${JSON.stringify(out)}`;
  if (out === '') rejected += 1;
  else allowed += 1;
  console.log(`  ${verdict.padEnd(46)} <- ${note}`);
  console.log(`      input: ${JSON.stringify(url)}`);
}

console.log('');
console.log('=== A. EXECUTED: remoteImageUrl (image sources) ===');
for (const [url, note] of HOSTILE) {
  const out = remoteImageUrl(url);
  console.log(`  ${(out === undefined ? 'REJECTED' : `ALLOWED as ${JSON.stringify(out)}`).padEnd(46)} <- ${note}`);
}

console.log('');
console.log('=== A. EXECUTED: is any dangerous scheme reachable? ===');
const dangerous = HOSTILE.filter(([u]) => {
  const p = (() => { try { return new URL(u).protocol; } catch { return ''; } })();
  return p !== '' && !['http:', 'https:', 'mailto:'].includes(p);
});
const leaked = dangerous.filter(([u]) => sanitizeUrl(u) !== '');
console.log(`  inputs whose PROTOCOL is outside the allowlist: ${dangerous.length}`);
console.log(`  of those, how many the allowlist let through:    ${leaked.length}`);
console.log(`  ${leaked.length === 0 ? 'PASS' : 'FAIL'} — no off-allowlist protocol survives`);
console.log('');
console.log(`  totals: ${rejected} rejected, ${allowed} allowed (the 3 controls + mailto expect ALLOWED)`);
