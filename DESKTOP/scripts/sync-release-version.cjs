const fs = require('fs');
const path = require('path');

const appRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(appRoot, '..');
const versionFile = path.join(repoRoot, 'VERSION');
const packageFile = path.join(appRoot, 'package.json');
const lockFile = path.join(appRoot, 'package-lock.json');
const gradleFile = path.join(repoRoot, 'android', 'app', 'build.gradle.kts');

function assertVersion(value) {
  if (!/^\d+\.\d+\.\d+$/.test(value)) throw new Error(`version must be semantic X.Y.Z, received ${JSON.stringify(value)}`);
  return value;
}

function versionCode(version) {
  const [major, minor, patch] = version.split('.').map(Number);
  if (major > 214747 || minor > 99 || patch > 99) throw new Error(`version cannot be represented as an Android versionCode: ${version}`);
  return major * 10000 + minor * 100 + patch;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function check(version) {
  const pkg = readJson(packageFile);
  const lock = readJson(lockFile);
  const gradle = fs.readFileSync(gradleFile, 'utf8');
  const failures = [];
  if (pkg.version !== version) failures.push(`DESKTOP/package.json=${pkg.version}`);
  if (lock.version !== version) failures.push(`DESKTOP/package-lock.json=${lock.version}`);
  if (lock.packages?.['']?.version !== version) failures.push(`DESKTOP/package-lock.json packages[\"\"].version=${lock.packages?.['']?.version}`);
  if (!new RegExp(`versionName\\s*=\\s*\"${version.replace(/\./g, '\\.')}\"`).test(gradle)) failures.push('Android versionName differs');
  if (!new RegExp(`versionCode\\s*=\\s*${versionCode(version)}(?:\\D|$)`).test(gradle)) failures.push('Android versionCode differs');
  if (failures.length) throw new Error(`release version ${version} is not synchronized: ${failures.join(', ')}`);
  console.log(`[release-version] desktop=${version} android=${version} versionCode=${versionCode(version)}`);
}

function write(version) {
  fs.writeFileSync(versionFile, `${version}\n`);
  for (const file of [packageFile, lockFile]) {
    const data = readJson(file);
    data.version = version;
    if (file === lockFile && data.packages?.['']) data.packages[''].version = version;
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  }
  const gradle = fs.readFileSync(gradleFile, 'utf8')
    .replace(/versionCode\s*=\s*\d+/, `versionCode = ${versionCode(version)}`)
    .replace(/versionName\s*=\s*"[^"]+"/, `versionName = "${version}"`);
  fs.writeFileSync(gradleFile, gradle);
}

const setIndex = process.argv.indexOf('--set');
if (setIndex >= 0) {
  const next = assertVersion(String(process.argv[setIndex + 1] || '').trim());
  write(next);
}
const canonical = assertVersion(fs.readFileSync(versionFile, 'utf8').trim());
const releaseTag = String(process.env.GITHUB_REF_NAME || '').trim();
if (releaseTag.startsWith('dev-') && releaseTag !== `dev-${canonical}`) {
  throw new Error(`release tag ${releaseTag} does not match bound version dev-${canonical}`);
}
check(canonical);
