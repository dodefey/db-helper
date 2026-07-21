import {
  AppConfig,
  BackupRecord,
  EnvironmentConfig,
  EnvironmentId
} from "../config/types.js";
import {
  archivePathForBackup,
  ensureBackupArtifacts,
  readBackup
} from "./backups.js";
import {
  ArchiveMutationState,
  combineRemoteTransportErrors,
  dropCollections,
  isArchivePreflightError,
  listCollections,
  prepareArchiveRestoreSession,
  PreparedArchiveRestoreSession,
  RemoteOperationError,
  restoreArchiveToEnvironment
} from "./mongo.js";
import { verifyRestore } from "./verify.js";
import { backupCreate } from "../commands/backup.js";
import {
  CommandInvocationContext,
  createCommandInvocationContext
} from "./invocationContext.js";
import { OutputMode } from "./output.js";
import { getRunLogger } from "./runLog.js";

export interface RunRestoreDependencies {
  ensureBackupArtifacts: typeof ensureBackupArtifacts;
  readBackup: typeof readBackup;
  archivePathForBackup: typeof archivePathForBackup;
  backupCreate: typeof backupCreate;
  restoreArchiveToEnvironment: typeof restoreArchiveToEnvironment;
  prepareArchiveRestoreSession: typeof prepareArchiveRestoreSession;
  listCollections: typeof listCollections;
  dropCollections: typeof dropCollections;
  verifyRestore: typeof verifyRestore;
  installInterruptHandler: (onInterrupt: () => void) => () => void;
  writeStdout: (message: string) => void;
}

const DEFAULT_RUN_RESTORE_DEPENDENCIES: RunRestoreDependencies = {
  ensureBackupArtifacts,
  readBackup,
  archivePathForBackup,
  backupCreate,
  restoreArchiveToEnvironment,
  prepareArchiveRestoreSession,
  listCollections,
  dropCollections,
  verifyRestore,
  installInterruptHandler: (onInterrupt) => {
    const handler = (): void => onInterrupt();
    process.on("SIGINT", handler);
    return () => process.off("SIGINT", handler);
  },
  writeStdout: (message) => process.stdout.write(message)
};

type RestorePhase =
  | "backup_validation"
  | "pre_restore_backup"
  | "restore"
  | "prune"
  | "verify"
  | "cleanup";

type RestoreSubprocessState = "not_started" | "succeeded" | "failed";
type RestorePostMutationState = "not_started" | "succeeded" | "failed";

function targetTrustState(input: {
  restoreSubprocess: RestoreSubprocessState;
  prune: RestorePostMutationState;
  verification: RestorePostMutationState;
}): string {
  if (input.verification === "succeeded") return "verified";
  if (input.restoreSubprocess === "not_started") return "unchanged";
  if (input.prune === "failed" || input.verification === "failed") {
    return "requires independent verification";
  }
  return "may be partially modified";
}

function isInterruptedError(error: unknown): boolean {
  return (
    (error instanceof Error &&
      error.message.startsWith("Command interrupted:")) ||
    (error instanceof RemoteOperationError && error.interrupted)
  );
}

function getErrorDetails(error: unknown): string {
  if (error instanceof RemoteOperationError) {
    return error.details;
  }
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }

  return "Unknown restore failure.";
}

