import { unlink } from "node:fs/promises";
import { AppConfig, BackupManifest, EnvironmentId } from "../config/types.js";
import {
  createArchiveBackup,
  createLocalTempFile,
  getCollectionCounts,
  listCollections,
  restoreArchiveToEnvironment
} from "./mongo.js";
import { OutputMode, shouldPrintCommandSummary } from "./output.js";
import { verifyRestore } from "./verify.js";

export interface RunSyncDependencies {
  writeStdout: (message: string) => void;
  isInteractiveStdout: () => boolean;
  runWithElapsedStatus: <T>(
    baseMessage: string,
    task: () => Promise<T>
  ) => Promise<T>;
  createLocalTempFile: (appConfig: AppConfig, suffix: string) => string;
  createArchiveBackup: typeof createArchiveBackup;
  listCollections: typeof listCollections;
  getCollectionCounts: typeof getCollectionCounts;
  restoreArchiveToEnvironment: typeof restoreArchiveToEnvironment;
  verifyRestore: typeof verifyRestore;
  unlink: (path: string) => Promise<void>;
}

function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

async function runWithElapsedStatus<T>(
  writeStdout: (message: string) => void,
  isInteractiveStdout: () => boolean,
  baseMessage: string,
  task: () => Promise<T>
): Promise<T> {
  if (!isInteractiveStdout()) {
    return task();
  }

  const startedAt = Date.now();
  const render = (): void => {
    writeStdout(`\r${baseMessage} ${formatElapsed(Date.now() - startedAt)}`);
  };

  render();
  const timer = setInterval(render, 1000);
  try {
    return await task();
  } finally {
    clearInterval(timer);
    writeStdout("\n");
  }
}

const DEFAULT_RUN_SYNC_DEPENDENCIES: RunSyncDependencies = {
  writeStdout: (message: string) => process.stdout.write(message),
  isInteractiveStdout: () => Boolean(process.stdout.isTTY),
  runWithElapsedStatus: (baseMessage, task) =>
    runWithElapsedStatus(
      (message) => process.stdout.write(message),
      () => Boolean(process.stdout.isTTY),
      baseMessage,
      task
    ),
  createLocalTempFile,
  createArchiveBackup,
  listCollections,
  getCollectionCounts,
  restoreArchiveToEnvironment,
  verifyRestore,
  unlink
};

type SyncPhase =
  | "source_metadata"
  | "dump"
  | "restore"
  | "verify"
  | "cleanup";

class SyncPhaseError extends Error {
  readonly phase: SyncPhase;
  readonly targetMayBeDirty: boolean;
  readonly cleanupFailed: boolean;
  readonly cause?: unknown;

  constructor(input: {
    phase: SyncPhase;
    message: string;
    targetMayBeDirty: boolean;
    cleanupFailed?: boolean;
    cause?: unknown;
  }) {
    super(input.message);
    this.name = "SyncPhaseError";
    this.phase = input.phase;
    this.targetMayBeDirty = input.targetMayBeDirty;
    this.cleanupFailed = input.cleanupFailed ?? false;
    this.cause = input.cause;
  }
}

function formatSyncFailure(
  input: {
    from: EnvironmentId;
    to: EnvironmentId;
    phase: SyncPhase;
    targetMayBeDirty: boolean;
    details: string;
    cleanupFailed?: boolean;
  }
): string {
  const phaseLabel =
    input.phase === "source_metadata"
      ? "source metadata"
      : input.phase;
  const targetStatus = input.targetMayBeDirty
    ? `Target ${input.to} may be dirty.`
    : `Target ${input.to} was not modified.`;
  const cleanupStatus = input.cleanupFailed
    ? " Temp artifact cleanup also failed."
    : "";

  return (
    `Sync failed during ${phaseLabel} for ${input.from} -> ${input.to}.\n` +
    `${targetStatus}${cleanupStatus}\n` +
    `${input.details}`
  );
}

