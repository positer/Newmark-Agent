#!/usr/bin/env node
/**
 * Newmark2DSH 0.3.16 — the release/install heartbeat, and the git round-trip proof.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The 0.3.16 heartbeat work has to move from source to a *loaded* plugin. That move has
 * exactly three places it can lie, and every one of them is checked here rather than
 * asserted in prose:
 *
 *   1. "The tarball carries the source."  A files pattern that stops matching ships a package
 *      that installs cleanly and then cannot import. So the tarball is re-read, member by
 *      member, and every member is hashed against the file on disk.
 *   2. "The profile installed it."  The profile consumes newmark2dsh as a pnpm file: tarball
 *      dependency (evidence: the profile package.json and pnpm-lock.yaml), not as a copy. So
 *      the install is that same pnpm install, and afterwards every installed file is hashed
 *      against the tarball member it came from.
 *   3. "It was pushed."  A push can be issued and not land. So the push is followed by a pull
 *      and by a network read of the remote ref, and the commit itself is inspected to prove it
 *      contains only the paths the caller named.
 *
 * WHY THE COMMIT NAMES THE PATHS TWICE, AND IS INSPECTED BEFORE IT IS PUSHED
 * -------------------------------------------------------------------------
 * This workspace's real index already carries thousands of pre-staged paths that belong to
 * nobody's task. "git add -A" and a bare "git commit" would publish all of them. So the script
 *
 *   - runs "git add -- <paths>": a pathspec, never -A, and never a directory the caller did not
 *     name, and then MEASURES the index delta to prove only those entries changed;
 *   - runs "git commit -- <paths>": git's own partial commit, which ignores whatever else the
 *     index has staged, so the unrelated entries stay staged and stay uncommitted;
 *   - reads the new commit's own file list BACK, and refuses to push if it names anything the
 *     caller did not.
 *
 * The last step is the one that matters: a commit is only dangerous once it has been pushed, and
 * every check above runs before "git push".
 *
 * WHY THE TARBALL NAME CARRIES A CONTENT HASH
 * -------------------------------------------
 * pnpm resolves a file: dependency to a store entry keyed by the integrity recorded in the
 * lockfile. If the bytes change while the filename does not, a re-run can silently keep the
 * previous contents. Naming the tarball with the first 8 hex of its sha256 makes any content
 * change a new specifier, which is what makes "re-runnable" a property of the mechanism instead
 * of a hope. The installed directory is removed before the install for the same reason.
 *
 * HOW TO RUN
 * ----------
 *   node Newmark2DSH/scripts/release-heartbeat-0.3.16.mjs pack --dry-run
 *       Packs, verifies tarball-vs-source, prints the plan. Touches nothing outside a temp dir.
 *   node Newmark2DSH/scripts/release-heartbeat-0.3.16.mjs pack --apply
 *       Backs the installed plugin up, installs, verifies installed-vs-source per file.
 *   node Newmark2DSH/scripts/release-heartbeat-0.3.16.mjs push-pull --paths <p> [<p> ...]
 *       Stages ONLY those paths (temporary index), commits, pushes, pulls, proves the round trip.
 *
 * "pack" with neither --dry-run nor --apply refuses: a release script whose default mode writes
 * into the live profile is the exact failure this task exists to prevent.
 *
 * Exit codes: 0 ok · 1 a step ran and failed · 2 usage refusal · 3 preflight refusal (nothing was
 * written). The machine-readable receipt is the ONLY thing written to stdout; progress lines go
 * to stderr.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const BUNDLE = 'newmark2dsh';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const NEWMARK = path.resolve(HERE, '..');
const WORKSPACE = path.resolve(NEWMARK, '..');
const PACKAGE_DIR = path.join(NEWMARK, 'packages', 'newmark-core');
const EVIDENCE_DIR = path.join(NEWMARK, 'evidence', '20261017-heartbeat-barrier');
const TARBALL_SLUG = 'heartbeat';
/** Paths this script must never stage, whatever the caller asks for. */
const FORBIDDEN_PATH_PREFIXES = ['Newmark2DSH/evidence/cu-hidden-agent/'];

/* --------------------------------------------------------------------- output */

function say(message) {
  process.stderr.write(message + '\n');
}

function refuse(code, message, receipt) {
  say('refusing: ' + message);
  if (receipt) {
    receipt.ok = false;
    receipt.refused = message;
    process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
  }
  process.exit(code);
}

/* ------------------------------------------------------------------ plumbing */

function stamp() {
  const now = new Date();
  const pad = (value, width) => String(value).padStart(width === undefined ? 2 : width, '0');
  return (
    String(now.getFullYear()) + pad(now.getMonth() + 1) + pad(now.getDate()) +
    '-' + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds()) +
    '-' + pad(now.getMilliseconds(), 3)
  );
}

function display(command, args) {
  const shown = path.basename(command).toLowerCase() === path.basename(process.execPath).toLowerCase() ? 'node' : command;
  return [shown].concat(args.map((arg) => (/[\s"]/.test(arg) ? JSON.stringify(arg) : arg))).join(' ');
}

function spawn(command, args, options) {
  const settings = options === undefined ? {} : options;
  const startedAt = Date.now();
  let result;
  try {
    result = spawnSync(command, args, {
      cwd: settings.cwd,
      env: settings.env === undefined ? process.env : settings.env,
      // Some queries (git check-ignore) only answer a list handed to them on stdin; without this
      // the call returns nothing and a check that reads its output silently never fires.
      input: settings.input,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      timeout: settings.timeoutMs === undefined ? 1200000 : settings.timeoutMs,
    });
  } catch (error) {
    return { display: display(command, args), exitCode: null, stdout: '', stderr: String(error && error.message ? error.message : error), failed: true, ms: Date.now() - startedAt };
  }
  return {
    display: display(command, args),
    exitCode: result.status,
    signal: result.signal === null ? undefined : result.signal,
    stdout: result.stdout === null || result.stdout === undefined ? '' : result.stdout,
    stderr: result.stderr === null || result.stderr === undefined ? '' : result.stderr,
    failed: result.status !== 0,
    error: result.error ? String(result.error.message) : undefined,
    ms: Date.now() - startedAt,
  };
}

/** git is a real executable on PATH on both platforms, so no shell is needed or wanted. */
function git(args, options) {
  const settings = options === undefined ? {} : options;
  return spawn('git', args, { cwd: settings.cwd === undefined ? WORKSPACE : settings.cwd, env: settings.env });
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sha256File(file) {
  return sha256(fs.readFileSync(file));
}

/** Every regular file under dir, as dir-relative POSIX paths, sorted. */
function walkFiles(dir) {
  const found = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) found.push(path.relative(dir, full).split(path.sep).join('/'));
    }
  };
  if (fs.existsSync(dir)) visit(dir);
  return found.sort();
}

/**
 * Describe one installed file. The link fields are the point: the profile also declares two
 * components as junctions into the live source tree, so a hash that matches the source is not by
 * itself evidence that the tarball was installed. A path that is a reparse point is recorded as
 * one, and the install verification refuses to count it.
 */
function describeFile(full) {
  const stats = fs.lstatSync(full);
  const isLink = stats.isSymbolicLink();
  return {
    isLink,
    nlink: isLink ? 0 : fs.statSync(full).nlink,
    target: isLink ? fs.realpathSync(full) : undefined,
  };
}

/**
 * The first reparse point on the path from root down to full, if any. A per-file lstat is not
 * enough: if a whole DIRECTORY were a junction (as two of the profile's own component entries
 * are), every file below it would look like an ordinary file whose bytes happen to match — which
 * is exactly the vacuous pass this check exists to prevent.
 */
function linkOnPath(root, full) {
  const parts = path.relative(root, full).split(path.sep);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    const stats = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stats === undefined) return { missing: current };
    if (stats.isSymbolicLink()) return { link: current, target: fs.realpathSync(current) };
  }
  return undefined;
}

