const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const exePath = path.join(repoRoot, 'release', 'win-unpacked', 'Newmark Agent.exe');
const appAsar = path.join(repoRoot, 'release', 'win-unpacked', 'resources', 'app.asar');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'NewmarkPackagedOcrSmoke-'));
const fixture = path.join(root, 'academic-zh-en-formula.png');
const runner = path.join(root, 'runner.cjs');

try {
  if (!fs.existsSync(exePath) || !fs.existsSync(appAsar)) {
    throw new Error('Final win-unpacked package is missing.');
  }
  const escapedFixture = fixture.replace(/'/g, "''");
  const draw = [
    'Add-Type -AssemblyName System.Drawing',
    '$bitmap = New-Object System.Drawing.Bitmap 1200,360',
    '$graphics = [System.Drawing.Graphics]::FromImage($bitmap)',
    '$graphics.Clear([System.Drawing.Color]::White)',
    '$graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit',
    "$textFont = New-Object System.Drawing.Font('Microsoft YaHei UI',38,[System.Drawing.FontStyle]::Bold)",
    "$mathFont = New-Object System.Drawing.Font('Cambria Math',40,[System.Drawing.FontStyle]::Regular)",
    "$graphics.DrawString('学术影印读取  Academic OCR  20260726',$textFont,[System.Drawing.Brushes]::Black,25,55)",
    "$graphics.DrawString('E = mc²    F = ma    x² = 1/3',$mathFont,[System.Drawing.Brushes]::Black,25,170)",
    `$bitmap.Save('${escapedFixture}',[System.Drawing.Imaging.ImageFormat]::Png)`,
    '$graphics.Dispose(); $bitmap.Dispose(); $textFont.Dispose(); $mathFont.Dispose()',
  ].join('; ');
  const generated = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', draw], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (generated.status !== 0) throw new Error(generated.stderr || 'Could not generate packaged OCR fixture.');

  fs.writeFileSync(runner, `
const path = require('path');
const { LocalOcrEngine } = require(path.join(process.env.NEWMARK_APP_ASAR, 'dist', 'core', 'localOcr.js'));
(async () => {
  const engine = new LocalOcrEngine(process.env.NEWMARK_OCR_ROOT);
  const result = await engine.recognizeFile(process.env.NEWMARK_OCR_FIXTURE);
  await engine.dispose();
  process.stdout.write(JSON.stringify(result));
  if (!result.ok || !result.text.includes('Academic') || !result.text.includes('20260726')) process.exitCode = 2;
})().catch(error => { console.error(error); process.exitCode = 1; });
`, 'utf8');

  const executed = spawnSync(exePath, [runner], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NEWMARK_APP_ASAR: appAsar,
      NEWMARK_OCR_FIXTURE: fixture,
      NEWMARK_OCR_ROOT: path.join(root, 'runtime-root'),
    },
  });
  if (executed.status !== 0) throw new Error(executed.stderr || executed.stdout || `Packaged OCR exited ${executed.status}.`);
  const result = JSON.parse(executed.stdout);
  const formulaTokens = ['E', 'mc', 'F', 'ma', 'x', '1', '3'];
  const formulaRecall = formulaTokens.filter(token => String(result.text).toLowerCase().includes(token.toLowerCase())).length / formulaTokens.length;
  if (formulaRecall < 0.7) throw new Error(`Packaged formula token recall too low: ${formulaRecall}`);
  console.log(JSON.stringify({
    ok: true,
    packaged: true,
    languages: result.languages,
    formulaTokenRecall: formulaRecall,
    text: result.text,
  }));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
