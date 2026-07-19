const path = require('path');
const { patchAndVerify, patchExeIdentity } = require('./patch-win-exe-icon.cjs');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;

  const root = path.resolve(__dirname, '..');
  const exePath = path.join(context.appOutDir, 'Newmark Agent.exe');
  const iconPath = path.join(root, 'assets', 'icon.ico');
  patchExeIdentity(exePath);
  const verified = patchAndVerify(exePath, iconPath);
  console.log(`[after-pack-win-icon] verified ${exePath} ${JSON.stringify(verified)}`);
};
