import {
  type SandboxDaemonCommandParams,
  type SandboxDaemonCommandResult,
  type SandboxDaemonMethod,
} from '@expo/eas-build-job';
import { type bunyan } from '@expo/logger';
import { type Client } from '@urql/core';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { SandboxArtifactUploadManager } from './sandboxArtifacts';
import { ShellSessionManager } from './shellSessionManager';

const DEFAULT_EXEC_YIELD_TIME_MS = 10_000;
const DEFAULT_WRITE_YIELD_TIME_MS = 250;

export type SandboxDaemonCommandImplementations = {
  [Method in SandboxDaemonMethod]: (
    params: SandboxDaemonCommandParams<Method>
  ) => Promise<SandboxDaemonCommandResult<Method>>;
};

export function createSandboxCommandImplementations({
  workingDirectory,
  env,
  signal,
  graphqlClient,
  sandboxId,
  logger,
}: {
  workingDirectory: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  graphqlClient: Client;
  sandboxId: string;
  logger: bunyan;
}): {
  commandImplementations: SandboxDaemonCommandImplementations;
  stoppedPromise: Promise<void>;
} {
  const sessions = new ShellSessionManager({ workingDirectory, env, signal });
  const artifactUploads = new SandboxArtifactUploadManager({
    graphqlClient,
    sandboxId,
    logger,
    signal,
  });
  const stoppedPromise = Promise.all([
    sessions.stoppedPromise,
    artifactUploads.stoppedPromise,
  ]).then(() => {});
  stoppedPromise.catch(() => {});
  return {
    commandImplementations: {
      async execCommand(params) {
        const callStartedAt = performance.now();
        const sessionId = await sessions.startAsync({
          cmd: params.cmd,
          workdir: params.workdir,
          tty: params.tty,
        });
        const result = await sessions.readAsync(
          sessionId,
          params.yieldTimeMs ?? DEFAULT_EXEC_YIELD_TIME_MS
        );
        return { ...result, wallTimeSeconds: (performance.now() - callStartedAt) / 1_000 };
      },
      async writeStdin(params) {
        const callStartedAt = performance.now();
        if (params.chars !== undefined) {
          sessions.write(params.sessionId, params.chars);
        }
        const result = await sessions.readAsync(
          params.sessionId,
          params.yieldTimeMs ?? DEFAULT_WRITE_YIELD_TIME_MS
        );
        return { ...result, wallTimeSeconds: (performance.now() - callStartedAt) / 1_000 };
      },
      async uploadArtifact(params) {
        const id = await artifactUploads.startAsync({
          filePath: path.resolve(workingDirectory, params.path),
          name: params.name,
        });
        return { id };
      },
    },
    stoppedPromise,
  };
}
