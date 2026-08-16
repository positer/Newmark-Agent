import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync, spawn, spawnSync } from 'child_process';

export interface InstallUpdateOptions {
  source: string;
  target: string;
  targetFile?: string;
  expectedVersion?: string;
  preserve?: string[];
  dryRun?: boolean;
}

export interface InstallUpdateResult {
  ok: boolean;
  appVersion: string;
  source: string;
  target: string;
  dryRun: boolean;
  copied: string[];
  preserved: string[];
  manifestPath?: string;
  deferred?: boolean;
  helperPath?: string;
  helperPid?: number;
  error?: string;
}

export interface GitHubReleaseAsset {
  name: string;
  size: number;
  browserDownloadUrl: string;
  contentType?: string;
}

export interface GitHubUpdateCheckResult {
  ok: boolean;
  repo: string;
  tag: string;
  version: string;
  currentVersion: string;
  updateAvailable: boolean;
  url?: string;
  assets: GitHubReleaseAsset[];
  selectedAsset?: GitHubReleaseAsset;
  error?: string;
}

export interface GitHubUpdateCheckRuntimeOptions {
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
  currentVersion?: string;
  apiBaseUrl?: string;
}

export interface GitHubUpdateApplyOptions {
  repo?: string;
  tag?: string;
  asset?: string;
  target: string;
  expectedVersion?: string;
  dryRun?: boolean;
  token?: string;
}

export interface GitHubUpdateApplyResult extends InstallUpdateResult {
  release?: GitHubUpdateCheckResult;
  downloadPath?: string;
  extractPath?: string;
}

const DEFAULT_PRESERVE = [
  'config.json',
  'agent.md',
  'PC_Hash.config',
  'Work',
  'skills',
  'Memory Lab',
  'archive',
  'Design.md',
];

function normalizeItem(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

function isSubPath(candidate: string, parent: string): boolean {
  const rel = path.relative(parent, candidate);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function shouldPreserve(relativePath: string, preserve: string[]): boolean {
  const rel = normalizeItem(relativePath);
  return preserve.some(item => rel === item || rel.startsWith(`${item}/`));
}

function readJsonVersion(filePath: string): string {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return String(parsed.version || '');
  } catch {
    return '';
  }
}

export function currentAppVersion(): string {
  const candidates = [
    path.join(__dirname, '..', 'package.json'),
    path.join(__dirname, '..', '..', 'package.json'),
    path.join(process.cwd(), 'package.json'),
  ];
  for (const candidate of candidates) {
    const version = readJsonVersion(candidate);
    if (version) return version;
  }
  return process.env.npm_package_version || 'unknown';
}

function copyDirectory(source: string, target: string, preserve: string[], dryRun: boolean, copied: string[], preserved: string[]): void {
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    const relativeTarget = path.relative(target, targetPath);
    const normalized = normalizeItem(relativeTarget);
    if (shouldPreserve(normalized, preserve)) {
      preserved.push(normalized);
      continue;
    }
    if (entry.isDirectory()) {
      if (!dryRun) fs.mkdirSync(targetPath, { recursive: true });
      copyDirectory(sourcePath, targetPath, preserve, dryRun, copied, preserved);
      continue;
    }
    if (!entry.isFile()) continue;
    copied.push(normalized);
    if (!dryRun) {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.copyFileSync(sourcePath, targetPath);
    }
  }
}

