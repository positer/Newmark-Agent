import { CLI_COMMANDS } from './cli-commands';

const TOP_LEVEL_COMMANDS = new Set<string>([...CLI_COMMANDS, 'flow', 'edit', 'help']);
const VALUE_FLAGS = new Set<string>([
  '--root',
  '--input',
  '--input-env',
  '--input-file',
  '--mode',
  '--model',
  '--language',
  '--conversation',
  '--args',
  '--args-file',
  '--selected',
  '--models',
  '--name',
  '--url',
  '--key',
  '--api-key',
  '--protocol',
  '--endpoint',
  '--endpoint-env',
  '--url-env',
  '--key-env',
  '--api-key-env',
  '--env-file',
  '--env-file-env',
  '--claude-env-file',
  '--claude-env-file-env',
  '--anthropic-env-file',
  '--anthropic-env-file-env',
  '--candidate-models',
  '--query',
  '--type',
  '--target',
  '--source',
  '--source-id',
  '--remove-source',
  '--enable-source',
  '--disable-source',
  '--target-file',
  '--expected-version',
  '--preserve',
  '--repo',
  '--tag',
  '--asset',
  '--path',
  '--component',
  '--content-file',
  '--content',
  '--description',
  '--tags',
  '--workspace',
  '--remote-debugging-port',
  '--user-data-dir',
  '--disable-features',
  '--enable-features',
  '--remote-debugging-address',
  '--inspect-port',
  '--js-flags',
  '--viewer-request',
  '--msi',
  '--log-dir',
]);
const BOOLEAN_FLAGS = new Set<string>([
  '--tui',
  '--gui',
  '--cli',
  '--server',
  '--help',
  '-h',
  '--version',
  '-v',
  '-version',
  '--automation-wake',
  '--newmark-viewer',
  '--allow-multiple-instances',
  '--disable-gpu',
  '--no-sandbox',
  '--no-devtools',
  '--demo',
  '--persist',
  '--agent-only',
  '--list',
  '--preview-only',
  '--sources',
  '--add-source',
  '--check-github',
  '--from-github',
  '--dry-run',
  '--read',
  '--index',
  '--reindex',
  '--update',
  '--folder',
  '--quiet',
  '--json',
  '--limit',
  '--scopes',
  '--web',
  '--yes',
  '--confirm-stop',
  '--confirm-remove-legacy',
  '--no-uninstall-previous',
  '--no-elevate',
]);

/** Public version spellings accepted by every Newmark entrypoint. */
export function isVersionArgument(args: string[]): boolean {
  return args.some(arg => ['--version', '-v', '-version'].includes(String(arg).toLowerCase()));
}

/**
 * Validate arguments that are interpreted before a command-specific parser is
 * entered. This keeps malformed launch probes from silently starting a GUI or
 * falling back to the default user root.
 */
export function invalidTopLevelArgument(args: string[]): string | undefined {
  let skipNext = false;
  for (let index = 0; index < args.length; index++) {
    const raw = args[index];
    const arg = String(raw || '');
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (!arg || arg === '--') continue;
    if (!arg.startsWith('-')) continue;
    const name = (arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg).toLowerCase();
    const hasInlineValue = arg.includes('=');
    if (BOOLEAN_FLAGS.has(name)) continue;
    if (VALUE_FLAGS.has(name)) {
      if (!hasInlineValue) {
        const next = args[index + 1];
        if (!next || String(next).startsWith('-')) return `${name} requires a value`;
        skipNext = true;
      } else if (!arg.slice(name.length + 1)) {
        return `${name} requires a value`;
      }
      continue;
    }
    return arg;
  }
  return undefined;
}

/**
 * Return the first unknown positional top-level token without validating a
 * command's own arguments. Values belonging to documented flags are skipped,
 * so a space-containing --root or --input cannot be mistaken for a command.
 */
export function unknownTopLevelCommand(args: string[]): string | undefined {
  let skipNext = false;
  for (let index = 0; index < args.length; index++) {
    const raw = args[index];
    const arg = String(raw || '');
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (!arg) continue;
    if (arg.startsWith('--')) {
      const name = (arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg).toLowerCase();
      if (VALUE_FLAGS.has(name) && !arg.includes('=')) skipNext = true;
      else if (!VALUE_FLAGS.has(name) && !BOOLEAN_FLAGS.has(name)) return arg;
      continue;
    }
    if (arg.startsWith('-')) {
      if (!BOOLEAN_FLAGS.has(arg)) return arg;
      continue;
    }
    if (TOP_LEVEL_COMMANDS.has(arg.toLowerCase())) return undefined;
    return arg;
  }
  return undefined;
}
