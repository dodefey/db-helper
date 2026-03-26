import path from "node:path";
import { AppConfig, BackupRecord, EnvironmentId } from "../config/types.js";
import {
  archivePathForBackup,
  buildBackupName,
  ensureBackupArtifacts,
  listBackups,
  readBackup,
  writeBackupManifest
} from "../lib/backups.js";
import { ensureDirectory } from "../lib/fs.js";
import {
  createArchiveBackup,
  getCollectionCounts,
  listCollections
} from "../lib/mongo.js";
import { TOOL_VERSION } from "../version.js";

export async function backupCreate(
  appConfig: AppConfig,
  input: {
    from: EnvironmentId;
    note?: string;
    tags?: string[];
    backupName?: string;
  }
): Promise<BackupRecord> {
  const env = appConfig.environments[input.from];
  const backupName = input.backupName ?? buildBackupName(env);
  const archiveFile = archivePathForBackup(appConfig.backupRoot, backupName);

  await ensureDirectory(appConfig.backupRoot);
  await ensureDirectory(path.dirname(archiveFile));

  const collectionList = await listCollections(env);
  const collectionCounts = await getCollectionCounts(env, collectionList);
  await createArchiveBackup(env, appConfig, archiveFile);

  const manifest = {
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

  await writeBackupManifest(appConfig.backupRoot, manifest);
  await ensureBackupArtifacts(appConfig.backupRoot, backupName);

  return readBackup(appConfig.backupRoot, backupName);
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
