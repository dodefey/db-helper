import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { BackupManifest, BackupRecord, EnvironmentConfig } from "../config/types.js";
import { ensureDirectory, exists, listDirectories, readJsonFile, writeJsonFile } from "./fs.js";

export function buildBackupName(env: EnvironmentConfig): string {
  return `${new Date().toISOString().replace(/:/g, "-").replace(/\.\d{3}Z$/, "")}-${env.id}`;
}

export function backupPath(backupRoot: string, backupName: string): string {
  return path.join(backupRoot, backupName);
}

export function archivePathForBackup(backupRoot: string, backupName: string): string {
  return path.join(backupPath(backupRoot, backupName), "dump.archive.gz");
}

export function manifestPathForBackup(backupRoot: string, backupName: string): string {
  return path.join(backupPath(backupRoot, backupName), "manifest.json");
}

export async function writeBackupManifest(backupRoot: string, manifest: BackupManifest): Promise<void> {
  await ensureDirectory(backupPath(backupRoot, manifest.backupName));
  await writeJsonFile(manifestPathForBackup(backupRoot, manifest.backupName), manifest);
}

export async function readBackup(backupRoot: string, backupName: string): Promise<BackupRecord> {
  const manifest = await readJsonFile<BackupManifest>(manifestPathForBackup(backupRoot, backupName));
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

  return records.sort((left, right) => right.manifest.createdAt.localeCompare(left.manifest.createdAt));
}

export async function ensureBackupArtifacts(backupRoot: string, backupName: string): Promise<void> {
  const manifestFile = manifestPathForBackup(backupRoot, backupName);
  const archiveFile = archivePathForBackup(backupRoot, backupName);

  if (!(await exists(manifestFile))) {
    throw new Error(`Backup ${backupName} is missing manifest.json`);
  }
  if (!(await exists(archiveFile))) {
    throw new Error(`Backup ${backupName} is missing dump.archive.gz`);
  }

  const archiveStats = await stat(archiveFile);
  if (archiveStats.size <= 0) {
    throw new Error(`Backup ${backupName} archive is empty`);
  }

  const manifestContent = await readFile(manifestFile, "utf8");
  if (!manifestContent.trim()) {
    throw new Error(`Backup ${backupName} manifest.json is empty`);
  }
}