function getErrorDetails(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function filterSyncCollections(collections: string[]): string[] {
  return collections.filter((name) => !name.startsWith("system."));
}

function buildSyncVerificationManifest(
  from: EnvironmentId,
  collectionList: string[],
  collectionCounts?: Record<string, number>
): BackupManifest {
  return {
    backupName: `sync-${from}`,
    sourceEnvironment: from,
    databaseName: from,
    createdAt: new Date(0).toISOString(),
    tags: [],
    collectionList,
    toolVersion: "sync-verification",
    archiveFile: "sync",
    collectionCounts
  };
}

export async function runSync(
  appConfig: AppConfig,
  input: { from: EnvironmentId; to: EnvironmentId; outputMode: OutputMode },
  dependencies: RunSyncDependencies = DEFAULT_RUN_SYNC_DEPENDENCIES
): Promise<void> {
  const source = appConfig.environments[input.from];
  const target = appConfig.environments[input.to];
  const printSummary = shouldPrintCommandSummary(input.outputMode);
  let countProgressActive = false;
  let countProgressLastWidth = 0;
  const collectionList = filterSyncCollections(
    await dependencies.listCollections(source, {
      outputMode: input.outputMode
    })
  );
  const collectionCounts = await dependencies.getCollectionCounts(
    source,
    collectionList,
    { outputMode: input.outputMode }
  );
  const verificationManifest = buildSyncVerificationManifest(
    input.from,
    collectionList,
    collectionCounts
  );
  const tempArchive = dependencies.createLocalTempFile(
    appConfig,
    ".archive.gz"
  );
  let syncSucceeded = false;
  let currentPhase: SyncPhase = "dump";
  let targetMayBeDirty = false;
  let primaryError: SyncPhaseError | undefined;

  try {
    if (printSummary) {
      dependencies.writeStdout(`Starting sync ${input.from} -> ${input.to}\n`);
    }
    if (printSummary) {
      currentPhase = "dump";
      await dependencies.runWithElapsedStatus(
        `Dumping source ${input.from}...`,
        () =>
          dependencies.createArchiveBackup(source, appConfig, tempArchive, {
            outputMode: input.outputMode
          })
      );
    } else {
      currentPhase = "dump";
      await dependencies.createArchiveBackup(source, appConfig, tempArchive, {
        outputMode: input.outputMode
      });
    }
    if (printSummary) {
      currentPhase = "restore";
      targetMayBeDirty = true;
      await dependencies.runWithElapsedStatus(
        `Restoring target ${input.to}...`,
        () =>
          dependencies.restoreArchiveToEnvironment(
            target,
            appConfig,
            tempArchive,
            { drop: true, outputMode: input.outputMode }
          )
      );
      dependencies.writeStdout(`Verifying target ${input.to}...\n`);
      dependencies.writeStdout(`Checking collection presence...\n`);
      dependencies.writeStdout(`Checking collection counts...\n`);
    } else {
      currentPhase = "restore";
      targetMayBeDirty = true;
      await dependencies.restoreArchiveToEnvironment(
        target,
        appConfig,
        tempArchive,
        { drop: true, outputMode: input.outputMode }
      );
    }
    currentPhase = "verify";
    const verification = await dependencies.verifyRestore(
      target,
      verificationManifest,
      {
        outputMode: input.outputMode,
        onCountedCollection: printSummary
          ? ({ completed, total, collection }) => {
              const message = `Checked collection counts: ${completed}/${total} (${collection})`;
              if (dependencies.isInteractiveStdout()) {
                countProgressActive = true;
                const paddedMessage = message.padEnd(countProgressLastWidth, " ");
                countProgressLastWidth = paddedMessage.length;
                dependencies.writeStdout(`\r${paddedMessage}`);
                return;
              }
              dependencies.writeStdout(`${message}\n`);
            }
          : undefined
      }
    );
    if (countProgressActive) {
      dependencies.writeStdout("\n");
      countProgressActive = false;
      countProgressLastWidth = 0;
    }
    if (
      verification.missingCollections.length > 0 ||
      verification.countMismatches.length > 0
    ) {
      throw new SyncPhaseError({
        phase: "verify",
        targetMayBeDirty: true,
        message: formatSyncFailure({
          from: input.from,
          to: input.to,
          phase: "verify",
          targetMayBeDirty: true,
          details:
            `Missing collections: ${
              verification.missingCollections.join(", ") || "none"
            }\n` +
            `Count mismatches: ${
              verification.countMismatches
                .map(
                  (item) =>
                    `${item.collection} expected=${item.expected} actual=${item.actual}`
                )
                .join(", ") || "none"
            }`
        })
      });
    }
    syncSucceeded = true;
  } catch (error) {
    if (error instanceof SyncPhaseError) {
      primaryError = error;
    } else {
      primaryError = new SyncPhaseError({
        phase: currentPhase,
        targetMayBeDirty,
        cause: error,
        message: formatSyncFailure({
          from: input.from,
          to: input.to,
          phase: currentPhase,
          targetMayBeDirty,
          details: getErrorDetails(error)
        })
      });
    }
  }
  if (countProgressActive) {
    dependencies.writeStdout("\n");
    countProgressLastWidth = 0;
  }
  if (printSummary) {
    dependencies.writeStdout(`Cleaning up sync temp artifacts...\n`);
  }
  try {
    await dependencies.unlink(tempArchive);
  } catch (error) {
    if (primaryError) {
      primaryError = new SyncPhaseError({
        phase: primaryError.phase,
        targetMayBeDirty: primaryError.targetMayBeDirty,
        cleanupFailed: true,
        cause: primaryError.cause,
        message: formatSyncFailure({
          from: input.from,
          to: input.to,
          phase: primaryError.phase,
          targetMayBeDirty: primaryError.targetMayBeDirty,
          details: getErrorDetails(primaryError.cause ?? primaryError),
          cleanupFailed: true
        })
      });
    } else if (!syncSucceeded) {
      primaryError = new SyncPhaseError({
        phase: "cleanup",
        targetMayBeDirty,
        cause: error,
        cleanupFailed: true,
        message: formatSyncFailure({
          from: input.from,
          to: input.to,
          phase: "cleanup",
          targetMayBeDirty,
          details: getErrorDetails(error),
          cleanupFailed: true
        })
      });
    }
  }
  if (primaryError) {
    throw primaryError;
  }
  if (printSummary && syncSucceeded) {
    dependencies.writeStdout(
      `Sync ${input.from} -> ${input.to} complete. Verified ${collectionList.length} collections.\n`
    );
  }
}
