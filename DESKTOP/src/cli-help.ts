import { cliCommandUsage } from './cli-commands';

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
    '  --version, -v  Show the installed version and exit.',
  ].join('\n');
}
