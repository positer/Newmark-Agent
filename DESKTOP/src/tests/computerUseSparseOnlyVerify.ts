import * as fs from 'node:fs';
import * as path from 'node:path';

type Check = { ok: boolean; label: string };

const desktopRoot = path.resolve(__dirname, '..', '..');
const sourceRoot = path.join(desktopRoot, 'src');
const checks: Check[] = [];

function check(value: unknown, label: string): void {
  checks.push({ ok: !!value, label });
  console.log(`${value ? 'PASS' : 'FAIL'}: ${label}`);
}

function sourceFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory()
      ? sourceFiles(fullPath)
      : /\.(?:ts|tsx|js|cjs|mjs)$/.test(entry.name) ? [fullPath] : [];
  });
}

const productionFiles = [
  ...sourceFiles(path.join(sourceRoot, 'core')),
  ...sourceFiles(path.join(sourceRoot, 'tools')),
  ...sourceFiles(path.join(sourceRoot, 'llm')),
];
const forbidden = /onnxruntime-node|NEWMARK_CU_(?:NMEP|LAB_ROOT)|\b(?:CU_NMEP|NES-T|NMEP)\b|artifactDiscovery|CuStableEdgeModelProvider/i;
const matches: string[] = [];
for (const file of productionFiles) {
  const text = fs.readFileSync(file, 'utf8');
  if (forbidden.test(text)) matches.push(path.relative(sourceRoot, file));
}
check(matches.length === 0, `production runtime has no CULab artifact, local inference, or ONNX hooks (${matches.join(', ') || 'clean'})`);
check(!fs.existsSync(path.join(sourceRoot, 'core', 'computerUse')), 'retired app-local model/ABI module tree is absent');
check(!fs.existsSync(path.join(desktopRoot, 'dist', 'core', 'computerUse')), 'clean build contains no stale compiled local model module');

const packageJson = JSON.parse(fs.readFileSync(path.join(desktopRoot, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
};
check(!packageJson.dependencies?.['onnxruntime-node'] && !packageJson.optionalDependencies?.['onnxruntime-node'],
  'desktop package has no onnxruntime-node dependency');
const scriptText = Object.values(packageJson.scripts || {}).join('\n');
check(!/emit-cu-contract-schema|computerUse(?:EdgeModel|EdgeTrackHint|Weightless|PerceptionFallback|HighMotion|SceneVersion|TemporalIdentity|StaleAction|VisionCapability)/i.test(scriptText),
  'build and test scripts no longer expose retired local model gates');

const computerUseSource = fs.readFileSync(path.join(sourceRoot, 'tools', 'computerUse.ts'), 'utf8');
const computerUseToolSchemaSource = fs.readFileSync(path.join(sourceRoot, 'tools', 'index.ts'), 'utf8');
check(/sparseWaitMs/.test(computerUseSource)
  && /sparse_wait_ms/.test(computerUseToolSchemaSource)
  && /coarse-grid-luminance-change-wakeup/.test(computerUseSource)
  && /fresh_full_observation/.test(computerUseSource)
  && /vision_image_path/.test(computerUseSource),
'production CU uses sparse wake-up followed by a fresh full observation');

const runnerSource = fs.readFileSync(path.join(sourceRoot, 'core', 'agentKernelRunner.ts'), 'utf8');
check(/computerUseVisionImageInput/.test(runnerSource)
  && /vision_image_path/.test(runnerSource)
  && /unlinkSync\(imagePath\)/.test(runnerSource),
'full-observation image is passed through the provider input path and deleted after one use');

check(fs.existsSync(path.join(sourceRoot, 'core', 'computerUseSession.ts')),
  'production conversation-bound Computer Use session remains available');

const failed = checks.filter(item => !item.ok);
console.log(`\nComputer Use sparse-only verification: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) process.exitCode = 1;
