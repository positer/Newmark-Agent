import type { GitHubUpdateCheckResult } from './installUpdate';

export type StartupPrewarmTaskStatus = 'running' | 'ready' | 'warning' | 'failed';

export interface StartupPrewarmTask<T = unknown> {
  id: string;
  label: string;
  required: boolean;
  run: () => Promise<T> | T;
}

export interface StartupPrewarmTaskResult<T = unknown> {
  id: string;
  label: string;
  required: boolean;
  status: Exclude<StartupPrewarmTaskStatus, 'running'>;
  value?: T;
  error?: string;
}

export interface StartupPrewarmProgress {
  id: string;
  label: string;
  required: boolean;
  status: StartupPrewarmTaskStatus;
  completed: number;
  total: number;
}

export interface StartupPrewarmReport {
  ok: boolean;
  completed: number;
  total: number;
  tasks: StartupPrewarmTaskResult[];
  failures: StartupPrewarmTaskResult[];
  warnings: StartupPrewarmTaskResult[];
}

export type StartupPrewarmProgressListener = (progress: StartupPrewarmProgress) => void;

export interface DeferredStartupTask<T = unknown> {
  id: string;
  label: string;
  delayMs?: number;
  run: (signal: AbortSignal) => Promise<T> | T;
}

export interface DeferredStartupTaskResult<T = unknown> {
  id: string;
  label: string;
  status: 'ready' | 'warning' | 'cancelled';
  value?: T;
  error?: string;
}

export interface DeferredStartupTaskOptions {
  delayMs?: number;
  signal?: AbortSignal;
  onResult?: (result: DeferredStartupTaskResult) => void;
}

export interface DeferredStartupTaskHandle {
  signal: AbortSignal;
  done: Promise<DeferredStartupTaskResult[]>;
  cancel: () => void;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Starts noncritical work after promotion without coupling its outcome to the
 * first-frame barrier. Cancelling settles pending/running receipts promptly;
 * task implementations also receive the signal so they can stop underlying IO.
 */
export function scheduleDeferredStartupTasks(
  tasks: DeferredStartupTask[],
  options: DeferredStartupTaskOptions = {},
): DeferredStartupTaskHandle {
  const controller = new AbortController();
  const externalSignal = options.signal;
  const cancel = (): void => controller.abort();
  if (externalSignal?.aborted) cancel();
  else externalSignal?.addEventListener('abort', cancel, { once: true });

  const done = Promise.all(tasks.map(task => new Promise<DeferredStartupTaskResult>(resolve => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    const settle = (result: DeferredStartupTaskResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      controller.signal.removeEventListener('abort', onAbort);
      options.onResult?.(result);
      resolve(result);
    };
    const onAbort = (): void => settle({ id: task.id, label: task.label, status: 'cancelled' });
    controller.signal.addEventListener('abort', onAbort, { once: true });
    const delayMs = Math.max(0, Number(task.delayMs ?? options.delayMs ?? 0));
    timer = setTimeout(() => {
      timer = null;
      if (controller.signal.aborted) return onAbort();
      Promise.resolve()
        .then(() => task.run(controller.signal))
        .then(value => settle(controller.signal.aborted
          ? { id: task.id, label: task.label, status: 'cancelled' }
          : { id: task.id, label: task.label, status: 'ready', value }))
        .catch(error => settle(controller.signal.aborted
          ? { id: task.id, label: task.label, status: 'cancelled' }
          : { id: task.id, label: task.label, status: 'warning', error: errorText(error) }));
    }, delayMs);
    if (controller.signal.aborted) onAbort();
  }))).finally(() => {
    externalSignal?.removeEventListener('abort', cancel);
  });

  return { signal: controller.signal, done, cancel };
}

/**
 * Waits for every startup task to settle. Optional failures are warnings, but
 * a required failure keeps the splash visible and makes the attempt retryable.
 */
export async function runStartupPrewarmBarrier(
  tasks: StartupPrewarmTask[],
  onProgress?: StartupPrewarmProgressListener,
): Promise<StartupPrewarmReport> {
  const total = tasks.length;
  let completed = 0;
  const results = await Promise.all(tasks.map(async task => {
    onProgress?.({
      id: task.id,
      label: task.label,
      required: task.required,
      status: 'running',
      completed,
      total,
    });
    try {
      const value = await task.run();
      completed += 1;
      const result: StartupPrewarmTaskResult = {
        id: task.id,
        label: task.label,
        required: task.required,
        status: 'ready',
        value,
      };
      onProgress?.({ ...result, completed, total });
      return result;
    } catch (error) {
      completed += 1;
      const result: StartupPrewarmTaskResult = {
        id: task.id,
        label: task.label,
        required: task.required,
        status: task.required ? 'failed' : 'warning',
        error: errorText(error),
      };
      onProgress?.({ ...result, completed, total });
      return result;
    }
  }));
  const failures = results.filter(result => result.status === 'failed');
  const warnings = results.filter(result => result.status === 'warning');
  return {
    ok: failures.length === 0,
    completed,
    total,
    tasks: results,
    failures,
    warnings,
  };
}

export interface StartupTimeoutResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

/** Settles a startup dependency even when an external service never replies. */
export async function withStartupTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<StartupTimeoutResult<T>> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const value = await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.max(1, timeoutMs)}ms`)), Math.max(1, timeoutMs));
      }),
    ]);
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface StartupUpdatePromptContent {
  title: string;
  message: string;
  detail: string;
  buttons: [string, string];
  url: string;
  version: string;
}

export function startupUpdatePromptContent(
  release: GitHubUpdateCheckResult | null | undefined,
  language: string,
  locale = '',
): StartupUpdatePromptContent | null {
  if (!release?.ok || !release.updateAvailable || !release.version) return null;
  const normalizedLanguage = String(language || 'auto').toLowerCase();
  const zh = normalizedLanguage === 'zh'
    || (normalizedLanguage === 'auto' && String(locale || '').toLowerCase().startsWith('zh'));
  return {
    title: zh ? '发现 Newmark Agent 更新' : 'Newmark Agent update available',
    message: zh ? `发现新版本 ${release.version}` : `New version ${release.version} is available`,
    detail: zh
      ? `当前版本：${release.currentVersion}\n远端版本：${release.version}`
      : `Current version: ${release.currentVersion}\nAvailable version: ${release.version}`,
    buttons: zh ? ['查看更新', '稍后'] : ['View update', 'Later'],
    url: String(release.url || ''),
    version: release.version,
  };
}
