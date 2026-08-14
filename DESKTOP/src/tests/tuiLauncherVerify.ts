import * as fs from 'node:fs';
import * as path from 'node:path';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`TUI launcher verification failed: ${message}`);
}

const desktopRoot = path.resolve(__dirname, '..', '..');
const launcherSource = fs.readFileSync(path.join(desktopRoot, 'src', 'launcher.ts'), 'utf8');
const helpSource = fs.readFileSync(path.join(desktopRoot, 'src', 'cli-help.ts'), 'utf8');
const cliCommandsSource = fs.readFileSync(path.join(desktopRoot, 'src', 'cli-commands.ts'), 'utf8');
const mainSource = fs.readFileSync(path.join(desktopRoot, 'src', 'main.ts'), 'utf8');
const batchSource = fs.readFileSync(path.join(desktopRoot, 'newmark.bat'), 'utf8');
const tuiAppSource = fs.readFileSync(path.join(desktopRoot, '..', 'TUI', 'src', 'app.js'), 'utf8');
const tuiAdapterSource = fs.readFileSync(path.join(desktopRoot, '..', 'TUI', 'src', 'adapters', 'core-runtime-adapter.js'), 'utf8');
const consoleLauncherSource = fs.readFileSync(path.join(desktopRoot, 'scripts', 'create-console-launcher.cjs'), 'utf8');
const consoleWrapperSource = fs.readFileSync(path.join(desktopRoot, 'scripts', 'newmark-console-wrapper.c'), 'utf8');
const afterPackSource = fs.readFileSync(path.join(desktopRoot, 'scripts', 'after-pack-win-icon.cjs'), 'utf8');
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
assert(launcherSource.includes('function resolveTuiWorkspacePath')
  && launcherSource.includes("return pathArgValue(values, '--root') ? root : process.cwd()")
  && launcherSource.includes('workspacePath: resolveTuiWorkspacePath(args, root)'),
  'Node launcher must bind an explicit isolated root as the default TUI workspace while preserving caller cwd without --root');
assert(launcherSource.includes('if (path.resolve(r) === path.resolve(userRuntimeRoot())) migrateLegacyRuntimeRoot(r)'),
  'Node launcher must restrict legacy AppData migration to the canonical user runtime and keep explicit --root isolated');
assert(tuiAdapterSource.includes('function safeWorkspacePath(root, candidate)')
  && tuiAdapterSource.includes('isProtectedInstallPath')
  && tuiAdapterSource.includes('safeWorkspacePath,'),
  'TUI must redirect an installation-directory caller cwd to the writable runtime root before workspace registration');
assert(mainSource.includes("arg.toLowerCase() === '--tui'"), 'packaged Electron entry must recognize case-insensitive --TUI');
assert(mainSource.includes("!args.includes('--gui')"), 'source Electron entry must preserve explicit --GUI startup');
assert(mainSource.includes("require('./tui/src/app')"), 'packaged Electron entry must load the bundled TUI');
assert(mainSource.includes('setWindowsConsoleMode()') && mainSource.includes('process.env.NEWMARK_FORCE_TTY'),
  'packaged Electron entry must enable and later restore Windows console Raw Mode');
assert(mainSource.includes("path.basename(process.execPath).toLowerCase() === 'newmark.exe'")
  && mainSource.includes("path.basename(process.execPath).toLowerCase() === 'newmark console runtime.exe'")
  && mainSource.includes("ELECTRON_RUN_AS_NODE: '1'"),
  'packaged console executables must hand off --TUI to their terminal Node mode');
assert(/if \/i "%1"=="--TUI"/i.test(batchSource), 'portable batch launcher must keep --TUI attached to the terminal');
assert(batchSource.includes('"%NEWMARK_ROOT%\\Newmark.exe" %*')
  && !batchSource.includes('set "ELECTRON_RUN_AS_NODE=1"'),
  'packaged Windows TUI launcher must use the console wrapper, which owns the terminal Node handoff');
assert(batchSource.includes('call :capture_exit')
  && batchSource.includes('set "NEWMARK_EXIT=%ERRORLEVEL%"')
  && batchSource.includes('endlocal & exit /b %NEWMARK_EXIT%'),
  'portable Windows CLI launcher must preserve the child exit code across endlocal');
assert(!/%\*\s+--root\s+"%NEWMARK_ROOT%"/i.test(batchSource), 'TUI launcher must not use the install directory as mutable runtime root');
assert(tuiAppSource.includes('process.env.NEWMARK_FORCE_TTY === "1"')
  && tuiAppSource.includes('function resolveTuiWorkspacePath')
  && tuiAppSource.includes('const workspacePath = resolveTuiWorkspacePath'),
  'TUI must support the packaged Windows PTY fallback and keep explicit root startup isolated by default');
