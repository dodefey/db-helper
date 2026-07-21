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
  dropCollections,
  inspectArchiveCollections,
  listCollections,
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
  inspectArchiveCollections?: typeof inspectArchiveCollections;
  listCollections?: typeof listCollections;
  dropCollections?: typeof dropCollections;
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
  inspectArchiveCollections,
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
  | "verify";

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
            : "verify";

  const statusLine = options.interrupted
    ? `Restore interrupted during ${phaseLabel} for ${options.backup} -> ${options.to}.`
    : `Restore failed during ${phaseLabel} for ${options.backup} -> ${options.to}.`;

  const targetLine = options.targetMayBeDirty
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

  return lines.join("\n");
}

function cleanupLineForFailure(
  phase: RestorePhase,
  target: EnvironmentConfig
): string | undefined {
  if (target.kind !== "remote") {
    return undefined;
  }

  if (phase === "restore") {
    return "Temporary restore artifact cleanup was attempted but may not have completed.";
  }

  if (phase === "prune" || phase === "verify") {
    return "Temporary restore artifact cleanup was already attempted before verification began.";
  }

  return undefined;
}

function getRemoteTempPath(error: unknown): string | undefined {
  return error instanceof RemoteOperationError
    ? error.remoteTempPath
    : undefined;
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
    const inspectedArchiveCollections = dependencies.inspectArchiveCollections
      ? filterRestoreCollections(
          await dependencies.inspectArchiveCollections(
            target,
            appConfig,
            dependencies.archivePathForBackup(
              appConfig.backupRoot,
              input.backup
            ),
            {
              sourceDatabaseName: backup.manifest.databaseName,
              outputMode: input.outputMode,
              signal: abortController.signal,
              remotePreflightSession: context.remotePreflightSession
            }
          )
        )
      : manifestCollections;
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
    targetMayBeDirty = true;
    runLogger.info("restore", "Restoring target database", {
      backup: input.backup,
      to: input.to
    });
    if (printSummary) {
      dependencies.writeStdout(`Restoring target ${input.to}...\n`);
    }
    await dependencies.restoreArchiveToEnvironment(
      target,
      appConfig,
      dependencies.archivePathForBackup(appConfig.backupRoot, input.backup),
      {
        sourceDatabaseName: backup.manifest.databaseName,
        drop: true,
        outputMode: input.outputMode,
        signal: abortController.signal,
        remotePreflightSession: context.remotePreflightSession
      }
    );

    const targetCollections = dependencies.listCollections
      ? filterRestoreCollections(
          await dependencies.listCollections(target, {
            outputMode: input.outputMode,
            signal: abortController.signal,
            remotePreflightSession: context.remotePreflightSession
          })
        )
      : [];
    const targetOnlyCollections = collectionSetDifference(
      targetCollections,
      inspectedArchiveCollections
    );
    if (dependencies.dropCollections && targetOnlyCollections.length > 0) {
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
    if (printSummary) {
      dependencies.writeStdout(
        `Restore complete: ${input.backup} -> ${input.to}\n`
      );
    }
    runLogger.info("restore", "Restore full workflow completed", {
      backup: input.backup,
      to: input.to
    });
  } catch (error) {
    runLogger.error("restore", "Restore full workflow failed", {
      backup: input.backup,
      to: input.to,
      phase: currentPhase,
      interrupted: isInterruptedError(error),
      error: getErrorDetails(error)
    });
    throw new Error(
      formatRestoreFailure({
        backup: input.backup,
        to: input.to,
        phase: currentPhase,
        targetMayBeDirty,
        interrupted: isInterruptedError(error),
        cleanupLine: cleanupLineForFailure(currentPhase, target),
        remoteTempPath: getRemoteTempPath(error),
        details: getErrorDetails(error)
      }),
      { cause: error }
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

    currentPhase = "restore";
    targetMayBeDirty = true;
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
        remotePreflightSession: context.remotePreflightSession
      }
    );
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
    runLogger.error("restore", "Restore collection workflow failed", {
      backup: input.backup,
      collection: input.collection,
      to: input.to,
      phase: currentPhase,
      interrupted: isInterruptedError(error),
      error: getErrorDetails(error)
    });
    throw new Error(
      formatRestoreFailure({
        backup: input.backup,
        to: input.to,
        phase: currentPhase,
        targetMayBeDirty,
        interrupted: isInterruptedError(error),
        cleanupLine: cleanupLineForFailure(currentPhase, target),
        remoteTempPath: getRemoteTempPath(error),
        details: getErrorDetails(error)
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
