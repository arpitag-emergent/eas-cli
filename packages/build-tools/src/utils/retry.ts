import { bunyan } from '@expo/logger';

export async function sleepAsync(ms: number): Promise<void> {
  await new Promise(res => setTimeout(res, ms));
}

export interface RetryOptions {
  retries: number;
  retryIntervalMs: number;
}

export async function retryAsync<T = void>(
  fn: (attemptCount: number) => Promise<T>,
  {
    retryOptions: { retries, retryIntervalMs },
    logger,
    signal,
  }: {
    retryOptions: RetryOptions;
    logger?: bunyan;
    signal?: AbortSignal;
  }
): Promise<T> {
  let attemptCount = -1;
  for (;;) {
    signal?.throwIfAborted();
    try {
      attemptCount += 1;
      const result = await fn(attemptCount);
      signal?.throwIfAborted();
      return result;
    } catch (err: any) {
      signal?.throwIfAborted();
      logger?.debug(
        { err, stdout: err.stdout, stderr: err.stderr },
        `Retry attempt ${attemptCount}`
      );
      await sleepAsync(retryIntervalMs);
      if (attemptCount === retries) {
        throw err;
      }
    }
  }
}
