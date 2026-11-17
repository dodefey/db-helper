import { lstat, realpath, rm } from "node:fs/promises";
import { backupPath } from "./backups.js";
import {
  acquireBackupGuard,
  assertCreationStopped,
  deletionGuardPath
} from "./backupActivity.js";
import { errorCode } from "./queryReport.js";

export interface BackupDeleteTarget {
  name: string;
  root: string;
  path: string;
}

/** Resolve the configured root once so confirmation and execution use the same path. */
export async function resolveBackupDeleteTarget(
  root: string,
  name: string
): Promise<BackupDeleteTarget> {
  backupPath(root, name);
  const resolvedRoot = await realpath(root);
  if (!(await lstat(resolvedRoot)).isDirectory())
    throw new Error("Backup root is not a directory.");
  return { name, root: resolvedRoot, path: backupPath(resolvedRoot, name) };
}

export async function inspectBackupDeleteTarget(
  target: BackupDeleteTarget
): Promise<{ exists: boolean; staleMarkers: string[] }> {
  const staleMarkers = await assertCreationStopped(target.root, target.name);
  try {
    const stats = await lstat(target.path);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(
        `Refusing to delete a backup that is not a real directory: ${target.path}`
      );
    }
    return { exists: true, staleMarkers };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { exists: false, staleMarkers };
    throw error;
  }
}

/** Shared exact-name deletion for CLI callers and future pruning. Never prompts or selects backups. */
export async function deleteBackup(
  root: string,
  name: string
): Promise<"deleted" | "absent"> {
  const target = await resolveBackupDeleteTarget(root, name);
  const guard = deletionGuardPath(target.root, name);
  const releaseGuard = await acquireBackupGuard(target.root, name);
  let deletionStarted = false;
  let failure: unknown;
  let result: "deleted" | "absent" = "absent";
  try {
    const { exists, staleMarkers } = await inspectBackupDeleteTarget(target);
    deletionStarted = true;
    if (exists) await rm(target.path, { recursive: true, force: true });
    for (const marker of staleMarkers) await rm(marker, { force: true });
    result = exists ? "deleted" : "absent";
  } catch (error) {
    failure = deletionStarted
      ? new Error(
          `Backup deletion failed for ${target.path}; files may already have been removed. ${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        )
      : error;
  }
  try {
    await releaseGuard();
  } catch (error) {
    throw new Error(
      `${failure instanceof Error ? failure.message : `Backup ${result}: ${target.name}.`} Deletion guard cleanup failed: ${guard}.`,
      { cause: error }
    );
  }
  if (failure) throw failure;
  return result;
}
