import * as fs from 'fs';
import * as path from 'path';
import { MAX_EDITOR_BYTES, WorkspaceFileRouter } from '../core/workspaceFileRouter';

type Assert = (condition: boolean, name: string, detail?: string) => void;

export async function verifyWorkspaceFileRouter(testRoot: string, assert: Assert): Promise<void> {
  const workspaceRoot = path.join(testRoot, 'file-router-workspace');
  const outsideRoot = path.join(testRoot, 'file-router-outside');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(outsideRoot, { recursive: true });

  const utf8Path = path.join(workspaceRoot, 'hello.txt');
  const utf16Path = path.join(workspaceRoot, 'hello-utf16.txt');
  const invalidUtf16Path = path.join(workspaceRoot, 'invalid-utf16.txt');
  const scriptPath = path.join(workspaceRoot, 'safe.bat');
  const invalidScriptPath = path.join(workspaceRoot, 'invalid.cmd');
  const htmlPath = path.join(workspaceRoot, 'page.html');
  const disguisedHtmlPath = path.join(workspaceRoot, 'page.txt');
  const pdfPath = path.join(workspaceRoot, 'manual.pdf');
  const disguisedPdfPath = path.join(workspaceRoot, 'manual.dat');
  const binaryPath = path.join(workspaceRoot, 'binary.dat');
  const disguisedExePath = path.join(workspaceRoot, 'disguised.txt');
  const largeTextPath = path.join(workspaceRoot, 'large.txt');
  const maxTextPath = path.join(workspaceRoot, 'max.txt');
  const largeScriptPath = path.join(workspaceRoot, 'large.ps1');
  const outsidePath = path.join(outsideRoot, 'outside.txt');

  fs.writeFileSync(utf8Path, 'hello\nworld', 'utf8');
  fs.writeFileSync(utf16Path, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hello utf16', 'utf16le')]));
  fs.writeFileSync(invalidUtf16Path, Buffer.from([0xff, 0xfe, 0x41]));
  fs.writeFileSync(scriptPath, '@echo off\r\necho SAFE\r\n', 'utf8');
  fs.writeFileSync(invalidScriptPath, Buffer.from([0xff, 0xff, 0xff, 0xff]));
  fs.writeFileSync(htmlPath, '<!doctype html><html><body><script>window.previewOk=true</script></body></html>', 'utf8');
  fs.writeFileSync(disguisedHtmlPath, '<!doctype html><html><body>disguised html</body></html>', 'utf8');
  fs.writeFileSync(pdfPath, Buffer.from('%PDF-1.7\n% test fixture\n', 'ascii'));
  fs.writeFileSync(disguisedPdfPath, Buffer.from('%PDF-1.7\n% disguised test fixture\n', 'ascii'));
  fs.writeFileSync(binaryPath, Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00]));
  fs.writeFileSync(disguisedExePath, Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]));
  fs.writeFileSync(largeTextPath, Buffer.alloc(MAX_EDITOR_BYTES + 1, 0x61));
  fs.writeFileSync(maxTextPath, Buffer.alloc(MAX_EDITOR_BYTES, 0x61));
  fs.writeFileSync(largeScriptPath, Buffer.alloc(MAX_EDITOR_BYTES + 1, 0x23));
  fs.writeFileSync(outsidePath, 'outside', 'utf8');

  const router = new WorkspaceFileRouter(() => workspaceRoot);
  const utf8 = await router.open(utf8Path, 'renderer-a');
  const utf16 = await router.open(utf16Path, 'renderer-a');
  const invalidUtf16 = await router.open(invalidUtf16Path, 'renderer-a');
  const script = await router.open(scriptPath, 'renderer-a');
  const invalidScript = await router.open(invalidScriptPath, 'renderer-a');
  const html = await router.open(htmlPath, 'renderer-a');
  const disguisedHtml = await router.open(disguisedHtmlPath, 'renderer-a');
  const pdf = await router.open(pdfPath, 'renderer-a');
  const disguisedPdf = await router.open(disguisedPdfPath, 'renderer-a');
  const binary = await router.open(binaryPath, 'renderer-a');
  const disguisedExe = await router.open(disguisedExePath, 'renderer-a');
  const largeText = await router.open(largeTextPath, 'renderer-a');
  const maxText = await router.open(maxTextPath, 'renderer-a');
  const largeScript = await router.open(largeScriptPath, 'renderer-a');
  const outside = await router.open(outsidePath, 'renderer-a');

  assert(utf8.kind === 'editor' && utf8.content === 'hello\nworld' && utf8.encoding === 'utf8', 'file router: valid UTF-8 opens in editor');
  assert(utf16.kind === 'editor' && utf16.content === 'hello utf16' && utf16.encoding === 'utf16le', 'file router: UTF-16 BOM text opens and preserves encoding');
  assert(invalidUtf16.kind === 'external' && invalidUtf16.reason === 'binary', 'file router: malformed odd-byte UTF-16 is never truncated into editable text');
  assert(script.kind === 'editor' && script.content.includes('echo SAFE'), 'file router: small text batch script opens in editor instead of executing');
  assert(invalidScript.kind === 'reveal' && invalidScript.reason === 'script-non-text', 'file router: non-text script extensions are only revealed and never executed');
  assert(html.kind === 'browser' && html.mime === 'text/html' && html.url.startsWith('newmark-preview://'), 'file router: HTML routes through controlled internal preview');
  assert(disguisedHtml.kind === 'browser' && disguisedHtml.mime === 'text/html', 'file router: HTML content detection wins over a text extension');
  assert(pdf.kind === 'browser' && pdf.mime === 'application/pdf' && pdf.url.startsWith('newmark-preview://'), 'file router: PDF magic routes through controlled internal preview');
  assert(disguisedPdf.kind === 'browser' && disguisedPdf.mime === 'application/pdf', 'file router: PDF magic wins over a binary extension');
  assert(binary.kind === 'external' && binary.reason === 'binary', 'file router: other binary files route to the default application');
  assert(disguisedExe.kind === 'reveal' && disguisedExe.reason === 'executable', 'file router: executable magic wins over a text extension and only reveals the file');
  assert(largeText.kind === 'external' && largeText.reason === 'too-large', 'file router: ordinary text above 5 MiB routes to the default application');
  assert(maxText.kind === 'editor' && maxText.size === MAX_EDITOR_BYTES, 'file router: text at the exact 5 MiB limit remains editable');
  assert(largeScript.kind === 'reveal' && largeScript.reason === 'script-too-large', 'file router: scripts above 5 MiB are only revealed');
  assert(outside.kind === 'rejected' && outside.error.includes('outside the active workspace'), 'file router: lexical paths outside the active workspace are rejected');

  if (utf8.kind === 'editor') {
    const wrongOwner = await router.save(utf8.token, 'blocked', utf8.revision, 'renderer-b');
    assert(!wrongOwner.ok, 'file router: editor token is bound to its renderer owner');
    const saved = await router.save(utf8.token, 'updated', utf8.revision, 'renderer-a');
    assert(saved.ok && fs.readFileSync(utf8Path, 'utf8') === 'updated', 'file router: revision-bound editor token saves the inspected file');
    const stale = await router.save(utf8.token, 'stale', utf8.revision, 'renderer-a');
    assert(!stale.ok && stale.conflict === true, 'file router: stale editor revision is rejected');
  }

  if (html.kind === 'browser') {
    const htmlResource = await router.resolvePreview(html.url);
    assert(htmlResource?.filePath === fs.realpathSync(htmlPath) && htmlResource.mime.startsWith('text/html'), 'file router: preview token resolves only its workspace resource');
    const escaped = await router.resolvePreview(html.url.replace(/page\.html$/, '../../file-router-outside/outside.txt'));
    assert(escaped === null, 'file router: preview token rejects path traversal');
  }
  if (disguisedHtml.kind === 'browser' && disguisedPdf.kind === 'browser') {
    const htmlResource = await router.resolvePreview(disguisedHtml.url);
    const pdfResource = await router.resolvePreview(disguisedPdf.url, 'bytes=0-3');
    assert(htmlResource?.mime === 'text/html' && pdfResource?.mime === 'application/pdf', 'file router: content-classified preview entries keep their detected MIME');
    assert(pdfResource?.range?.start === 0 && pdfResource.range.end === 3, 'file router: PDF preview supports bounded byte ranges');
  }

  const linkPath = path.join(workspaceRoot, 'outside-link.txt');
  try {
    fs.symlinkSync(outsidePath, linkPath, 'file');
    const linkedOutside = await router.open(linkPath, 'renderer-a');
    assert(linkedOutside.kind === 'rejected' && linkedOutside.error.includes('Linked file path'), 'file router: symlinks outside the active workspace are rejected');
  } catch {
    assert(true, 'file router: symlink boundary test skipped when the host forbids test symlinks');
  }

  if (process.platform === 'win32') {
    const junctionPath = path.join(workspaceRoot, 'outside-junction');
    try {
      fs.symlinkSync(outsideRoot, junctionPath, 'junction');
      const linkedOutside = await router.open(path.join(junctionPath, 'outside.txt'), 'renderer-a');
      assert(linkedOutside.kind === 'rejected' && linkedOutside.error.includes('Linked file path'), 'file router: Windows junctions outside the active workspace are rejected');
    } catch {
      assert(true, 'file router: junction boundary test skipped when the host forbids test junctions');
    }
  }
}
