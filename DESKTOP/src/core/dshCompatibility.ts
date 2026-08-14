import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface DshCompatibilityOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  pathValue?: string;
  platform?: NodeJS.Platform;
}

export interface DshMcpTemplate {
  name: string;
  enabled: false;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
}

export interface DshMcpCandidate {
  name: string;
  source: string;
  importable: boolean;
  reason?: string;
  envKeys: string[];
  headerKeys: string[];
  template?: DshMcpTemplate;
}

export interface DshConfigLayer {
  kind: 'bundle' | 'profile' | 'home';
  name: string;
  path: string;
  order: number;
}

export interface DshBundleSnapshot {
  name: string;
  version?: string;
  source: string;
  manifestPath: string;
  patch?: string;
  patchPath?: string;
  patchExists: boolean;
  unknownKeys: string[];
  resolved: boolean;
}

export interface DshProfileSnapshot {
  name: string;
  source: string;
  manifestPath: string;
  bundles: string[];
  unsupportedBundleEntries: number;
  configFiles: string[];
  layers: DshConfigLayer[];
  unknownKeys: string[];
}

/**
 * DSH dsh-compaction-basic 运行时 seam 到 Newmark 压缩系统的语义映射(纯元数据)。
 * Newmark 落地为运行时等价物，而非复制 DSH 代码；DSH 发现层永不 import/execute 插件主模块。
 */
export interface DshCompactionRuntimeSemantics {
  plugin: '@deepseek-ai/dsh-compaction-basic';
  execution: 'native-equivalent';
  seams: {
    apply: { dsh: string; newmark: string; description: string };
    summarize: { dsh: string; newmark: string; description: string };
    compactIfNeeded: { dsh: string; newmark: string; description: string };
    compactNow: { dsh: string; newmark: string; description: string };
  };
  budget: {
    buildBlockTriggerRatio: 0.70;
    longHistoryTriggerRatio: 0.20;
    buildRetainRatio: 0.16;
    longHistoryRetainRatio: 0.05;
    newmarkSource: string;
  };
  cacheReuse: { dshStrategy: string; newmarkEquivalent: string; note: string };
  /** DSH toolResultPruner 的 Newmark 落地（压缩前裁剪大工具结果）。 */
  toolPruning: { dsh: string; newmark: string; thresholdChars: number };
}

/**
 * DSH 工具层运行时语义映射（纯元数据，永不执行 DSH 插件代码）。
 * 覆盖 DSH 的 ToolRuntime / defineTool / 工具呈现与并发分级语义，映射到
 * Newmark 原生工具执行层。DSH 是 developer preview，schema 可能不兼容变更，
 * 映射层 fail-soft：未识别字段保留为元数据、降级 opaque，不抛错不改写外部文件。
 */
export interface DshToolLayerRuntimeSemantics {
  plugin: '@deepseek-ai/dsh-tools';
  execution: 'native-equivalent';
  seams: {
    register: { dsh: string; newmark: string; description: string };
    concurrency: { dsh: string; newmark: string; description: string };
    presentation: { dsh: string; newmark: string; description: string };
    pluginDiscovery: { dsh: string; newmark: string; description: string };
  };
  breakingChangeCompat: {
    strategy: string;
    mechanisms: string[];
    boundary: string;
  };
}

export interface DshCompatibilitySnapshot {
  id: 'deepseek-harness';
  displayName: 'DeepSeek Harness (DSH)';
  developerPreview: true;
  detected: boolean;
  readOnly: true;
  preservesUnknownFields: true;
  dshHome: string;
  home: { path: string; source: 'DSH_HOME' | 'default'; exists: boolean };
  cli: { command: 'dsh'; available: boolean; path?: string; version?: string; packageVersion?: string };
  package: { name: '@deepseek-ai/dsh'; version?: string; manifestPath?: string };
  update: {
    package: '@deepseek-ai/dsh';
    channel: 'latest';
    locked: false;
    runCommand: 'npx @deepseek-ai/dsh web';
    pluginCommand: 'dsh plugin --profile <name> add <package>';
    repository: string;
    documentation: string;
    npm: string;
  };
  recognizedManifestKeys: ['dsh.bundle.patch', 'dsh.profile.bundles'];
  profiles: DshProfileSnapshot[];
  bundles: DshBundleSnapshot[];
  mcpCandidates: DshMcpCandidate[];
  configFiles: string[];
  homeConfigFiles: string[];
  unknownKeys: string[];
  warnings: string[];
  scannedAt: string;
  compaction: DshCompactionRuntimeSemantics;
  toolLayer: DshToolLayerRuntimeSemantics;
}

