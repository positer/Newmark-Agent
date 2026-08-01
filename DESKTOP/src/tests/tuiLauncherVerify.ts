import * as fs from 'node:fs';
import * as path from 'node:path';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`TUI launcher verification failed: ${message}`);
}

const desktopRoot = path.resolve(__dirname, '..', '..');
const launcherSource = fs.readFileSync(path.join(desktopRoot, 'src', 'launcher.ts'), 'utf8');
const mainSource = fs.readFileSync(path.join(desktopRoot, 'src', 'main.ts'), 'utf8');
const batchSource = fs.readFileSync(path.join(desktopRoot, 'newmark.bat'), 'utf8');
const tuiAppSource = fs.readFileSync(path.join(desktopRoot, '..', 'TUI', 'src', 'app.js'), 'utf8');
const consoleLauncherSource = fs.readFileSync(path.join(desktopRoot, 'scripts', 'create-console-launcher.cjs'), 'utf8');
const msiHookSource = fs.readFileSync(path.join(desktopRoot, 'scripts', 'patch-msi-project.cjs'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(desktopRoot, 'package.json'), 'utf8')) as {
  bin?: Record<string, string>;
  scripts?: Record<string, string>;
};
const copiedTuiRoot = path.join(desktopRoot, 'dist', 'tui');

assert(launcherSource.includes("arg.toLowerCase() === '--tui'"), 'Node launcher must recognize case-insensitive --TUI');
assert(launcherSource.includes("arg.toLowerCase() === '--gui'")
  && launcherSource.includes('function launchGui()')
  && launcherSource.includes("require('electron')")
  && launcherSource.includes('NEWMARK_GUI_EXECUTABLE'),
  'npm global command must expose a case-insensitive Newmark --GUI native/Electron launcher');
assert(launcherSource.includes("workspacePath: process.cwd()"), 'Node launcher must preserve the caller working directory');
assert(mainSource.includes("arg.toLowerCase() === '--tui'"), 'packaged Electron entry must recognize case-insensitive --TUI');
assert(mainSource.includes("!args.includes('--gui')"), 'source Electron entry must preserve explicit --GUI startup');
assert(mainSource.includes("require('./tui/src/app')"), 'packaged Electron entry must load the bundled TUI');
assert(mainSource.includes('setWindowsConsoleMode()') && mainSource.includes('process.env.NEWMARK_FORCE_TTY'),
  'packaged Electron entry must enable and later restore Windows console Raw Mode');
assert(mainSource.includes("path.basename(process.execPath).toLowerCase() === 'newmark.exe'")
  && mainSource.includes("ELECTRON_RUN_AS_NODE: '1'"),
  'installed Newmark.exe --TUI must hand off to its terminal Node mode');
assert(/if \/i "%1"=="--TUI"/i.test(batchSource), 'portable batch launcher must keep --TUI attached to the terminal');
assert(batchSource.includes('set "ELECTRON_RUN_AS_NODE=1"'), 'packaged Windows TUI launcher must use the real terminal Node runtime');
assert(!/%\*\s+--root\s+"%NEWMARK_ROOT%"/i.test(batchSource), 'TUI launcher must not use the install directory as mutable runtime root');
assert(tuiAppSource.includes('process.env.NEWMARK_FORCE_TTY === "1"'), 'TUI must support the packaged Windows PTY fallback');
assert(consoleLauncherSource.includes('image.writeUInt16LE(3, subsystemOffset)'),
  'Windows package must include a console-subsystem Newmark.exe for CLI/TUI/SSH');
assert(packageJson.scripts?.['dist:portable']?.startsWith('npm run test:full-release')
  && msiHookSource.includes('Name="PATH"') && msiHookSource.includes('Value="[APPLICATIONFOLDER]"'),
  'MSI must register the installed console launcher globally through PATH');
assert(packageJson.bin?.newmark === 'dist/launcher.js', 'npm global command must route newmark to dist/launcher.js');
assert(packageJson.scripts?.build?.includes('build-tui.cjs'), 'normal build must include the TUI copy step');
assert(packageJson.scripts?.['test:full-release']?.includes('test:desktop:built')
  && packageJson.scripts?.['test:full-release']?.includes('test:tui:built')
  && packageJson.scripts?.['test:full-release']?.includes('test:ssh-tui-stress:built')
  && packageJson.scripts?.['test:full-release']?.includes('test:wsl-tui-stress:built')
  && packageJson.scripts?.['test:full-release']?.includes('test:cli:built')
  && packageJson.scripts?.['test:full-release']?.includes('test:gui-tui-cli-stress:built'),
'full release regression must run DESKTOP, TUI, SSH, WSL/Linux, CLI, and cross-surface stress');
assert(packageJson.scripts?.['dist:portable']?.startsWith('npm run test:full-release'),
  'Windows portable/MSI packaging must be gated by the full surface regression');
assert(fs.existsSync(path.join(copiedTuiRoot, 'src', 'app.js')), 'compiled distribution must contain the TUI runtime');
assert(fs.existsSync(path.join(copiedTuiRoot, 'src', 'adapters', 'core-runtime-adapter.js')), 'compiled distribution must contain the real Core adapter');

process.stdout.write('TUI/GUI launcher verification: 19/19 checks passed\n');