function hashTree(dir) {
  return walkFiles(dir).map((relative) => {
    const full = path.join(dir, relative);
    const description = describeFile(full);
    const entry = { path: relative, sha256: sha256File(full), bytes: fs.statSync(full).size, link: description.isLink, nlink: description.nlink };
    if (description.isLink) entry.linkTarget = description.target;
    return entry;
  });
}

/* ------------------------------------------------------------- tool discovery */

/**
 * npm and pnpm are launched as "node <cli.js>" rather than through their .cmd/.ps1 shims:
 * Node 24 refuses to spawn a .cmd without a shell, and going through a shell would make the
 * recorded command depend on quoting rules instead of on the argv actually passed.
 */
function resolveNpmCli() {
  const candidate = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return fs.existsSync(candidate) ? candidate : undefined;
}

function resolvePnpmCli() {
  const appData = process.env.APPDATA === undefined ? path.join(os.homedir(), 'AppData', 'Roaming') : process.env.APPDATA;
  const candidates = [
    path.join(appData, 'npm', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
    path.join(appData, 'npm', 'node_modules', 'pnpm', 'bin', 'pnpm.js'),
  ];
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  return undefined;
}

/* ------------------------------------------------------- a minimal tar reader */

function cstr(buffer, start, length) {
  const limit = start + length;
  const end = buffer.indexOf(0, start);
  const stop = end === -1 || end > limit ? limit : end;
  return buffer.toString('utf8', start, stop);
}

/**
 * Read a gzipped tar into its members. Hand-rolled on purpose: the SHA-256 this script asserts
 * is over the bytes the tarball actually holds, and asking the archiver that wrote the file to
 * confirm its own output would be asking the wrong witness. Anything the reader does not
 * recognise REFUSES rather than being skipped, so an unparsed member can never look verified.
 */
function readTarMembers(tarball, label) {
  const archive = zlib.gunzipSync(fs.readFileSync(tarball));
  const members = [];
  const meta = [];
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    let allZero = true;
    for (const byte of header) if (byte !== 0) { allZero = false; break; }
    if (allZero) break;
    const name = cstr(header, 0, 100);
    const prefix = cstr(header, 345, 155);
    const sizeText = cstr(header, 124, 12).trim();
    const size = sizeText === '' ? 0 : Number.parseInt(sizeText, 8);
    const typeFlag = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    if (!Number.isFinite(size) || size < 0) throw new Error(label + ': unreadable size field for member ' + JSON.stringify(name));
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > archive.length) throw new Error(label + ': member ' + JSON.stringify(name) + ' runs past the end of the archive');
    const full = (prefix === '' ? name : prefix + '/' + name).replace(/^\.\//, '');
    if (typeFlag === '0') members.push({ path: full, bytes: size, sha256: sha256(archive.subarray(dataStart, dataEnd)) });
    else meta.push({ path: full, typeFlag });
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  // The two zero blocks that end a tar may be followed by blocking-factor padding; anything
  // that is NOT zero there means the reader stopped early and the member list is incomplete.
  for (let index = offset; index < archive.length; index += 1) {
    if (archive[index] !== 0) throw new Error(label + ': non-zero bytes after the final member at ' + index + '; refusing to trust a partial member list');
  }
  const unexpected = meta.filter((entry) => entry.typeFlag !== 'x' && entry.typeFlag !== 'g' && entry.typeFlag !== '5');
  if (unexpected.length > 0) throw new Error(label + ': unsupported tar member types ' + JSON.stringify(unexpected));
  return { members, meta };
}

/* ------------------------------------------------------------- path handling */

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Remove the materialised package without ever following a link into its target. On Windows
 * "fs.rmSync(dir, { recursive: true })" against a directory junction can recurse INTO the
 * junction's target, so if the installed entry were ever a junction (the profile already uses
 * junctions for two other packages) the source tree would be deleted. A reparse point is removed
 * with unlinkSync, which takes the link and leaves the target alone — the same distinction
 * verify-newmark-core-reinstall.mjs records for the same reason.
 */