function formatRestoreFailure(options: {
  backup: string;
  to: EnvironmentId;
  phase: RestorePhase;
  targetMayBeDirty: boolean;
  interrupted: boolean;
  cleanupLine?: string;
  remoteTempPath?: string;
  details?: string;
  restoreSubprocess: RestoreSubprocessState;
  prune: RestorePostMutationState;
  verification: RestorePostMutationState;
}): string {
  const phaseLabel =
    options.phase === "backup_validation"
      ? "backup validation"
      : options.phase === "pre_restore_backup"
        ? "pre-restore backup"
        : options.phase === "restore"
          ? "restore"
          : options.phase === "prune"
            ? "prune"
            : options.phase === "verify"
              ? "verify"
              : "cleanup";

  const statusLine = options.interrupted
    ? `Restore interrupted during ${phaseLabel} for ${options.backup} -> ${options.to}.`
    : `Restore failed during ${phaseLabel} for ${options.backup} -> ${options.to}.`;

  const trustState = targetTrustState({
    restoreSubprocess: options.restoreSubprocess,
    prune: options.prune,
    verification: options.verification
  });
  const targetLine =
    trustState === "verified"
      ? "Target database restore verification succeeded; only temporary artifact cleanup failed."
      : options.targetMayBeDirty
        ? "Target database may be dirty. Restore it from a known good backup or rerun restore before trusting it."
        : "Target database was not modified.";

  const lines = [statusLine, targetLine];

  if (options.cleanupLine) {
    lines.push(options.cleanupLine);
  }

  if (options.remoteTempPath) {
    lines.push(`Remote temporary archive path: ${options.remoteTempPath}`);
  }

  if (options.interrupted) {
    lines.push("The restore was interrupted by the operator.");
  } else if (options.details) {
    lines.push(options.details);
  }

  lines.push(`Restore subprocess: ${options.restoreSubprocess}`);
  lines.push(`Post-restore pruning: ${options.prune}`);
  lines.push(`Post-restore verification: ${options.verification}`);
  lines.push(
    `Target trust state: ${targetTrustState({
      restoreSubprocess: options.restoreSubprocess,
      prune: options.prune,
      verification: options.verification
    })}`
  );

  return lines.join("\n");
}

function cleanupLineForFailure(
  target: EnvironmentConfig,
  cleanupFailed: boolean
): string | undefined {
  if (target.kind !== "remote" || !cleanupFailed) {
    return undefined;
  }
  return "Temporary restore artifact cleanup was attempted but may not have completed.";
}

function hasRemoteCleanupFailure(error: unknown): boolean {
  return (
    error instanceof RemoteOperationError &&
    (error.code === "remoteCleanupFailed" ||
      error.details.includes("Remote temporary archive cleanup failed:"))
  );
}

function getRemoteTempPath(error: unknown): string | undefined {
  let current = error;
  const visited = new Set<unknown>();
  while (current instanceof Error && !visited.has(current)) {
    if (current instanceof RemoteOperationError && current.remoteTempPath) {
      return current.remoteTempPath;
    }
    visited.add(current);
    current = current.cause;
  }
  return undefined;
}

function filterRestoreCollections(collections: string[]): string[] {
  return collections.filter((collection) => !collection.startsWith("system."));
}

function collectionSetDifference(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((collection) => !rightSet.has(collection)).sort();
}

function manifestCollectionsFromBackup(backup: BackupRecord): string[] {
  return filterRestoreCollections(backup.manifest.collectionList).sort();
}

function formatRestoreVerificationFailure(
  backup: BackupRecord,
  to: EnvironmentId,
  verification: {
    missingCollections: string[];
    countMismatches: Array<{
      collection: string;
      expected: number;
      actual: number;
    }>;
  }
): string {
  return (
    `Restore verification failed for ${backup.name} -> ${to}\n` +
    `Missing collections: ${verification.missingCollections.join(", ") || "none"}\n` +
    `Count mismatches: ${
      verification.countMismatches
        .map(
          (item) =>
            `${item.collection} expected=${item.expected} actual=${item.actual}`
        )
        .join(", ") || "none"
    }`
  );
}

