import { SystemError } from '@expo/eas-build-job';
import WebSocket from 'ws';

import { type ServeSimLaunchOptions } from './remoteDeviceRunSession';
import { withDeviceRunSessionTimeoutAsync } from './deviceRunSessionTimeout';

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
                      : reply.error || reply.stderr || 'invalid reply';
                  reject(new SystemError(`serve-sim application launch failed: ${detail}`));
                }
              }
            } catch {
              reject(new SystemError('serve-sim returned an invalid application launch reply.'));
            }
          });
          socket.once('error', () =>
            reject(new SystemError('Could not connect to serve-sim to launch the application.'))
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
