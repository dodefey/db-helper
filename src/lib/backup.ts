import path from "node:path";
import { AppConfig, BackupManifest, BackupRecord, EnvironmentId } from "../config/types.js";
import {
  archivePathForBackup,
  buildBackupName,
  ensureBackupArtifacts,
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
  ensureDirectory: typeof ensureDirectory;
  buildBackupName: typeof buildBackupName;
  archivePathForBackup: typeof archivePathForBackup;
  listCollections: typeof listCollections;
  getCollectionCounts: typeof getCollectionCounts;
  createArchiveBackup: typeof createArchiveBackup;
  writeBackupManifest: typeof writeBackupManifest;
  ensureBackupArtifacts: typeof ensureBackupArtifacts;
  readBackup: typeof readBackup;
}

const DEFAULT_RUN_BACKUP_CREATE_DEPENDENCIES: RunBackupCreateDependencies = {
  ensureDirectory,
  buildBackupName,
  archivePathForBackup,
  listCollections,
  getCollectionCounts,
  createArchiveBackup,
  writeBackupManifest,
  ensureBackupArtifacts,
  readBackup
};

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
  await dependencies.ensureDirectory(appConfig.backupRoot);
  await dependencies.ensureDirectory(path.dirname(archiveFile));

  const collectionList = filterBackupCollections(
    await dependencies.listCollections(env)
  );
  const collectionCounts = await dependencies.getCollectionCounts(
    env,
    collectionList
  );
  await dependencies.createArchiveBackup(env, appConfig, archiveFile);

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

  await dependencies.writeBackupManifest(appConfig.backupRoot, manifest);
  await dependencies.ensureBackupArtifacts(appConfig.backupRoot, backupName);

  return dependencies.readBackup(appConfig.backupRoot, backupName);
}
