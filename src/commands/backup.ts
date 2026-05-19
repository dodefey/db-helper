import { AppConfig, BackupRecord, EnvironmentId } from "../config/types.js";
import {
  ensureBackupArtifacts,
  listBackups,
  readBackup
} from "../lib/backups.js";
import { runBackupCreate } from "../lib/backup.js";
import {
  CommandInvocationContext,
  createCommandInvocationContext
} from "../lib/invocationContext.js";
import { OutputMode } from "../lib/output.js";
import { getRunLogger } from "../lib/runLog.js";

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
  dependencies: BackupCommandDependencies = DEFAULT_BACKUP_COMMAND_DEPENDENCIES,
  context: CommandInvocationContext = createCommandInvocationContext()
): Promise<BackupRecord> {
  getRunLogger().info("backup.command", "Starting backup create", {
    from: input.from,
    outputMode: input.outputMode,
    tagCount: input.tags?.length ?? 0,
    hasNote: Boolean(input.note)
  });
  return dependencies.runBackupCreate(appConfig, input, undefined, context);
}

export async function backupList(
  appConfig: AppConfig,
  filters: { from?: EnvironmentId; tag?: string },
  dependencies: BackupCommandDependencies = DEFAULT_BACKUP_COMMAND_DEPENDENCIES
): Promise<BackupRecord[]> {
  getRunLogger().info("backup.command", "Listing backups", filters);
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
  getRunLogger().info("backup.command", "Inspecting backup", { backupName });
  await dependencies.ensureBackupArtifacts(appConfig.backupRoot, backupName);
  return dependencies.readBackup(appConfig.backupRoot, backupName);
}