export async function runRestoreFull(
  appConfig: AppConfig,
  input: {
    backup: string;
    to: EnvironmentId;
    skipPreBackup: boolean;
    outputMode: OutputMode;
  },
  dependencies: RunRestoreDependencies = DEFAULT_RUN_RESTORE_DEPENDENCIES,
  context: CommandInvocationContext = createCommandInvocationContext()
): Promise<void> {
  const runLogger = getRunLogger();
  const abortController = new AbortController();
  let currentPhase: RestorePhase = "backup_validation";
  let targetMayBeDirty = false;
  let restoreSubprocess: RestoreSubprocessState = "not_started";
  let pruneState: RestorePostMutationState = "not_started";
  let verificationState: RestorePostMutationState = "not_started";
  let preparedSession: PreparedArchiveRestoreSession | undefined;
  const printSummary = input.outputMode !== "quiet";
  const target = appConfig.environments[input.to];
  const removeInterruptHandler = dependencies.installInterruptHandler(() => {
    abortController.abort();
  });

  try {
    runLogger.info("restore", "Restore full workflow started", {
      backup: input.backup,
      to: input.to,
      skipPreBackup: input.skipPreBackup,
      outputMode: input.outputMode
    });
    if (printSummary) {
      dependencies.writeStdout(
        `Starting restore ${input.backup} -> ${input.to}\n`
      );
    }
    await dependencies.ensureBackupArtifacts(
      appConfig.backupRoot,
      input.backup
    );
    const backup = await dependencies.readBackup(
      appConfig.backupRoot,
      input.backup
    );

    const manifestCollections = manifestCollectionsFromBackup(backup);
    const archivePath = dependencies.archivePathForBackup(
      appConfig.backupRoot,
      input.backup
    );
    preparedSession = await dependencies.prepareArchiveRestoreSession(
      target,
      appConfig,
      archivePath,
      {
        sourceDatabaseName: backup.manifest.databaseName,
        outputMode: input.outputMode,
        signal: abortController.signal,
        remotePreflightSession: context.remotePreflightSession
      }
    );
    const inspectedArchiveCollections = filterRestoreCollections(
      preparedSession.inspection.collections
    );
    if (
      inspectedArchiveCollections.length !== manifestCollections.length ||
      inspectedArchiveCollections.some(
        (collection, index) => collection !== manifestCollections[index]
      )
    ) {
      throw new Error(
        `Archive inspection does not match backup manifest. Missing from archive: ${collectionSetDifference(manifestCollections, inspectedArchiveCollections).join(", ") || "none"}. Unexpected in archive: ${collectionSetDifference(inspectedArchiveCollections, manifestCollections).join(", ") || "none"}.`
      );
    }

    if (target.isProduction && !input.skipPreBackup) {
      currentPhase = "pre_restore_backup";
      runLogger.info("restore", "Creating pre-restore backup", {
        backup: input.backup,
        to: input.to
      });
      if (printSummary) {
        dependencies.writeStdout("Creating pre-restore backup...\n");
      }
      await dependencies.backupCreate(
        appConfig,
        {
          from: target.name,
          note: `automatic pre-restore backup before restoring ${input.backup}`,
          tags: ["pre-restore"],
          outputMode: input.outputMode
        },
        undefined,
        context
      );
    }

    currentPhase = "restore";
    runLogger.info("restore", "Restoring target database", {
      backup: input.backup,
      to: input.to
    });
    if (printSummary) {
      dependencies.writeStdout(`Restoring target ${input.to}...\n`);
    }
    const restoreOptions = {
      sourceDatabaseName: backup.manifest.databaseName,
      drop: true,
      outputMode: input.outputMode,
      signal: abortController.signal,
      onMutationState: (state: ArchiveMutationState) => {
        if (state === "in_progress") targetMayBeDirty = true;
      }
    };
    await preparedSession.restore(restoreOptions);
    restoreSubprocess = "succeeded";

    const targetCollections = filterRestoreCollections(
      await dependencies.listCollections(target, {
        outputMode: input.outputMode,
        signal: abortController.signal,
        remotePreflightSession: context.remotePreflightSession
      })
    );
    const targetOnlyCollections = collectionSetDifference(
      targetCollections,
      inspectedArchiveCollections
    );
    if (targetOnlyCollections.length > 0) {
      currentPhase = "prune";
      runLogger.info("restore", "Dropping target-only collections", {
        to: input.to,
        collections: targetOnlyCollections
      });
      await dependencies.dropCollections(target, targetOnlyCollections, {
        outputMode: input.outputMode,
        signal: abortController.signal,
        remotePreflightSession: context.remotePreflightSession
      });
    }
    pruneState = "succeeded";

    currentPhase = "verify";
    runLogger.info("restore", "Verifying restored target", {
      backup: input.backup,
      to: input.to
    });
    if (printSummary) {
      dependencies.writeStdout(`Verifying target ${input.to}...\n`);
    }
    const verification = await dependencies.verifyRestore(
      target,
      backup.manifest,
      {
        outputMode: input.outputMode,
        signal: abortController.signal,
        remotePreflightSession: context.remotePreflightSession
      }
    );
    const unexpectedCollections = collectionSetDifference(
      filterRestoreCollections(verification.collectionsPresent),
      manifestCollections
    );
    if (
      verification.missingCollections.length > 0 ||
      verification.countMismatches.length > 0 ||
      unexpectedCollections.length > 0
    ) {
      throw new Error(
        `${formatRestoreVerificationFailure(backup, input.to, verification)}\n` +
          `Unexpected collections: ${unexpectedCollections.join(", ") || "none"}`
      );
    }
    verificationState = "succeeded";
    currentPhase = "cleanup";
    await preparedSession?.cleanup();
    preparedSession = undefined;
    if (printSummary) {
      dependencies.writeStdout(
        `Restore complete: ${input.backup} -> ${input.to}\n`
      );
    }
    runLogger.info("restore", "Restore full workflow completed", {
      backup: input.backup,
      to: input.to
    });
  } catch (caughtError) {
    let error = caughtError;
    let cleanupFailed = hasRemoteCleanupFailure(caughtError);
    if (preparedSession) {
      try {
        await preparedSession.cleanup();
      } catch (cleanupError) {
        cleanupFailed = true;
        error = combineRemoteTransportErrors(
          error,
          cleanupError,
          cleanupError instanceof RemoteOperationError
            ? (cleanupError.remoteTempPath ?? "unknown")
            : "unknown"
        );
      }
    }
    if (currentPhase === "restore" && !isArchivePreflightError(error)) {
      restoreSubprocess = "failed";
      targetMayBeDirty = true;
    }
    if (currentPhase === "prune") pruneState = "failed";
    if (currentPhase === "verify") verificationState = "failed";
    runLogger.error("restore", "Restore full workflow failed", {
      backup: input.backup,
      to: input.to,
      phase: currentPhase,
      interrupted: isInterruptedError(error),
      scope: "full",
      restoreSubprocess,
      prune: pruneState,
      verification: verificationState,
      targetTrustState: targetTrustState({
        restoreSubprocess,
        prune: pruneState,
        verification: verificationState
      }),
      error: getErrorDetails(error)
    });
    throw new Error(
      formatRestoreFailure({
        backup: input.backup,
        to: input.to,
        phase: currentPhase,
        targetMayBeDirty,
        interrupted: isInterruptedError(error),
        cleanupLine: cleanupLineForFailure(target, cleanupFailed),
        remoteTempPath: getRemoteTempPath(error),
        details: getErrorDetails(error),
        restoreSubprocess,
        prune: pruneState,
        verification: verificationState
      }),
      { cause: caughtError }
    );
  } finally {
    runLogger.debug("restore", "Removing restore interrupt handler", {
      backup: input.backup,
      to: input.to
    });
    removeInterruptHandler();
  }
}

