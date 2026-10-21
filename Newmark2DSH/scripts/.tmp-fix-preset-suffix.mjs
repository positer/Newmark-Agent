// One-shot, idempotent repair: drop the persona `suffix` row from the Dev and
// rDev preset declarations. DSH 0.2.1-rc.1 registers only provider/model as
// prompt variables, so `suffix: Your working directory is {{cwd}}.` fails every
// turn at prompt assembly. The shipped presets dropped the same row.
import { readFileSync, writeFileSync } from 'node:fs';

const targets = [
  'C:/Users/12252/Desktop/Files/Code/Newmark Agent/Newmark2DSH/packages/newmark-core/cordis.patch.yml',
  'C:/Users/12252/.dsh/profiles/desktop/node_modules/newmark2dsh/cordis.patch.yml',
];

const comment = [
  '# No `suffix` row: 0.2.1-rc.1 registers only `provider` and `model` as',
  '# prompt variables, so a cwd-interpolated suffix fails the whole turn at',
  '# prompt assembly ("unknown prompt variable") and every session on this',
  '# preset dies before its first model request. The working directory',
  '# reaches the model through the runtime context, as the shipped presets do.',
];

for (const target of targets) {
  let text = readFileSync(target, 'utf8');
  const oldBlock = '            config:\n              suffix: Your working directory is {{cwd}}.\n              prefix: |';
  const newBlock = ['            config:', ...comment.map((line) => `              ${line}`), '              prefix: |'].join('\n');
  const count = text.split(oldBlock).length - 1;
  if (count !== 2) {
    console.log(`SKIP ${target}: anchor count ${count}`);
    continue;
  }
  writeFileSync(target, text.split(oldBlock).join(newBlock), 'utf8');
  console.log(`PATCHED ${target}: ${count} occurrences`);
}
