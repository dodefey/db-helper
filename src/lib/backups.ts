import path from "node:path";
import { readFile, rm, stat } from "node:fs/promises";
import {
  BackupManifest,
  BackupRecord,
  EnvironmentConfig
} from "../config/types.js";
import {
  ensureDirectory,
  exists,
  listDirectories,
  readJsonFile,
  writeJsonFile
} from "./fs.js";

const BACKUP_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
export const FULL_ARCHIVE = "dump.archive.gz";
export const COLLECTION_ARCHIVE = "collections.archive.gz";

export function requireFullBackup(backup: BackupRecord): void {
  if (backup.manifest.archiveFile === COLLECTION_ARCHIVE) {
    throw new Error(
      `Backup ${backup.name} contains selected collections. Use dbh restore collection with --collections=name1,name2 or repeat --collection <name>.`
    );
  }
}

export function buildBackupName(env: EnvironmentConfig): string {
  return `${new Date()
    .toISOString()
    .replace(/:/g, "-")
    .replace(/\.\d{3}Z$/, "")}-${env.id}`;
}

export function validateBackupName(backupName: string): void {
  if (!backupName) {
    throw new Error("Backup name must not be empty");
  }
  if (
    backupName === "." ||
    backupName === ".." ||
    backupName.includes("..") ||
    backupName.includes(path.sep) ||
    backupName.includes(path.posix.sep) ||
    backupName.includes(path.win32.sep) ||
    path.isAbsolute(backupName) ||
    !BACKUP_NAME_PATTERN.test(backupName)
  ) {
    throw new Error(
      "Invalid backup name. Use only letters, numbers, dots, underscores, and hyphens, with no path separators or '..'."
    );
  }
}

function resolveBackupPath(backupRoot: string, backupName: string): string {
  validateBackupName(backupName);
  const resolvedRoot = path.resolve(backupRoot);
  const resolvedPath = path.resolve(resolvedRoot, backupName);
  const relative = path.relative(resolvedRoot, resolvedPath);
  if (
    relative === "" ||
    relative === "." ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      `Backup path escaped backup root for name ${JSON.stringify(backupName)}`
    );
  }

  return resolvedPath;
}

export function backupPath(backupRoot: string, backupName: string): string {
  return resolveBackupPath(backupRoot, backupName);
}

export function archivePathForBackup(
  backupRoot: string,
  backupName: string,
  archiveFile = FULL_ARCHIVE
): string {
  if (archiveFile !== FULL_ARCHIVE && archiveFile !== COLLECTION_ARCHIVE) {
    throw new Error(
      `Backup ${backupName} has an unsupported archive filename.`
    );
  }
  return path.join(backupPath(backupRoot, backupName), archiveFile);
}

export function manifestPathForBackup(
  backupRoot: string,
  backupName: string
): string {
  return path.join(backupPath(backupRoot, backupName), "manifest.json");
}

export async function removeBackupArtifacts(
  backupRoot: string,
  backupName: string
): Promise<void> {
  await rm(backupPath(backupRoot, backupName), {
    recursive: true,
    force: true
  });
}

export async function writeBackupManifest(
  backupRoot: string,
  manifest: BackupManifest
): Promise<void> {
  await ensureDirectory(backupPath(backupRoot, manifest.backupName));
  await writeJsonFile(
    manifestPathForBackup(backupRoot, manifest.backupName),
    manifest
  );
}

export async function readBackup(
  backupRoot: string,
  backupName: string
): Promise<BackupRecord> {
  const manifest = await readJsonFile<BackupManifest>(
    manifestPathForBackup(backupRoot, backupName)
  );
  return {
    name: backupName,
    path: backupPath(backupRoot, backupName),
    manifest
  };
}

export async function listBackups(backupRoot: string): Promise<BackupRecord[]> {
  const directories = await listDirectories(backupRoot);
  const records: BackupRecord[] = [];

  for (const directory of directories) {
    const name = path.basename(directory);
    const manifestFile = manifestPathForBackup(backupRoot, name);
    if (!(await exists(manifestFile))) {
      continue;
    }

    const manifest = await readJsonFile<BackupManifest>(manifestFile);
    records.push({ name, path: directory, manifest });
  }

  return records.sort((left, right) =>
    right.manifest.createdAt.localeCompare(left.manifest.createdAt)
  );
}

export async function ensureBackupArtifacts(
  backupRoot: string,
  backupName: string
): Promise<void> {
  const manifestFile = manifestPathForBackup(backupRoot, backupName);
  if (!(await exists(manifestFile))) {
    throw new Error(`Backup ${backupName} is missing manifest.json`);
  }
  const manifestContent = await readFile(manifestFile, "utf8");
  if (!manifestContent.trim()) {
    throw new Error(`Backup ${backupName} manifest.json is empty`);
  }
  const manifest = JSON.parse(manifestContent) as BackupManifest;
  const archiveFile = archivePathForBackup(
    backupRoot,
    backupName,
    manifest.archiveFile
  );
  if (!(await exists(archiveFile))) {
    throw new Error(
      `Backup ${backupName} is missing ${path.basename(archiveFile)}`
    );
  }

  const archiveStats = await stat(archiveFile);
  if (archiveStats.size <= 0) {
    throw new Error(`Backup ${backupName} archive is empty`);
  }
}
