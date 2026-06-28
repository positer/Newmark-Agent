import * as fs from 'fs';
import * as path from 'path';

type FileType = 'txt' | 'json' | 'tex' | 'md';

interface EditCommand {
  type: string;
  args: string[];
}

function detectType(filePath: string): FileType {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.json') return 'json';
  if (ext === '.tex') return 'tex';
  if (ext === '.md') return 'md';
  return 'txt';
}

function formatHelp(type: FileType, fileName: string): string {
  const cmds: Record<string, string> = {
    'cat': 'cat — show file content',
    'lines [n]': 'lines — show first/last n lines',
    'replace "old" "new"': 'replace — find & replace',
    'insert <n> <text>': 'insert — insert after line N',
    'append <text>': 'append — add line at end',
    'delete <n>': 'delete — remove line N',
    'save': 'save — write changes to disk',
    'validate': 'validate — check syntax',
    'help': 'help — show this menu',
    'quit': 'quit — exit (discards unsaved)',
  };
  if (type === 'json') cmds['format'] = 'format — pretty-print JSON';
  if (type === 'tex' || type === 'md') cmds['preview'] = 'preview — show plain-text strip';

  let out = `\n  ${'='.repeat(40)}\n  CLI Editor — .${type}  |  ${fileName}\n  ${'='.repeat(40)}\n\n  Commands:\n`;
  for (const [k, v] of Object.entries(cmds)) out += `    ${k.padEnd(30)}${v}\n`;
  out += `\n  Press Enter on empty line to preview.\n`;
  return out;
}

export async function runCliEditor(filePath: string): Promise<void> {
  const absPath = path.resolve(filePath);
  const type = detectType(absPath);
  let content: string;
  let modified = false;

  if (fs.existsSync(absPath)) {
    content = fs.readFileSync(absPath, 'utf-8');
    console.log(`\n  Loaded: ${absPath} (${content.length} chars, ${content.split('\n').length} lines)`);
  } else {
    console.log(`\n  New file: ${absPath}`);
    content = type === 'json' ? '{}' : '';
    modified = true;
  }

  if (type === 'json') {
    try { JSON.parse(content); } catch { content = '{}'; }
  }

  console.log(formatHelp(type, path.basename(absPath)));
  showPreview(content, type);

  const rl = (await import('readline')).createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  rl.on('line', async (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) { showPreview(content, type); rl.prompt(); return; }

    const parsed = parseCommand(trimmed);
    if (!parsed) { console.log(`  Unknown: "${trimmed}". Type "help"`); rl.prompt(); return; }

    const result = executeCommand(parsed, content, type, absPath);
    if (result.content !== undefined) {
      content = result.content;
      modified = true;
    }
    if (result.output) console.log(result.output);
    if (result.quit) {
      if (modified) {
        console.log('  (unsaved changes discarded)');
      }
      rl.close();
      process.exit(0);
    }
    if (result.save) {
      fs.writeFileSync(absPath, content, 'utf-8');
      modified = false;
      console.log(`  Saved: ${absPath} (${content.length} chars)`);
    }
    rl.prompt();
  });

  rl.prompt();
}

