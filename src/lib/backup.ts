import {
  AppConfig,
  BackupManifest,
  BackupRecord,
  EnvironmentId
} from "../config/types.js";
import {
  archivePathForBackup,
  COLLECTION_ARCHIVE,
  FULL_ARCHIVE,
  buildBackupName,
  ensureBackupArtifacts,
  validateBackupName,
  removeBackupArtifacts,
  readBackup,
  writeBackupManifest
} from "./backups.js";
import { ensureDirectory } from "./fs.js";
import { beginBackupCreation } from "./backupActivity.js";
import {
  createArchiveBackup,
  getCollectionCounts,
  listCollections,
  RemoteOperationError
} from "./mongo.js";
import {
  CommandInvocationContext,
  createCommandInvocationContext
} from "./invocationContext.js";
import { OutputMode } from "./output.js";
import { getRunLogger } from "./runLog.js";
import {
  requireCollections,
  validateCollectionSelection
} from "./collections.js";
import { TOOL_VERSION } from "../version.js";

export interface RunBackupCreateDependencies {
  installInterruptHandler: (onInterrupt: () => void) => () => void;
  writeStdout: (message: string) => void;
  isInteractiveStdout: () => boolean;
  runWithElapsedStatus: <T>(
    baseMessage: string,
    task: () => Promise<T>
  ) => Promise<T>;
  ensureDirectory: typeof ensureDirectory;
  beginBackupCreation: typeof beginBackupCreation;
  buildBackupName: typeof buildBackupName;
  archivePathForBackup: typeof archivePathForBackup;
  listCollections: typeof listCollections;
  getCollectionCounts: typeof getCollectionCounts;
  createArchiveBackup: typeof createArchiveBackup;
  writeBackupManifest: typeof writeBackupManifest;
  ensureBackupArtifacts: typeof ensureBackupArtifacts;
  removeBackupArtifacts: typeof removeBackupArtifacts;
  readBackup: typeof readBackup;
}

const DEFAULT_RUN_BACKUP_CREATE_DEPENDENCIES: RunBackupCreateDependencies = {
  installInterruptHandler: (onInterrupt) => {
    process.on("SIGINT", onInterrupt);
    return () => process.removeListener("SIGINT", onInterrupt);
  },
  writeStdout: (message: string) => process.stdout.write(message),
  isInteractiveStdout: () => Boolean(process.stdout.isTTY),
  runWithElapsedStatus: (baseMessage, task) =>
    runWithElapsedStatus(
      (message) => process.stdout.write(message),
      () => Boolean(process.stdout.isTTY),
      baseMessage,
      task
    ),
  ensureDirectory,
  beginBackupCreation,
  buildBackupName,
  archivePathForBackup,
  listCollections,
  getCollectionCounts,
  createArchiveBackup,
  writeBackupManifest,
  ensureBackupArtifacts,
  removeBackupArtifacts,
  readBackup
};

type BackupCreatePhase = "metadata" | "archive" | "manifest" | "validation";

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
    writeStdout(`${baseMessage}\n`);
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
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function formatBackupCreateFailure(input: {
  from: EnvironmentId;
  phase: BackupCreatePhase;
  interrupted: boolean;
  cleanupAttempted: boolean;
  cleanupFailed: boolean;
  details: string;
}): string {
  const phaseLabel =
    input.phase === "archive" ? "archive creation" : input.phase;
  const actionLabel = input.interrupted ? "interrupted" : "failed";
  const validityStatus =
    input.phase === "metadata"
      ? "No valid backup was created."
      : "The backup may be incomplete or invalid and must not be trusted.";

  let cleanupStatus = "";
  if (input.cleanupAttempted) {
    cleanupStatus = input.cleanupFailed
      ? "Cleanup of incomplete backup artifacts was attempted but may not have completed."
      : "Cleanup of incomplete backup artifacts was attempted.";
  }

  const details = input.interrupted
    ? "The backup was interrupted by the operator."
    : input.details;

  return [
    `Backup ${actionLabel} during ${phaseLabel} for ${input.from}.`,
    validityStatus,
    cleanupStatus,
    details
  ]
    .filter(Boolean)
    .join("\n");
}

function filterBackupCollections(collections: string[]): string[] {
  return collections.filter((name) => !name.startsWith("system."));
}