function removeInstalledDir(dir) {
  const stats = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (stats === undefined) return 'absent';
  if (stats.isSymbolicLink()) {
    fs.unlinkSync(dir);
    return 'unlinked-reparse-point';
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return 'removed-directory';
}

/* --------------------------------------------------------------- install core */

function profileDirFor(options) {
  if (options.profile !== undefined && options.profile !== null) return path.resolve(options.profile);
  if (typeof process.env.DSH_PROFILE_DIR === 'string' && process.env.DSH_PROFILE_DIR.length > 0) return path.resolve(process.env.DSH_PROFILE_DIR);
  return path.join(os.homedir(), '.dsh', 'profiles', 'desktop');
}

function installedState(profileDir) {
  const installedDir = path.join(profileDir, 'node_modules', BUNDLE);
  const manifest = readJson(path.join(installedDir, 'package.json'));
  const exists = fs.existsSync(installedDir);
  return { installedDir, exists, version: manifest === undefined ? null : manifest.version, fileCount: exists ? walkFiles(installedDir).length : 0 };
}

function profileFileHashes(profileDir) {
  const files = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.yml', 'cordis.patch.yml'];
  const hashes = {};
  for (const name of files) {
    const full = path.join(profileDir, name);
    hashes[name] = fs.existsSync(full) ? sha256File(full) : null;
  }
  return hashes;
}

/* ------------------------------------------------------------------ arguments */

function parseArguments(argv) {
  const options = { command: 'pack', dryRun: false, apply: false, profile: undefined, repo: undefined, paths: [], message: undefined, branch: 'master', includeIgnored: false, help: false, unknown: [] };
  let index = 0;
  if (argv.length > 0 && !argv[0].startsWith('-')) {
    options.command = argv[0];
    index = 1;
  }
  for (; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--apply') options.apply = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--profile') options.profile = argv[++index];
    else if (argument.startsWith('--profile=')) options.profile = argument.slice('--profile='.length);
    else if (argument === '--message') options.message = argv[++index];
    else if (argument.startsWith('--message=')) options.message = argument.slice('--message='.length);
    else if (argument === '--branch') options.branch = argv[++index];
    else if (argument === '--repo') options.repo = argv[++index];
    else if (argument.startsWith('--repo=')) options.repo = argument.slice('--repo='.length);
    // An ignored path is refused by default because "git add" would silently omit it; the caller
    // who has looked at the rule and still wants it must say so, and the receipt records that.
    else if (argument === '--include-ignored') options.includeIgnored = true;
    else if (argument === '--paths') {
      while (index + 1 < argv.length && !argv[index + 1].startsWith('--')) options.paths.push(argv[++index]);
    } else options.unknown.push(argument);
  }
  return options;
}

function usage() {
  say('usage:');
  say('  release-heartbeat-0.3.16.mjs pack [--dry-run | --apply] [--profile <dir>]');
  say('  release-heartbeat-0.3.16.mjs push-pull --paths <path> [<path> ...] [--message <text>] [--branch master] [--repo <dir>]');
  say('                                 [--dry-run] [--include-ignored]');
  say('' );
  say('  push-pull --dry-run validates the list and prints the plan without staging or pushing.');
  say('  push-pull refuses a git-ignored path unless --include-ignored is given, and then force-adds');
  say('  only that named path (never -A).');
}

/* ------------------------------------------------------------------ pack/install */

