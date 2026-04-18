import { constants as fsConstants } from "node:fs";
import { access, unlink } from "node:fs/promises";
import { AppConfig, BackupManifest, EnvironmentId } from "../config/types.js";
import {
  createArchiveBackup,
  createLocalTempFile,
  dropCollections,
  getCollectionCounts,
  inspectArchiveCollections,
  listCollections,
  restoreArchiveToEnvironment
} from "./mongo.js";
import { OutputMode, shouldPrintCommandSummary } from "./output.js";
import { verifyRestore } from "./verify.js";

export interface RunSyncDependencies {
  writeStdout: (message: string) => void;
  isInteractiveStdout: () => boolean;
  installInterruptHandler: (onInterrupt: () => void) => () => void;
  runWithElapsedStatus: <T>(
    baseMessage: string,
    task: () => Promise<T>
  ) => Promise<T>;
  createLocalTempFile: (appConfig: AppConfig, suffix: string) => string;
  createArchiveBackup: typeof createArchiveBackup;
  listCollections: typeof listCollections;
  getCollectionCounts: typeof getCollectionCounts;
  inspectArchiveCollections: typeof inspectArchiveCollections;
  restoreArchiveToEnvironment: typeof restoreArchiveToEnvironment;
  dropCollections: typeof dropCollections;
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

async function removeTempArchiveIfPresent(archivePath: string): Promise<void> {
  try {
    await access(archivePath, fsConstants.F_OK);
  } catch {
    return;
  }

  await unlink(archivePath);
}

const DEFAULT_RUN_SYNC_DEPENDENCIES: RunSyncDependencies = {
  writeStdout: (message: string) => process.stdout.write(message),
  isInteractiveStdout: () => Boolean(process.stdout.isTTY),
  installInterruptHandler: (onInterrupt) => {
    process.on("SIGINT", onInterrupt);
    return () => process.removeListener("SIGINT", onInterrupt);
  },
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
  inspectArchiveCollections,
  restoreArchiveToEnvironment,
  dropCollections,
  verifyRestore,
  unlink: removeTempArchiveIfPresent
};

type SyncPhase =
  | "source_metadata"
  | "dump"
  | "restore"
  | "prune"
  | "verify"
  | "cleanup";

class SyncPhaseError extends Error {
  readonly phase: SyncPhase;
  readonly targetMayBeDirty: boolean;
  readonly cleanupFailed: boolean;
  readonly interrupted: boolean;
  readonly cause?: unknown;

