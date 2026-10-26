import { stat, statfs } from "node:fs/promises";
import path from "node:path";
import {
  errorCode,
  queryIssue,
  QueryIssue,
  queryReport,
  QueryReport
} from "./queryReport.js";

export interface FilesystemCapacity {
  id: string;
  totalBytes: number;
  freeBytes: number;
  availableBytes: number;
}

export async function getFilesystemCapacity(
  directory: string
): Promise<FilesystemCapacity> {
  const location = await stat(directory);
  if (!location.isDirectory())
    throw Object.assign(new Error("Path is not a directory"), {
      code: "ENOTDIR"
    });
  const filesystem = await statfs(directory);
  return {
    id: String(location.dev),
    totalBytes: filesystem.blocks * filesystem.bsize,
    freeBytes: filesystem.bfree * filesystem.bsize,
    availableBytes: filesystem.bavail * filesystem.bsize
  };
}

export interface StorageLocation {
  kind: "backupRoot" | "tempRoot";
  path: string;
  status: "available" | "missing" | "not-directory" | "unavailable";
  filesystem: FilesystemCapacity | null;
}

export interface BackupUsage {
  locations: StorageLocation[];
  sharedFilesystem: boolean | null;
}

export async function collectBackupUsage(
  paths: { backupRoot: string; tempRoot: string },
  getCapacity: typeof getFilesystemCapacity = getFilesystemCapacity
): Promise<QueryReport<BackupUsage>> {
  const locations: StorageLocation[] = [];
  const issues: QueryIssue[] = [];
  for (const kind of ["backupRoot", "tempRoot"] as const) {
    const location: StorageLocation = {
      kind,
      path: path.resolve(paths[kind]),
      status: "available",
      filesystem: null
    };
    try {
      location.filesystem = await getCapacity(location.path);
    } catch (error) {
      const code = errorCode(error);
      location.status =
        code === "ENOENT"
          ? "missing"
          : code === "ENOTDIR"
            ? "not-directory"
            : "unavailable";
      issues.push(
        queryIssue(
          "FILESYSTEM_UNAVAILABLE",
          location.path,
          `Filesystem capacity is unavailable (${location.status}).`,
          error
        )
      );
    }
    locations.push(location);
  }
  const [backup, temp] = locations;
  const data: BackupUsage = {
    locations,
    sharedFilesystem:
      backup.filesystem && temp.filesystem
        ? backup.filesystem.id === temp.filesystem.id
        : null
  };
  return queryReport(
    "backup.usage",
    data,
    issues,
    issues.length === 0
      ? "ok"
      : issues.length === locations.length
        ? "error"
        : "partial"
  );
}