function packAndInstall(options) {
  const mode = options.dryRun ? 'dry-run' : 'apply';
  const profileDir = profileDirFor(options);
  const receipt = {
    tool: 'release-heartbeat-0.3.16',
    command: 'pack',
    mode,
    ok: false,
    at: new Date().toISOString(),
    workspace: WORKSPACE,
    packageDir: PACKAGE_DIR,
    profileDir,
    steps: [],
    commands: [],
    evidence: [],
  };
  const step = (name, ok, detail) => {
    const entry = { name, ok };
    if (detail !== undefined) entry.detail = detail;
    receipt.steps.push(entry);
    say((ok ? 'ok  ' : 'FAIL') + ' - ' + name + (ok || detail === undefined ? '' : '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))));
    return ok;
  };
  const finishPack = (code) => {
    receipt.ok = code === 0;
    process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
    process.exit(code);
  };

  if (options.dryRun === options.apply) {
    refuse(2, 'pass exactly one of --dry-run (preview) or --apply (install). This script never writes into the live profile by default.', receipt);
  }
  if (options.unknown.length > 0) refuse(2, 'unknown argument(s): ' + options.unknown.join(', '), receipt);

  const manifestPath = path.join(PACKAGE_DIR, 'package.json');
  const manifest = readJson(manifestPath);
  if (manifest === undefined) refuse(3, 'package manifest not found or unreadable: ' + manifestPath, receipt);
  if (manifest.name !== BUNDLE) refuse(3, 'package manifest names ' + JSON.stringify(manifest.name) + ', expected ' + JSON.stringify(BUNDLE), receipt);
  if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+/.test(manifest.version)) refuse(3, 'package manifest version is not a version: ' + JSON.stringify(manifest.version), receipt);
  if (manifest.dsh === undefined || manifest.dsh.bundle === undefined || manifest.dsh.bundle.patch === undefined) refuse(3, BUNDLE + ' declares no dsh.bundle.patch, so it is not a bundle', receipt);

  const npmCli = resolveNpmCli();
  const pnpmCli = resolvePnpmCli();
  if (npmCli === undefined) refuse(3, 'npm-cli.js was not found next to the running node; refusing to invent a packer', receipt);
  if (options.apply && pnpmCli === undefined) refuse(3, 'pnpm.cjs was not found under %APPDATA%/npm; refusing to install without the package manager the profile actually uses', receipt);

  const profileManifestPath = path.join(profileDir, 'package.json');
  const profileManifest = readJson(profileManifestPath);
  if (profileManifest === undefined) refuse(3, 'profile manifest not found or unreadable: ' + profileManifestPath, receipt);

  receipt.package = { name: manifest.name, version: manifest.version, files: manifest.files === undefined ? [] : manifest.files, manifestSha256: sha256File(manifestPath) };
  receipt.profile = {
    manifestSpecifier: profileManifest.dependencies === undefined ? null : profileManifest.dependencies[BUNDLE] === undefined ? null : profileManifest.dependencies[BUNDLE],
    bundles: profileManifest.dsh === undefined || profileManifest.dsh.profile === undefined || profileManifest.dsh.profile.bundles === undefined ? [] : profileManifest.dsh.profile.bundles,
    fileHashes: profileFileHashes(profileDir),
  };

  /* --- 1. pack -------------------------------------------------------------------- */

  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-pack-'));
  const packCall = spawn(process.execPath, [npmCli, 'pack', '--json', '--pack-destination', stageDir], { cwd: PACKAGE_DIR });
  receipt.commands.push({ display: packCall.display, cwd: PACKAGE_DIR, exitCode: packCall.exitCode, ms: packCall.ms });
  if (packCall.failed) {
    step('npm pack', false, { exitCode: packCall.exitCode, stderr: packCall.stderr.slice(-2000) });
    return finishPack(1);
  }
  let packed;
  try {
    packed = JSON.parse(packCall.stdout.slice(packCall.stdout.indexOf('[')));
  } catch (error) {
    step('npm pack printed parseable JSON', false, String(error.message));
    return finishPack(1);
  }
  const packReport = Array.isArray(packed) ? packed[0] : packed;
  if (packReport === undefined || typeof packReport.filename !== 'string') {
    step('npm pack named a tarball', false, packCall.stdout.slice(0, 800));
    return finishPack(1);
  }
  const stagedTarball = path.join(stageDir, packReport.filename);
  if (!fs.existsSync(stagedTarball)) {
    step('the packed tarball exists on disk', false, stagedTarball);
    return finishPack(1);
  }
  const tarballSha256 = sha256File(stagedTarball);
  const npmInventory = packReport.files.map((entry) => entry.path);
  if (!step('npm pack produced ' + packReport.filename, true, packReport.size + ' bytes, ' + packReport.entryCount + ' entries')) return finishPack(1);
  if (!step('the packed version is the manifest version', packReport.version === manifest.version, packReport.version + ' vs ' + manifest.version)) return finishPack(1);

  /* --- 2. the tarball really carries the source ----------------------------------- */

  let members;
  let meta;
  try {
    const parsed = readTarMembers(stagedTarball, 'tarball');
    members = parsed.members;
    meta = parsed.meta;
  } catch (error) {
    step('the tarball parses as a complete tar', false, String(error.message));
    return finishPack(1);
  }
  // npm reports the same set that it wrote; a disagreement means one of the two readers is
  // wrong, and neither can then be used as evidence.
  const memberPaths = members.map((member) => member.path.replace(/^package\//, ''));
  const inventorySet = npmInventory.slice().sort();
  const memberSet = memberPaths.slice().sort();
  const sameSet = JSON.stringify(inventorySet) === JSON.stringify(memberSet);
  if (!step('the tar reader and npm agree on the shipped file set', sameSet, { tarMembers: memberSet.length, npmEntries: inventorySet.length })) {
    step('set difference', false, { onlyTar: memberSet.filter((p) => inventorySet.indexOf(p) === -1), onlyNpm: inventorySet.filter((p) => memberSet.indexOf(p) === -1) });
    return finishPack(1);
  }

  const sourceChecks = [];
  for (const member of members) {
    const relative = member.path.replace(/^package\//, '');
    const sourceFile = path.join(PACKAGE_DIR, relative);
    if (!fs.existsSync(sourceFile)) {
      sourceChecks.push({ path: relative, ok: false, reason: 'absent-from-source' });
      continue;
    }
    const sourceSha256 = sha256File(sourceFile);
    sourceChecks.push({ path: relative, ok: sourceSha256 === member.sha256, sourceSha256, tarballSha256: member.sha256, bytes: member.bytes });
  }
  const mismatched = sourceChecks.filter((check) => !check.ok);
  const diskNotShipped = walkFiles(PACKAGE_DIR).filter((relative) => memberPaths.indexOf(relative) === -1);
  receipt.tarball = {
    stagedPath: stagedTarball,
    filename: packReport.filename,
    sha256: tarballSha256,
    npmShasum: packReport.shasum,
    npmIntegrity: packReport.integrity,
    bytes: fs.statSync(stagedTarball).size,
    unpackedBytes: packReport.unpackedSize,
    members: members.length,
    metaMembers: meta,
  };
  receipt.sourceCheck = { membersChecked: sourceChecks.length, matched: sourceChecks.length - mismatched.length, mismatched, diskFilesNotShipped: diskNotShipped };
  if (!step('every one of the ' + sourceChecks.length + ' shipped files matches the source byte for byte', mismatched.length === 0, mismatched.slice(0, 5))) return finishPack(1);
  step(diskNotShipped.length + ' file(s) in the package tree are not shipped (runtime byproducts)', true, diskNotShipped);

  /* --- 3. where it goes and what would change ------------------------------------ */

  const finalTarball = path.join(profileDir, BUNDLE + '-' + manifest.version + '-' + TARBALL_SLUG + '-' + tarballSha256.slice(0, 8) + '.tgz');
  const installDir = path.join(profileDir, 'node_modules', BUNDLE);
  const before = installedState(profileDir);
  const backupRoot = path.join(profileDir, '.newmark-install-backups');
  const backupDir = path.join(backupRoot, stamp() + '-' + BUNDLE + '-' + (before.version === null ? 'absent' : before.version) + '-before-' + manifest.version);
  const specifier = 'file:' + toPosix(finalTarball);
  const previousSpecifier = profileManifest.dependencies === undefined ? null : profileManifest.dependencies[BUNDLE] === undefined ? null : profileManifest.dependencies[BUNDLE];
  receipt.install = {
    performed: false,
    plan: {
      tarballFinalPath: finalTarball,
      dependencySpecifier: specifier,
      previousSpecifier,
      backupDir: before.exists ? backupDir : null,
      installedBefore: before.version,
      removeInstalledDirBeforeInstall: true,
      pnpmCommand: pnpmCli === undefined ? null : process.execPath + ' ' + pnpmCli + ' install',
    },
  };
  step('tarball would land at ' + finalTarball, true);

  /* --- 4. the before-state, always measured (a read, never a write) --------------- */

  const beforeState = {
    at: new Date().toISOString(),
    mode,
    profileDir,
    installedDir: before.installedDir,
    installedExists: before.exists,
    installedVersion: before.version,
    installedFileCount: before.fileCount,
    installedFiles: before.exists ? hashTree(before.installedDir) : [],
    // Recorded because these two junctions are how the memorylab and computeruse trees can be
    // read from the working source instead of from the installed bundle; that is a property of
    // the profile, not of the tarball, and it must not be mistaken for an install.
    profileComponentLinks: ['newmark2dsh-memorylab', 'newmark2dsh-computeruse'].map((name) => {
      const full = path.join(profileDir, 'node_modules', name);
      if (!fs.existsSync(full)) return { name, exists: false };
      const description = describeFile(full);
      return { name, exists: true, isLink: description.isLink, linkTarget: description.target };
    }),
    profileFileHashes: receipt.profile.fileHashes,
    profileDependencySpecifier: previousSpecifier,
    backupDir: mode === 'apply' && before.exists ? backupDir : null,
    note: mode === 'apply'
      ? 'measured immediately before the install; backupDir holds the copy this run made'
      : 'measured by a dry run; the profile was not touched, so no backup was made',
  };
  const beforePath = path.join(EVIDENCE_DIR, 'install-before.json');
  writeJson(beforePath, beforeState);
  receipt.evidence.push(beforePath);
  step('before-state written (' + beforeState.installedFileCount + ' installed files hashed)', true, beforePath);

  if (mode === 'dry-run') {
    const dryReceipt = path.join(EVIDENCE_DIR, 'pack-dry-run-' + stamp() + '.json');
    receipt.install.performed = false;
    receipt.install.reason = 'dry run: the profile was not written, pnpm was not run, no backup was needed';
    receipt.evidence.push(dryReceipt);
    writeJson(dryReceipt, receipt);
    return finishPack(0);
  }

  /* --- 5. apply: back up, install, verify ---------------------------------------- */

  // The backup is made before anything under the profile is written, so every later failure
  // has somewhere to roll back to.
  if (before.exists) {
    fs.mkdirSync(path.dirname(backupDir), { recursive: true });
    // dereference: true, because a bundle that is itself a reparse point would otherwise be
    // COPIED AS A LINK — and creating a symlink inside the backup needs a privilege this process
    // does not have on Windows, so the backup would die with EPERM before anything else ran.
    fs.cpSync(before.installedDir, path.join(backupDir, 'plugin'), { recursive: true, dereference: true });
    for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.yml', 'cordis.patch.yml']) {
      const source = path.join(profileDir, name);
      if (fs.existsSync(source)) {
        fs.mkdirSync(path.join(backupDir, 'profile'), { recursive: true });
        fs.copyFileSync(source, path.join(backupDir, 'profile', name));
      }
    }
    step('installed plugin backed up (' + beforeState.installedFileCount + ' files)', true, backupDir);
  } else {
    step('no installed plugin to back up', true, before.installedDir);
  }

  fs.copyFileSync(stagedTarball, finalTarball);
  const writtenSha256 = sha256File(finalTarball);
  if (!step('the tarball copied into the profile is the packed tarball', writtenSha256 === tarballSha256, { expected: tarballSha256, written: writtenSha256 })) return finishPack(1);

  const editedManifest = JSON.parse(JSON.stringify(profileManifest));
  editedManifest.dependencies = Object.assign({}, editedManifest.dependencies === undefined ? {} : editedManifest.dependencies);
  editedManifest.dependencies[BUNDLE] = specifier;
  fs.writeFileSync(profileManifestPath, JSON.stringify(editedManifest, null, 2) + '\n');
  step('profile manifest declares ' + BUNDLE + ' as ' + specifier, true);

  // Removing the materialised package first is what makes a re-run pick up changed bytes
  // rather than keep hardlinks to the previous store entry.
  receipt.install.removedInstalledDir = removeInstalledDir(installDir);

  const pnpmCall = spawn(process.execPath, [pnpmCli, 'install'], { cwd: profileDir });
  receipt.commands.push({ display: pnpmCall.display, cwd: profileDir, exitCode: pnpmCall.exitCode, ms: pnpmCall.ms });
  receipt.install.pnpm = { exitCode: pnpmCall.exitCode, stdoutTail: pnpmCall.stdout.slice(-4000), stderrTail: pnpmCall.stderr.slice(-4000) };
  if (pnpmCall.failed) {
    step('pnpm install', false, { exitCode: pnpmCall.exitCode });
    rollback(receipt, { backupDir, profileDir, installDir, before, profileManifestPath });
    return finishPack(1);
  }
  step('pnpm install completed in ' + Math.round(pnpmCall.ms / 100) / 10 + 's', true);

  /* --- 6. the installed bytes are the source bytes -------------------------------- */

  const after = installedState(profileDir);
  // The top-level entry may legitimately be a link under pnpm's default (isolated) linker, where
  // node_modules/<pkg> points into node_modules/.pnpm. What must not happen is the bytes coming
  // from somewhere else, so a link is accepted only when it resolves inside the profile's own
  // .pnpm store, and the resolved path is recorded either way.
  const installedDirIsLink = fs.lstatSync(after.installedDir).isSymbolicLink();
  const installedDirRealPath = fs.realpathSync(after.installedDir);
  const installedDirLinkAccepted = installedDirIsLink && isInside(path.join(profileDir, 'node_modules', '.pnpm'), installedDirRealPath);
  const verification = {
    installedDir: after.installedDir,
    installedDirIsLink,
    installedDirRealPath,
    installedDirLinkAccepted,
    installedVersion: after.version,
    expectedVersion: manifest.version,
    missing: [],
    mismatched: [],
    linked: [],
    extra: [],
    linkTypes: { file: 0, hardLinkedFile: 0, reparsePoint: 0 },
  };
  for (const member of members) {
    const relative = member.path.replace(/^package\//, '');
    const installedFile = path.join(after.installedDir, relative);
    if (!fs.existsSync(installedFile)) {
      verification.missing.push(relative);
      continue;
    }
    const description = describeFile(installedFile);
    const ancestor = linkOnPath(after.installedDir, installedFile);
    // A reparse point — on the file OR anywhere on its path — would mean the "installed" bytes
    // are whatever it points at, possibly the very source the tarball was packed from. That would
    // make a hash comparison pass while nothing was installed, so it is a failure, not a footnote.
    if (description.isLink || (ancestor !== undefined && ancestor.link !== undefined)) {
      verification.linkTypes.reparsePoint += 1;
      verification.linked.push({ path: relative, linkTarget: description.target ?? ancestor.target, linkPath: ancestor?.link, sha256: sha256File(installedFile) });
      continue;
    }
    if (description.nlink > 1) verification.linkTypes.hardLinkedFile += 1;
    else verification.linkTypes.file += 1;
    const installedSha256 = sha256File(installedFile);
    if (installedSha256 !== member.sha256) verification.mismatched.push({ path: relative, expected: member.sha256, installed: installedSha256 });
  }
  verification.extra = walkFiles(after.installedDir).filter((relative) => memberPaths.indexOf(relative) === -1);
  verification.checked = members.length;
  verification.matched = members.length - verification.missing.length - verification.mismatched.length - verification.linked.length;
  verification.profileComponentLinks = beforeState.profileComponentLinks;
  receipt.verification = verification;

  const versionOk = verification.installedVersion === manifest.version;
  const bytesOk =
    verification.missing.length === 0 &&
    verification.mismatched.length === 0 &&
    verification.linked.length === 0 &&
    (!installedDirIsLink || installedDirLinkAccepted);
  if (!versionOk || !bytesOk) {
    step('installed version, link structure and bytes', false, {
      installedVersion: verification.installedVersion,
      installedDirIsLink,
      installedDirRealPath,
      installedDirLinkAccepted,
      missing: verification.missing.slice(0, 5),
      mismatched: verification.mismatched.slice(0, 5),
      linked: verification.linked.slice(0, 5),
    });
    rollback(receipt, { backupDir, profileDir, installDir, before, profileManifestPath });
    return finishPack(1);
  }
  step('installed ' + verification.matched + '/' + verification.checked + ' files match the tarball byte for byte', true, {
    version: verification.installedVersion,
    linkTypes: verification.linkTypes,
    extra: verification.extra.length,
  });

  receipt.install.performed = true;
  const afterPath = path.join(EVIDENCE_DIR, 'install-after-' + stamp() + '.json');
  receipt.evidence.push(afterPath);
  writeJson(afterPath, { at: new Date().toISOString(), profileDir, specifier, backupDir, verification, tarball: receipt.tarball });
  step('install-after evidence written', true, afterPath);
  return finishPack(0);
}

/**
 * Put the profile back the way the before-state recorded it. Best effort and reported as such:
 * a rollback that silently half-succeeds is worse than one that says which half it did.
 */
function rollback(receipt, context) {
  const actions = [];
  try {
    if (context.before.exists) {
      removeInstalledDir(context.installDir);
      fs.cpSync(path.join(context.backupDir, 'plugin'), context.installDir, { recursive: true, dereference: true });
      actions.push('installed directory restored from the backup');
      for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.yml', 'cordis.patch.yml']) {
        const source = path.join(context.backupDir, 'profile', name);
        if (fs.existsSync(source)) {
          fs.copyFileSync(source, path.join(context.profileDir, name));
          actions.push(name + ' restored');
        }
      }
    } else {
      actions.push('no previous install existed, so the new directory was ' + removeInstalledDir(context.installDir));
    }
  } catch (error) {
    actions.push('rollback incomplete: ' + String(error && error.message ? error.message : error));
  }
  receipt.rollback = { backupDir: context.backupDir, actions };
  say('rollback: ' + actions.join('; '));
  return receipt;
}

/* ----------------------------------------------------------------- push / pull */

/** The exact set of files a staging of paths must produce, with git-ignored files removed. */
function expectedStagedSet(repoRoot, paths) {
  const candidates = new Set();
  for (const relative of paths) {
    const absolute = path.join(repoRoot, relative);
    const stats = fs.statSync(absolute);
    if (stats.isDirectory()) for (const file of walkFiles(absolute)) candidates.add((relative + '/' + file).replace(/\/+/g, '/'));
    else candidates.add(relative);
  }
  const list = Array.from(candidates).sort();
  if (list.length === 0) return { list, ignored: [] };
  const ignoredCall = spawn('git', ['check-ignore', '--stdin'], { cwd: repoRoot, input: list.join('\n') + '\n' });
  const ignored = new Set(ignoredCall.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0));
  return { list: list.filter((entry) => !ignored.has(entry)), ignored: list.filter((entry) => ignored.has(entry)) };
}

function pushPull(options) {
  const receipt = {
    tool: 'release-heartbeat-0.3.16',
    command: 'push-pull',
    ok: false,
    at: new Date().toISOString(),
    workspace: WORKSPACE,
    requestedPaths: options.paths,
    steps: [],
    commands: [],
    evidence: [],
  };
  const step = (name, ok, detail) => {
    const entry = { name, ok };
    if (detail !== undefined) entry.detail = detail;
    receipt.steps.push(entry);
    say((ok ? 'ok  ' : 'FAIL') + ' - ' + name + (ok || detail === undefined ? '' : '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))));
    return ok;
  };
  const finish = (code) => {
    receipt.ok = code === 0;
    const file = path.join(EVIDENCE_DIR, 'push-pull-' + stamp() + '.json');
    receipt.evidence.push(file);
    writeJson(file, receipt);
    process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
    process.exit(code);
  };

  // The empty list is the one refusal the handover names outright, because "git add" with no
  // paths in a tree this dirty is how 5000 unrelated entries get committed.
  if (options.paths.length === 0) refuse(2, 'the path list is empty. This script stages only the paths you name and never runs a bare "git add" or "git add -A".', receipt);
  if (options.unknown.length > 0) refuse(2, 'unknown argument(s): ' + options.unknown.join(', '), receipt);

  // --repo exists so this mechanism can be rehearsed in a throwaway repository: a guard that
  // has never been seen to refuse, and a commit path that has never been seen to run, are both
  // beliefs rather than evidence.
  const repoCwd = options.repo === undefined ? WORKSPACE : path.resolve(options.repo);
  const repoGit = (args, settings) => git(args, { cwd: repoCwd, env: settings === undefined ? undefined : settings.env });
  const toplevel = repoGit(['rev-parse', '--show-toplevel']);
  const repoRoot = toplevel.stdout.trim();
  if (toplevel.failed || repoRoot === '') refuse(3, 'git rev-parse --show-toplevel failed: ' + toplevel.stderr.trim(), receipt);
  const gitDir = repoGit(['rev-parse', '--absolute-git-dir']).stdout.trim();
  const branch = repoGit(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
  receipt.repo = { root: repoRoot, gitDir, branch };

  const relativePaths = [];
  for (const requested of options.paths) {
    const absolute = path.isAbsolute(requested) ? requested : path.resolve(repoRoot, requested);
    try {
      fs.statSync(absolute);
    } catch {
      refuse(3, 'path does not exist: ' + requested + ' (resolved ' + absolute + ')', receipt);
    }
    if (!isInside(repoRoot, absolute)) refuse(3, 'path is outside the repository: ' + absolute, receipt);
    const relative = toPosix(path.relative(repoRoot, absolute));
    if (relative.split('/').indexOf('.dsh') !== -1) refuse(3, 'refusing to stage anything under ~/.dsh: ' + requested, receipt);
    if (FORBIDDEN_PATH_PREFIXES.some((prefix) => relative === prefix.replace(/\/$/, '') || relative.startsWith(prefix))) {
      refuse(3, 'refusing to stage the pre-existing browser-cache tree: ' + relative, receipt);
    }
    relativePaths.push(relative);
  }
  step('resolved ' + relativePaths.length + ' path(s) inside ' + repoRoot, true, relativePaths);
  if (branch !== options.branch) {
    step('HEAD is on ' + options.branch, false, 'it is on ' + branch + '; refusing to push a branch this run did not expect');
    return finish(1);
  }

  const expected = expectedStagedSet(repoRoot, relativePaths);
  if (expected.list.length === 0) {
    step('the paths name at least one git-visible file', false, { ignored: expected.ignored });
    return finish(1);
  }
  if (expected.ignored.length > 0 && !options.includeIgnored) {
    step('refusing: ' + expected.ignored.length + ' path(s) are git-ignored and would be silently omitted', false, {
      ignored: expected.ignored.slice(0, 20),
      hint: 'pass --include-ignored to force-add exactly those named paths',
    });
    return finish(1);
  }
  const filesToStage = options.includeIgnored ? expected.list.concat(expected.ignored).sort() : expected.list;
  if (filesToStage.length === 0) {
    step('the paths name at least one file to stage', false, { ignored: expected.ignored });
    return finish(1);
  }
  const totalBytes = filesToStage.reduce((sum, entry) => sum + fs.statSync(path.join(repoRoot, entry)).size, 0);
  step(filesToStage.length + ' file(s) will be staged (' + totalBytes + ' bytes)', true, filesToStage.length > 12 ? filesToStage.slice(0, 12).join(', ') + ' ...' : filesToStage);
  if (expected.ignored.length > 0) step('force-adding ' + expected.ignored.length + ' git-ignored named path(s), because --include-ignored was given', true, expected.ignored);

  const headBefore = repoGit(['rev-parse', 'HEAD']).stdout.trim();
  const originBefore = repoGit(['rev-parse', 'origin/' + options.branch]);
  const lsRemoteBefore = repoGit(['ls-remote', 'origin', 'refs/heads/' + options.branch]);
  const remoteBefore = lsRemoteBefore.failed ? null : lsRemoteBefore.stdout.split(/\s/)[0];
  receipt.before = {
    head: headBefore,
    originTrackedRef: originBefore.failed ? null : originBefore.stdout.trim(),
    remoteRef: remoteBefore === undefined ? null : remoteBefore,
    statusOnPaths: repoGit(['status', '--porcelain', '--', ...relativePaths]).stdout.trim().split(/\r?\n/).filter(Boolean),
  };

  /* --- the plan, and the dry run that stops here ------------------------------------ */

  receipt.plan = {
    repoRoot,
    branch: options.branch,
    files: filesToStage.length,
    bytes: totalBytes,
    ignored: expected.ignored,
    includeIgnored: options.includeIgnored,
    commands: [
      'git add ' + (options.includeIgnored ? '-f ' : '') + '-- <' + relativePaths.length + ' named path(s)>',
      'git commit --no-gpg-sign -m <message> -- <same named path(s)>',
      'git push origin HEAD:refs/heads/' + options.branch,
      'git pull --ff-only origin ' + options.branch,
    ],
  };
  if (options.dryRun) {
    receipt.dryRun = true;
    receipt.staged = false;
    receipt.pushed = false;
    step('dry run: nothing was staged, committed or pushed', true, receipt.plan.files + ' file(s), ' + totalBytes + ' bytes');
    return finish(0);
  }

  /* --- stage, then commit, naming the paths twice ---------------------------------- */

  const message = options.message === undefined
    ? 'Newmark2DSH 0.3.16 ' + TARBALL_SLUG + ': ' + relativePaths.length + ' path(s) staged by release-heartbeat-0.3.16.mjs'
    : options.message;

  // The index is fingerprinted before and after the staging so "only the named paths were
  // staged" is measured rather than promised. In this workspace the index already holds
  // thousands of unrelated staged entries, so the check is on the DELTA, not on the total.
  const listIndex = () => {
    const call = repoGit(['ls-files', '-s', '-z']);
    const entries = new Map();
    for (const record of call.stdout.split('\u0000').filter(Boolean)) {
      const tab = record.indexOf('\t');
      entries.set(record.slice(tab + 1), record.slice(0, tab));
    }
    return entries;
  };
  const indexBefore = listIndex();
  const indexFileBefore = sha256File(path.join(gitDir, 'index'));

  const addCall = repoGit(['add', ...(options.includeIgnored ? ['-f'] : []), '--', ...relativePaths]);
  receipt.commands.push({ display: addCall.display, cwd: repoRoot, exitCode: addCall.exitCode });
  if (addCall.failed) {
    step('git add of the named paths', false, addCall.stderr.trim());
    return finish(1);
  }

  const indexAfter = listIndex();
  const indexFileAfter = sha256File(path.join(gitDir, 'index'));
  const indexDelta = [];
  for (const [entry, value] of indexAfter) if (indexBefore.get(entry) !== value) indexDelta.push(entry);
  for (const entry of indexBefore.keys()) if (!indexAfter.has(entry)) indexDelta.push(entry);
  const strayStaged = indexDelta.filter((entry) => expected.list.indexOf(entry) === -1);
  receipt.staging = {
    indexFileSha256Before: indexFileBefore,
    indexFileSha256After: indexFileAfter,
    entriesChanged: indexDelta.sort(),
    strayEntries: strayStaged,
    indexEntriesTotal: indexAfter.size,
  };
  if (!step('staging changed exactly the named index entries (' + indexAfter.size + ' entries in the index)', strayStaged.length === 0, strayStaged.slice(0, 10))) {
    return finish(1);
  }

  // The staged delta against HEAD is what the commit will change. A named path whose bytes
  // already match HEAD legitimately produces no delta, so it is recorded rather than failed.
  const stagedChanges = repoGit(['diff', '--cached', '--name-only', '-z']).stdout.split('\u0000').filter(Boolean).sort();
  const namedChanges = stagedChanges.filter((entry) => filesToStage.indexOf(entry) !== -1);
  let headAfter;

  if (namedChanges.length === 0) {
    /* No staged delta. That is either "there is nothing to do" or "a previous run already made
     * exactly this commit and was interrupted before pushing it". The second case is accepted only
     * when it is provable, because resuming onto the wrong commit would push something nobody
     * asked for: HEAD must be exactly one commit ahead of the remote's tip, and every path HEAD
     * changes must be one the caller named. */
    const parent = repoGit(['rev-parse', 'HEAD^']).stdout.trim();
    const remoteTip = repoGit(['rev-parse', 'origin/' + options.branch]).stdout.trim();
    const existing = repoGit(['show', '--pretty=format:', '--name-only', '-z', 'HEAD']).stdout.split('\u0000').filter(Boolean).sort();
    const resumable =
      parent !== '' && parent === remoteTip && existing.length > 0 && existing.every((entry) => filesToStage.indexOf(entry) !== -1);
    if (!resumable) {
      step('the commit would change at least one path', false, {
        reason: 'every named path already matches HEAD, so the commit would be empty',
        parentOfHead: parent || null,
        remoteTip,
      });
      return finish(1);
    }
    headAfter = repoGit(['rev-parse', 'HEAD']).stdout.trim();
    receipt.resumed = true;
    step('a previous run already created ' + headAfter.slice(0, 12) + ' on top of ' + remoteTip.slice(0, 12) + '; resuming at the push', true, {
      commitFiles: existing.length,
    });
  } else {
    const alreadyAtHead = filesToStage.filter((entry) => stagedChanges.indexOf(entry) === -1);
    step('staged ' + namedChanges.length + ' changed named file(s)', true, alreadyAtHead.length > 0 ? { alreadyAtHead } : undefined);

    // The pathspec is what makes the commit safe here: "git commit -- <paths>" ignores everything
    // else the index has staged, so the ~5000 unrelated entries stay staged and stay uncommitted.
    const commitCall = repoGit(['commit', '--no-gpg-sign', '-m', message, '--', ...relativePaths]);
    receipt.commands.push({ display: commitCall.display, cwd: repoRoot, exitCode: commitCall.exitCode });
    if (commitCall.failed) {
      step('git commit', false, (commitCall.stdout.trim() + ' ' + commitCall.stderr.trim()).trim());
      return finish(1);
    }
    headAfter = repoGit(['rev-parse', 'HEAD']).stdout.trim();
    step('commit ' + headAfter.slice(0, 12) + ' created', true, commitCall.stdout.split(/\r?\n/)[0]);
  }

  // Verified BEFORE the push: a commit that named anything else would otherwise be published
  // before anyone could inspect it.
  const committed = repoGit(['show', '--pretty=format:', '--name-only', '-z', headAfter]).stdout.split('\u0000').filter(Boolean).sort();
  const committedWithinNamed = committed.every((entry) => filesToStage.indexOf(entry) !== -1);
  const committedMatches = committedWithinNamed && committed.length > 0;
  receipt.commit = { sha: headAfter, message, files: committed, onlyTheNamedPaths: committedMatches, namedPaths: filesToStage };
  if (!step('the commit contains only the named paths, and changes at least one', committedMatches, committedMatches ? committed.length + ' file(s)' : { committed: committed.slice(0, 12), expected: expected.list.slice(0, 12) })) {
    return finish(1);
  }

  /* --- push, pull, prove ----------------------------------------------------------- */

  const pushCall = repoGit(['push', 'origin', 'HEAD:refs/heads/' + options.branch]);
  receipt.commands.push({ display: pushCall.display, cwd: repoRoot, exitCode: pushCall.exitCode });
  if (pushCall.failed) {
    step('git push', false, (pushCall.stdout.trim() + ' ' + pushCall.stderr.trim()).trim());
    return finish(1);
  }
  step('git push reported success', true, pushCall.stderr.trim().split(/\r?\n/).slice(-1)[0]);

  const pullCall = repoGit(['pull', '--ff-only', 'origin', options.branch]);
  receipt.commands.push({ display: pullCall.display, cwd: repoRoot, exitCode: pullCall.exitCode });
  if (pullCall.failed) {
    step('git pull --ff-only', false, (pullCall.stdout.trim() + ' ' + pullCall.stderr.trim()).trim());
    return finish(1);
  }
  step('git pull --ff-only reported success', true, pullCall.stdout.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0]);

  const headFinal = repoGit(['rev-parse', 'HEAD']).stdout.trim();
  const originFinal = repoGit(['rev-parse', 'origin/' + options.branch]).stdout.trim();
  const lsRemoteAfter = repoGit(['ls-remote', 'origin', 'refs/heads/' + options.branch]);
  const remoteFinal = lsRemoteAfter.failed ? null : lsRemoteAfter.stdout.split(/\s/)[0];
  const statusFinal = repoGit(['status', '--porcelain', '--', ...relativePaths]).stdout.trim().split(/\r?\n/).filter(Boolean);
  receipt.after = {
    head: headFinal,
    originTrackedRef: originFinal,
    remoteRef: remoteFinal === undefined ? null : remoteFinal,
    statusOnPaths: statusFinal,
    changedFromBefore: headFinal !== headBefore,
  };

  const agree = headFinal === headAfter && originFinal === headAfter && receipt.after.remoteRef === headAfter;
  if (!step('HEAD, origin/<branch> and the remote ref are all the new commit', agree, { head: headFinal, origin: originFinal, remote: receipt.after.remoteRef, commit: headAfter })) {
    return finish(1);
  }
  if (!step('the named paths are clean in the working tree after the round trip', statusFinal.length === 0, statusFinal.slice(0, 10))) return finish(1);

  return finish(0);
}

/* ------------------------------------------------------------------------ main */

const options = parseArguments(process.argv.slice(2));
if (options.help) {
  usage();
  process.exit(0);
}
/**
 * Every path through this script is supposed to end in a machine-readable receipt, so an
 * unexpected exception must still produce one. A run that dies with a bare stack trace leaves its
 * caller unable to tell what happened, which is worse than the failure itself.
 */
function main() {
  try {
    if (options.command === 'pack') packAndInstall(options);
    else if (options.command === 'push-pull') pushPull(options);
    else refuse(2, 'unknown command ' + JSON.stringify(options.command) + '; expected pack or push-pull', undefined);
  } catch (error) {
    const receipt = {
      tool: 'release-heartbeat-0.3.16',
      command: options.command,
      ok: false,
      at: new Date().toISOString(),
      unhandled: String((error && error.stack) || error),
    };
    process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
    say('unhandled failure: ' + String((error && error.message) || error));
    process.exit(1);
  }
}

main();