  constructor(input: {
    phase: SyncPhase;
    message: string;
    targetMayBeDirty: boolean;
    cleanupFailed?: boolean;
    interrupted?: boolean;
    cause?: unknown;
  }) {
    super(input.message);
    this.name = "SyncPhaseError";
    this.phase = input.phase;
    this.targetMayBeDirty = input.targetMayBeDirty;
    this.cleanupFailed = input.cleanupFailed ?? false;
    this.interrupted = input.interrupted ?? false;
    this.cause = input.cause;
  }
}

function formatSyncFailure(input: {
  from: EnvironmentId;
  to: EnvironmentId;
  phase: SyncPhase;
  targetMayBeDirty: boolean;
  details: string;
  cleanupFailed?: boolean;
  interrupted?: boolean;
}): string {
  const phaseLabel =
    input.phase === "source_metadata"
      ? "source metadata"
      : input.phase === "prune"
        ? "removing target-only collections"
        : input.phase;
  const actionLabel = input.interrupted ? "interrupted" : "failed";
  const targetStatus = input.targetMayBeDirty
    ? `Target database may be dirty. Restore it from a known good backup or rerun sync before trusting it.`
    : `Target database was not modified.`;
  const cleanupStatus = input.cleanupFailed
    ? "Attempted to delete temporary sync artifacts, but cleanup may not have finished."
    : input.interrupted
      ? "Attempted to delete temporary sync artifacts, but cleanup success is not confirmed."
      : "";
  const details = input.interrupted
    ? "The sync was interrupted by the operator."
    : input.details;

  return (
    `Sync ${actionLabel} during ${phaseLabel} for ${input.from} -> ${input.to}.\n` +
    `${targetStatus}\n` +
    `${cleanupStatus}\n` +
    `${details}`
  );
}

function getErrorDetails(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function isInterruptedError(error: unknown): boolean {
  return (
    error instanceof Error && error.message.startsWith("Command interrupted:")
  );
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
  let interrupted = false;
  const abortController = new AbortController();
  const removeInterruptHandler = dependencies.installInterruptHandler(() => {
    interrupted = true;
    abortController.abort();
  });
  let countProgressActive = false;
  let countProgressLastWidth = 0;
  let syncSucceeded = false;
  let currentPhase: SyncPhase = "source_metadata";
  let targetMayBeDirty = false;
  let primaryError: SyncPhaseError | undefined;
  let verificationCollectionList: string[] = [];
  let tempArchive = "";

  try {
    verificationCollectionList = filterSyncCollections(
      await dependencies.listCollections(source, {
        outputMode: input.outputMode,
        signal: abortController.signal
      })
    );
    const collectionCounts = await dependencies.getCollectionCounts(
      source,
      verificationCollectionList,
      { outputMode: input.outputMode, signal: abortController.signal }
    );
    const verificationManifest = buildSyncVerificationManifest(
      input.from,
      verificationCollectionList,
      collectionCounts
    );
    tempArchive = dependencies.createLocalTempFile(appConfig, ".archive.gz");

    if (printSummary) {
      dependencies.writeStdout(`Starting sync ${input.from} -> ${input.to}\n`);
    }
    if (printSummary) {
      currentPhase = "dump";
      await dependencies.runWithElapsedStatus(
        `Dumping source ${input.from}...`,
        () =>
          dependencies.createArchiveBackup(source, appConfig, tempArchive, {
            outputMode: input.outputMode,
            signal: abortController.signal
          })
      );
    } else {
      currentPhase = "dump";
      await dependencies.createArchiveBackup(source, appConfig, tempArchive, {
        outputMode: input.outputMode,
        signal: abortController.signal
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
            {
              sourceDatabaseName: source.databaseName,
              drop: true,
              outputMode: input.outputMode,
              signal: abortController.signal
            }
          )
      );
    } else {
      currentPhase = "restore";
      targetMayBeDirty = true;
      await dependencies.restoreArchiveToEnvironment(
        target,
        appConfig,
        tempArchive,
        {
          sourceDatabaseName: source.databaseName,
          drop: true,
          outputMode: input.outputMode,
          signal: abortController.signal
        }
      );
    }
    currentPhase = "prune";
    const expectedCollections = new Set(
      filterSyncCollections(
        await dependencies.inspectArchiveCollections(
          target,
          appConfig,
          tempArchive,
          {
            sourceDatabaseName: source.databaseName,
            outputMode: input.outputMode,
            signal: abortController.signal
          }
        )
      )
    );
    const targetCollections = filterSyncCollections(
      await dependencies.listCollections(target, {
        outputMode: input.outputMode,
        signal: abortController.signal
      })
    );
    const targetOnlyCollections = targetCollections.filter(
      (collection) => !expectedCollections.has(collection)
    );
    if (printSummary) {
      dependencies.writeStdout(
        `Removing target-only collections from ${input.to}...\n`
      );
    }
    await dependencies.dropCollections(target, targetOnlyCollections, {
      outputMode: input.outputMode,
      signal: abortController.signal
    });

    currentPhase = "verify";
    if (printSummary) {
      dependencies.writeStdout(`Verifying target ${input.to}...\n`);
      dependencies.writeStdout(`Checking collection presence...\n`);
      dependencies.writeStdout(`Checking collection counts...\n`);
    }
    const verification = await dependencies.verifyRestore(
      target,
      verificationManifest,
      {
        outputMode: input.outputMode,
        signal: abortController.signal,
        onCountedCollection: printSummary
          ? ({ completed, total, collection }) => {
              const message = `Checked collection counts: ${completed}/${total} (${collection})`;
              if (dependencies.isInteractiveStdout()) {
                countProgressActive = true;
                const paddedMessage = message.padEnd(
                  countProgressLastWidth,
                  " "
                );
                countProgressLastWidth = paddedMessage.length;
                dependencies.writeStdout(`\r${paddedMessage}`);
                return;
              }
              dependencies.writeStdout(`${message}\n`);
            }
          : undefined
      }
    );
    const unexpectedCollections = filterSyncCollections(
      verification.collectionsPresent
    ).filter((collection) => !expectedCollections.has(collection));
    if (countProgressActive) {
      dependencies.writeStdout("\n");
      countProgressActive = false;
      countProgressLastWidth = 0;
    }
    if (
      verification.missingCollections.length > 0 ||
      unexpectedCollections.length > 0 ||
      verification.countMismatches.length > 0
    ) {
      throw new SyncPhaseError({
        phase: "verify",
        targetMayBeDirty: true,
        interrupted: false,
        message: formatSyncFailure({
          from: input.from,
          to: input.to,
          phase: "verify",
          targetMayBeDirty: true,
          interrupted: false,
          details:
            `Missing collections: ${
              verification.missingCollections.join(", ") || "none"
            }\n` +
            `Unexpected collections: ${
              unexpectedCollections.join(", ") || "none"
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
        interrupted: interrupted || isInterruptedError(error),
        cause: error,
        message: formatSyncFailure({
          from: input.from,
          to: input.to,
          phase: currentPhase,
          targetMayBeDirty,
          interrupted: interrupted || isInterruptedError(error),
          details: getErrorDetails(error)
        })
      });
    }
  } finally {
    removeInterruptHandler();
  }
  if (countProgressActive) {
    dependencies.writeStdout("\n");
    countProgressLastWidth = 0;
  }
  if (printSummary && tempArchive) {
    dependencies.writeStdout(`Cleaning up sync temp artifacts...\n`);
  }
  if (tempArchive) {
    try {
      await dependencies.unlink(tempArchive);
    } catch (error) {
      if (primaryError) {
        primaryError = new SyncPhaseError({
          phase: primaryError.phase,
          targetMayBeDirty: primaryError.targetMayBeDirty,
          cleanupFailed: true,
          interrupted: primaryError.interrupted,
          cause: primaryError.cause,
          message: formatSyncFailure({
            from: input.from,
            to: input.to,
            phase: primaryError.phase,
            targetMayBeDirty: primaryError.targetMayBeDirty,
            interrupted: primaryError.interrupted,
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
          interrupted,
          message: formatSyncFailure({
            from: input.from,
            to: input.to,
            phase: "cleanup",
            targetMayBeDirty,
            interrupted,
            details: getErrorDetails(error),
            cleanupFailed: true
          })
        });
      }
    }
  }
  if (primaryError) {
    throw primaryError;
  }
  if (printSummary && syncSucceeded) {
    dependencies.writeStdout(
      `Sync ${input.from} -> ${input.to} complete. Verified ${verificationCollectionList.length} collections.\n`
    );
  }
}