function shellSingleQuote(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function runningExecutableTarget(target: string): string {
  const names = ['Newmark Agent.exe', path.basename(process.execPath || '')].filter(Boolean);
  for (const name of Array.from(new Set(names))) {
    const candidate = path.join(target, name);
    if (path.resolve(candidate).toLowerCase() === path.resolve(process.execPath || '').toLowerCase()) return candidate;
  }
  return '';
}

function collectDirectoryPlan(source: string, target: string, preserve: string[]): { copied: string[]; preserved: string[] } {
  const copied: string[] = [];
  const preserved: string[] = [];
  copyDirectory(source, target, preserve, true, copied, preserved);
  return { copied, preserved: Array.from(new Set(preserved)).sort() };
}

function assertTargetWritableBeforeCopy(target: string): void {
  const probePath = path.join(target, `.newmark-write-probe-${process.pid}-${Date.now()}`);
  try {
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(probePath, 'ok', 'utf-8');
    fs.unlinkSync(probePath);
  } catch {
    try { if (fs.existsSync(probePath)) fs.unlinkSync(probePath); } catch {}
    throw new Error(`Update target is not writable: ${target}. Install the MSI or rerun the update with administrator privileges.`);
  }
}

function writeDeferredWindowsUpdate(source: string, target: string, preserve: string[], appVersion: string): { helperPath: string; helperPid?: number } {
  const helperPath = path.join(os.tmpdir(), `newmark-update-${process.pid}-${Date.now()}.ps1`);
  const preserveItems = preserve.map(item => shellSingleQuote(item)).join(', ');
  const manifestPath = path.join(target, '.newmark-install.json');
  const logPath = path.join(os.tmpdir(), `newmark-update-${process.pid}.log`);
  const script = `
$ErrorActionPreference = 'Stop'
$pidToWait = ${process.pid}
$source = ${shellSingleQuote(source)}
$target = ${shellSingleQuote(target)}
$manifestPath = ${shellSingleQuote(manifestPath)}
$logPath = ${shellSingleQuote(logPath)}
$appVersion = ${shellSingleQuote(appVersion)}
$preserve = @(${preserveItems})
function Write-NewmarkLog([string]$message) {
  try { Add-Content -LiteralPath $logPath -Value ("[" + (Get-Date).ToString("o") + "] " + $message) -Encoding UTF8 } catch {}
}
function Normalize-Rel([string]$value) {
  return $value.Replace('\\', '/').TrimStart('/').TrimEnd('/')
}
function Should-Preserve([string]$rel) {
  $n = Normalize-Rel $rel
  foreach ($item in $preserve) {
    if ($n -eq $item -or $n.StartsWith($item + '/')) { return $true }
  }
  return $false
}
function Copy-NewmarkDirectory {
  New-Item -ItemType Directory -Force -Path $target | Out-Null
  $sourceRoot = (Get-Item -LiteralPath $source).FullName.TrimEnd('\\')
  Get-ChildItem -LiteralPath $source -Force -Recurse | ForEach-Object {
    $rel = $_.FullName.Substring($sourceRoot.Length).TrimStart('\\')
    if (-not $rel) { return }
    if (Should-Preserve $rel) { return }
    $dest = Join-Path $target $rel
    if ($_.PSIsContainer) {
      New-Item -ItemType Directory -Force -Path $dest | Out-Null
    } else {
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
      Copy-Item -LiteralPath $_.FullName -Destination $dest -Force
    }
  }
  $manifest = @{
    appVersion = $appVersion
    updatedAt = (Get-Date).ToUniversalTime().ToString('o')
    source = $source
    deferred = $true
    waitedForPid = $pidToWait
    preserved = $preserve
  } | ConvertTo-Json -Depth 4
  Set-Content -LiteralPath $manifestPath -Value $manifest -Encoding UTF8
}
try {
  Wait-Process -Id $pidToWait -Timeout 90 -ErrorAction SilentlyContinue
} catch {}
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  $_.Name -eq 'Newmark Agent.exe' -and $_.ProcessId -ne $pidToWait
} | ForEach-Object {
  try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
}
for ($i = 0; $i -lt 30; $i++) {
  try {
    Copy-NewmarkDirectory
    Write-NewmarkLog "deferred update complete"
    exit 0
  } catch {
    Write-NewmarkLog ("attempt " + $i + " failed: " + $_.Exception.Message)
    Start-Sleep -Milliseconds 1000
  }
}
exit 1
`.trimStart();
  fs.writeFileSync(helperPath, script, 'utf-8');
  const launcher = [
    '$ErrorActionPreference = "Stop"',
    `$helper = ${shellSingleQuote(helperPath)}`,
    '$argsList = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $helper)',
    'Start-Process -FilePath "powershell.exe" -ArgumentList $argsList -WindowStyle Hidden',
  ].join('; ');
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', launcher], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return { helperPath, helperPid: child.pid };
}

export function installUpdate(options: InstallUpdateOptions): InstallUpdateResult {
  const source = path.resolve(options.source || '');
  const target = path.resolve(options.target || '');
  const appVersion = currentAppVersion();
  const dryRun = !!options.dryRun;
  const preserve = (options.preserve && options.preserve.length ? options.preserve : DEFAULT_PRESERVE).map(normalizeItem);
  const copied: string[] = [];
  const preserved: string[] = [];

  try {
    if (!source || !fs.existsSync(source)) throw new Error('Update source does not exist.');
    if (!target) throw new Error('Update target is required.');
    if (source === target || isSubPath(target, source)) throw new Error('Target must not be inside the update source.');
    if (options.expectedVersion && options.expectedVersion !== appVersion) {
      throw new Error(`Version check failed: expected ${options.expectedVersion}, current ${appVersion}.`);
    }

    const stat = fs.statSync(source);
    if (stat.isDirectory()) {
      const runningTarget = process.platform === 'win32' ? runningExecutableTarget(target) : '';
      if (!dryRun && runningTarget && fs.existsSync(path.join(source, path.basename(runningTarget)))) {
        const plan = collectDirectoryPlan(source, target, preserve);
        const helper = writeDeferredWindowsUpdate(source, target, preserve, appVersion);
        return {
          ok: true,
          appVersion,
          source,
          target,
          dryRun,
          copied: plan.copied,
          preserved: plan.preserved,
          manifestPath: path.join(target, '.newmark-install.json'),
          deferred: true,
          helperPath: helper.helperPath,
          helperPid: helper.helperPid,
        };
      }
      if (!dryRun) assertTargetWritableBeforeCopy(target);
      copyDirectory(source, target, preserve, dryRun, copied, preserved);
    } else if (stat.isFile()) {
      const targetFile = path.resolve(options.targetFile || path.join(target, path.basename(source)));
      if (targetFile === source) throw new Error('Target file must differ from source file.');
      if (!targetFile.startsWith(target + path.sep) && targetFile !== target) throw new Error('Target file must stay inside target directory.');
      copied.push(normalizeItem(path.relative(target, targetFile) || path.basename(targetFile)));
      if (!dryRun) {
        assertTargetWritableBeforeCopy(path.dirname(targetFile));
        fs.copyFileSync(source, targetFile);
      }
    } else {
      throw new Error('Update source must be a file or directory.');
    }

    const manifestPath = path.join(target, '.newmark-install.json');
    if (!dryRun) {
      fs.writeFileSync(manifestPath, JSON.stringify({
        appVersion,
        updatedAt: new Date().toISOString(),
        source,
        preserved,
      }, null, 2), 'utf-8');
    }

    return { ok: true, appVersion, source, target, dryRun, copied, preserved: Array.from(new Set(preserved)).sort(), manifestPath };
  } catch (e) {
    return { ok: false, appVersion, source, target, dryRun, copied, preserved: Array.from(new Set(preserved)).sort(), error: e instanceof Error ? e.message : String(e) };
  }
}

function normalizeRepo(repo?: string): string {
  return String(repo || 'positer/Newmark-Agent').replace(/^https:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '');
}

export function normalizeReleaseVersion(input: string): string {
  const value = String(input || '')
    .trim()
    .replace(/^refs\/tags\//i, '')
    .replace(/^dev-/i, '')
    .replace(/^v/i, '');
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return '';
  return `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}${match[4] ? `-${match[4]}` : ''}`;
}

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

function parseSemver(input: string): ParsedSemver | null {
  const normalized = normalizeReleaseVersion(input);
  const match = normalized.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

export function compareSemver(a: string, b: string): number {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) return 0;
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1;
  }
  if (!left.prerelease.length && !right.prerelease.length) return 0;
  if (!left.prerelease.length) return 1;
  if (!right.prerelease.length) return -1;
  for (let i = 0; i < Math.max(left.prerelease.length, right.prerelease.length); i++) {
    const l = left.prerelease[i];
    const r = right.prerelease[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;
    const ln = /^\d+$/.test(l) ? Number(l) : null;
    const rn = /^\d+$/.test(r) ? Number(r) : null;
    if (ln !== null && rn !== null) return ln > rn ? 1 : -1;
    if (ln !== null) return -1;
    if (rn !== null) return 1;
    return l > r ? 1 : -1;
  }
  return 0;
}

function githubHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'Newmark-Agent-Updater',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const safeToken = token || process.env.NEWMARK_GITHUB_TOKEN || process.env.GITHUB_TOKEN || '';
  if (safeToken) headers.Authorization = `Bearer ${safeToken}`;
  return headers;
}

function selectReleaseAsset(assets: GitHubReleaseAsset[], wanted?: string): GitHubReleaseAsset | undefined {
  const query = String(wanted || '').trim().toLowerCase();
  if (query) return assets.find(a => a.name.toLowerCase() === query) || assets.find(a => a.name.toLowerCase().includes(query));
  return assets.find(a => /win-unpacked.*x64.*\.zip$/i.test(a.name)) ||
    assets.find(a => /windows.*x64.*\.zip$/i.test(a.name)) ||
    assets.find(a => /\.zip$/i.test(a.name));
}

export async function checkGitHubUpdate(
  repoInput?: string,
  tagInput?: string,
  assetName?: string,
  token?: string,
  runtime: GitHubUpdateCheckRuntimeOptions = {},
): Promise<GitHubUpdateCheckResult> {
  const repo = normalizeRepo(repoInput);
  const tag = String(tagInput || 'latest').replace(/^refs\/tags\//, '');
  const manualTag = !!tag && tag !== 'latest';
  const apiBaseUrl = String(runtime.apiBaseUrl || 'https://api.github.com').replace(/\/+$/, '');
  const endpoint = manualTag
    ? `${apiBaseUrl}/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`
    : `${apiBaseUrl}/repos/${repo}/releases?per_page=30`;
  const currentVersion = normalizeReleaseVersion(runtime.currentVersion || currentAppVersion()) || currentAppVersion();
  const fetchImpl = runtime.fetchImpl || fetch;
  const timeoutMs = Math.max(1, Number(runtime.timeoutMs ?? 5_000));
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetchImpl(endpoint, { headers: githubHeaders(token), signal: controller.signal });
    if (!response.ok) throw new Error(`GitHub release request failed: HTTP ${response.status}`);
    const payload = await response.json() as Record<string, any> | Array<Record<string, any>>;
    // GitHub's releases endpoint returns an array, while older proxies and
    // compatibility gateways may still return a single latest-release object.
    const payloadItems = Array.isArray(payload) ? payload : [payload];
    const candidates: Array<Record<string, any>> = manualTag
      ? payloadItems.slice(0, 1)
      : payloadItems;
    const releases = candidates
      .filter(item => item && typeof item === 'object')
      .filter(item => manualTag || item.draft !== true)
      .map(item => ({ item, version: normalizeReleaseVersion(String(item.tag_name || '')) }))
      .filter(entry => !!entry.version)
      .sort((a, b) => compareSemver(b.version, a.version));
    const selectedRelease = releases[0];
    if (!selectedRelease) throw new Error('GitHub release check returned no valid non-draft semantic version.');
    const data = selectedRelease.item;
    const assets = Array.isArray(data.assets) ? data.assets.map((a: Record<string, any>) => ({
      name: String(a.name || ''),
      size: Number(a.size || 0),
      browserDownloadUrl: String(a.browser_download_url || ''),
      contentType: String(a.content_type || ''),
    })).filter((a: GitHubReleaseAsset) => a.name && a.browserDownloadUrl) : [];
    const version = selectedRelease.version;
    const selectedAsset = selectReleaseAsset(assets, assetName);
    return {
      ok: true,
      repo,
      tag: String(data.tag_name || tag),
      version,
      currentVersion,
      updateAvailable: compareSemver(version, currentVersion) > 0,
      url: String(data.html_url || ''),
      assets,
      selectedAsset,
    };
  } catch (e) {
    const error = timedOut
      ? `GitHub release check timed out after ${timeoutMs}ms`
      : (e instanceof Error ? e.message : String(e));
    return { ok: false, repo, tag, version: '', currentVersion, updateAvailable: false, assets: [], error };
  } finally {
    clearTimeout(timer);
  }
}

async function downloadFile(url: string, destination: string, token?: string): Promise<void> {
  const response = await fetch(url, { headers: githubHeaders(token), redirect: 'follow' });
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  const arrayBuffer = await response.arrayBuffer();
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, Buffer.from(arrayBuffer));
}

