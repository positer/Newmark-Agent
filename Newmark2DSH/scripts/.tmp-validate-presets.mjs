// Read-only validation: parse the three newmark patch files with the loader's
// YAML dialect neutralised (`!!js` scalars become inert markers, exactly as the
// Cordis loader represents them), then assert the Dev/rDev persona rows carry
// no `suffix` and no `{{...}}` prompt variables.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire('C:/Users/12252/.dsh/profiles/desktop/cordis.yml');
const yaml = require('js-yaml');

const files = [
  'C:/Users/12252/Desktop/Files/Code/Newmark Agent/Newmark2DSH/packages/newmark-core/cordis.patch.yml',
  'C:/Users/12252/.dsh/profiles/desktop/node_modules/newmark2dsh/cordis.patch.yml',
  'C:/Users/12252/.dsh/profiles/desktop/cordis.patch.yml',
];

// The loader dialect: `!!js <scalar>` is a loader expression. Replace it with an
// inert string so a plain YAML parser can read the structure.
function neutralise(text) {
  return text
    .replace(/!!js\s+"([^"]*)"/g, (_, expr) => JSON.stringify(`__jsExpr:${expr}`))
    .replace(/!!js\s+'([^']*)'/g, (_, expr) => JSON.stringify(`__jsExpr:${expr}`))
    .replace(/!!js\s+([^\n#]+)/g, (_, expr) => JSON.stringify(`__jsExpr:${expr.trim()}`));
}

function presetsOf(rows) {
  const out = new Map();
  for (const row of rows) {
    if (row && row.name === '@deepseek-ai/dsh-agent-preset' && row.config?.id) {
      out.set(row.config.id, row);
    }
    for (const nested of row?.insert ?? []) {
      if (nested && nested.name === '@deepseek-ai/dsh-agent-preset' && nested.config?.id) {
        out.set(nested.config.id, nested);
      }
    }
  }
  return out;
}

let failed = false;
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const rows = yaml.load(neutralise(text));
  const presets = presetsOf(rows);
  const ids = [...presets.keys()].sort().join(',');
  const problems = [];
  for (const [id, preset] of presets) {
    const persona = (preset.config.plugins ?? []).find((p) => p?.id === 'persona');
    if (!persona) problems.push(`${id}: no persona row`);
    else {
      if ('suffix' in (persona.config ?? {})) problems.push(`${id}: persona.suffix still present`);
      const variables = JSON.stringify(persona.config ?? {}).match(/\{\{[^}]+\}\}/g) ?? [];
      const unknown = variables.filter((v) => !['{{model}}', '{{provider}}'].includes(v));
      if (unknown.length) problems.push(`${id}: unknown prompt variables ${unknown.join(' ')}`);
    }
  }
  console.log(JSON.stringify({ file, presets: ids, problems }, null, 2));
  if (problems.length) failed = true;
}
process.exit(failed ? 1 : 0);
