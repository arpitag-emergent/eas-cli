import { BuildRuntimePlatform, type BuildStepContext } from '@expo/steps';
import spawn from '@expo/turtle-spawn';

import { createGlobalContextMock } from '../../../__tests__/utils/context';
import { type CustomBuildContext } from '../../../customBuildContext';
import { readLocalEgressHandoffAsync } from '../../utils/localEgress';
import { selectXcodeDeveloperDirectoryAsync } from '../../utils/remoteDeviceRunSession';
import { downloadBuildAsync } from '../downloadBuild';
import { installBuildAsync } from '../installBuild';
import { launchApplicationAsync } from '../launchApplication';
import {
  getAgentDeviceRemoteSessionEnvOrThrow,
  runAgentDeviceRemoteSessionAsync,
} from '../startAgentDeviceRemoteSession';
import { createStartAgentDeviceSessionBuildFunction } from '../startAgentDeviceSession';
import { startAndroidEmulatorAsync } from '../startAndroidEmulator';
import {
  bootIosSimulatorAsync,
  prepareBootedIosSimulatorAsync,
  resolveIosSimulatorUdidAsync,
} from '../startIosSimulator';

jest.mock('@expo/turtle-spawn', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../utils/localEgress', () => ({
  readLocalEgressHandoffAsync: jest.fn(),
  stopLocalEgressResourcesAsync: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../utils/remoteDeviceRunSession', () => ({
  ...jest.requireActual('../../utils/remoteDeviceRunSession'),
  selectXcodeDeveloperDirectoryAsync: jest.fn(),
}));
jest.mock('../startIosSimulator', () => ({
  bootIosSimulatorAsync: jest.fn(),
  prepareBootedIosSimulatorAsync: jest.fn(),
  resolveIosSimulatorUdidAsync: jest.fn(),
}));
jest.mock('../startAndroidEmulator', () => ({ startAndroidEmulatorAsync: jest.fn() }));
jest.mock('../downloadBuild', () => ({ downloadBuildAsync: jest.fn() }));
jest.mock('../installBuild', () => ({ installBuildAsync: jest.fn() }));
jest.mock('../launchApplication', () => ({
  ...jest.requireActual('../launchApplication'),
  launchApplicationAsync: jest.fn(),
}));
jest.mock('../startAgentDeviceRemoteSession', () => ({
  getAgentDeviceRemoteSessionEnvOrThrow: jest.fn(),
  runAgentDeviceRemoteSessionAsync: jest.fn(),
}));

const graphqlClient = { query: jest.fn() };
const ctx = { graphqlClient } as unknown as CustomBuildContext;
const sessionEnv = {
  deviceRunSessionId: 'device-run-session-id',
  ngrokTunnelDomain: 'tunnel.example.com',
  ngrokAuthtoken: 'ngrok-token',
};

type Device = Parameters<typeof runAgentDeviceRemoteSessionAsync>[1]['device'];
let deviceLaunch: unknown;

function prepareDeviceAsync(device: Device): Promise<unknown> {
  return (
    'prepareApplicationAsync' in device ? device.prepareApplicationAsync() : device.ready
  ).then(launch => {
    deviceLaunch = launch;
    return launch;
  });
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise(resolve => setImmediate(resolve));
  }
}

function runStep(
  runtimePlatform: BuildRuntimePlatform,
  inputValues: Record<string, unknown> = {},
  signal?: AbortSignal
): Promise<void> {
  const buildFunction = createStartAgentDeviceSessionBuildFunction(ctx);
  const logger = { info: jest.fn(), warn: jest.fn(), child: jest.fn().mockReturnThis() };
  const inputs = Object.fromEntries(
    [
      'device_identifier',
      'system_image_package',
      'lcd_width',
      'lcd_height',
      'lcd_density',
      'build_id',
      'application_archive_url',
      'launch_args',
      'open_url',
      'network_capture',
      'network_capture_fields',
      'package_version',
      'max_idle_time_minutes',
      'max_duration_seconds',
    ].map(id => [id, { value: inputValues[id] }])
  );
  return buildFunction.fn!(
    {
      logger,
      global: {
        runtimePlatform,
        staticContext: { job: { secrets: { robotAccessToken: 'robot-token' } } },
      },
    } as unknown as BuildStepContext,
    { inputs, outputs: {}, env: {}, signal } as never
  ) as Promise<void>;
}

