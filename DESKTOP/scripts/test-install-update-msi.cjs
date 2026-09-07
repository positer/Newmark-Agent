// Exercises the built-in installer boundary without running MSI or requesting UAC.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const childProcess = require('node:child_process');
const ts = require('typescript');
const sourcePath = path.resolve(__dirname, '../src/core/installUpdate.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const moduleUnderTest = new Module(sourcePath, module);
moduleUnderTest.filename = sourcePath;
moduleUnderTest.paths = Module._nodeModulePaths(path.dirname(sourcePath));
moduleUnderTest._compile(ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
}}).outputText, sourcePath);
const { installMsiPackage, executeManagedMsiInstall } = moduleUnderTest.exports;
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark installer core '));
const originalSpawn = childProcess.spawnSync;
const originalExec = childProcess.execFileSync;
let calls = [];
let receipt;
let shellExit = 0;
const packagePath = path.join(fixture, 'Newmark Agent test.msi');
fs.writeFileSync(packagePath, 'not an executable MSI: mocked boundary only');
childProcess.spawnSync = (file, args) => {
  calls.push({ file, args });
  assert.equal(file, 'powershell.exe');
  assert.ok(args.includes('-File'));
  assert.ok(args.includes(packagePath));
  const evidence = args[args.indexOf('-EvidenceDirectory') + 1];
  if (receipt) fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(receipt));
  return { status: shellExit, stdout: '', stderr: '' };
};
try {
  let result = installMsiPackage(packagePath, { logDir: fixture, allowElevate: false });
  assert.equal(result.ok, false, 'PowerShell exit 0 without a receipt must fail');
  assert.ok(calls.at(-1).args.includes('-NoElevate'));
  receipt = { Success: false, Error: 'Installed ASAR mismatch' };
  result = installMsiPackage(packagePath, { logDir: fixture });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Installed ASAR mismatch');
  receipt = { Success: true, Steps: [{ ExitCode: 0 }] };
  shellExit = 1;
  result = installMsiPackage(packagePath, { logDir: fixture });
  assert.equal(result.ok, false, 'worker process failure must reject a success receipt');
  shellExit = 0;
  result = installMsiPackage(packagePath, { logDir: fixture });
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  receipt = { Success: true, Steps: [{ ExitCode: 3010 }] };
  result = installMsiPackage(packagePath, { logDir: fixture });
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 3010);
  let registrationReads = 0;
  childProcess.execFileSync = (file, args) => {
    if (file === 'where.exe') throw new Error('no legacy executables in fixture');
    const script = args.at(-1);
    if (script.includes('Win32_Process')) return '[]';
    if (script.includes('Uninstall')) {
      registrationReads++;
      return registrationReads === 1
        ? JSON.stringify([{ PSChildName: '{OLD-PRODUCT}', DisplayName: 'Newmark Agent', InstallLocation: fixture }])
        : '[]';
    }
    throw new Error(`Unexpected subprocess: ${file}`);
  };
  calls = [];
  const managed = executeManagedMsiInstall(packagePath, { stopConfirmed: true, removeLegacyConfirmed: true, logDir: fixture });
  assert.equal(managed.ok, true);
  assert.equal(calls.length, 1, 'upgrade must use one verified helper, no per-product elevation');
  assert.deepEqual(managed.uninstalled, ['{OLD-PRODUCT}']);
  const packageConfig = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));
  assert.ok(packageConfig.build.extraResources.some(entry => entry.to === 'installer/install-windows-msi.ps1'));
  const wixTemplate = fs.readFileSync(path.resolve(__dirname, '../node_modules/app-builder-lib/templates/msi/template.xml'), 'utf8');
  assert.match(wixTemplate, /<Product Id="\*"/);
  assert.match(wixTemplate, /AllowSameVersionUpgrades="yes"/);
  console.log('PASS built-in MSI: no false success, explicit no-elevation, receipt failure, reboot result, one upgrade worker, packaged helper, same-version authoring');
} finally {
  childProcess.spawnSync = originalSpawn;
  childProcess.execFileSync = originalExec;
  const root = path.resolve(fixture);
  assert.ok(root.startsWith(path.resolve(os.tmpdir()) + path.sep));
  assert.ok(path.basename(root).startsWith('newmark installer core '));
  fs.rmSync(root, { recursive: true, force: true });
}

// Keep the real MSI formatting/sequence regression on the existing installer
// verification entrypoint, including releases built from a prepared app image.
const authoring = originalSpawn(process.execPath, [path.join(__dirname, 'test-msi-authoring.cjs')], {
  stdio: 'inherit',
  windowsHide: true,
});
if (authoring.error) throw authoring.error;
assert.equal(authoring.status, 0, 'native MSI authoring regression must pass');
