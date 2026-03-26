import path from "node:path";
import { AppConfig, BackupManifest, BackupRecord, EnvironmentId } from "../config/types.js";
import {
  archivePathForBackup,
  buildBackupName,
  ensureBackupArtifacts,
  removeBackupArtifacts,
  readBackup,
  writeBackupManifest
} from "./backups.js";
import { ensureDirectory } from "./fs.js";
import {
  createArchiveBackup,
  getCollectionCounts,
  listCollections
} from "./mongo.js";
import { TOOL_VERSION } from "../version.js";

export interface RunBackupCreateDependencies {
  installInterruptHandler: (onInterrupt: () => void) => () => void;
  ensureDirectory: typeof ensureDirectory;
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
  ensureDirectory,
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

function isInterruptedError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("Command interrupted:");
}

function getErrorDetails(error: unknown): string {
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
    note?: string;
    tags?: string[];
    backupName?: string;
  },
  dependencies: RunBackupCreateDependencies = DEFAULT_RUN_BACKUP_CREATE_DEPENDENCIES
): Promise<BackupRecord> {
  const env = appConfig.environments[input.from];
  const backupName = input.backupName ?? dependencies.buildBackupName(env);
  const archiveFile = dependencies.archivePathForBackup(
    appConfig.backupRoot,
    backupName
  );
  const abortController = new AbortController();
  let interrupted = false;
  const removeInterruptHandler = dependencies.installInterruptHandler(() => {
    interrupted = true;
    abortController.abort();
  });
  let currentPhase: BackupCreatePhase = "metadata";
  let cleanupFailed = false;

  try {
    await dependencies.ensureDirectory(appConfig.backupRoot);
    await dependencies.ensureDirectory(path.dirname(archiveFile));

    const collectionList = filterBackupCollections(
      await dependencies.listCollections(env, { signal: abortController.signal })
    );
    const collectionCounts = await dependencies.getCollectionCounts(
      env,
      collectionList,
      { signal: abortController.signal }
    );

    currentPhase = "archive";
    await dependencies.createArchiveBackup(env, appConfig, archiveFile, {
      signal: abortController.signal
    });

    const manifest: BackupManifest = {
      backupName,
      sourceEnvironment: env.id,
      databaseName: env.databaseName,
      createdAt: new Date().toISOString(),
      note: input.note,
      tags: input.tags ?? [],
      collectionList,
      toolVersion: TOOL_VERSION,
      archiveFile: "dump.archive.gz",
      collectionCounts
    };

    currentPhase = "manifest";
    await dependencies.writeBackupManifest(appConfig.backupRoot, manifest);

    currentPhase = "validation";
    await dependencies.ensureBackupArtifacts(appConfig.backupRoot, backupName);

    return dependencies.readBackup(appConfig.backupRoot, backupName);
  } catch (error) {
    const interruptedFailure = interrupted || isInterruptedError(error);

    try {
      await dependencies.removeBackupArtifacts(appConfig.backupRoot, backupName);
    } catch {
      cleanupFailed = true;
    }

    throw new Error(
      formatBackupCreateFailure({
        from: input.from,
        phase: currentPhase,
        interrupted: interruptedFailure,
        cleanupAttempted: true,
        cleanupFailed,
        details: getErrorDetails(error)
      }),
      { cause: error }
    );
  } finally {
    removeInterruptHandler();
  }
}
