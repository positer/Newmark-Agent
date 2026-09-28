import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export interface FileReadRange {
  startLine?: number;
  endLine?: number;
}

export type FileObservationRequirement =
  | { kind: 'full' }
  | { kind: 'edit'; oldText: string };

export interface FileMutationContext {
  targetPath: string;
  canonicalPath: string;
  exists: boolean;
  bytes?: Buffer;
  text?: string;
  assertBeforeCommit(): void;
}

export interface FileMutationOutcome<T> {
  value: T;
  committed: boolean;
}

export type FileMutationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

interface ReadRangeReceipt {
  startLine: number;
  endLine: number;
  text: string;
}

interface ReadReceipt {
  canonicalPath: string;
  exists: boolean;
  fingerprint: string;
  observedAt: number;
  totalLines: number;
  full: boolean;
  ranges: ReadRangeReceipt[];
}

interface ParentAnchor {
  lexicalPath: string;
  canonicalPath: string;
  identity: string;
}

type TargetSnapshot =
  | {
      kind: 'file';
      targetPath: string;
      canonicalPath: string;
      fingerprint: string;
      bytes: Buffer;
      text: string;
      totalLines: number;
      receiptEligible: boolean;
      receiptReason?: string;
    }
  | {
      kind: 'missing';
      targetPath: string;
      canonicalPath: string;
      fingerprint: string;
      parentAnchor: ParentAnchor;
    }
  | {
      kind: 'blocked';
      targetPath: string;
      canonicalPath?: string;
      error: string;
    };

const READ_CHAR_LIMIT = 20_000;
const RECEIPT_TTL_MS = 5 * 60 * 1000;
const MAX_INLINE_RESULT_CHARS = 24_000;
const MAX_RECEIPTS = 256;
const MAX_READ_RANGES = 128;
const MAX_RECEIPT_CHARS = 150_000;
const processPathMutationLocks = new Map<string, Promise<void>>();

function errorCode(error: unknown): string {
  return error && typeof error === 'object' ? String((error as NodeJS.ErrnoException).code || '') : '';
}

function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function statIdentity(stat: fs.Stats): string {
  return [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.size,
    stat.mtimeMs,
    stat.ctimeMs,
  ].join(':');
}