function sessionDevice(): Device {
  return jest.mocked(runAgentDeviceRemoteSessionAsync).mock.calls[0][1].device;
}

describe(createStartAgentDeviceSessionBuildFunction, () => {
  beforeEach(() => {
    deviceLaunch = undefined;
    jest.clearAllMocks();
    jest.mocked(spawn).mockResolvedValue({ stdout: '', stderr: '' } as never);
    jest.mocked(readLocalEgressHandoffAsync).mockResolvedValue(null);
    jest.mocked(resolveIosSimulatorUdidAsync).mockResolvedValue('selected-udid' as never);
    jest.mocked(prepareBootedIosSimulatorAsync).mockResolvedValue(undefined);
    jest.mocked(getAgentDeviceRemoteSessionEnvOrThrow).mockReturnValue(sessionEnv);
    jest
      .mocked(runAgentDeviceRemoteSessionAsync)
      .mockImplementation(async (_ctx, { device, tasks }) => {
        await tasks.untilAborted(prepareDeviceAsync(device));
      });
    jest.mocked(bootIosSimulatorAsync).mockResolvedValue({
      deviceIdentifier: 'iPhone 17' as never,
      udid: 'udid' as never,
      displayName: 'iPhone 17',
    });
    jest.mocked(startAndroidEmulatorAsync).mockResolvedValue({
      serialId: 'emulator-5554' as never,
      emulatorPromise: Promise.resolve(),
      shouldAdjustAnimationScale: true,
    });
    jest.mocked(downloadBuildAsync).mockResolvedValue({ artifactPath: '/tmp/App.app' });
    jest
      .mocked(installBuildAsync)
      .mockResolvedValue({ applicationIdentifier: 'dev.example.app', activityName: '.Main' });
    jest.mocked(launchApplicationAsync).mockResolvedValue(undefined);
  });

  it('keeps guarded iOS on the legacy boot path while downloading', async () => {
    jest.mocked(readLocalEgressHandoffAsync).mockResolvedValue({} as never);
    const boot = deferred<Awaited<ReturnType<typeof bootIosSimulatorAsync>>>();
    jest.mocked(bootIosSimulatorAsync).mockReturnValue(boot.promise);

    const step = runStep(BuildRuntimePlatform.DARWIN, {
      build_id: 'build-id',
      launch_args: ['-flag'],
      open_url: 'exp://example.test',
    });
    await flushAsync();

    expect(
      jest.mocked(selectXcodeDeveloperDirectoryAsync).mock.invocationCallOrder[0]
    ).toBeLessThan(jest.mocked(bootIosSimulatorAsync).mock.invocationCallOrder[0]);
    expect(downloadBuildAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        buildId: 'build-id',
        extensions: ['app'],
        graphqlClient,
        robotAccessToken: 'robot-token',
      })
    );
    expect(runAgentDeviceRemoteSessionAsync).toHaveBeenCalledTimes(1);
    expect(prepareBootedIosSimulatorAsync).not.toHaveBeenCalled();
    // The install needs the booted Simulator.
    expect(installBuildAsync).not.toHaveBeenCalled();

    boot.resolve({
      deviceIdentifier: 'iPhone 17' as never,
      udid: 'udid' as never,
      displayName: '',
    });
    await step;

    expect(installBuildAsync).toHaveBeenCalledWith(
      expect.objectContaining({ artifactPath: '/tmp/App.app' })
    );
    expect(launchApplicationAsync).not.toHaveBeenCalled();
    expect(deviceLaunch).toEqual({
      launchAppIdentifier: 'dev.example.app',
      launchArgs: ['-flag'],
      openUrl: 'exp://example.test',
    });
  });

  it('downloads concurrently and installs on the selected Simulator after host readiness', async () => {
    const hostReady = deferred();
    const bootComplete = deferred<Awaited<ReturnType<typeof spawn>>>();
    jest.mocked(spawn).mockReturnValueOnce(bootComplete.promise as ReturnType<typeof spawn>);
    jest.mocked(runAgentDeviceRemoteSessionAsync).mockImplementation(async (_ctx, { device }) => {
      await hostReady.promise;
      await prepareDeviceAsync(device);
    });
    const step = runStep(BuildRuntimePlatform.DARWIN, {
      device_identifier: 'iPhone 17',
      build_id: 'build-id',
      launch_args: ['-flag'],
      open_url: 'exp://example.test',
    });
    await flushAsync();

    expect(resolveIosSimulatorUdidAsync).toHaveBeenCalledWith({
      deviceIdentifier: 'iPhone 17',
      env: {},
    });
    expect(bootIosSimulatorAsync).not.toHaveBeenCalled();
    expect(sessionDevice()).toEqual({
      iosSimulatorUdid: 'selected-udid',
      prepareApplicationAsync: expect.any(Function),
    });
    expect(downloadBuildAsync).toHaveBeenCalledTimes(1);
    expect(prepareBootedIosSimulatorAsync).not.toHaveBeenCalled();
    expect(installBuildAsync).not.toHaveBeenCalled();

    hostReady.resolve();
    await flushAsync();
    expect(spawn).toHaveBeenCalledWith('xcrun', ['simctl', 'bootstatus', 'selected-udid', '-b'], {
      env: {},
      signal: expect.any(AbortSignal),
    });
    expect(prepareBootedIosSimulatorAsync).not.toHaveBeenCalled();
    expect(installBuildAsync).not.toHaveBeenCalled();
    bootComplete.resolve({ stdout: '', stderr: '' } as never);
    await step;
    expect(
      jest.mocked(runAgentDeviceRemoteSessionAsync).mock.calls[0][1].logger.info
    ).toHaveBeenCalledWith('Selected iOS Simulator: selected-udid.');
    expect(prepareBootedIosSimulatorAsync).toHaveBeenCalledWith({
      udid: 'selected-udid',
      env: {},
      logger: expect.any(Object),
      signal: expect.any(AbortSignal),
    });
    expect(jest.mocked(prepareBootedIosSimulatorAsync).mock.invocationCallOrder[0]).toBeLessThan(
      jest.mocked(installBuildAsync).mock.invocationCallOrder[0]
    );
    expect(jest.mocked(spawn).mock.invocationCallOrder[0]).toBeLessThan(
      jest.mocked(prepareBootedIosSimulatorAsync).mock.invocationCallOrder[0]
    );
    expect(installBuildAsync).toHaveBeenCalledWith(
      expect.objectContaining({ artifactPath: '/tmp/App.app', iosSimulatorUdid: 'selected-udid' })
    );
    expect(launchApplicationAsync).not.toHaveBeenCalled();
    expect(deviceLaunch).toEqual({
      launchAppIdentifier: 'dev.example.app',
      launchArgs: ['-flag'],
      openUrl: 'exp://example.test',
    });
  });

  it('fails before preparation and installation when boot completion fails', async () => {
    const bootError = new Error('bootstatus failed');
    jest.mocked(spawn).mockRejectedValueOnce(bootError);

    await expect(runStep(BuildRuntimePlatform.DARWIN, { build_id: 'build-id' })).rejects.toBe(
      bootError
    );
    expect(prepareBootedIosSimulatorAsync).not.toHaveBeenCalled();
    expect(installBuildAsync).not.toHaveBeenCalled();
    expect(launchApplicationAsync).not.toHaveBeenCalled();
  });

  it('cancels and drains the boot completion wait before returning', async () => {
    const controller = new AbortController();
    const cancelled = new Error('cancelled');
    let bootWaitStopped = false;
    jest.mocked(spawn).mockImplementationOnce(
      ((_command, _args, options) =>
        new Promise((_resolve, reject) => {
          expect(options?.signal).toBeInstanceOf(AbortSignal);
          options!.signal!.addEventListener(
            'abort',
            () => {
              setImmediate(() => {
                bootWaitStopped = true;
                reject(new Error('spawn aborted'));
              });
            },
            { once: true }
          );
        })) as typeof spawn
    );
    const step = runStep(BuildRuntimePlatform.DARWIN, { build_id: 'build-id' }, controller.signal);
    const failure = expect(step).rejects.toBe(cancelled);
    await flushAsync();
    expect(spawn).toHaveBeenCalledTimes(1);
    controller.abort(cancelled);

    await failure;
    expect(bootWaitStopped).toBe(true);
    expect(prepareBootedIosSimulatorAsync).not.toHaveBeenCalled();
    expect(installBuildAsync).not.toHaveBeenCalled();
    expect(launchApplicationAsync).not.toHaveBeenCalled();
  });

  it('waits for the download when the host is ready first', async () => {
    const download = deferred<{ artifactPath: string }>();
    jest.mocked(downloadBuildAsync).mockReturnValue(download.promise);

    const step = runStep(BuildRuntimePlatform.DARWIN, {
      application_archive_url: 'https://example.test/app.tar.gz',
    });
    await flushAsync();
    expect(installBuildAsync).not.toHaveBeenCalled();

    download.resolve({ artifactPath: '/tmp/App.app' });
    await step;
    expect(installBuildAsync).toHaveBeenCalledTimes(1);
  });

  it('prepares the host-booted Simulator even when there is no app', async () => {
    await runStep(BuildRuntimePlatform.DARWIN);

    expect(downloadBuildAsync).not.toHaveBeenCalled();
    expect(installBuildAsync).not.toHaveBeenCalled();
    expect(launchApplicationAsync).not.toHaveBeenCalled();
    expect(prepareBootedIosSimulatorAsync).toHaveBeenCalledTimes(1);
    expect(sessionDevice()).toEqual({
      iosSimulatorUdid: 'selected-udid',
      prepareApplicationAsync: expect.any(Function),
    });
  });

  it('boots the Android Emulator with the device inputs', async () => {
    await runStep(BuildRuntimePlatform.LINUX, {
      device_identifier: 'pixel_7',
      system_image_package: 'system-images;android-35-ext15;google_apis_playstore;x86_64',
      lcd_width: 720,
      lcd_height: 1600,
      lcd_density: 300,
      build_id: 'build-id',
    });

    expect(selectXcodeDeveloperDirectoryAsync).not.toHaveBeenCalled();
    expect(startAndroidEmulatorAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceIdentifier: 'pixel_7',
        systemImagePackage: 'system-images;android-35-ext15;google_apis_playstore;x86_64',
        lcdWidth: 720,
        lcdHeight: 1600,
        lcdDensity: 300,
      })
    );
    expect(downloadBuildAsync).toHaveBeenCalledWith(
      expect.objectContaining({ extensions: ['apk'] })
    );
    expect(launchApplicationAsync).toHaveBeenCalledWith(
      expect.objectContaining({ applicationIdentifier: 'dev.example.app', activityName: '.Main' })
    );
  });

  it('fails the session when the download fails, without an unhandled rejection', async () => {
    jest.mocked(readLocalEgressHandoffAsync).mockResolvedValue({} as never);
    const boot = deferred<Awaited<ReturnType<typeof bootIosSimulatorAsync>>>();
    jest.mocked(bootIosSimulatorAsync).mockReturnValue(boot.promise);
    jest.mocked(downloadBuildAsync).mockRejectedValue(new Error('download failed'));

    const stepFailure = expect(
      runStep(BuildRuntimePlatform.DARWIN, { build_id: 'build-id' })
    ).rejects.toThrow('download failed');
    // The download fails while the boot still runs. Nothing inside the step may leave
    // that rejection unhandled; Jest fails the test if it does.
    await flushAsync();
    boot.resolve({
      deviceIdentifier: 'iPhone 17' as never,
      udid: 'udid' as never,
      displayName: '',
    });

    await stepFailure;
    expect(installBuildAsync).not.toHaveBeenCalled();
  });

  /** A download that runs until its abort signal fires, like a stalled one. */
  function mockStalledDownload(): { aborted: () => boolean; settled: () => boolean } {
    let aborted = false;
    let settled = false;
    jest.mocked(downloadBuildAsync).mockImplementation(
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal!.addEventListener('abort', () => {
            aborted = true;
            // Settles a bit later, like a request that winds down.
            setImmediate(() => {
              settled = true;
              reject(new Error('The user aborted a request.'));
            });
          });
        })
    );
    return { aborted: () => aborted, settled: () => settled };
  }

  /** Runs the session like the real one: fails with the daemon, then waits for every part. */
  function mockSessionWithFailingDaemon(beforeFailure?: () => Promise<void>): void {
    jest
      .mocked(runAgentDeviceRemoteSessionAsync)
      .mockImplementation(async (_ctx, { tasks, device }) => {
        const ready = prepareDeviceAsync(device);
        await beforeFailure?.();
        const daemon = tasks.run('agent-device daemon', async () => {
          throw new Error('daemon failed');
        });
        try {
          await Promise.all([daemon, ready]);
        } finally {
          await Promise.allSettled([daemon, ready]);
        }
      });
  }

  it('stops the download and waits for it when the boot fails', async () => {
    jest.mocked(readLocalEgressHandoffAsync).mockResolvedValue({} as never);
    const download = mockStalledDownload();
    jest.mocked(bootIosSimulatorAsync).mockRejectedValue(new Error('boot failed'));

    await expect(runStep(BuildRuntimePlatform.DARWIN, { build_id: 'build-id' })).rejects.toThrow(
      'boot failed'
    );

    expect(download.aborted()).toBe(true);
    // The step returned only after the download stopped.
    expect(download.settled()).toBe(true);
    expect(installBuildAsync).not.toHaveBeenCalled();
  });

  it('stops a stalled download and does not install when the daemon fails', async () => {
    const download = mockStalledDownload();
    mockSessionWithFailingDaemon();

    await expect(runStep(BuildRuntimePlatform.DARWIN, { build_id: 'build-id' })).rejects.toThrow(
      'daemon failed'
    );

    expect(download.aborted()).toBe(true);
    expect(download.settled()).toBe(true);
    expect(installBuildAsync).not.toHaveBeenCalled();
    expect(launchApplicationAsync).not.toHaveBeenCalled();
  });

  it('drains the download when host startup fails before app preparation', async () => {
    const download = mockStalledDownload();
    jest.mocked(runAgentDeviceRemoteSessionAsync).mockRejectedValue(new Error('host failed'));

    await expect(runStep(BuildRuntimePlatform.DARWIN, { build_id: 'build-id' })).rejects.toThrow(
      'host failed'
    );
    expect(download.aborted()).toBe(true);
    expect(download.settled()).toBe(true);
    expect(installBuildAsync).not.toHaveBeenCalled();
  });

  it('does not start work for an already cancelled step', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));

    await expect(
      runStep(BuildRuntimePlatform.DARWIN, { build_id: 'build-id' }, controller.signal)
    ).rejects.toThrow('cancelled');
    expect(selectXcodeDeveloperDirectoryAsync).not.toHaveBeenCalled();
    expect(downloadBuildAsync).not.toHaveBeenCalled();
    expect(runAgentDeviceRemoteSessionAsync).not.toHaveBeenCalled();
  });

  it('cancels and drains a pending download through the external signal', async () => {
    const controller = new AbortController();
    const download = mockStalledDownload();
    const step = runStep(BuildRuntimePlatform.DARWIN, { build_id: 'build-id' }, controller.signal);
    const failure = expect(step).rejects.toThrow('cancelled');
    await flushAsync();
    controller.abort(new Error('cancelled'));

    await failure;
    expect(download.aborted()).toBe(true);
    expect(download.settled()).toBe(true);
    expect(installBuildAsync).not.toHaveBeenCalled();
  });

  it('does not start device or download work after cancellation during Xcode selection', async () => {
    const controller = new AbortController();
    const selected = deferred();
    jest.mocked(selectXcodeDeveloperDirectoryAsync).mockReturnValue(selected.promise);
    const step = runStep(BuildRuntimePlatform.DARWIN, { build_id: 'build-id' }, controller.signal);
    const failure = expect(step).rejects.toThrow('cancelled');
    await flushAsync();
    controller.abort(new Error('cancelled'));
    selected.resolve();

    await failure;
    expect(resolveIosSimulatorUdidAsync).not.toHaveBeenCalled();
    expect(bootIosSimulatorAsync).not.toHaveBeenCalled();
    expect(downloadBuildAsync).not.toHaveBeenCalled();
    expect(runAgentDeviceRemoteSessionAsync).not.toHaveBeenCalled();
  });

  it('drains Simulator setup and does not install after cancellation', async () => {
    const controller = new AbortController();
    const setup = deferred();
    jest.mocked(prepareBootedIosSimulatorAsync).mockReturnValue(setup.promise);
    const step = runStep(BuildRuntimePlatform.DARWIN, { build_id: 'build-id' }, controller.signal);
    let completed = false;
    void step.then(
      () => {
        completed = true;
      },
      () => {
        completed = true;
      }
    );
    const failure = expect(step).rejects.toThrow('cancelled');
    await flushAsync();
    expect(prepareBootedIosSimulatorAsync).toHaveBeenCalledTimes(1);
    controller.abort(new Error('cancelled'));
    await flushAsync();
    expect(completed).toBe(false);
    expect(installBuildAsync).not.toHaveBeenCalled();

    setup.resolve();
    await failure;
    expect(installBuildAsync).not.toHaveBeenCalled();
    expect(launchApplicationAsync).not.toHaveBeenCalled();
  });

  it('does not launch the app when startup fails during the install', async () => {
    const install = deferred<Awaited<ReturnType<typeof installBuildAsync>>>();
    const installStarted = deferred();
    jest.mocked(installBuildAsync).mockImplementation(() => {
      installStarted.resolve();
      return install.promise;
    });
    mockSessionWithFailingDaemon(async () => {
      await installStarted.promise;
      // The install finishes only after the daemon failed.
      setImmediate(() => install.resolve({ applicationIdentifier: 'dev.example.app' }));
    });

    await expect(runStep(BuildRuntimePlatform.DARWIN, { build_id: 'build-id' })).rejects.toThrow(
      'daemon failed'
    );

    expect(installBuildAsync).toHaveBeenCalledTimes(1);
    expect(launchApplicationAsync).not.toHaveBeenCalled();
  });

  it('rejects conflicting application inputs before it boots anything', async () => {
    await expect(
      runStep(BuildRuntimePlatform.DARWIN, {
        build_id: 'build-id',
        application_archive_url: 'https://example.test/app.tar.gz',
      })
    ).rejects.toThrow('Pass only one of build_id or application_archive_url.');
    await expect(
      runStep(BuildRuntimePlatform.DARWIN, { open_url: 'exp://example.test' })
    ).rejects.toThrow('launch_args and open_url need an application');

    expect(bootIosSimulatorAsync).not.toHaveBeenCalled();
    expect(runAgentDeviceRemoteSessionAsync).not.toHaveBeenCalled();
  });

  it('declares the step inputs', () => {
    const buildFunction = createStartAgentDeviceSessionBuildFunction(ctx);
    const globalCtx = createGlobalContextMock();

    expect(
      buildFunction.inputProviders?.map(provider => provider(globalCtx, 'Test step').id)
    ).toEqual([
      'device_identifier',
      'system_image_package',
      'lcd_width',
      'lcd_height',
      'lcd_density',
      'build_id',
      'application_archive_url',
      'launch_args',
      'open_url',
      'network_capture',
      'network_capture_fields',
      'package_version',
      'max_idle_time_minutes',
      'max_duration_seconds',
    ]);
  });

  it('passes network capture to the session', async () => {
    await runStep(BuildRuntimePlatform.DARWIN, {
      network_capture: true,
      network_capture_fields: ['header', 'response-body'],
    });

    expect(runAgentDeviceRemoteSessionAsync).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        capture: { networkCapture: true, networkCaptureFields: ['header', 'response-body'] },
      })
    );
  });

  it('rejects network capture on Android before it boots anything', async () => {
    await expect(
      runStep(BuildRuntimePlatform.LINUX, { network_capture: true, system_image_package: 'x' })
    ).rejects.toThrow('records traffic through serve-sim on an iOS simulator');
    expect(startAndroidEmulatorAsync).not.toHaveBeenCalled();
    expect(runAgentDeviceRemoteSessionAsync).not.toHaveBeenCalled();
  });
});