function parseCommand(line: string): EditCommand | null {
  const parts = line.match(/(?:[^\s"]+|"[^"]*")+/g);
  if (!parts || parts.length === 0) return null;
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1).map(a => a.replace(/^"(.*)"$/, '$1'));

  const valid: Record<string, number> = {
    'cat': 0, 'view': 0, 'lines': 1,
    'replace': 2, 'insert': 2, 'append': 1, 'delete': 1,
    'validate': 0, 'help': 0, 'quit': 0, 'exit': 0,
    'save': 0, 'format': 0, 'preview': 0, 'p': 0,
  };

  if (!(cmd in valid)) return null;
  if (cmd === 'exit') return { type: 'quit', args: [] };
  return { type: cmd as EditCommand['type'], args };
}

function executeCommand(
  cmd: EditCommand, content: string, type: FileType, absPath: string
): { content?: string; output?: string; quit?: boolean; save?: boolean } {
  const lines = content.split('\n');

  switch (cmd.type) {
    case 'cat':
    case 'view':
      return { output: `  ${'─'.repeat(50)}\n${content}\n${'─'.repeat(50)}` };

    case 'help':
      return { output: formatHelp(type, path.basename(absPath)) };

    case 'quit':
      return { quit: true };

    case 'save':
      fs.writeFileSync(absPath, content, 'utf-8');
      return { output: `  Saved: ${absPath} (${content.length} chars)`, save: true };

    case 'lines': {
      const n = parseInt(cmd.args[0]) || 10;
      const shown = lines.slice(0, n);
      return { output: shown.map((l, i) => `  ${(i + 1).toString().padStart(4)}| ${l}`).join('\n') };
    }

    case 'replace': {
      if (cmd.args.length < 2) return { output: '  Usage: replace "old" "new"' };
      const [oldStr, newStr] = cmd.args;
      if (!content.includes(oldStr)) return { output: `  Not found: "${oldStr}"` };
      const count = (content.match(new RegExp(escapeRegex(oldStr), 'g')) || []).length;
      return { content: content.replace(new RegExp(escapeRegex(oldStr), 'g'), newStr), output: `  Replaced ${count} occurrence(s)` };
    }

    case 'insert': {
      const n = parseInt(cmd.args[0]);
      if (isNaN(n) || n < 1 || n > lines.length) return { output: `  Line ${cmd.args[0]} out of range (1-${lines.length})` };
      const text = cmd.args.slice(1).join(' ');
      lines.splice(n, 0, text);
      return { content: lines.join('\n'), output: `  Inserted at line ${n}` };
    }

    case 'append':
      lines.push(cmd.args.join(' '));
      return { content: lines.join('\n'), output: `  Appended line ${lines.length}` };

    case 'delete': {
      const n = parseInt(cmd.args[0]);
      if (isNaN(n) || n < 1 || n > lines.length) return { output: `  Line ${cmd.args[0]} out of range (1-${lines.length})` };
      const removed = lines.splice(n - 1, 1);
      return { content: lines.join('\n'), output: `  Removed line ${n}: "${removed[0]}"` };
    }

    case 'validate':
      if (type === 'json') {
        try { JSON.parse(content); return { output: '  ✓ Valid JSON' }; }
        catch (e) { return { output: `  ✗ ${e}` }; }
      }
      if (type === 'tex') {
        const unbalanced = (content.match(/{/g) || []).length - (content.match(/}/g) || []).length;
        if (unbalanced !== 0) return { output: `  ⚠ ${Math.abs(unbalanced)} unbalanced brace(s)` };
        return { output: '  ✓ Braces balanced' };
      }
      return { output: `  ✓ ${content.length} chars, ${lines.length} lines` };

    case 'format':
      if (type === 'json') {
        try { return { content: JSON.stringify(JSON.parse(content), null, 2), output: '  Formatted' }; }
        catch (e) { return { output: `  ✗ ${e}` }; }
      }
      return { output: '  Format only supported for JSON' };

    case 'preview':
    case 'p':
      return { output: stripPreview(content, type) };

    default:
      return { output: `  Unknown: ${cmd.type}` };
  }
}

function stripPreview(content: string, type: FileType): string {
  let text = content;
  if (type === 'md') {
    text = text.replace(/^#+\s*/gm, '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1')
      .replace(/\[(.+?)\]\(.+?\)/g, '$1').replace(/```[\s\S]*?```/g, '[code]').replace(/`([^`]+)`/g, '$1');
  }
  if (type === 'tex') {
    text = text.replace(/\\(?:section|subsection|textbf|textit|emph|underline)\{([^}]*)\}/g, '$1')
      .replace(/\\(?:begin|end)\{[a-z]+\*\}/g, '').replace(/\\\[|\\\]/g, '').replace(/\$([^$]+)\$/g, '$1')
      .replace(/\\(?:[a-z]+)(?:\[[^\]]*\])*(?:\{[^}]*\})?/g, '').replace(/\{|\}/g, '')
      .replace(/%[^\n]*/g, '').replace(/\n{3,}/g, '\n\n').trim();
  }
  const lines = text.split('\n').filter(l => l.trim());
  return lines.map((l, i) => `  ${(i + 1).toString().padStart(4)}| ${l}`).join('\n');
}

function showPreview(content: string, type: FileType): void {
  const preview = stripPreview(content, type);
  console.log(`  Preview (${content.length} chars, ${content.split('\n').length} lines):`);
  console.log(`  ${'─'.repeat(50)}`);
  const short = preview.split('\n').slice(0, 15).join('\n');
  console.log(short || '  (empty)');
  if (preview.split('\n').length > 15) console.log('  ...');
  console.log();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