assert(consoleLauncherSource.includes('newmark-console-wrapper.c')
  && consoleLauncherSource.includes('spawnSync')
  && consoleLauncherSource.includes('patchConsoleSubsystem')
  && consoleWrapperSource.includes('CreateProcessW')
  && consoleWrapperSource.includes('Newmark Console Runtime.exe')
  && consoleWrapperSource.includes('append_argument(command_line, &cursor, L"--")'),
  'Windows package must include a console Newmark.exe wrapper plus a console-subsystem Electron runtime that injects the Electron -- argument boundary for CLI/TUI/SSH');
assert(afterPackSource.includes('createConsoleLauncher(context.appOutDir)'),
  'the direct electron-builder Windows path must create the console wrapper before MSI project generation');
assert(packageJson.scripts?.['dist:portable']?.startsWith('npm run test:full-release')
  && msiHookSource.includes('Name="PATH"') && msiHookSource.includes('Value="[APPLICATIONFOLDER]"'),
  'MSI must register the installed console launcher globally through PATH');
assert(packageJson.scripts?.['release:console-wrapper-boundary-stress']
  && fs.existsSync(path.join(desktopRoot, 'scripts', 'release-console-wrapper-boundary-stress.cjs')),
  'release gates must retain the packaged console argument-boundary and spaced-root stress probe');
assert(packageJson.scripts?.['release:safe-shared-root-restart-stress']
  && fs.existsSync(path.join(desktopRoot, 'scripts', 'release-safe-shared-root-restart-stress.cjs')),
  'release gates must retain the protected-cwd shared GUI/TUI/CLI restart stress probe');
assert(packageJson.bin?.newmark === 'dist/launcher.js', 'npm global command must route newmark to dist/launcher.js');
assert(packageJson.scripts?.build?.includes('build-tui.cjs'), 'normal build must include the TUI copy step');
assert(packageJson.scripts?.['test:full-release']?.includes('test:desktop:built')
  && packageJson.scripts?.['test:full-release']?.includes('test:tui:built')
  && packageJson.scripts?.['test:full-release']?.includes('test:ssh-tui-stress:built')
  && packageJson.scripts?.['test:full-release']?.includes('test:wsl-tui-stress:built')
  && packageJson.scripts?.['test:full-release']?.includes('test:cli:built')
  && packageJson.scripts?.['test:full-release']?.includes('test:gui-tui-cli-stress:built'),
  'full release regression must run DESKTOP, TUI, SSH, WSL/Linux, CLI, and cross-surface stress');
assert(launcherSource.includes('const isHelpArg')
  && launcherSource.includes('const hasCliCommand')
  && launcherSource.includes('const cliCommand = args.find')
  && launcherSource.includes('cliHelpRequested(args)')
  && launcherSource.includes('cliCommandHelp(cliCommand)')
  && launcherSource.includes('!hasCliCommand')
  && launcherSource.includes('newmarkHelpText(currentAppVersion())')
  && launcherSource.includes('process.exit(0)'),
  'console launcher must terminate top-level and command-specific --help/--version before first-run initialization without swallowing CLI command flags');
assert(launcherSource.includes('newmarkFlowHelpText()')
  && launcherSource.includes('newmarkEditHelpText()')
  && helpSource.includes('Newmark Flow command:')
  && helpSource.includes('Newmark editor command:'),
  'console launcher must expose command-specific Flow and editor help before runtime initialization');
assert(mainSource.includes('const isHelpArg')
  && mainSource.includes('const hasCliCommand')
  && mainSource.includes('const cliCommand = args.find')
  && mainSource.includes('cliHelpRequested(args)')
  && mainSource.includes('cliCommandHelp(cliCommand)')
  && mainSource.includes('!hasCliCommand')
  && mainSource.includes('if (isHelpArg)')
  && mainSource.includes("newmarkHelpText(currentAppVersion())"),
  'packaged Electron entry must terminate top-level and command-specific --help before GUI/TUI/server startup without swallowing CLI command flags');
assert(mainSource.includes('newmarkFlowHelpText()') && mainSource.includes('newmarkEditHelpText()'),
  'packaged Electron entry must expose command-specific Flow and editor help before GUI startup');
assert(helpSource.includes('cliCommandUsage()')
  && cliCommandsSource.includes('Newmark CLI non-interactive commands:')
  && helpSource.includes('Newmark Agent.exe [--gui|--TUI|--cli]'),
  'shared help text must expose the product command surface to a new tester');
assert(packageJson.scripts?.['dist:portable']?.startsWith('npm run test:full-release'),
  'Windows portable/MSI packaging must be gated by the full surface regression');
assert(fs.existsSync(path.join(copiedTuiRoot, 'src', 'app.js')), 'compiled distribution must contain the TUI runtime');
assert(fs.existsSync(path.join(copiedTuiRoot, 'src', 'adapters', 'core-runtime-adapter.js')), 'compiled distribution must contain the real Core adapter');

process.stdout.write('TUI/GUI launcher verification: 28/28 checks passed\n');
