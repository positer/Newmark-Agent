import { cliCommandUsage } from './cli-commands';

export function newmarkFlowHelpText(): string {
  return [
    'Newmark Flow command:',
    '',
    'Usage: Newmark.exe flow <workflow-name> [start-pc] [--input "text"] [--root <dir>]',
    'Run a saved Flow workflow from the selected local runtime root.',
    '',
    'Flags:',
    '  --help, -h     Show this Flow help and exit without runtime or model work.',
  ].join('\n') + '\n';
}

export function newmarkEditHelpText(): string {
  return [
    'Newmark editor command:',
    '',
    'Usage: Newmark.exe edit <file.txt|.json|.tex|.md>',
    'Open a supported text file in the terminal editor.',
    '',
    'Flags:',
    '  --help, -h     Show this editor help and exit without opening a file.',
  ].join('\n') + '\n';
}

export function newmarkHelpText(version: string): string {
  return [
    `Newmark Agent ${version}`,
    '',
    'Usage:',
    '  Newmark Agent.exe [--gui|--TUI|--cli] [--root <dir>]',
    '  Newmark.exe <command> ...',
    '  Newmark.exe flow <workflow-name> [start-pc] [--input "text"] [--root <dir>]',
    '  Newmark.exe edit <file.txt|.json|.tex|.md>',
    '',
    cliCommandUsage(),
    '',
    'Flags:',
    '  --help, -h     Show this help and exit.',
    '  --version, -v, -version  Show the installed version and exit.',
  ].join('\n');
}
