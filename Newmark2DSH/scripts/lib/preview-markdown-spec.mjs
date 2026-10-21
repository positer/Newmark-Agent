/**
 * The reading pane renders Markdown and LaTeX — the assertions, as one callable block.
 *
 * Kept in its own module so the same assertions can be run against a STAGED copy of
 * `client.js` while a mutation is planted, without ever editing the real one. The gate
 * calls it too, so there is exactly one copy of every claim below.
 *
 * ## What is asserted, and what is deliberately NOT
 *
 * The real `MarkdownText` cannot run on this machine: it is a browser bundle whose parser
 * graph (`katex`, `mdast-util-*`, `micromark-*`, `shiki`) is not installed anywhere here —
 * see the report. So these assertions do NOT claim the renderer parses Markdown correctly.
 * They claim the things the pane itself owns and can be wrong about:
 *
 *   - that the pane CALLS the renderer, with the body, instead of drawing raw source;
 *   - that the labels object satisfies every key the shipped renderer reads unguarded;
 *   - that the labels object keeps ONE identity, so the renderer's memo cannot be
 *     invalidated on every selection change;
 *   - that the variant is the compact one, with a reason that is measured;
 *   - that a shell WITHOUT the renderer still shows the body, as text.
 *
 * ## Anti-vacuity
 *
 * Every assertion is written against the element or the argument that CARRIES the
 * property — the spy's recorded call, the container's own child elements, the object
 * identity across two renders — and never against page text that would be true anyway
 * (the page carries the component's name in the column regardless of what the pane drew).
 * And no check skips itself: every early exit below is preceded by a `check` that fails
 * by name, so a build that stops the spec early reports red, not silence.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

/** The keys `renderCode` reads one level down (`lib/index.js:11361-11363`, `:9459`, `:9468`, `:9488`). */
const CODE_TOOLBAR_KEYS = ['codeLabel', 'wrapLabel', 'unwrapLabel'];

/** Flatten an element tree to text, tolerating the spy's empty children. */
function textOfNodes(nodes) {
  if (nodes === null || nodes === undefined || nodes === false) return '';
  if (Array.isArray(nodes)) return nodes.map(textOfNodes).join(' ').trim();
  if (typeof nodes === 'string') return nodes;
  if (typeof nodes === 'number') return String(nodes);
  if (typeof nodes !== 'object') return '';
  const own = typeof nodes.props?.children === 'string' ? nodes.props.children : '';
  return `${own} ${textOfNodes(nodes.children)}`.trim();
}

/** Every element matching a predicate. */
function findAllNodes(node, predicate, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) findAllNodes(child, predicate, out);
    return out;
  }
  if ('type' in node) {
    if (predicate(node)) out.push(node);
    findAllNodes(node.children, predicate, out);
  }
  return out;
}

/** The `CSS` template literal the client half ships, read as text. */
function readClientCss(clientHalf) {
  const source = fs.readFileSync(clientHalf, 'utf8');
  const marker = 'const CSS = `';
  const start = source.indexOf(marker);
  if (start === -1) return '';
  const from = start + marker.length;
  const end = source.indexOf('`;', from);
  return end === -1 ? '' : source.slice(from, end);
}

/**
 * Run the reading-pane assertions.
 *
 * @param options.check — the gate's own `check(name, condition, detail)`.
 * @param options.packagesDir — the bundle's `packages/` directory.
 * @param options.clientHalf — the client module under test.
 * @param options.mountSyntheticStore / options.renderDetailColumns — the harness helpers.
 */
