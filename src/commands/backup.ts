import { AppConfig, BackupRecord, EnvironmentId } from "../config/types.js";
import {
  ensureBackupArtifacts,
  listBackups,
  readBackup
} from "../lib/backups.js";
import { runBackupCreate } from "../lib/backup.js";
import { OutputMode } from "../lib/output.js";

export interface BackupCommandDependencies {
  runBackupCreate: typeof runBackupCreate;
  listBackups: typeof listBackups;
  ensureBackupArtifacts: typeof ensureBackupArtifacts;
  readBackup: typeof readBackup;
}

const DEFAULT_BACKUP_COMMAND_DEPENDENCIES: BackupCommandDependencies = {
  runBackupCreate,
  listBackups,
  ensureBackupArtifacts,
  readBackup
};

export async function backupCreate(
  appConfig: AppConfig,
  input: {
    from: EnvironmentId;
    note?: string;
    tags?: string[];
    backupName?: string;
    outputMode: OutputMode;
  },
  dependencies: BackupCommandDependencies = DEFAULT_BACKUP_COMMAND_DEPENDENCIES
): Promise<BackupRecord> {
  return dependencies.runBackupCreate(appConfig, input);
}

export async function backupList(
  appConfig: AppConfig,
  filters: { from?: EnvironmentId; tag?: string },
  dependencies: BackupCommandDependencies = DEFAULT_BACKUP_COMMAND_DEPENDENCIES
): Promise<BackupRecord[]> {
  let backups = await dependencies.listBackups(appConfig.backupRoot);
  if (filters.from) {
    backups = backups.filter(
      (backup) => backup.manifest.sourceEnvironment === filters.from
    );
  }
  const tag = filters.tag;
  if (tag) {
    backups = backups.filter((backup) => backup.manifest.tags.includes(tag));
  }

  return backups;
}

export async function backupInspect(
  appConfig: AppConfig,
  backupName: string,
  dependencies: BackupCommandDependencies = DEFAULT_BACKUP_COMMAND_DEPENDENCIES
): Promise<BackupRecord> {
  await dependencies.ensureBackupArtifacts(appConfig.backupRoot, backupName);
  return dependencies.readBackup(appConfig.backupRoot, backupName);
}
