import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

let assertions = 0;

function ok(value: unknown, message: string): void {
  assert.ok(value, message);
  assertions += 1;
}

function source(file: string): string {
  return fs.readFileSync(path.join(__dirname, '..', '..', 'src', file), 'utf8');
}

function section(value: string, start: string, end: string): string {
  const from = value.indexOf(start);
  const to = value.indexOf(end, from + start.length);
  return from >= 0 && to > from ? value.slice(from, to) : '';
}

function main(): void {
  const browserUse = source('core/browserUse.ts');
  const mainSource = source('main.ts');
  const tools = source('tools/index.ts');

  ok(browserUse.includes('visible?: boolean')
    && browserUse.includes('if (value === undefined) return true')
    && browserUse.includes("if (typeof value !== 'boolean') throw new TypeError")
    && browserUse.includes('visible: bindBrowserUseVisible(raw.visible)'),
  'Browser-Use accepts an optional boolean, defaults omission to true, and rejects all defined non-boolean values at the trusted binding boundary');

  ok(tools.includes("visible: { type: 'boolean'")
    && tools.includes("visible: typeof args.visible === 'boolean' ? args.visible : true"),
  'the PC tool schema is strict while execution preserves the backwards-compatible true default');

  const visibleResolver = section(mainSource, 'async function ensureBrowserWebContents', 'async function ensureBackgroundBrowserWebContents');
  ok(visibleResolver.includes("host.send('browser:ensureGuest'")
    && visibleResolver.includes('waitForRegisteredBrowserGuest'),
  'visible=true retains the registered right-sidebar guest path');

  const backgroundResolver = section(mainSource, 'async function ensureBackgroundBrowserWebContents', 'function ensureElectronBrowserUseHost');
  ok(backgroundResolver.includes('new WebContentsView({')
    && backgroundResolver.includes('backgroundBrowserViewsByRuntime')
    && backgroundResolver.includes("await contents.loadURL('about:blank')")
    && !backgroundResolver.includes("browser:ensureGuest")
    && !backgroundResolver.includes('BrowserWindow'),
  'visible=false uses a main-process-only background WebContents and never sends sidebar IPC or creates a window');

  const hostFactory = section(mainSource, 'function ensureElectronBrowserUseHost', 'function ensureBrowserUseEngine');
  ok(hostFactory.includes('scope.visible === false')
    && hostFactory.includes('ensureBackgroundBrowserWebContents')
    && hostFactory.includes('ensureBrowserWebContents'),
  'the Electron host chooses the execution surface from visible without silently falling back between them');

  ok(mainSource.includes('releaseBackgroundBrowserWebContents(workEvent.runtimeKey)')
    && mainSource.includes('releaseAllBackgroundBrowserWebContents()')
    && mainSource.includes('releaseBackgroundBrowserWebContents(runtimeKey)'),
  'background WebContents are released at run termination, target cancellation, and app shutdown');

  console.log(`BROWSER_USE_VISIBLE_CONTRACT_VERIFY_PASS ${assertions}`);
}

main();