export async function runRestoreCollection(
  appConfig: AppConfig,
  input: {
    backup: string;
    collection: string;
    to: EnvironmentId;
    outputMode: OutputMode;
  },
  dependencies: RunRestoreDependencies = DEFAULT_RUN_RESTORE_DEPENDENCIES,
  context: CommandInvocationContext = createCommandInvocationContext()
): Promise<void> {
  const runLogger = getRunLogger();
  const abortController = new AbortController();
  let currentPhase: RestorePhase = "backup_validation";
  let targetMayBeDirty = false;
  let restoreSubprocess: RestoreSubprocessState = "not_started";
  const pruneState: RestorePostMutationState = "not_started";
  let verificationState: RestorePostMutationState = "not_started";
  const printSummary = input.outputMode !== "quiet";
  const target = appConfig.environments[input.to];
  const removeInterruptHandler = dependencies.installInterruptHandler(() => {
    abortController.abort();
  });

  try {
    runLogger.info("restore", "Restore collection workflow started", {
      backup: input.backup,
      collection: input.collection,
      to: input.to,
      outputMode: input.outputMode
    });
    if (printSummary) {
      dependencies.writeStdout(
        `Starting restore ${input.backup}:${input.collection} -> ${input.to}\n`
      );
    }
    await dependencies.ensureBackupArtifacts(
      appConfig.backupRoot,
      input.backup
    );
    const backup = await dependencies.readBackup(
      appConfig.backupRoot,
      input.backup
    );
    if (!backup.manifest.collectionList.includes(input.collection)) {
      throw new Error(
        `Collection ${input.collection} not present in backup ${input.backup}`
      );
    }
    const expectedCount = backup.manifest.collectionCounts?.[input.collection];
    if (
      expectedCount === undefined ||
      !Number.isInteger(expectedCount) ||
      expectedCount < 0
    ) {
      throw new Error(
        `Collection ${input.collection} has no valid manifest count in backup ${input.backup}`
      );
    }

    currentPhase = "restore";
    runLogger.info("restore", "Restoring collection into target", {
      backup: input.backup,
      collection: input.collection,
      to: input.to
    });
    if (printSummary) {
      dependencies.writeStdout(
        `Restoring collection ${input.collection} into ${input.to}...\n`
      );
    }
    await dependencies.restoreArchiveToEnvironment(
      target,
      appConfig,
      dependencies.archivePathForBackup(appConfig.backupRoot, input.backup),
      {
        sourceDatabaseName: backup.manifest.databaseName,
        collection: input.collection,
        drop: true,
        outputMode: input.outputMode,
        signal: abortController.signal,
        onMutationState: (state: ArchiveMutationState) => {
          if (state === "in_progress") targetMayBeDirty = true;
          if (state === "subprocess_succeeded") {
            restoreSubprocess = "succeeded";
          }
        },
        remotePreflightSession: context.remotePreflightSession
      }
    );
    restoreSubprocess = "succeeded";
    currentPhase = "verify";
    if (printSummary) {
      dependencies.writeStdout(
        `Verifying collection ${input.collection} in ${input.to}...\n`
      );
    }
    const verification = await dependencies.verifyRestore(
      target,
      {
        ...backup.manifest,
        collectionList: [input.collection],
        collectionCounts: { [input.collection]: expectedCount }
      },
      {
        outputMode: input.outputMode,
        signal: abortController.signal,
        remotePreflightSession: context.remotePreflightSession
      }
    );
    if (
      verification.missingCollections.length > 0 ||
      verification.countMismatches.length > 0
    ) {
      throw new Error(
        `Collection restore verification failed for ${backup.name}:${input.collection} -> ${input.to}\n` +
          `Missing collections: ${verification.missingCollections.join(", ") || "none"}\n` +
          `Count mismatches: ${
            verification.countMismatches
              .map(
                (item) =>
                  `${item.collection} expected=${item.expected} actual=${item.actual}`
              )
              .join(", ") || "none"
          }`
      );
    }
    verificationState = "succeeded";
    if (printSummary) {
      dependencies.writeStdout(
        `Restore complete: ${input.backup}:${input.collection} -> ${input.to}\n`
      );
    }
    runLogger.info("restore", "Restore collection workflow completed", {
      backup: input.backup,
      collection: input.collection,
      to: input.to
    });
  } catch (error) {
    if (
      currentPhase === "restore" &&
      restoreSubprocess === "succeeded" &&
      hasRemoteCleanupFailure(error)
    ) {
      currentPhase = "cleanup";
    }
    if (
      currentPhase === "restore" &&
      restoreSubprocess !== "succeeded" &&
      !isArchivePreflightError(error)
    ) {
      restoreSubprocess = "failed";
      targetMayBeDirty = true;
    }
    if (currentPhase === "verify") verificationState = "failed";
    runLogger.error("restore", "Restore collection workflow failed", {
      backup: input.backup,
      collection: input.collection,
      to: input.to,
      phase: currentPhase,
      interrupted: isInterruptedError(error),
      scope: "collection",
      restoreSubprocess,
      prune: pruneState,
      verification: verificationState,
      targetTrustState: targetTrustState({
        restoreSubprocess,
        prune: pruneState,
        verification: verificationState
      }),
      error: getErrorDetails(error)
    });
    throw new Error(
      formatRestoreFailure({
        backup: input.backup,
        to: input.to,
        phase: currentPhase,
        targetMayBeDirty,
        interrupted: isInterruptedError(error),
        cleanupLine: cleanupLineForFailure(
          target,
          hasRemoteCleanupFailure(error)
        ),
        remoteTempPath: getRemoteTempPath(error),
        details: getErrorDetails(error),
        restoreSubprocess,
        prune: pruneState,
        verification: verificationState
      }),
      { cause: error }
    );
  } finally {
    runLogger.debug("restore", "Removing restore interrupt handler", {
      backup: input.backup,
      collection: input.collection,
      to: input.to
    });
    removeInterruptHandler();
  }
}
