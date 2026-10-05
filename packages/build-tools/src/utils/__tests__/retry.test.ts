import { retryAsync } from '../retry';

afterEach(() => jest.useRealTimers());

it('preserves the abort reason when an interrupted operation throws a different error', async () => {
  const controller = new AbortController();
  const failure = new Error('build download failed');
  const operation = jest.fn(async () => {
    controller.abort(failure);
    throw new Error('The operation was aborted');
  });
  await expect(
    retryAsync(operation, {
      retryOptions: { retries: 10, retryIntervalMs: 1_000 },
      signal: controller.signal,
    })
  ).rejects.toBe(failure);
  expect(operation).toHaveBeenCalledTimes(1);
});

it('stops polling after cancellation during the retry interval', async () => {
  jest.useFakeTimers();
  const controller = new AbortController();
  const failure = new Error('session cancelled');
  const operation = jest.fn().mockRejectedValue(new Error('not ready'));
  const waiting = retryAsync(operation, {
    retryOptions: { retries: 1_800, retryIntervalMs: 1_000 },
    signal: controller.signal,
  });
  const rejected = expect(waiting).rejects.toBe(failure);
  await jest.advanceTimersByTimeAsync(0);
  controller.abort(failure);
  await jest.advanceTimersByTimeAsync(1_000);
  await rejected;
  expect(operation).toHaveBeenCalledTimes(1);
});
