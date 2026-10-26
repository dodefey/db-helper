import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { BackupManifest } from "../config/types.js";
import { validateBackupName } from "./backups.js";
import { getDirectoryDiskUsage } from "./diskUsage.js";
import {
  errorCode,
  queryIssue,
  QueryIssue,
  queryReport,
  QueryReport
} from "./queryReport.js";

export interface CatalogEntry {
  name: string;
  path: string;
  manifest: BackupManifest | null;
  manifestStatus:
    | "valid"
    | "missing"
    | "invalid"
    | "unreadable"
    | "symlink"
    | "not-inspected";
  matchesFilters: boolean | null;
  archive: {
    path: string;
    status:
      | "present"
      | "missing"
      | "empty"
      | "not-file"
      | "unreadable"
      | "symlink"
      | "not-inspected";
    sizeBytes: number | null;
    verification: "not-performed";
  };
  diskUsage: {
    status: "measured" | "unavailable";
    allocatedBytes: number | null;
  };
}

export interface BackupCatalog {
  backupRoot: {
    path: string;
    status: "available" | "missing" | "not-directory" | "unreadable";
  };
  filters: { from: string | null; tag: string | null };
  backups: CatalogEntry[];
  knownAllocatedBytes: number;
  allocationComplete: boolean;
}

export interface CatalogDependencies {
  lstat: typeof lstat;
  readdir: typeof readdir;
  readFile: typeof readFile;
  measureUsage: typeof getDirectoryDiskUsage;
}

const DEFAULT_DEPENDENCIES: CatalogDependencies = {
  lstat,
  readdir,
  readFile,
  measureUsage: getDirectoryDiskUsage
};

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNumericMap(value: unknown): value is Record<string, number> {
  return (
    isObject(value) &&
    Object.values(value).every(
      (item) =>
        typeof item === "number" && Number.isSafeInteger(item) && item >= 0
    )
  );
}

/** Validate fields this CLI consumes; project known metadata without copying unknown fields. */
function parseManifest(value: unknown, name: string): BackupManifest | null {
  if (
    !isObject(value) ||
    value.backupName !== name ||
    !isNonEmptyString(value.sourceEnvironment) ||
    !isNonEmptyString(value.databaseName) ||
    !isNonEmptyString(value.toolVersion) ||
    typeof value.createdAt !== "string" ||
    !/(Z|[+-]\d{2}:\d{2})$/.test(value.createdAt) ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    value.archiveFile !== "dump.archive.gz" ||
    !isStringArray(value.tags) ||
    !isStringArray(value.collectionList) ||
    (value.note !== undefined && typeof value.note !== "string") ||
    (value.collectionCounts !== undefined &&
      !isNumericMap(value.collectionCounts)) ||
    (value.collectionSizes !== undefined &&
      !isNumericMap(value.collectionSizes))
  ) {
    return null;
  }
  return {
    backupName: name,
    sourceEnvironment: value.sourceEnvironment,
    databaseName: value.databaseName,
    toolVersion: value.toolVersion,
    createdAt: new Date(value.createdAt).toISOString(),
    archiveFile: "dump.archive.gz",
    tags: value.tags,
    collectionList: value.collectionList,
    ...(value.note === undefined ? {} : { note: value.note }),
    ...(value.collectionCounts === undefined
      ? {}
      : { collectionCounts: value.collectionCounts }),
    ...(value.collectionSizes === undefined
      ? {}
      : { collectionSizes: value.collectionSizes })
  };
}