type JsonRecord = Record<string, unknown>;

const REPOSITORY = 'https://github.com/deepseek-ai/deepseek-harness';
const DOCUMENTATION = `${REPOSITORY}/blob/master/docs/user/develop/basic/publish.md`;
const NPM = 'https://www.npmjs.com/package/@deepseek-ai/dsh';
const CONFIG_NAMES = ['cordis.patch.yml', 'cordis.yml'] as const;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
const MAX_PROFILES = 256;
const MAX_DIRECTORY_ENTRIES = 1024;
const DSH_PACKAGE_KEYS = new Set(['bundle', 'profile']);
const PACKAGE_KEYS = new Set([
  'name', 'version', 'private', 'description', 'keywords', 'homepage', 'bugs', 'license', 'author', 'contributors',
  'funding', 'files', 'main', 'module', 'types', 'typings', 'exports', 'bin', 'scripts', 'engines', 'os', 'cpu',
  'publishConfig', 'repository', 'dependencies', 'devDependencies', 'peerDependencies', 'peerDependenciesMeta',
  'optionalDependencies', 'bundledDependencies', 'bundleDependencies', 'workspaces', 'packageManager', 'type', 'sideEffects',
  'dsh',
]);

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function readTextFile(filePath: string, maxBytes: number): string | undefined {
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile() || stats.size > maxBytes) return undefined;
    const value = fs.readFileSync(filePath);
    if (value.byteLength > maxBytes) return undefined;
    return value.toString('utf8').replace(/^\uFEFF/, '');
  } catch {
    return undefined;
  }
}