export async function runPreviewMarkdownSpec({ check, packagesDir, clientHalf, mountSyntheticStore, renderDetailColumns }) {
  const ROOT = path.join(os.tmpdir(), `newmark-preview-gate-${process.pid}`);
  /* The body is fixed HERE rather than left to the store's own generator: the assertions
   * below are about Markdown and LaTeX specifically, and a body without that syntax cannot
   * witness whether the pane renders it or prints it. */
  const BODY = [
    '# Preview heading',
    '',
    'Inline maths $a^2 + b^2 = c^2$ sits in a sentence.',
    '',
    '$$',
    '\\int_0^1 x^2 \\, dx = \\frac{1}{3}',
    '$$',
    '',
    '```js',
    'const answer = 42;',
    '```',
    '',
    'A last paragraph, so the document ends on prose.',
  ].join('\n');
  const fixture = [
    { name: 'preview-target', tags: ['#P'], tagPaths: [['#P']], body: BODY },
    { name: 'preview-other', tags: ['#P'], tagPaths: [['#P']] },
  ];

  let mount = null;
  try {
    /* FIRST, because everything below imports the module: a client that cannot be parsed
     * makes the dynamic import throw, and a spec that only discovered that later would
     * abort with an unhandled rejection instead of saying which file is broken. */
    const source = fs.readFileSync(clientHalf, 'utf8');
    const parseError = (() => {
      try {
        // eslint-disable-next-line no-new
        new vm.Script(source, { filename: clientHalf });
        return null;
      } catch (error) {
        return error;
      }
    })();
    check(
      'the client half parses as a script, so the module the shell loads is valid JavaScript',
      parseError === null,
      parseError ? `${parseError.name}: ${parseError.message}` : '',
    );
    if (parseError !== null) return;

    /* Every render goes through here, so a throw is a NAMED failure rather than an
     * exception that unwinds the spec and leaves the gate reporting on a client it never
     * managed to load. A planted syntax error made exactly that happen once: the gate went
     * green with an unparseable `client.js`, because `renderDetailColumns` rejected and
     * nothing was there to catch it. */
    async function render(selection, markdown) {
      try {
        return await renderDetailColumns({ packagesDir, globals, clientHalf, selection, markdown });
      } catch (error) {
        check(
          `the detail view renders with the module table "${markdown}"`,
          false,
          `${error?.name}: ${String(error?.message).slice(0, 200)}`,
        );
        return null;
      }
    }

    const mounted = await mountSyntheticStore({ packagesDir, root: ROOT, fixture });
    mount = mounted.mount;
    const globals = mounted.mount.windowGlobals();
    const wire = mounted.payload.index.components;
    const slugOf = Object.fromEntries(wire.map((entry) => [entry.name, entry.slug]));
    const target = slugOf['preview-target'];

    check(
      'the reading-pane fixture holds the component the assertions select',
      Boolean(target),
      `wire names: ${JSON.stringify(wire.map((entry) => entry.name))}`,
    );
    if (!target) return;

    const selection = { kind: 'component', slug: target, tag: '#P' };

    /* The pane must render the body the STORE holds. It is read back and the expectations
     * below are derived from it, so a change to the fixture cannot quietly turn these
     * assertions into a tautology — and the Markdown syntax this spec needs is checked to
     * be present, because "rendered vs printed" is only distinguishable when it is. */
    const stored = mounted.payload.contents?.[target];
    check(
      'the fixture body carries the Markdown and LaTeX the assertions below need',
      typeof stored === 'string'
        && /^#\s+\S/m.test(stored)
        && /\$\$?[^$\n]+\$\$?/.test(stored)
        && /^```/m.test(stored),
      `stored body: ${JSON.stringify(String(stored).slice(0, 120))}`,
    );
    if (typeof stored !== 'string' || !/^#\s+\S/m.test(stored)) return;

    const heading = stored.match(/^#\s+(.+)$/m)[1].trim();

    /* ------------------------------------------------- 1. the rendered path */
    const rendered = await render(selection, 'spy');
    if (!rendered) return;
    const calls = rendered.markdownCalls || [];

    check(
      'with the primitives available the pane calls the Markdown renderer exactly once',
      calls.length === 1,
      `renderer calls: ${calls.length} — a pane that printed the body records none`,
    );

    /* The anti-vacuity gate for every spy read below: with no call there is no argument to
     * inspect, and a spec reading `calls[0]?.text` would sail past `undefined`. The shape
     * is checked by name first, and the early exit is itself a reported failure. */
    const call = calls[0];
    const callIsObject = call !== null && typeof call === 'object';
    check(
      'the recorded renderer call carries a props object to inspect',
      callIsObject,
      `calls[0]: ${JSON.stringify(call)}`,
    );
    if (!callIsObject) return;

    check(
      'the pane hands the renderer the stored body verbatim',
      call.text === stored,
      `text ${JSON.stringify(String(call.text).slice(0, 60))} vs stored ${JSON.stringify(String(stored).slice(0, 60))}`,
    );

    /* The document container is found under the pane's own body element, so this reads the
     * element that carries the property rather than any node that happens to match. */
    const bodies = findAllNodes(rendered.tree, (n) => (n.props?.className || '') === 'ml-preview-body');
    /* The container is identified by CLASS **and** by being a real element. The renderer's
     * own node copies the class through (`MarkdownText` renders a `div` carrying
     * `markdown compact`, and the stand-in mirrors that), so a class-only match finds two
     * elements and reading the wrong one reports the wrapper instead of the document. */
    const docs = bodies
      .flatMap((node) => node.children)
      .filter((child) => (child?.props?.className || '') === 'ml-preview-doc' && typeof child?.type === 'string');
    check(
      'the rendered pane wraps the document in the container the stylesheet sizes',
      bodies.length === 1 && docs.length === 1 && docs[0].children.length > 0,
      `ml-preview-body: ${bodies.length}, document container inside it: ${docs.length}`,
    );

    const docChildren = docs[0] ? docs[0].children : [];
    const docText = textOfNodes(docChildren);

    /* Everything inside the document container, at any depth. The renderer's own node is a
     * `memo` wrapper, so the harness's `expand` leaves it whole and the rendered blocks sit
     * one level inside it — searching the subtree is what reaches them, and it is still the
     * pane's own function that is being read, not page text. */
    const inside = docs[0] ? findAllNodes(docs[0], () => true) : [];
    const elementTypes = inside.filter((node) => typeof node.type === 'string').map((node) => node.type);
    const literalText = docChildren.filter((child) => typeof child === 'string').join(' ');

    /* "A document, not preformatted source" has to be stated precisely, because `pre` is
     * NOT the tell: the body contains a fenced code block, and a `pre` for that block is
     * exactly right. (An earlier version forbade `pre` outright and was simply wrong about
     * its own fixture.) The tell is the block sequence the renderer produced: a body
     * printed as source is ONE `<pre>` holding the whole string, so it yields no heading
     * and no block separation at all, while a parsed body yields an element per block. The
     * fixture guarantees a heading and a fence, so those two are what is required, read
     * through the subtree walk that is known to reach the rendered blocks. */
    const blockTypes = elementTypes.filter((type) => type === 'pre' || /^h[1-6]$/.test(type) || type === 'li' || type === 'blockquote');
    check(
      'the rendered body is a sequence of blocks, not one preformatted string',
      blockTypes.some((type) => /^h[1-6]$/.test(type)) && blockTypes.includes('pre') && blockTypes.length >= 2,
      `blocks ${blockTypes.length} ${JSON.stringify(blockTypes)} — a source dump produces none of these`,
    );
    /* The syntax assertions. The stand-in turns the `#` of an ATX heading into an `hn`, so
     * a `#` surviving as LITERAL text means the body reached the tree unparsed. (A `#`
     * inside a heading's own text is not syntax and is not asserted against.) And the
     * heading assertion reads the pane's own subtree rather than `textOf(tree)`, because
     * the page carries the component's name in the column and would pass regardless. */
    check(
      'the Markdown heading syntax reached the renderer and came back as a heading element',
      elementTypes.some((type) => /^h[1-6]$/.test(type)),
      `elements inside the document: ${JSON.stringify(elementTypes)} — no heading element was produced`,
    );
    check(
      'the heading marker survives as literal text only if the body was printed, not parsed',
      docChildren.length > 0 && !literalText.includes('#'),
      `literal document text: ${JSON.stringify(literalText.slice(0, 100))}`,
    );
    check(
      'the heading text itself survives the parse',
      docText.includes(heading),
      `document text ${JSON.stringify(docText.slice(0, 120))} does not carry ${JSON.stringify(heading)}`,
    );

    /* The two syntaxes the task names, asserted against the stand-in's own documented
     * vocabulary. Both read the same "did this survive as literal text?" property, which is
     * what separates a parsed body from a printed one, and both name the renderer's
     * recognised elements so the failure says which syntax was left unparsed. */
    const mathSource = /\$\$?[^$\n]+\$\$?/.test(stored);
    check(
      'the fixture body carries LaTeX, so a maths assertion measures something',
      mathSource,
      `stored body has no $…$ or $$…$$: ${JSON.stringify(String(stored).slice(0, 100))}`,
    );
    check(
      'LaTeX in the body is handed to the renderer rather than printed as source',
      mathSource
        && (elementTypes.includes('span') || elementTypes.includes('div'))
        && !/\$/.test(literalText),
      `document children ${JSON.stringify(elementTypes)}, literal text ${JSON.stringify(literalText.slice(0, 80))}`,
    );

    const fenceSource = /^```/m.test(stored);
    check(
      'the fixture body carries a fenced code block, so that assertion measures something',
      fenceSource,
      `stored body has no fenced code block: ${JSON.stringify(String(stored).slice(0, 100))}`,
    );
    check(
      'a fenced code block is handed to the renderer rather than printed as source',
      fenceSource && elementTypes.includes('pre') && !literalText.includes('```'),
      `document children ${JSON.stringify(elementTypes)}, literal text ${JSON.stringify(literalText.slice(0, 80))}`,
    );

    /* ------------------------------------------------- 2. the labels object */
    const labels = call.labels;
    check(
      'the renderer receives a labels object at all, never undefined',
      labels !== null && typeof labels === 'object',
      `labels: ${JSON.stringify(labels)}`,
    );
    if (labels === null || typeof labels !== 'object') return;

    /* The exact keys, compared as SETS. Reported as sets too: an earlier version compared
     * unsorted key order and printed `Object.keys` in its failure message, which made a
     * one-character ordering difference look like a missing key. The property being
     * asserted is "exactly these keys", so the comparison is a set comparison and the
     * message shows sets. */
    const asSet = (value) => [...value].sort().join(',');
    const labelKeys = Object.keys(labels);
    const codeKeys = Object.keys(labels.code || {});
    const toolbarKeys = Object.keys(labels.code?.toolbarLabels || {});
    check(
      'the labels object carries exactly the keys the shipped renderer reads',
      asSet(labelKeys) === asSet(['code', 'footnotes'])
        && asSet(codeKeys) === asSet(['copyLabel', 'copiedLabel', 'toolbarLabels'])
        && asSet(toolbarKeys) === asSet(CODE_TOOLBAR_KEYS),
      `labels {${asSet(labelKeys)}} expected {code,footnotes}; code {${asSet(codeKeys)}} expected {copiedLabel,copyLabel,toolbarLabels}; toolbar {${asSet(toolbarKeys)}} expected {${asSet(CODE_TOOLBAR_KEYS)}}`,
    );
    check(
      'every label value the renderer reads is a non-empty string',
      typeof labels.footnotes === 'string' && labels.footnotes.length > 0
        && typeof labels.code?.copyLabel === 'string' && labels.code.copyLabel.length > 0
        && typeof labels.code?.copiedLabel === 'string' && labels.code.copiedLabel.length > 0
        && CODE_TOOLBAR_KEYS.every((key) => typeof labels.code?.toolbarLabels?.[key] === 'string' && labels.code.toolbarLabels[key].length > 0),
      JSON.stringify(labels),
    );
    check(
      'the labels object is frozen, so nothing downstream can mutate what the renderer reads',
      Object.isFrozen(labels) && Object.isFrozen(labels.code) && Object.isFrozen(labels.code.toolbarLabels),
      `frozen: labels=${Object.isFrozen(labels)} code=${Object.isFrozen(labels.code)} toolbar=${Object.isFrozen(labels.code.toolbarLabels)}`,
    );

    /* The identity property, asserted in the two forms that are actually observable here.
     *
     * The obvious form — compare the labels object from two `renderDetailColumns` calls —
     * CANNOT FAIL IN THIS HARNESS, and it is worth saying why rather than shipping it: each
     * call re-imports the client module with a cache-busting query, so even a correct
     * module-level constant is a different object per call. A check written that way is red
     * on a correct build and proves nothing; it is the "assertion that cannot pass" mirror
     * of the assertion that cannot fail.
     *
     * What IS observable:
     *   1. SOURCE — the render site names a module-level constant and does not build an
     *      object literal per render. This is the actual property: a per-render object is
     *      the defect, and it is visible in the source whatever the harness does.
     *   2. BEHAVIOUR — two independent renders agree on the labels CONTENT and both receive
     *      a complete object, so a fix that renamed the constant but dropped a key, or that
     *      made the second render's labels differ in shape, fails here.
     */
    check(
      'the render site passes a module-level labels constant, not an object built per render',
      /h\(MarkdownText,\s*\{[^}]*\blabels:\s*[A-Z][A-Z0-9_]*\b/.test(source)
        && /^\s*const\s+[A-Z][A-Z0-9_]*\s*=\s*Object\.freeze\(/m.test(source),
      'expected `labels: SOME_CONSTANT` where SOME_CONSTANT is an Object.freeze(...) at module scope',
    );

    const again = await render(selection, 'spy');
    const secondCall = again ? (again.markdownCalls || [])[0] : undefined;
    check(
      'a second independent render receives the same complete labels object',
      Boolean(secondCall)
        && Object.keys(secondCall.labels || {}).sort().join(',') === asSet(labelKeys)
        && Object.keys(secondCall.labels?.code || {}).sort().join(',') === asSet(codeKeys)
        && Object.keys(secondCall.labels?.code?.toolbarLabels || {}).sort().join(',') === asSet(toolbarKeys),
      secondCall
        ? `second render labels {${asSet(Object.keys(secondCall.labels || {}))}} code {${asSet(Object.keys(secondCall.labels?.code || {}))}} toolbar {${asSet(Object.keys(secondCall.labels?.code?.toolbarLabels || {}))}}`
        : 'the second render recorded no renderer call at all',
    );

    /* ------------------------------------------------- 3. the variant */
    check(
      'the pane asks for the compact variant, the one the package documents for a narrow column',
      call.variant === 'compact',
      `variant: ${JSON.stringify(call.variant)} — the default body variant is document typography with 32px heading margins`,
    );
    check(
      'the pane renders settled, not streaming, so stored LaTeX is typeset rather than held literal',
      call.streaming === undefined || call.streaming === false,
      `streaming: ${JSON.stringify(call.streaming)}`,
    );

    /* ------------------------------------------------- 4. the fallback path */
    const plain = await render(selection, 'absent');
    if (!plain) return;
    const plainPres = findAllNodes(plain.tree, (n) => n.type === 'pre');

    check(
      'with no primitives module the pane still shows the body, and shows it as text',
      plain.markdownCalls.length === 0 && plainPres.length === 1,
      `renderer calls: ${plain.markdownCalls.length}, pre elements: ${plainPres.length}`,
    );
    check(
      'the fallback shows the body verbatim, Markdown syntax and all',
      plainPres.length === 1 && textOfNodes([plainPres[0]]) === stored,
      `fallback text: ${JSON.stringify(textOfNodes(plainPres).slice(0, 100))}`,
    );
    check(
      'the fallback draws no document container, because nothing rendered a document',
      findAllNodes(plain.tree, (n) => (n?.props?.className || '') === 'ml-preview-doc').length === 0,
      'ml-preview-doc is present in the fallback tree',
    );

    /* ------------------------------------------------- 5. the pane does not widen */    /* A long, unbreakable body must not widen the column. The renderer's side of that is
     * its own max-width; the pane's side is the bounded column plus a document container
     * allowed to shrink. Read off the same stylesheet the component ships, so removing
     * either rule fails here instead of in a browser this machine does not have. */
    const css = readClientCss(clientHalf);
    check(
      'the pane keeps its bounded width, so a long body cannot widen the column',
      /\.ml-preview\s*\{[^}]*width:\s*min\(420px,\s*40%\)/.test(css),
      'the .ml-preview width rule is gone or changed',
    );
    check(
      'the document container may shrink, so a wide table scrolls instead of widening the row',
      /\.ml-preview-doc\s*\{[^}]*min-width:\s*0/.test(css),
      'the .ml-preview-doc min-width rule is gone',
    );
    /* The bare `<pre>` rule stays, and this is the reason: the fallback still draws one.
     * If a later change makes the fallback draw something else, this goes red — which is
     * exactly when the rule becomes removable and should be reconsidered. */
    check(
      'the plain-text stylesheet rule is still reachable, because the fallback still draws a pre',
      /\.ml-preview-body\s+pre\s*\{/.test(css) && plainPres.length === 1,
      'the .ml-preview-body pre rule and the fallback pre must agree',
    );
  } finally {
    if (mount) await mount.dispose();
    fs.rmSync(ROOT, { recursive: true, force: true });
  }
}
