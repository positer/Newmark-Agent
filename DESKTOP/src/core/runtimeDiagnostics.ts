import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

export type RuntimeDiagnosticLevel = 'info' | 'warn' | 'error';

export interface RuntimeDiagnosticEvent {
  event: string;
  level?: RuntimeDiagnosticLevel;
  runtimeKey?: string;
  generation?: number;
  pid?: number;
  requestId?: string;
  tool?: string;
  stage?: string;
  durationMs?: number;
  exitCode?: number | null;
  expected?: boolean;
  error?: string;
}

const MAX_LOG_BYTES = 2 * 1024 * 1024;

function boundedText(value: unknown, limit = 800): string {
  return String(value || '')
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s"']+/g, '[local-path]')
    .replace(/\b(?:sk|ghp|github_pat)-?[A-Za-z0-9_.-]{8,}\b/g, '[redacted]')
    .replace(/(Authorization\s*:\s*Bearer\s+)[^\s,;]+/ig, '$1[redacted]')
    .slice(-limit);
}

function runtimeCorrelation(runtimeKey: string): string {
  return runtimeKey
    ? createHash('sha256').update(runtimeKey).digest('hex').slice(0, 16)
    : '';
}

/** Append one bounded, path-free JSON event. Diagnostics must never break runtime work. */
export function appendRuntimeDiagnostic(root: string, input: RuntimeDiagnosticEvent): void {
  try {
    const directory = path.join(root, '.newmark-runtime');
    const file = path.join(directory, 'runtime-events.jsonl');
    fs.mkdirSync(directory, { recursive: true });
    try {
      if (fs.statSync(file).size > MAX_LOG_BYTES) {
        const previous = `${file}.1`;
        try { fs.unlinkSync(previous); } catch {}
        fs.renameSync(file, previous);
      }
    } catch {}
    const record = {
      at: new Date().toISOString(),
      event: boundedText(input.event, 100),
      level: input.level || 'info',
      runtime: runtimeCorrelation(String(input.runtimeKey || '')),
      generation: Math.max(0, Math.floor(Number(input.generation) || 0)),
      pid: Math.max(0, Math.floor(Number(input.pid) || 0)),
      requestId: boundedText(input.requestId, 160),
      tool: boundedText(input.tool, 80),
      stage: boundedText(input.stage, 80),
      durationMs: Math.max(0, Math.floor(Number(input.durationMs) || 0)),
      exitCode: input.exitCode === null ? null : Number.isFinite(Number(input.exitCode)) ? Number(input.exitCode) : undefined,
      expected: input.expected,
      error: boundedText(input.error),
    };
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf-8');
  } catch {}
}