function readJson(filePath: string): JsonRecord | undefined {
  try {
    const text = readTextFile(filePath, MAX_JSON_BYTES);
    return text === undefined ? undefined : record(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function fileExists(filePath: string): boolean {
  try { return fs.statSync(filePath).isFile(); } catch { return false; }
}

function directoryExists(filePath: string): boolean {
  try { return fs.statSync(filePath).isDirectory(); } catch { return false; }
}

function pathEscapes(basePath: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(basePath), path.resolve(candidatePath));
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function confinedPatchPath(directory: string, patch: string): string | undefined {
  const clean = String(patch || '').trim();
  if (!clean || path.isAbsolute(clean)) return undefined;
  const candidate = path.resolve(directory, clean);
  if (pathEscapes(directory, candidate)) return undefined;
  if (fileExists(candidate)) {
    try {
      const realDirectory = fs.realpathSync(directory);
      const realCandidate = fs.realpathSync(candidate);
      if (pathEscapes(realDirectory, realCandidate)) return undefined;
    } catch {
      return undefined;
    }
  }
  return candidate;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function unknownPackageKeys(manifest: JsonRecord): string[] {
  return Object.keys(manifest).filter(key => !PACKAGE_KEYS.has(key)).sort();
}

function unknownDshKeys(value: unknown): string[] {
  return Object.keys(record(value)).filter(key => !DSH_PACKAGE_KEYS.has(key)).sort();
}

function findDshCommand(pathValue: string, platform: NodeJS.Platform): string | undefined {
  const names = platform === 'win32' ? ['dsh.exe', 'dsh.cmd', 'dsh.bat'] : ['dsh'];
  for (const directory of pathValue.split(path.delimiter).map(value => value.trim()).filter(Boolean).slice(0, 512)) {
    for (const name of names) {
      const candidate = path.resolve(directory.replace(/^"|"$/g, ''), name);
      if (fileExists(candidate)) return candidate;
    }
  }
  return undefined;
}

function packageManifestCandidates(root: string, dshHome: string, cliPath?: string): string[] {
  const candidates = [
    path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    path.join(dshHome, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
  ];
  if (cliPath) {
    const bin = path.dirname(cliPath);
    candidates.push(
      path.join(bin, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
      path.resolve(bin, '..', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
      path.resolve(bin, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    );
  }
  return unique(candidates.map(candidate => path.resolve(candidate)));
}

function manifestVersion(filePath: string | undefined): string | undefined {
  const value = filePath ? readJson(filePath) : undefined;
  return typeof value?.version === 'string' ? value.version : undefined;
}

function bundleName(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  const entry = record(value);
  for (const key of ['name', 'package', 'id']) {
    if (typeof entry[key] === 'string' && String(entry[key]).trim()) return String(entry[key]).trim();
  }
  return undefined;
}

function dependencyPath(profileRoot: string, name: string, spec: unknown): string[] {
  const paths = [path.join(profileRoot, 'node_modules', ...name.split('/'), 'package.json')];
  if (typeof spec === 'string') {
    const clean = spec.replace(/^(?:file:|link:)/, '');
    if (clean !== spec || clean.startsWith('.') || path.isAbsolute(clean)) paths.unshift(path.resolve(profileRoot, clean, 'package.json'));
  }
  return unique(paths);
}

function bundleSnapshot(name: string, manifestPath: string, source: string): DshBundleSnapshot {
  const manifest = readJson(manifestPath);
  if (!manifest) {
    return { name, source, manifestPath, patchExists: false, unknownKeys: [], resolved: false };
  }
  const dsh = record(manifest.dsh);
  const bundle = record(dsh.bundle);
  const patch = typeof bundle.patch === 'string' ? bundle.patch : undefined;
  const patchPath = patch ? confinedPatchPath(path.dirname(manifestPath), patch) : undefined;
  return {
    name: typeof manifest.name === 'string' ? manifest.name : name,
    version: typeof manifest.version === 'string' ? manifest.version : undefined,
    source,
    manifestPath,
    patch,
    patchPath,
    patchExists: !!patchPath && fileExists(patchPath),
    unknownKeys: unique(unknownPackageKeys(manifest).concat(unknownDshKeys(dsh), Object.keys(bundle).filter(key => key !== 'patch'))),
    resolved: true,
  };
}

function safeScalar(raw: string): string | undefined {
  const value = raw.trim().replace(/\s+#.*$/, '').trim();
  if (!value || /^!!|[&*!]|\$\{|process\.|require\(|<%/i.test(value)) return undefined;
  if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
    try { return value.startsWith('"') ? JSON.parse(value) : value.slice(1, -1).replace(/''/g, "'"); } catch { return undefined; }
  }
  if (/^[A-Za-z0-9_@./:\\+ -]+$/.test(value)) return value;
  return undefined;
}

function inlineStringArray(raw: string): string[] | undefined {
  const value = raw.trim();
  if (!value.startsWith('[') || !value.endsWith(']') || /!!|process\.|\$\{|[&*!]/i.test(value)) return undefined;
  try {
    const json = value.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_match, inner) => JSON.stringify(inner.replace(/\\'/g, "'")));
    const parsed = JSON.parse(json);
    return Array.isArray(parsed)
      && parsed.length <= 100
      && parsed.every(item => typeof item === 'string' && item.length <= 4000 && !item.includes('\0'))
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function indentation(line: string): number {
  return line.match(/^\s*/)?.[0].length || 0;
}

function collectNestedKeys(lines: string[], start: number, parentIndent: number): string[] {
  const keys: string[] = [];
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = indentation(line);
    if (indent <= parentIndent) break;
    const match = line.trim().match(/^([A-Za-z_][A-Za-z0-9_-]*):/);
    if (match) keys.push(match[1]);
  }
  return unique(keys).sort();
}

function findScalar(lines: string[], start: number, end: number, key: string): string | undefined {
  for (let index = start; index < end; index++) {
    const match = lines[index].trim().match(new RegExp(`^${key}:\\s*(.+)$`));
    if (match) return safeScalar(match[1]);
  }
  return undefined;
}

function discoverMcpCandidates(configPath: string): DshMcpCandidate[] {
  const text = readTextFile(configPath, MAX_CONFIG_BYTES);
  if (text === undefined) return [];
  const lines = text.split(/\r?\n/);
  const candidates: DshMcpCandidate[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (!/^\s*name:\s*['"]?@deepseek-ai\/dsh-mcp-client['"]?\s*(?:#.*)?$/.test(lines[index])) continue;
    const itemIndent = (() => {
      for (let cursor = index; cursor >= 0; cursor--) if (/^\s*-\s+/.test(lines[cursor])) return indentation(lines[cursor]);
      return Math.max(0, indentation(lines[index]) - 2);
    })();
    let start = index;
    while (start > 0 && !(indentation(lines[start]) === itemIndent && /^\s*-\s+/.test(lines[start]))) start--;
    let end = index + 1;
    while (end < lines.length && !(indentation(lines[end]) === itemIndent && /^\s*-\s+/.test(lines[end]))) end++;
    const block = lines.slice(start, end);
    const dynamicEndpoint = block.some(line => /^\s*(?:transport|command|url|args):.*(?:!!|process\.|\$\{|require\(|<%)/.test(line));
    const serverName = findScalar(lines, start, end, 'serverName') || findScalar(lines, start, end, 'id') || `DSH MCP ${candidates.length + 1}`;
    const transport = findScalar(lines, start, end, 'transport');
    const command = findScalar(lines, start, end, 'command');
    const url = findScalar(lines, start, end, 'url');
    let args: string[] | undefined;
    for (let cursor = start; cursor < end; cursor++) {
      const match = lines[cursor].trim().match(/^args:\s*(.+)$/);
      if (match) args = inlineStringArray(match[1]);
    }
    const envIndex = lines.findIndex((line, cursor) => cursor >= start && cursor < end && /^\s*env:\s*$/.test(line));
    const headerIndex = lines.findIndex((line, cursor) => cursor >= start && cursor < end && /^\s*headers:\s*$/.test(line));
    const envKeys = envIndex >= 0 ? collectNestedKeys(lines, envIndex, indentation(lines[envIndex])) : [];
    const headerKeys = headerIndex >= 0 ? collectNestedKeys(lines, headerIndex, indentation(lines[headerIndex])) : [];
    const isHttp = transport === 'streamable-http' || transport === 'http';
    const isStdio = !transport || transport === 'stdio';
    const urlHasCredentials = (() => {
      if (!isHttp || !url) return false;
      try {
        const parsed = new URL(url);
        return !!(parsed.username || parsed.password)
          || Array.from(parsed.searchParams.keys()).some(key => /(?:api.?key|authorization|access.?token|secret|password|credential)/i.test(key));
      } catch {
        return false;
      }
    })();
    const argsContainCredentials = !!args && args.some((item, argIndex) => {
      if (/(?:api.?key|authorization|access.?token|secret|password|credential)\s*[:=]\s*[^\s]/i.test(item)) return true;
      return /^(?:--?|\/)(?:api[-_]?key|authorization|access[-_]?token|token|secret|password|credential)$/i.test(item)
        && argIndex + 1 < args.length;
    });
    const sensitiveEndpoint = urlHasCredentials || argsContainCredentials;
    const importable = !dynamicEndpoint && !sensitiveEndpoint && (isHttp ? !!url && /^https?:\/\//i.test(url) : isStdio && !!command);
    const template: DshMcpTemplate | undefined = importable ? {
      name: serverName,
      enabled: false,
      transport: isHttp ? 'http' : 'stdio',
      command: isHttp ? undefined : command,
      args: isHttp ? undefined : (args || []),
      url: isHttp ? url : undefined,
    } : undefined;
    candidates.push({
      name: serverName,
      source: configPath,
      importable,
      reason: importable
        ? undefined
        : (dynamicEndpoint
          ? 'Dynamic Cordis endpoint values are not evaluated; review this candidate in DSH.'
          : (sensitiveEndpoint
            ? 'Credentials embedded in an MCP URL or argument are not exposed; configure them manually with environment variables or headers.'
            : 'No complete recognized static command or HTTP URL was found.')),
      envKeys,
      headerKeys,
      template,
    });
  }
  return candidates;
}

function workspaceBundleManifests(root: string): string[] {
  const output: string[] = [];
  const ignored = new Set(['.git', 'node_modules', 'dist', 'release', 'archive', '.newmark-runtime', 'conversations']);
  const visit = (directory: string, depth: number) => {
    if (depth > 3 || output.length >= 256) return;
    const manifestPath = path.join(directory, 'package.json');
    if (fileExists(manifestPath)) {
      const manifest = readJson(manifestPath);
      if (record(record(manifest?.dsh).bundle).patch) output.push(manifestPath);
    }
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }).slice(0, MAX_DIRECTORY_ENTRIES); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || ignored.has(entry.name) || entry.name.startsWith('.')) continue;
      visit(path.join(directory, entry.name), depth + 1);
    }
  };
  visit(root, 0);
  return unique(output);
}

export function discoverDshCompatibility(root: string, options: DshCompatibilityOptions = {}): DshCompatibilitySnapshot {
  const env = options.env || process.env;
  const homeDir = options.homeDir || os.homedir();
  const dshHome = path.resolve(String(env.DSH_HOME || '').trim() || path.join(homeDir, '.dsh'));
  const homeSource = String(env.DSH_HOME || '').trim() ? 'DSH_HOME' : 'default';
  const pathValue = options.pathValue ?? String(env.PATH || env.Path || '');
  const cliPath = findDshCommand(pathValue, options.platform || process.platform);
  const dshPackageManifest = packageManifestCandidates(root, dshHome, cliPath).find(fileExists);
  const packageVersion = manifestVersion(dshPackageManifest);
  const profiles: DshProfileSnapshot[] = [];
  const bundles: DshBundleSnapshot[] = [];
  const mcpCandidates: DshMcpCandidate[] = [];
  const warnings: string[] = [
    'DSH is a developer preview. Newmark scans metadata only and does not install, update, import, execute, or rewrite DSH/plugin code.',
    'The @deepseek-ai/dsh update channel remains latest and unpinned; review compatibility warnings after every DSH update.',
  ];
  const unknownKeys: string[] = [];
  const profileRoot = path.join(dshHome, 'profiles');
  const homeConfigFiles = CONFIG_NAMES.map(name => path.join(dshHome, name)).filter(fileExists);
  let profileEntries: fs.Dirent[] = [];
  try { profileEntries = fs.readdirSync(profileRoot, { withFileTypes: true }); } catch {}
  const directoryProfiles = profileEntries.filter(item => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
  if (directoryProfiles.length > MAX_PROFILES) warnings.push(`Only the first ${MAX_PROFILES} DSH profiles were inspected in this bounded read-only scan.`);
  for (const entry of directoryProfiles.slice(0, MAX_PROFILES)) {
    const source = path.join(profileRoot, entry.name);
    const manifestPath = path.join(source, 'package.json');
    const manifest = readJson(manifestPath);
    if (!manifest) {
      warnings.push(`Profile ${entry.name} has no readable package.json.`);
      continue;
    }
    const dsh = record(manifest.dsh);
    const profile = record(dsh.profile);
    const rawBundles = Array.isArray(profile.bundles) ? profile.bundles : [];
    const orderedBundles = rawBundles.map(bundleName).filter((name): name is string => !!name);
    const configFiles = CONFIG_NAMES.map(name => path.join(source, name)).filter(fileExists);
    const layers: DshConfigLayer[] = [];
    const profileUnknown = unique(unknownPackageKeys(manifest).concat(unknownDshKeys(dsh), Object.keys(profile).filter(key => key !== 'bundles')));
    profiles.push({
      name: typeof manifest.name === 'string' ? manifest.name : entry.name,
      source,
      manifestPath,
      bundles: orderedBundles,
      unsupportedBundleEntries: Math.max(0, rawBundles.length - orderedBundles.length),
      configFiles,
      layers,
      unknownKeys: profileUnknown,
    });
    unknownKeys.push(...profileUnknown.map(key => `${entry.name}:${key}`));
    if (!Array.isArray(profile.bundles)) warnings.push(`Profile ${entry.name} does not expose dsh.profile.bundles as an array.`);
    if (rawBundles.length !== orderedBundles.length) warnings.push(`Profile ${entry.name} contains future or unsupported bundle entries; their order was not rewritten.`);
    const dependencies = { ...record(manifest.dependencies), ...record(manifest.devDependencies), ...record(manifest.optionalDependencies) };
    for (const name of orderedBundles) {
      const candidates = dependencyPath(source, name, dependencies[name]);
      const resolved = candidates.find(fileExists);
      const snapshot = bundleSnapshot(name, resolved || candidates[0], source);
      bundles.push(snapshot);
      if (snapshot.patchPath && snapshot.patchExists) {
        layers.push({ kind: 'bundle', name: snapshot.name, path: snapshot.patchPath, order: layers.length });
      }
      if (!snapshot.resolved) warnings.push(`Bundle ${name} from profile ${entry.name} could not be resolved locally.`);
      else if (!snapshot.patch) warnings.push(`Bundle ${name} has no static dsh.bundle.patch declaration.`);
      else if (!snapshot.patchExists) warnings.push(`Bundle ${name} declares a missing patch file: ${snapshot.patch}`);
    }
    for (const configFile of configFiles) {
      layers.push({ kind: 'profile', name: path.basename(configFile), path: configFile, order: layers.length });
    }
    for (const configFile of configFiles) mcpCandidates.push(...discoverMcpCandidates(configFile));
  }
  for (const configFile of homeConfigFiles) mcpCandidates.push(...discoverMcpCandidates(configFile));
  for (const manifestPath of workspaceBundleManifests(root)) {
    const manifest = readJson(manifestPath);
    const name = typeof manifest?.name === 'string' ? manifest.name : path.basename(path.dirname(manifestPath));
    if (!bundles.some(bundle => path.resolve(bundle.manifestPath) === path.resolve(manifestPath))) bundles.push(bundleSnapshot(name, manifestPath, root));
  }
  for (const bundle of bundles) {
    unknownKeys.push(...bundle.unknownKeys.map(key => `${bundle.name}:${key}`));
    if (bundle.patchPath && bundle.patchExists) mcpCandidates.push(...discoverMcpCandidates(bundle.patchPath));
  }
  if (!cliPath) warnings.push('The dsh command was not found on PATH; this is informational and no command was executed.');
  if (!dshPackageManifest) warnings.push('@deepseek-ai/dsh was not found in the inspected local package roots.');
  if (!profiles.length) warnings.push(`No DSH profiles were found under ${profileRoot}.`);
  const dedupedBundles = bundles.filter((bundle, index) => bundles.findIndex(other => path.resolve(other.manifestPath) === path.resolve(bundle.manifestPath)) === index);
  const dedupedMcp = mcpCandidates.filter((candidate, index) => mcpCandidates.findIndex(other => other.name === candidate.name && other.source === candidate.source) === index);
  const configFiles = unique(profiles.flatMap(profile => profile.configFiles).concat(
    dedupedBundles.flatMap(bundle => bundle.patchPath && bundle.patchExists ? [bundle.patchPath] : []),
    homeConfigFiles,
  ));
  return {
    id: 'deepseek-harness',
    displayName: 'DeepSeek Harness (DSH)',
    developerPreview: true,
    detected: !!(cliPath || dshPackageManifest || directoryExists(dshHome) || profiles.length || dedupedBundles.length),
    readOnly: true,
    preservesUnknownFields: true,
    dshHome,
    home: { path: dshHome, source: homeSource, exists: directoryExists(dshHome) },
    cli: { command: 'dsh', available: !!cliPath, path: cliPath, version: cliPath ? packageVersion : undefined, packageVersion },
    package: { name: '@deepseek-ai/dsh', version: packageVersion, manifestPath: dshPackageManifest },
    update: {
      package: '@deepseek-ai/dsh',
      channel: 'latest',
      locked: false,
      runCommand: 'npx @deepseek-ai/dsh web',
      pluginCommand: 'dsh plugin --profile <name> add <package>',
      repository: REPOSITORY,
      documentation: DOCUMENTATION,
      npm: NPM,
    },
    recognizedManifestKeys: ['dsh.bundle.patch', 'dsh.profile.bundles'],
    profiles,
    bundles: dedupedBundles,
    mcpCandidates: dedupedMcp,
    configFiles,
    homeConfigFiles,
    unknownKeys: unique(unknownKeys).sort(),
    warnings: unique(warnings),
    scannedAt: new Date().toISOString(),
    compaction: dshCompactionRuntimeSemantics(),
    toolLayer: dshToolLayerRuntimeSemantics(),
  };
}

/**
 * DSH dsh-compaction-basic 运行时 seam 到 Newmark 压缩系统的语义映射。
 * 纯只读元数据：描述 DSH 各运行时入口如何映射到 Newmark 的原生等价实现，
 * 既不 import 也不 execute 任何 DSH 插件代码。
 */
export function dshCompactionRuntimeSemantics(): DshCompactionRuntimeSemantics {
  return {
    plugin: '@deepseek-ai/dsh-compaction-basic',
    execution: 'native-equivalent',
    seams: {
      apply: {
        dsh: 'apply(ctx) 注册 automatic compaction（agent/pre-step 压力检测 + agent/request-error 溢出恢复）',
        newmark: 'Agent.maybeCompress() + Agent.compressionBudget()（Build 70% / 长期 20% 触发）',
        description: 'DSH 的 between-step 自动压缩注册机制，由 Newmark 原生 maybeCompress 承接。',
      },
      summarize: {
        dsh: 'summarize(input, agent, signal) 单次摘要（复用主对话 system+tools+前缀消息命中 provider KV 缓存）',
        newmark: 'Agent.compressMiddleMessages()（LLM 摘要 + localCompressionSummary 回退）',
        description: 'DSH 的 prefix-cache 复用策略由 Newmark 以显式 system 前缀渲染承接（见 cacheReuse）。',
      },
      compactIfNeeded: {
        dsh: 'compactIfNeeded(agent, trigger, signal) 压力/溢出触发，带重试回退',
        newmark: 'Agent.maybeCompress(msgs, provider, signal, compressionModel, force)',
        description: '触发判定 + 重试 + 阈值后置检查的运行时入口一一对应。',
      },
      compactNow: {
        dsh: 'compactNow(agent, signal, sourceCommandId) 手工空闲会话压缩',
        newmark: 'Agent.handleContextCompress()（context_compress 工具）',
        description: 'DSH 的手工压缩命令入口对应 Newmark 的 context_compress/context_history_manage 工具。',
      },
    },
    budget: {
      buildBlockTriggerRatio: 0.70,
      longHistoryTriggerRatio: 0.20,
      buildRetainRatio: 0.16,
      longHistoryRetainRatio: 0.05,
      newmarkSource: 'Agent.compressionBudget（buildBlockTriggerTokens = maxTokens * 0.70, longHistoryTriggerTokens = maxTokens * 0.20）',
    },
    cacheReuse: {
      dshStrategy: '压缩摘要调用重放主对话的 system prompt + tools + 前缀消息，仅把压缩指令作为最后一条 user 消息追加，复用 provider 的 warm prefix cache，避免 KV cache 失效。',
      newmarkEquivalent: 'buildCompressionSummary 已落地 DSH 式前缀复用：system = buildSystemPrompt()（systemPromptCache 保证跨回合字节稳定），messages = 被压缩省略段原样前缀（含 tool/tool_calls，openAIChatMessages 自动修复工具配对） + 压缩指令尾 user 消息；历史图片降级为占位文本以保持前缀一致。',
      note: '缓存命中来自 system 前缀稳定 + 省略段消息前缀复用两层；主对话的额外 bootstrap 段(第一次请求/压缩后各注入一次)不参与摘要前缀，因 provider 按连续前缀缓存，省略段消息前缀的命中已覆盖主要 token。',
    },
    toolPruning: {
      dsh: 'ctx.get("toolResultPruner").pruneSession(session)：压缩前先裁剪会话中的大工具结果，再测是否仍需压缩。',
      newmark: 'buildCompressionSummary 在构建前缀消息时，对 role=tool/function 且 content 超过 TOOL_RESULT_PRUNE_CHARS(8000) 的结果调用 pruneToolResultContent() 裁剪为「头部结论 + 尾部证据」，避免巨型 read/grep/terminal 输出整段重放给摘要模型。',
      thresholdChars: 8000,
    },
  };
}

/**
 * DSH 工具层的运行时语义映射（纯只读元数据）。
 * 描述 DSH 工具层各 seam 如何映射到 Newmark 原生工具执行层，并声明破坏性
 * developer-preview schema 更新的 fail-soft 兼容策略。既不 import 也不 execute
 * 任何 DSH 插件代码。
 */
export function dshToolLayerRuntimeSemantics(): DshToolLayerRuntimeSemantics {
  return {
    plugin: '@deepseek-ai/dsh-tools',
    execution: 'native-equivalent',
    seams: {
      register: {
        dsh: 'defineTool(schema, execute, { isConcurrencySafe, presentCall, presentResult }) + ToolRuntime.register(definition)',
        newmark: 'ToolExecutor.execute(name, args, wsPath, context) + compat.legacyToolToNewmark(def) + compat.inferSideEffects(name)',
        description: 'DSH 的工具定义/注册运行时入口对应 Newmark 的 ToolExecutor + compat 工具规范化与副作用推断。',
      },
      concurrency: {
        dsh: 'isConcurrencySafe(args): boolean 运行时分类，仅 true 才允许与兄弟调用并行；exclusive 形成屏障',
        newmark: 'isConcurrencySafeTool(name) + AgentTool.concurrencySafe + agent-loop.executeToolCalls 分级调度（只读工具并行，副作用工具独占串行）',
        description: 'DSH 的并发安全分级已落地为 Newmark 的 concurrencySafe 字段与分级调度器，避免盲目 Promise.all 导致副作用工具竞态。',
      },
      presentation: {
        dsh: 'ToolPresentationMode: native（逐工具 schema）/ code（run_code 批量内联）/ both',
        newmark: 'Newmark 原生 native 工具循环（chatStreamWithTools + 内联 toolResult 有界截断 boundInlineToolResult）',
        description: 'Newmark 保持 native 呈现；DSH 的 code-mode 批量内联思想以内联工具结果有界截断承接，避免巨型结果撑爆 context。',
      },
      pluginDiscovery: {
        dsh: 'cordis plugin loader 加载工具层插件（defineTool 注册）',
        newmark: 'compat.discoverPluginManifests(root) 发现 components.tools；runOpenCodeTool 执行 OpenCode 工具',
        description: 'DSH 工具层插件由 Newmark 的插件清单发现层以只读元数据承接；只有 OpenCode JS 工具经 compat-tool 显式执行。',
      },
    },
    breakingChangeCompat: {
      strategy: 'DSH 是 developer preview，manifest/tool schema 可能不兼容变更。Newmark 保持 fail-soft：每个 seam 独立版本化，未识别字段一律保留为元数据并降级为 opaque 展示，绝不因 DSH schema 演进而抛错、拒绝启动或改写外部 DSH 文件。',
      mechanisms: [
        'unknownKeys 全量保留并上报（dshCompatibility 的 preservesUnknownFields: true + unknownKeys 数组）',
        'unresolved/未来 bundle 条目降级为 unsupportedBundleEntries 计数而非失败',
        '动态 !!js / 凭据承载的 MCP 端点判为不可导入并附 reason，而非执行或暴露',
        '工具层映射（register/concurrency/presentation）是元数据描述，不绑定 DSH 精确 schema，DSH 更新只增删描述不破坏 Newmark 运行',
      ],
      boundary: 'Newmark 永不 import/require/execute/spawn DSH 插件 main 模块或可执行标签，永不 install/update/rewrite DSH 文件；官方 dsh 命令是唯一写路径。',
    },
  };
}