function extractZip(zipPath: string, destination: string): void {
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });
  execFileSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-Command',
    'Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force; Write-Output "expand-ok"',
    zipPath,
    destination,
  ], { stdio: 'ignore', windowsHide: true });
}

function resolveExtractedUpdateRoot(extractPath: string): string {
  const winUnpacked = path.join(extractPath, 'win-unpacked');
  if (fs.existsSync(winUnpacked)) return winUnpacked;
  const entries = fs.readdirSync(extractPath, { withFileTypes: true }).filter(e => e.isDirectory());
  const nested = entries.find(e => /win-unpacked/i.test(e.name));
  if (nested) return path.join(extractPath, nested.name);
  return extractPath;
}

export async function applyGitHubUpdate(options: GitHubUpdateApplyOptions): Promise<GitHubUpdateApplyResult> {
  const release = await checkGitHubUpdate(options.repo, options.tag, options.asset, options.token);
  if (!release.ok) return { ...installUpdate({ source: '.', target: options.target, dryRun: true }), ok: false, release, error: release.error || 'GitHub release check failed.' };
  if (!release.selectedAsset) return { ...installUpdate({ source: '.', target: options.target, dryRun: true }), ok: false, release, error: 'No zip update asset found in GitHub release.' };
  try {
    const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-update-'));
    const downloadPath = path.join(workRoot, release.selectedAsset.name);
    const extractPath = path.join(workRoot, 'extracted');
    await downloadFile(release.selectedAsset.browserDownloadUrl, downloadPath, options.token);
    extractZip(downloadPath, extractPath);
    const source = resolveExtractedUpdateRoot(extractPath);
    const result = installUpdate({
      source,
      target: options.target,
      expectedVersion: options.expectedVersion,
      dryRun: options.dryRun,
    });
    return { ...result, release, downloadPath, extractPath };
  } catch (e) {
    return {
      ok: false,
      appVersion: currentAppVersion(),
      source: release.selectedAsset.browserDownloadUrl,
      target: path.resolve(options.target),
      dryRun: !!options.dryRun,
      copied: [],
      preserved: [],
      release,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export interface RunningNewmarkProcess {
  pid: number;
  name: string;
  executablePath: string;
}

export interface InstalledNewmarkProduct {
  productCode: string;
  displayName: string;
  installLocation: string;
  uninstallString: string;
}

export interface ManagedMsiInstallOptions {
  stopConfirmed?: boolean;
  removeLegacyConfirmed?: boolean;
  uninstallPrevious?: boolean;
  allowElevate?: boolean;
  excludeRoots?: string[];
  logDir?: string;
}

export interface ManagedMsiInstallPlan {
  ok: boolean;
  msiPath: string;
  runningProcesses: RunningNewmarkProcess[];
  installedProducts: InstalledNewmarkProduct[];
  legacyExecutables: string[];
  needsStopConfirmation: boolean;
  needsLegacyRemovalConfirmation: boolean;
  error?: string;
}

export interface ManagedMsiInstallResult {
  ok: boolean;
  plan: ManagedMsiInstallPlan;
  stopped: number[];
  uninstalled: string[];
  removedLegacy: string[];
  exitCode?: number;
  logPath?: string;
  error?: string;
}

const NEWMARK_PROCESS_NAMES = ['Newmark Agent.exe', 'Newmark.exe'];
const NEWMARK_LEGACY_EXECUTABLES = new Set(['newmark.exe', 'newmark agent.exe']);

function normalizeWindowsPathForCompare(value: string): string {
  return path.resolve(String(value)).toLowerCase();
}

function isWithinOrEqual(candidate: string, parent: string): boolean {
  const child = normalizeWindowsPathForCompare(candidate);
  const rootPath = normalizeWindowsPathForCompare(parent);
  return child === rootPath || child.startsWith(rootPath.endsWith(path.sep) ? rootPath : rootPath + path.sep);
}

function runPowerShellJson(script: string): Array<Record<string, any>> {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script];
  const stdout = execFileSync('powershell.exe', args, { encoding: 'utf-8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const trimmed = String(stdout || '').replace(/^\uFEFF/, '').trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed);
  return Array.isArray(parsed) ? parsed.map(item => item as Record<string, any>) : [parsed as Record<string, any>];
}

export function listRunningNewmarkProcesses(): RunningNewmarkProcess[] {
  const rows = runPowerShellJson(
    `Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'Newmark Agent.exe' -or $_.Name -eq 'Newmark.exe' } | Select-Object ProcessId,Name,ExecutablePath | ConvertTo-Json -Compress`,
  );
  const skipPid = Number(process.env.NEWMARK_SKIP_PROCESS_PID || process.pid);
  return rows
    .map(row => ({
      pid: Number(row.ProcessId || 0),
      name: String(row.Name || ''),
      executablePath: String(row.ExecutablePath || ''),
    }))
    .filter(proc => proc.pid > 0 && proc.pid !== skipPid);
}

export function stopNewmarkProcesses(pids: number[]): { stopped: number[]; errors: string[] } {
  const ids = Array.from(new Set((pids || []).map(Number).filter(pid => Number.isFinite(pid) && pid > 0)));
  if (!ids.length) return { stopped: [], errors: [] };
  const script = `$ids = @(${ids.join(',')}); foreach ($id in $ids) { try { Stop-Process -Id $id -Force -ErrorAction Stop; Write-Output ('stopped:' + $id) } catch { Write-Output ('error:' + $id + ':' + $_.Exception.Message) } }`;
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script];
  const stdout = String(execFileSync('powershell.exe', args, { encoding: 'utf-8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }) || '');
  const stopped: number[] = [];
  const errors: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const stoppedMatch = trimmed.match(/^stopped:(\d+)$/);
    const errorMatch = trimmed.match(/^error:(\d+):(.*)$/);
    if (stoppedMatch) stopped.push(Number(stoppedMatch[1]));
    else if (errorMatch) errors.push(`PID ${errorMatch[1]}: ${errorMatch[2]}`);
  }
  return { stopped, errors };
}

export function listInstalledNewmarkProducts(): InstalledNewmarkProduct[] {
  const rows = runPowerShellJson(
    `$paths = @('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'); Get-ItemProperty $paths -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like '*Newmark Agent*' } | Select-Object PSChildName,DisplayName,InstallLocation,UninstallString,QuietUninstallString | ConvertTo-Json -Compress`,
  );
  return rows
    .map(row => ({
      productCode: String(row.PSChildName || ''),
      displayName: String(row.DisplayName || ''),
      installLocation: String(row.InstallLocation || ''),
      uninstallString: String(row.UninstallString || row.QuietUninstallString || ''),
    }))
    .filter(product => product.productCode);
}

function runMsiExec(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = spawnSync('msiexec.exe', args, { encoding: 'utf-8', windowsHide: true });
  return {
    exitCode: result.status === null ? -1 : result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  };
}

function windowsCommandQuote(value: string): string {
  const text = String(value);
  return /\s/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

function runElevatedMsiExec(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const argumentString = args.map(arg => windowsCommandQuote(arg)).join(' ');
  const script = [
    `$argumentList = '${argumentString.replace(/'/g, "''")}'`,
    '$process = Start-Process -FilePath "msiexec.exe" -ArgumentList $argumentList -Verb RunAs -Wait -PassThru',
    'Write-Output ("EXITCODE:" + $process.ExitCode)',
  ].join('; ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf-8', windowsHide: true });
  const stdout = String(result.stdout || '');
  const match = stdout.match(/EXITCODE:(\d+)/);
  return {
    exitCode: match ? Number(match[1]) : (result.status === null ? -1 : result.status),
    stdout,
    stderr: String(result.stderr || ''),
  };
}

export function uninstallNewmarkProduct(productCode: string, logPath: string): { ok: boolean; exitCode: number; logPath: string; error?: string } {
  const args = ['/x', productCode, '/qn', '/norestart', '/l*v', logPath];
  let result = runMsiExec(args);
  if (result.exitCode !== 0) result = runElevatedMsiExec(args);
  return {
    ok: result.exitCode === 0,
    exitCode: result.exitCode,
    logPath,
    error: result.exitCode === 0 ? undefined : `msiexec uninstall exited ${result.exitCode}`,
  };
}

export function installMsiPackage(msiPath: string, options: { logDir?: string; allowElevate?: boolean } = {}): { ok: boolean; exitCode: number; logPath: string; error?: string } {
  const logPath = path.join(options.logDir || os.tmpdir(), `newmark-msi-install-${process.pid}-${Date.now()}.log`);
  const args = ['/i', path.resolve(msiPath), '/qn', '/norestart', '/l*v', logPath];
  let result = runMsiExec(args);
  if (result.exitCode !== 0 && options.allowElevate !== false) result = runElevatedMsiExec(args);
  return {
    ok: result.exitCode === 0,
    exitCode: result.exitCode,
    logPath,
    error: result.exitCode === 0 ? undefined : `msiexec install exited ${result.exitCode}`,
  };
}

export function findLegacyNewmarkExecutables(excludeRoots: string[] = []): string[] {
  const found = new Map<string, string>();
  for (const name of NEWMARK_PROCESS_NAMES) {
    try {
      const stdout = String(execFileSync('where.exe', [name], { encoding: 'utf-8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }) || '');
      for (const line of stdout.split(/\r?\n/)) {
        const candidate = String(line || '').trim();
        if (!candidate) continue;
        const key = normalizeWindowsPathForCompare(candidate);
        if (NEWMARK_LEGACY_EXECUTABLES.has(path.basename(candidate).toLowerCase()) && !found.has(key)) found.set(key, candidate);
      }
    } catch {
      // where.exe returns non-zero when an executable is not found on PATH.
    }
  }
  const exclude = (excludeRoots || []).filter(Boolean).map(root => normalizeWindowsPathForCompare(root));
  return Array.from(found.values())
    .filter(candidate => !exclude.some(root => isWithinOrEqual(candidate, root)))
    .sort();
}

export function removeLegacyNewmarkExecutables(paths: string[]): { removed: string[]; errors: string[] } {
  const removed: string[] = [];
  const errors: string[] = [];
  for (const candidate of Array.from(new Set(paths || []))) {
    const full = path.resolve(candidate);
    if (!NEWMARK_LEGACY_EXECUTABLES.has(path.basename(full).toLowerCase())) {
      errors.push(`refusing non-Newmark executable: ${full}`);
      continue;
    }
    try {
      fs.unlinkSync(full);
      removed.push(full);
    } catch (e) {
      errors.push(`${full}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { removed, errors };
}

export function planManagedMsiInstall(msiPath: string, options: ManagedMsiInstallOptions = {}): ManagedMsiInstallPlan {
  const fullPath = path.resolve(msiPath);
  try {
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile() || path.extname(fullPath).toLowerCase() !== '.msi') {
      return {
        ok: false,
        msiPath: fullPath,
        runningProcesses: [],
        installedProducts: [],
        legacyExecutables: [],
        needsStopConfirmation: false,
        needsLegacyRemovalConfirmation: false,
        error: `MSI package does not exist or is not a .msi file: ${fullPath}`,
      };
    }
    const runningProcesses = listRunningNewmarkProcesses();
    const installedProducts = listInstalledNewmarkProducts();
    const excludeRoots = [
      ...(options.excludeRoots || []),
      process.cwd(),
      path.dirname(process.execPath || ''),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Newmark Agent'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Newmark Agent'),
      ...installedProducts.map(product => product.installLocation),
    ];
    const legacyExecutables = findLegacyNewmarkExecutables(excludeRoots);
    return {
      ok: true,
      msiPath: fullPath,
      runningProcesses,
      installedProducts,
      legacyExecutables,
      needsStopConfirmation: runningProcesses.length > 0 && options.stopConfirmed !== true,
      needsLegacyRemovalConfirmation: legacyExecutables.length > 0 && options.removeLegacyConfirmed !== true,
    };
  } catch (e) {
    return {
      ok: false,
      msiPath: fullPath,
      runningProcesses: [],
      installedProducts: [],
      legacyExecutables: [],
      needsStopConfirmation: false,
      needsLegacyRemovalConfirmation: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export function executeManagedMsiInstall(msiPath: string, options: ManagedMsiInstallOptions = {}): ManagedMsiInstallResult {
  const plan = planManagedMsiInstall(msiPath, options);
  if (!plan.ok) {
    return { ok: false, plan, stopped: [], uninstalled: [], removedLegacy: [], error: plan.error };
  }
  if (plan.needsStopConfirmation) {
    return { ok: false, plan, stopped: [], uninstalled: [], removedLegacy: [], error: 'Running Newmark processes require confirmation before they can be stopped.' };
  }
  if (plan.needsLegacyRemovalConfirmation) {
    return { ok: false, plan, stopped: [], uninstalled: [], removedLegacy: [], error: 'Legacy Newmark executables require confirmation before they can be removed.' };
  }

  const stopResult = plan.runningProcesses.length
    ? stopNewmarkProcesses(plan.runningProcesses.map(process => process.pid))
    : { stopped: [] as number[], errors: [] as string[] };
  const uninstalled: string[] = [];
  if (options.uninstallPrevious !== false) {
    for (const product of plan.installedProducts) {
      const logPath = path.join(options.logDir || os.tmpdir(), `newmark-msi-uninstall-${product.productCode}-${process.pid}-${Date.now()}.log`);
      const uninstallResult = uninstallNewmarkProduct(product.productCode, logPath);
      if (!uninstallResult.ok) {
        return {
          ok: false,
          plan,
          stopped: stopResult.stopped,
          uninstalled,
          removedLegacy: [],
          exitCode: uninstallResult.exitCode,
          logPath: uninstallResult.logPath,
          error: `Failed to uninstall previous Newmark version ${product.productCode}: ${uninstallResult.error}`,
        };
      }
      uninstalled.push(product.productCode);
    }
  }

  const removeResult = plan.legacyExecutables.length
    ? removeLegacyNewmarkExecutables(plan.legacyExecutables)
    : { removed: [] as string[], errors: [] as string[] };
  const installResult = installMsiPackage(plan.msiPath, { logDir: options.logDir, allowElevate: options.allowElevate });
  return {
    ok: installResult.ok,
    plan,
    stopped: stopResult.stopped,
    uninstalled,
    removedLegacy: removeResult.removed,
    exitCode: installResult.exitCode,
    logPath: installResult.logPath,
    error: installResult.error,
  };
}
