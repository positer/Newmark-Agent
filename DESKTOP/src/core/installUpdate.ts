import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync, spawn } from 'child_process';

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

function compareSemver(a: string, b: string): number {
  const pa = String(a || '').replace(/^v/i, '').split(/[.-]/).map(n => Number(n) || 0);
  const pb = String(b || '').replace(/^v/i, '').split(/[.-]/).map(n => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff) return diff > 0 ? 1 : -1;
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

export async function checkGitHubUpdate(repoInput?: string, tagInput?: string, assetName?: string, token?: string): Promise<GitHubUpdateCheckResult> {
  const repo = normalizeRepo(repoInput);
  const tag = String(tagInput || 'latest').replace(/^refs\/tags\//, '');
  const endpoint = tag && tag !== 'latest'
    ? `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`
    : `https://api.github.com/repos/${repo}/releases/latest`;
  const currentVersion = currentAppVersion();
  try {
    const response = await fetch(endpoint, { headers: githubHeaders(token) });
    if (!response.ok) throw new Error(`GitHub release request failed: HTTP ${response.status}`);
    const data = await response.json() as Record<string, any>;
    const assets = Array.isArray(data.assets) ? data.assets.map((a: Record<string, any>) => ({
      name: String(a.name || ''),
      size: Number(a.size || 0),
      browserDownloadUrl: String(a.browser_download_url || ''),
      contentType: String(a.content_type || ''),
    })).filter((a: GitHubReleaseAsset) => a.name && a.browserDownloadUrl) : [];
    const version = String(data.tag_name || '').replace(/^v/i, '') || currentVersion;
    const selectedAsset = selectReleaseAsset(assets, assetName);
    return {
      ok: true,
      repo,
      tag: String(data.tag_name || tag),
      version,
      currentVersion,
      updateAvailable: compareSemver(version, currentVersion) > 0 || String(data.tag_name || '') === `v${currentVersion}`,
      url: String(data.html_url || ''),
      assets,
      selectedAsset,
    };
  } catch (e) {
    return { ok: false, repo, tag, version: '', currentVersion, updateAvailable: false, assets: [], error: e instanceof Error ? e.message : String(e) };
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
