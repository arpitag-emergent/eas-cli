import { SystemError, UserError } from '@expo/eas-build-job';
import WebSocket from 'ws';

import { type ServeSimLaunchOptions } from './remoteDeviceRunSession';
import { withDeviceRunSessionTimeoutAsync } from './deviceRunSessionTimeout';

export function validateServeSimLaunchOptions({
  launchArgs = [],
  openUrl,
}: Pick<ServeSimLaunchOptions, 'launchArgs' | 'openUrl'>): void {
  // Mirrors serve-sim's app.launch schema so invalid input fails before startup.
  if (
    launchArgs.length > 256 ||
    launchArgs.some(arg => arg.length > 8192 || arg.includes('\0')) ||
    launchArgs.reduce((bytes, arg) => bytes + Buffer.byteLength(arg) + 1, 0) > 256 * 1024
  ) {
    throw new UserError(
      'EAS_LAUNCH_APPLICATION_INVALID_INPUT',
      'iOS launch_args supports up to 256 arguments of 8192 characters each, without NUL, and at most 256 KiB total UTF-8 bytes including terminators.'
    );
  }
  if (openUrl && openUrl.length > 8192) {
    throw new UserError(
      'EAS_LAUNCH_APPLICATION_INVALID_INPUT',
      'iOS open_url supports at most 8192 characters.'
    );
  }
}

export async function launchServeSimApplicationAsync({
  port,
  token,
  udid,
  signal,
  ...launch
}: ServeSimLaunchOptions & {
  port: number;
  token: string;
  udid: string;
  signal?: AbortSignal;
}): Promise<void> {
  await withDeviceRunSessionTimeoutAsync(
    { name: 'serve-sim application launch', timeoutMs: 120_000, signal },
    async signal => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/exec-ws`, [`serve-sim.token.${token}`]);
      let onAbort = (): void => {};
      try {
        await new Promise<void>((resolve, reject) => {
          let sent = false;
          onAbort = (): void => reject(signal.reason);
          signal.addEventListener('abort', onAbort, { once: true });
          socket.on('message', data => {
            if (signal.aborted) {
              return;
            }
            try {
              const reply = JSON.parse(data.toString());
              if (reply.ready === true && !sent) {
                sent = true;
                socket.send(
                  JSON.stringify({
                    id: 1,
                    action: 'app.launch',
                    params: {
                      udid,
                      bundleId: launch.launchAppIdentifier,
                      launchArgs: launch.launchArgs ?? [],
                      openUrl: launch.openUrl,
                    },
                  })
                );
              } else if (reply.id === 1) {
                if (reply.exitCode === 0 && !reply.error) {
                  resolve();
                } else {
                  const detail =
                    reply.error === 'unknown action app.launch'
                      ? 'The installed serve-sim lacks app.launch support. Release that action before deploying this build-tools version.'
                      : reply.error ||
                        reply.stderr ||
                        (typeof reply.exitCode === 'number'
                          ? `exit code ${reply.exitCode}`
                          : 'invalid reply');
                  reject(new SystemError(`serve-sim application launch failed: ${detail}`));
                }
              }
            } catch {
              reject(new SystemError('serve-sim returned an invalid application launch reply.'));
            }
          });
          socket.once('error', error =>
            reject(
              new SystemError(`serve-sim application launch connection failed: ${error.message}`)
            )
          );
          socket.once('close', () =>
            reject(new SystemError('serve-sim closed before the application launch completed.'))
          );
        });
      } finally {
        signal.removeEventListener('abort', onAbort);
        socket.terminate();
      }
    }
  );
}
