export type RuntimePoolBackend = 'utility' | 'wsl';

/** Raised when every bounded runtime slot is occupied by an active runtime. */
export class RuntimePoolCapacityError extends Error {
  readonly code = 'runtime_pool_capacity';

  constructor(
    readonly backend: RuntimePoolBackend,
    readonly capacity: number,
  ) {
    super(`${backend} runtime pool capacity ${capacity} reached; all resident runtimes are active`);
    this.name = 'RuntimePoolCapacityError';
  }
}
