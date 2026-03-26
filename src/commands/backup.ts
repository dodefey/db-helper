import { AppConfig, BackupRecord, EnvironmentId } from "../config/types.js";
import {
  ensureBackupArtifacts,
  listBackups,
  readBackup
} from "../lib/backups.js";
import { runBackupCreate } from "../lib/backup.js";

export async function backupCreate(
  appConfig: AppConfig,
  input: {
    from: EnvironmentId;
    note?: string;
    tags?: string[];
    backupName?: string;
  }
): Promise<BackupRecord> {
  return runBackupCreate(appConfig, input);
}

export async function backupList(
  appConfig: AppConfig,
  filters: { from?: EnvironmentId; tag?: string }
): Promise<BackupRecord[]> {
  let backups = await listBackups(appConfig.backupRoot);
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
  backupName: string
): Promise<BackupRecord> {
  await ensureBackupArtifacts(appConfig.backupRoot, backupName);
  return readBackup(appConfig.backupRoot, backupName);
}