export async function collectBackupCatalog(
  backupRoot: string,
  filters: { from?: string; tag?: string } = {},
  dependencies: CatalogDependencies = DEFAULT_DEPENDENCIES
): Promise<QueryReport<BackupCatalog>> {
  const root = path.resolve(backupRoot);
  const data: BackupCatalog = {
    backupRoot: { path: root, status: "available" },
    filters: { from: filters.from ?? null, tag: filters.tag ?? null },
    backups: [],
    knownAllocatedBytes: 0,
    allocationComplete: true
  };
  const issues: QueryIssue[] = [];
  let directories;
  try {
    // readdir follows an explicitly configured root symlink, but child links are never traversed.
    directories = await dependencies.readdir(root, { withFileTypes: true });
  } catch (error) {
    const code = errorCode(error);
    data.backupRoot.status =
      code === "ENOENT"
        ? "missing"
        : code === "ENOTDIR"
          ? "not-directory"
          : "unreadable";
    data.allocationComplete = false;
    issues.push(
      queryIssue(
        `ROOT_${data.backupRoot.status.replaceAll("-", "_").toUpperCase()}`,
        root,
        "Cannot enumerate the configured backup root.",
        error
      )
    );
    return queryReport("backup.list", data, issues, "error");
  }

  for (const directory of directories.sort((a, b) =>
    a.name.localeCompare(b.name)
  )) {
    if (!directory.isDirectory() && !directory.isSymbolicLink()) continue;
    const entryPath = path.join(root, directory.name);
    const manifestPath = path.join(entryPath, "manifest.json");
    const archivePath = path.join(entryPath, "dump.archive.gz");
    const entry: CatalogEntry = {
      name: directory.name,
      path: entryPath,
      manifest: null,
      manifestStatus: "not-inspected",
      matchesFilters: null,
      archive: {
        path: archivePath,
        status: "not-inspected",
        sizeBytes: null,
        verification: "not-performed"
      },
      diskUsage: { status: "unavailable", allocatedBytes: null }
    };
    const entryIssues: QueryIssue[] = [];
    const addIssue = (
      code: string,
      location: string,
      message: string,
      error?: unknown
    ) => entryIssues.push(queryIssue(code, location, message, error));
    if (directory.isSymbolicLink()) {
      addIssue(
        "SYMLINK_NOT_FOLLOWED",
        entryPath,
        "Backup entry is a symbolic link; its target was not inspected."
      );
    } else {
      try {
        validateBackupName(directory.name);
      } catch {
        addIssue(
          "INVALID_BACKUP_NAME",
          entryPath,
          "Directory name is not a supported backup identifier."
        );
      }
      try {
        const stats = await dependencies.lstat(manifestPath);
        if (stats.isSymbolicLink()) {
          entry.manifestStatus = "symlink";
          addIssue(
            "SYMLINK_NOT_FOLLOWED",
            manifestPath,
            "Manifest is a symbolic link; its target was not read."
          );
        } else if (!stats.isFile()) {
          entry.manifestStatus = "invalid";
          addIssue(
            "MANIFEST_INVALID",
            manifestPath,
            "Manifest is not a regular file."
          );
        } else {
          let raw: unknown;
          try {
            raw = JSON.parse(await dependencies.readFile(manifestPath, "utf8"));
          } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
          }
          entry.manifest = parseManifest(raw, directory.name);
          entry.manifestStatus = entry.manifest ? "valid" : "invalid";
          if (!entry.manifest)
            addIssue(
              "MANIFEST_INVALID",
              manifestPath,
              "Manifest JSON or required backup metadata is invalid."
            );
        }
      } catch (error) {
        entry.manifestStatus =
          errorCode(error) === "ENOENT" ? "missing" : "unreadable";
        addIssue(
          entry.manifestStatus === "missing"
            ? "MANIFEST_MISSING"
            : "MANIFEST_UNREADABLE",
          manifestPath,
          "Manifest could not be read.",
          error
        );
      }
      if (entry.manifest) {
        entry.matchesFilters =
          (!filters.from ||
            entry.manifest.sourceEnvironment === filters.from) &&
          (!filters.tag || entry.manifest.tags.includes(filters.tag));
        if (!entry.matchesFilters) continue;
      }
      try {
        const stats = await dependencies.lstat(archivePath);
        if (stats.isSymbolicLink()) {
          entry.archive.status = "symlink";
          addIssue(
            "SYMLINK_NOT_FOLLOWED",
            archivePath,
            "Archive is a symbolic link; its target was not inspected."
          );
        } else if (!stats.isFile()) {
          entry.archive.status = "not-file";
          addIssue(
            "ARCHIVE_NOT_FILE",
            archivePath,
            "Archive is not a regular file."
          );
        } else {
          entry.archive.sizeBytes = stats.size;
          entry.archive.status = stats.size === 0 ? "empty" : "present";
          if (stats.size === 0)
            addIssue("ARCHIVE_EMPTY", archivePath, "Archive is empty.");
        }
      } catch (error) {
        entry.archive.status =
          errorCode(error) === "ENOENT" ? "missing" : "unreadable";
        addIssue(
          entry.archive.status === "missing"
            ? "ARCHIVE_MISSING"
            : "ARCHIVE_UNREADABLE",
          archivePath,
          "Archive metadata could not be read.",
          error
        );
      }
    }
    try {
      entry.diskUsage.allocatedBytes =
        await dependencies.measureUsage(entryPath);
      entry.diskUsage.status = "measured";
      data.knownAllocatedBytes += entry.diskUsage.allocatedBytes;
    } catch (error) {
      data.allocationComplete = false;
      addIssue(
        "DISK_USAGE_UNAVAILABLE",
        entryPath,
        "Allocated disk usage could not be measured.",
        error
      );
    }
    data.backups.push(entry);
    issues.push(...entryIssues);
  }
  data.backups.sort(
    (a, b) =>
      (b.manifest?.createdAt ?? "").localeCompare(
        a.manifest?.createdAt ?? ""
      ) || a.name.localeCompare(b.name)
  );
  return queryReport(
    "backup.list",
    data,
    issues,
    issues.length ? "partial" : "ok"
  );
}
