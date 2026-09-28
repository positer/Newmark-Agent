'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: npm run test:computer-use-real-model -- --provider DeepSeek|APInebula [--exe PATH] [--evidence NEW_DIRECTORY]\nRuns the isolated sparse ComputerUse GUI scenario against the selected live vision provider. The model is asked to observe only; the existing harness verifies a real computer_use tool call, sparse sensing, fresh screenshot attachment, and semantic completion.');
  process.exit(0);
}

const providerIndex = args.indexOf('--provider');
const provider = providerIndex >= 0 ? String(args[providerIndex + 1] || '').trim() : '';
if (!['deepseek', 'apinebula'].includes(provider.toLowerCase())) {
  console.error('A configured live provider is required. Use --provider DeepSeek or --provider APInebula.');
  process.exit(2);
}

const forwarded = args.filter((value, index) => index !== providerIndex && index !== providerIndex + 1);
const harness = path.join(__dirname, 'test-user-soak-gui.cjs');
const result = spawnSync(process.execPath, [harness, '--cu-sparse-only', '--real-provider', provider, ...forwarded], {
  cwd: path.resolve(__dirname, '..'),
  env: process.env,
  stdio: 'inherit',
});
if (result.error) {
  console.error(`[computer-use-real-model] ${result.error.message}`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status === null ? 1 : result.status;
}