export async function runBackupCreate(
  appConfig: AppConfig,
  input: {
    from: EnvironmentId;
    collections?: readonly string[];
    note?: string;
    tags?: string[];
    backupName?: string;
    outputMode: OutputMode;
  },
  dependencies: RunBackupCreateDependencies = DEFAULT_RUN_BACKUP_CREATE_DEPENDENCIES,
  context: CommandInvocationContext = createCommandInvocationContext()
): Promise<BackupRecord> {
  const runLogger = getRunLogger();
  if (input.backupName) {
    validateBackupName(input.backupName);
  }
  const env = appConfig.environments[input.from];
  const backupName = input.backupName ?? dependencies.buildBackupName(env);
  if (input.collections) validateCollectionSelection(input.collections);
  const archiveName = input.collections ? COLLECTION_ARCHIVE : FULL_ARCHIVE;
  const archiveFile = dependencies.archivePathForBackup(
    appConfig.backupRoot,
    backupName,
    archiveName
  );
  const abortController = new AbortController();
  let interrupted = false;
  const removeInterruptHandler = dependencies.installInterruptHandler(() => {
    interrupted = true;
    abortController.abort();
  });
  const printSummary = input.outputMode !== "quiet";
  const useElapsedStatus = input.outputMode === "default";
  let currentPhase: BackupCreatePhase = "metadata";
  let cleanupFailed = false;
  let releaseActivity: (() => Promise<void>) | undefined;

  try {
    runLogger.info("backup", "Backup workflow started", {
      from: input.from,
      backupName,
      collections: input.collections,
      outputMode: input.outputMode
    });
    if (printSummary) {
      const scope = input.collections
        ? ` [${input.collections.join(", ")}]`
        : "";
      dependencies.writeStdout(`Starting backup from ${input.from}${scope}\n`);
    }
    await dependencies.ensureDirectory(appConfig.backupRoot);
    releaseActivity = await dependencies.beginBackupCreation(
      appConfig.backupRoot,
      backupName,
      input.from,
      input.tags ?? []
    );

    const metadataOutputMode =
      input.outputMode === "verbose" ? "default" : input.outputMode;

    const metadataOptions = {
      outputMode: metadataOutputMode,
      signal: abortController.signal,
      remotePreflightSession: context.remotePreflightSession
    };
    const collectMetadata = async () => {
      const sourceCollections = await dependencies.listCollections(env, {
        ...metadataOptions,
        rejectViewsIn: input.collections
      });
      if (input.collections) {
        requireCollections(
          input.collections,
          sourceCollections,
          `not found in source ${input.from}.`
        );
      }
      const collectionList = input.collections
        ? [...input.collections]
        : filterBackupCollections(sourceCollections);
      const collectionCounts = await dependencies.getCollectionCounts(
        env,
        collectionList,
        metadataOptions
      );
      return { sourceCollections, collectionList, collectionCounts };
    };
    if (printSummary && !useElapsedStatus) {
      dependencies.writeStdout("Collecting source metadata...\n");
    }
    const { sourceCollections, collectionList, collectionCounts } =
      useElapsedStatus
        ? await dependencies.runWithElapsedStatus(
            "Collecting source metadata...",
            collectMetadata
          )
        : await collectMetadata();
    runLogger.debug("backup", "Collected backup metadata", {
      backupName,
      collectionCount: collectionList.length
    });

    currentPhase = "archive";
    runLogger.info("backup", "Creating backup archive", { backupName });
    const dumpOptions = {
      outputMode: input.outputMode,
      signal: abortController.signal,
      remotePreflightSession: context.remotePreflightSession,
      ...(input.collections
        ? { selection: { collections: input.collections, sourceCollections } }
        : {})
    };
    if (useElapsedStatus) {
      await dependencies.runWithElapsedStatus("Creating archive...", () =>
        dependencies.createArchiveBackup(
          env,
          appConfig,
          archiveFile,
          dumpOptions
        )
      );
    } else {
      if (printSummary) {
        dependencies.writeStdout("Creating archive...\n");
      }
      await dependencies.createArchiveBackup(
        env,
        appConfig,
        archiveFile,
        dumpOptions
      );
    }

    const manifest: BackupManifest = {
      backupName,
      sourceEnvironment: env.id,
      databaseName: env.databaseName,
      createdAt: new Date().toISOString(),
      note: input.note,
      tags: input.tags ?? [],
      collectionList,
      toolVersion: TOOL_VERSION,
      archiveFile: archiveName,
      collectionCounts
    };

    currentPhase = "manifest";
    runLogger.info("backup", "Writing backup manifest", { backupName });
    if (printSummary) {
      dependencies.writeStdout(`Writing manifest...\n`);
    }
    await dependencies.writeBackupManifest(appConfig.backupRoot, manifest);

    currentPhase = "validation";
    runLogger.info("backup", "Validating backup artifacts", { backupName });
    if (printSummary) {
      dependencies.writeStdout(`Validating backup...\n`);
    }
    await dependencies.ensureBackupArtifacts(appConfig.backupRoot, backupName);

    const record = await dependencies.readBackup(
      appConfig.backupRoot,
      backupName
    );
    if (printSummary) {
      dependencies.writeStdout(`Backup complete: ${record.name}\n`);
      dependencies.writeStdout(`Path: ${record.path}\n`);
    }
    runLogger.info("backup", "Backup workflow completed", {
      backupName: record.name,
      path: record.path
    });
    return record;
  } catch (error) {
    const interruptedFailure = interrupted || isInterruptedError(error);
    runLogger.error("backup", "Backup workflow failed", {
      from: input.from,
      backupName,
      phase: currentPhase,
      interrupted: interruptedFailure,
      error: getErrorDetails(error)
    });

    try {
      if (releaseActivity)
        await dependencies.removeBackupArtifacts(
          appConfig.backupRoot,
          backupName
        );
    } catch {
      cleanupFailed = true;
    }

    throw new Error(
      formatBackupCreateFailure({
        from: input.from,
        phase: currentPhase,
        interrupted: interruptedFailure,
        cleanupAttempted: Boolean(releaseActivity),
        cleanupFailed,
        details: getErrorDetails(error)
      }),
      { cause: error }
    );
  } finally {
    try {
      await releaseActivity?.();
    } catch (error) {
      runLogger.warn("backup", "Could not remove backup activity marker", {
        backupName,
        error: getErrorDetails(error)
      });
    }
    runLogger.debug("backup", "Removing backup interrupt handler", {
      backupName
    });
    removeInterruptHandler();
  }
}