function directoryIdentity(stat: fs.Stats): string {
  return [stat.dev, stat.ino, stat.mode].join(':');
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function lineCount(text: string, starts = lineStarts(text)): number {
  if (text.length === 0) return 0;
  const newlineCount = starts.length - 1;
  return text.endsWith('\n') ? newlineCount : newlineCount + 1;
}

function mergeLineRanges(ranges: ReadRangeReceipt[], totalLines: number): boolean {
  if (totalLines === 0) return ranges.length > 0;
  const sorted = [...ranges].sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
  let nextLine = 1;
  for (const range of sorted) {
    if (range.endLine < nextLine) continue;
    if (range.startLine > nextLine) return false;
    nextLine = Math.max(nextLine, range.endLine + 1);
    if (nextLine > totalLines) return true;
  }
  return nextLine > totalLines;
}

function pathKey(value: string): string {
  const normalized = path.resolve(value);
  const windowsMountedPath = /^\/mnt\/[a-z]\//i.test(normalized);
  return process.platform === 'win32' || windowsMountedPath ? normalized.toLowerCase() : normalized;
}

export class FileWriteObservationGate {
  private readonly receipts = new Map<string, ReadReceipt>();

  async read(targetPath: string, scope: string, range: FileReadRange = {}): Promise<string> {
    const absolutePath = path.resolve(targetPath);
    const receiptKey = this.receiptKey(scope, absolutePath);
    this.pruneReceipts();

    const initial = this.inspect(absolutePath);
    const lockKey = pathKey(initial.canonicalPath || absolutePath);
    return this.withLock(lockKey, () => {
      const snapshot = this.inspect(absolutePath);
      if (snapshot.kind === 'blocked') {
        this.receipts.delete(receiptKey);
        return '[read blocked] ' + snapshot.error;
      }
      if (pathKey(snapshot.canonicalPath) !== lockKey) {
        this.receipts.delete(receiptKey);
        return '[read blocked] The target path changed while it was being read. Read it again.';
      }
      if (snapshot.kind === 'missing') {
        this.receipts.set(receiptKey, {
          canonicalPath: snapshot.canonicalPath,
          exists: false,
          fingerprint: snapshot.fingerprint,
          observedAt: Date.now(),
          totalLines: 0,
          full: true,
          ranges: [],
        });
        return '[read] Target does not exist: ' + absolutePath
          + '\n[write gate] Exact-path absence observed. A write may create this target; the observation expires in five minutes.'
          + '\nNearest existing directory: ' + snapshot.parentAnchor.canonicalPath;
      }

      const startProvided = range.startLine !== undefined;
      const endProvided = range.endLine !== undefined;
      if (startProvided !== endProvided) {
        return '[read blocked] Provide both start_line and end_line, or omit both.';
      }
      const explicitRange = startProvided && endProvided;
      const text = snapshot.text;
      const starts = lineStarts(text);
      const totalLines = snapshot.totalLines;
      let startLine = 1;
      let endLine = totalLines;
      let selected = text;
      let fullRead = !explicitRange;

      if (explicitRange) {
        startLine = Number(range.startLine);
        endLine = Number(range.endLine);
        if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
          return '[read blocked] start_line/end_line must be positive integers with end_line >= start_line.';
        }
        if (totalLines === 0) {
          if (startLine !== 1 || endLine !== 1) return '[read blocked] The empty file only supports line range 1-1.';
          startLine = 1;
          endLine = 0;
          selected = '';
          fullRead = true;
        } else {
          if (startLine > totalLines || endLine > totalLines) {
            return '[read blocked] Requested line range is outside this file (1-' + totalLines + ').';
          }
          const startOffset = starts[startLine - 1];
          const endOffset = endLine >= totalLines ? text.length : starts[endLine];
          selected = text.slice(startOffset, endOffset);
          fullRead = startLine === 1 && endLine === totalLines;
        }
      }

      if (!explicitRange && text.length > READ_CHAR_LIMIT) {
        const prior = this.receipts.get(receiptKey);
        if (!prior || prior.fingerprint !== snapshot.fingerprint || Date.now() - prior.observedAt > RECEIPT_TTL_MS) {
          this.receipts.delete(receiptKey);
        }
        return text.slice(0, READ_CHAR_LIMIT)
          + '\n...[truncated]'
          + '\n[write gate] No new full-read receipt was issued. Use read with start_line/end_line to inspect exact ranges; overwrite/delete requires complete line coverage.';
      }
      if (selected.length > READ_CHAR_LIMIT) {
        return '[read blocked] Requested range exceeds the 20000-character read limit. Split it into smaller line ranges.';
      }
      if (selected.length + absolutePath.length + 1200 > MAX_INLINE_RESULT_CHARS) {
        return '[read blocked] The returned path and line range would be truncated before reaching the model. Read a smaller range; no mutation receipt was issued.';
      }

      if (!snapshot.receiptEligible) {
        this.receipts.delete(receiptKey);
        const content = selected || (text.length === 0 ? '[empty file]' : '');
        return content
          + '\n[write gate] No mutation receipt: ' + (snapshot.receiptReason || 'the target is not a stable plain-text file.');
      }

      const now = Date.now();
      let receipt = this.receipts.get(receiptKey);
      if (!receipt
        || receipt.fingerprint !== snapshot.fingerprint
        || receipt.canonicalPath !== snapshot.canonicalPath
        || now - receipt.observedAt > RECEIPT_TTL_MS) {
        receipt = {
          canonicalPath: snapshot.canonicalPath,
          exists: true,
          fingerprint: snapshot.fingerprint,
          observedAt: now,
          totalLines,
          full: false,
          ranges: [],
        };
      }
      const replacedRange = receipt.ranges.find(item => item.startLine === startLine && item.endLine === endLine);
      const nextRangeCount = receipt.ranges.length + (replacedRange ? 0 : 1);
      const currentReceiptChars = receipt.ranges.reduce((total, item) => total + item.text.length, 0);
      const nextReceiptChars = currentReceiptChars - (replacedRange?.text.length || 0) + selected.length;
      if (nextRangeCount > MAX_READ_RANGES || nextReceiptChars > MAX_RECEIPT_CHARS) {
        return '[read blocked] The observation ledger reached its bounded range capacity. Read fewer, larger ranges; no new receipt range was added.';
      }
      receipt.observedAt = now;
      receipt.ranges = receipt.ranges.filter(item => item.startLine !== startLine || item.endLine !== endLine);
      receipt.ranges.push({ startLine, endLine, text: selected });
      receipt.full = receipt.full || fullRead || mergeLineRanges(receipt.ranges, totalLines);
      this.receipts.set(receiptKey, receipt);
      this.pruneReceipts();

      const content = selected || (text.length === 0 ? '[empty file]' : '');
      const rangeLabel = explicitRange
        ? '[read] ' + absolutePath + ' (lines ' + startLine + '-' + endLine + ' of ' + totalLines + ')'
        : '[read] ' + absolutePath + ' (complete text; ' + totalLines + ' lines)';
      const grant = receipt.full
        ? '\n[write gate] Complete target observation recorded for this conversation, actor, workspace, and run. It is single-use and expires in five minutes.'
        : '\n[write gate] Lines observed; edit may target text inside this range. Read every line before overwrite/delete.';
      return rangeLabel + '\n--- BEGIN READ CONTENT ---\n' + content + '\n--- END READ CONTENT ---' + grant;
    });
  }

  async mutate<T>(
    targetPath: string,
    scope: string,
    requirement: FileObservationRequirement,
    apply: (context: FileMutationContext) => Promise<FileMutationOutcome<T>> | FileMutationOutcome<T>,
  ): Promise<FileMutationResult<T>> {
    const absolutePath = path.resolve(targetPath);
    const receiptKey = this.receiptKey(scope, absolutePath);
    this.pruneReceipts();

    const initial = this.inspect(absolutePath);
    const lockKey = pathKey(initial.canonicalPath || absolutePath);
    return this.withLock(lockKey, async () => {
      const snapshot = this.inspect(absolutePath);
      if (snapshot.kind === 'blocked') {
        return { ok: false, error: '[write gate blocked] ' + snapshot.error };
      }
      if (pathKey(snapshot.canonicalPath) !== lockKey) {
        return { ok: false, error: '[write gate blocked] The target path changed before mutation. Read the target again.' };
      }

      const receipt = this.receipts.get(receiptKey);
      if (!receipt) {
        return {
          ok: false,
          error: '[write gate blocked] Read this exact target with the read tool before changing it. A read of another path, grep/glob output, or a write function internal read does not count.',
        };
      }
      if (Date.now() - receipt.observedAt > RECEIPT_TTL_MS) {
        this.receipts.delete(receiptKey);
        return { ok: false, error: '[write gate blocked] The read observation expired. Read the target again before changing it.' };
      }
      if (receipt.exists !== (snapshot.kind === 'file')
        || receipt.canonicalPath !== snapshot.canonicalPath
        || receipt.fingerprint !== snapshot.fingerprint) {
        this.receipts.delete(receiptKey);
        return { ok: false, error: '[write gate blocked] The target changed after it was read. Read the current target again before changing it.' };
      }
      if (requirement.kind === 'full' && snapshot.kind === 'file' && !receipt.full) {
        return {
          ok: false,
          error: '[write gate blocked] The complete file has not been read. Use read with line ranges that cover the whole file before overwrite/delete.',
        };
      }
      if (requirement.kind === 'edit') {
        const oldText = requirement.oldText;
        if (!oldText || !receipt.ranges.some(item => item.text.includes(oldText))) {
          return {
            ok: false,
            error: '[write gate blocked] Read the exact lines containing old_str before editing. Use read with a range that includes the full match.',
          };
        }
      }

      const context: FileMutationContext = {
        targetPath: absolutePath,
        canonicalPath: snapshot.canonicalPath,
        exists: snapshot.kind === 'file',
        ...(snapshot.kind === 'file' ? { bytes: snapshot.bytes, text: snapshot.text } : {}),
        assertBeforeCommit: () => this.assertBeforeCommit(absolutePath, snapshot),
      };
      const outcome = await apply(context);
      if (outcome.committed) this.receipts.delete(receiptKey);
      return { ok: true, value: outcome.value };
    });
  }

  private inspect(targetPath: string): TargetSnapshot {
    const absolutePath = path.resolve(targetPath);
    let linkStat: fs.Stats;
    try {
      linkStat = fs.lstatSync(absolutePath);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        return { kind: 'blocked', targetPath: absolutePath, error: 'Unable to inspect target: ' + String(error) };
      }
      return this.inspectMissing(absolutePath);
    }

    let canonicalPath: string;
    let followedStat: fs.Stats;
    try {
      canonicalPath = fs.realpathSync.native(absolutePath);
      followedStat = fs.statSync(absolutePath);
    } catch (error) {
      return { kind: 'blocked', targetPath: absolutePath, error: 'Unable to resolve target: ' + String(error) };
    }
    if (!followedStat.isFile()) {
      return {
        kind: 'blocked',
        targetPath: absolutePath,
        canonicalPath,
        error: 'The target is not a regular file: ' + absolutePath,
      };
    }

    let bytes: Buffer;
    let afterLinkStat: fs.Stats;
    let afterFollowedStat: fs.Stats;
    let afterCanonicalPath: string;
    try {
      bytes = fs.readFileSync(absolutePath);
      afterLinkStat = fs.lstatSync(absolutePath);
      afterFollowedStat = fs.statSync(absolutePath);
      afterCanonicalPath = fs.realpathSync.native(absolutePath);
    } catch (error) {
      return { kind: 'blocked', targetPath: absolutePath, canonicalPath, error: 'Unable to read target: ' + String(error) };
    }
    if (canonicalPath !== afterCanonicalPath
      || statIdentity(linkStat) !== statIdentity(afterLinkStat)
      || statIdentity(followedStat) !== statIdentity(afterFollowedStat)) {
      return {
        kind: 'blocked',
        targetPath: absolutePath,
        canonicalPath: afterCanonicalPath,
        error: 'The target changed while it was being read. Read it again.',
      };
    }

    const text = bytes.toString('utf8');
    const validUtf8 = Buffer.compare(Buffer.from(text, 'utf8'), bytes) === 0;
    const isSymbolicLink = linkStat.isSymbolicLink();
    const receiptReason = isSymbolicLink
      ? 'the target is a symbolic link; use its resolved file path'
      : (!validUtf8 ? 'the target is not valid UTF-8 text' : '');
    const fingerprint = sha256(JSON.stringify({
      canonicalPath,
      linkIdentity: statIdentity(linkStat),
      fileIdentity: statIdentity(followedStat),
      contentHash: sha256(bytes),
    }));
    return {
      kind: 'file',
      targetPath: absolutePath,
      canonicalPath,
      fingerprint,
      bytes,
      text,
      totalLines: lineCount(text),
      receiptEligible: !isSymbolicLink && validUtf8,
      ...(receiptReason ? { receiptReason } : {}),
    };
  }

  private inspectMissing(targetPath: string): TargetSnapshot {
    const parentPath = path.dirname(targetPath);
    let cursor = parentPath;
    let anchor: ParentAnchor | undefined;
    while (true) {
      try {
        const stat = fs.statSync(cursor);
        if (!stat.isDirectory()) {
          return { kind: 'blocked', targetPath, error: 'The parent path is not a directory: ' + cursor };
        }
        const canonicalPath = fs.realpathSync.native(cursor);
        anchor = {
          lexicalPath: path.resolve(cursor),
          canonicalPath,
          identity: directoryIdentity(stat),
        };
        break;
      } catch (error) {
        if (errorCode(error) !== 'ENOENT' || path.dirname(cursor) === cursor) {
          return { kind: 'blocked', targetPath, error: 'Unable to inspect the parent directory: ' + String(error) };
        }
        cursor = path.dirname(cursor);
      }
    }

    const canonicalTarget = path.resolve(anchor.canonicalPath, path.relative(anchor.lexicalPath, targetPath));
    const fingerprint = sha256(JSON.stringify({
      kind: 'missing',
      canonicalTarget,
      parentPath: anchor.canonicalPath,
      parentIdentity: anchor.identity,
    }));
    return {
      kind: 'missing',
      targetPath,
      canonicalPath: canonicalTarget,
      fingerprint,
      parentAnchor: anchor,
    };
  }

  private assertBeforeCommit(targetPath: string, observed: TargetSnapshot): void {
    const current = this.inspect(targetPath);
    if (observed.kind === 'file') {
      if (current.kind !== 'file'
        || current.canonicalPath !== observed.canonicalPath
        || current.fingerprint !== observed.fingerprint) {
        throw new Error('The target changed after it was read. Read it again before changing it.');
      }
      return;
    }
    if (observed.kind !== 'missing' || current.kind === 'blocked' || current.kind === 'file'
      || current.canonicalPath !== observed.canonicalPath) {
      throw new Error('The target path changed after it was read. Read it again before creating it.');
    }
  }

  private receiptKey(scope: string, targetPath: string): string {
    return scope + '\u0000' + pathKey(targetPath);
  }

  private pruneReceipts(): void {
    const now = Date.now();
    for (const [key, receipt] of this.receipts) {
      if (now - receipt.observedAt > RECEIPT_TTL_MS) this.receipts.delete(key);
    }
    while (this.receipts.size > MAX_RECEIPTS) {
      const oldest = this.receipts.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.receipts.delete(oldest);
    }
  }

  private async withLock<T>(key: string, action: () => T | Promise<T>): Promise<T> {
    const previous = processPathMutationLocks.get(key);
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    processPathMutationLocks.set(key, current);
    if (previous) await previous;
    try {
      return await action();
    } finally {
      release();
      if (processPathMutationLocks.get(key) === current) processPathMutationLocks.delete(key);
    }
  }
}
