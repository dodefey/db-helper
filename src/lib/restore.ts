import { AppConfig, BackupRecord, EnvironmentId } from "../config/types.js";
import {
  archivePathForBackup,
  ensureBackupArtifacts,
  readBackup
} from "./backups.js";
import { restoreArchiveToEnvironment } from "./mongo.js";
import { verifyRestore } from "./verify.js";
import { backupCreate } from "../commands/backup.js";

export interface RunRestoreDependencies {
  ensureBackupArtifacts: typeof ensureBackupArtifacts;
  readBackup: typeof readBackup;
  archivePathForBackup: typeof archivePathForBackup;
  backupCreate: typeof backupCreate;
  restoreArchiveToEnvironment: typeof restoreArchiveToEnvironment;
  verifyRestore: typeof verifyRestore;
}

const DEFAULT_RUN_RESTORE_DEPENDENCIES: RunRestoreDependencies = {
  ensureBackupArtifacts,
  readBackup,
  archivePathForBackup,
  backupCreate,
  restoreArchiveToEnvironment,
  verifyRestore
};

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
  },
  dependencies: RunRestoreDependencies = DEFAULT_RUN_RESTORE_DEPENDENCIES
): Promise<void> {
  await dependencies.ensureBackupArtifacts(appConfig.backupRoot, input.backup);
  const backup = await dependencies.readBackup(appConfig.backupRoot, input.backup);
  const target = appConfig.environments[input.to];

  if (target.isProduction && !input.skipPreBackup) {
    await dependencies.backupCreate(appConfig, {
      from: "production",
      note: `automatic pre-restore backup before restoring ${input.backup}`,
      tags: ["pre-restore"],
      outputMode: "default"
    });
  }

  await dependencies.restoreArchiveToEnvironment(
    target,
    appConfig,
    dependencies.archivePathForBackup(appConfig.backupRoot, input.backup),
    {
      drop: appConfig.defaultDropOnRestore
    }
  );

  const verification = await dependencies.verifyRestore(target, backup.manifest);
  if (
    verification.missingCollections.length > 0 ||
    verification.countMismatches.length > 0
  ) {
    throw new Error(
      formatRestoreVerificationFailure(backup, input.to, verification)
    );
  }
}

export async function runRestoreCollection(
  appConfig: AppConfig,
  input: {
    backup: string;
    collection: string;
    to: EnvironmentId;
  },
  dependencies: RunRestoreDependencies = DEFAULT_RUN_RESTORE_DEPENDENCIES
): Promise<void> {
  await dependencies.ensureBackupArtifacts(appConfig.backupRoot, input.backup);
  const backup = await dependencies.readBackup(appConfig.backupRoot, input.backup);
  if (!backup.manifest.collectionList.includes(input.collection)) {
    throw new Error(
      `Collection ${input.collection} not present in backup ${input.backup}`
    );
  }

  await dependencies.restoreArchiveToEnvironment(
    appConfig.environments[input.to],
    appConfig,
    dependencies.archivePathForBackup(appConfig.backupRoot, input.backup),
    { collection: input.collection, drop: true }
  );
}
