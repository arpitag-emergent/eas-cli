import { once } from 'node:events';
import { type IncomingMessage } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';

import { launchServeSimApplicationAsync } from '../serveSimAppLauncher';

let server: WebSocketServer;
let port: number;
let receivedFrames: string[];

beforeEach(async () => {
  receivedFrames = [];
  server = new WebSocketServer({
    port: 0,
    host: '127.0.0.1',
    verifyClient: (info: { req: IncomingMessage }) =>
      info.req.headers['sec-websocket-protocol'] === 'serve-sim.token.private-token',
  });
  server.on('connection', socket => {
    socket.on('message', data => receivedFrames.push(data.toString()));
    socket.send(JSON.stringify({ ready: true }));
  });
  await once(server, 'listening');
  const address = server.address();
  if (typeof address === 'string') {
    throw new Error('Expected a TCP port.');
  }
  port = address.port;
});

afterEach(async () => {
  for (const socket of server.clients) {
    socket.terminate();
  }
  await new Promise<void>(resolve => server.close(() => resolve()));
});

function launch(signal?: AbortSignal) {
  return launchServeSimApplicationAsync({
    port,
    token: 'private-token',
    udid: 'selected-udid',
    launchAppIdentifier: 'dev.example.app',
    launchArgs: ['--flag', 'literal value'],
    openUrl: 'example://screen',
    signal,
  });
}

it('authenticates before sending one launch and waits for its result', async () => {
  const requests: unknown[] = [];
  server.on('connection', socket =>
    socket.on('message', data => {
      const request = JSON.parse(data.toString());
      requests.push(request);
      socket.send(JSON.stringify({ ready: true }));
      socket.send(JSON.stringify({ id: 1, exitCode: 0, stdout: '', stderr: '' }));
    })
  );
  await launch();
  expect(requests).toEqual([
    {
      id: 1,
      action: 'app.launch',
      params: {
        udid: 'selected-udid',
        bundleId: 'dev.example.app',
        launchArgs: ['--flag', 'literal value'],
        openUrl: 'example://screen',
      },
    },
  ]);
});

it.each([
  [
    { id: 1, error: 'unknown action app.launch' },
    'Release that action before deploying this build-tools version',
  ],
  [{ id: 1, exitCode: 1, stderr: 'app is not installed' }, 'app is not installed'],
  [{ id: 1, exitCode: 1, stderr: '' }, 'exit code 1'],
])('fails when serve-sim refuses or fails the launch: %p', async (reply, detail) => {
  server.on('connection', socket =>
    socket.on('message', data => {
      socket.send(JSON.stringify(reply));
    })
  );
  await expect(launch()).rejects.toThrow(detail as string);
});

it('preserves the control connection failure diagnostic', async () => {
  server.options.verifyClient = () => false;
  await expect(launch()).rejects.toThrow(
    'serve-sim application launch connection failed: Unexpected server response: 401'
  );
});

it('fails when the control connection closes without a launch result', async () => {
  server.on('connection', socket => socket.close());
  await expect(launch()).rejects.toThrow('closed before the application launch completed');
});

it('closes the connection on cancellation without sending a launch after late authentication', async () => {
  const controller = new AbortController();
  const failure = new Error('session stopped');
  const pending = launch(controller.signal);
  const rejected = expect(pending).rejects.toBe(failure);
  const [socket] = (await once(server, 'connection')) as [WebSocket];
  const closed = once(socket, 'close');
  controller.abort(failure);
  socket.send(JSON.stringify({ ready: true }));
  await rejected;
  await closed;
  expect(receivedFrames).toEqual([]);
});

it('fails when serve-sim returns malformed JSON', async () => {
  server.on('connection', socket => socket.send('invalid-json'));
  await expect(launch()).rejects.toThrow('invalid application launch reply');
});

it('cancels while the control socket is still connecting without sending a launch', async () => {
  const controller = new AbortController();
  const failure = new Error('session stopped during handshake');
  let closed: Promise<unknown> | undefined;
  server.on('connection', socket => {
    closed = once(socket, 'close');
  });
  server.options.verifyClient = (
    _info: { req: IncomingMessage },
    done: (accepted: boolean) => void
  ) => {
    controller.abort(failure);
    done(true);
  };
  await expect(launch(controller.signal)).rejects.toBe(failure);
  await closed;
  expect(receivedFrames).toEqual([]);
});

it('closes a stalled launch connection at the deadline without retrying', async () => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  try {
    const pending = launch();
    const rejected = expect(pending).rejects.toThrow(
      'serve-sim application launch timed out after 120000ms'
    );
    const [socket] = (await once(server, 'connection')) as [WebSocket];
    const closed = once(socket, 'close');
    await once(socket, 'message');
    await jest.advanceTimersByTimeAsync(120_000);
    await rejected;
    await closed;
    expect(receivedFrames).toHaveLength(1);
  } finally {
    jest.useRealTimers();
  }
});
