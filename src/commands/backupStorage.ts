import { collectBackupCatalog } from "../lib/backupCatalog.js";
import { formatBytes, OutputMode } from "../lib/output.js";
import { getFilesystemCapacity } from "../lib/storage.js";
import { getRunLogger } from "../lib/runLog.js";

const LOW_SPACE_BYTES = 1024 ** 3; // Match doctor's minimum available space.

/** Advisory reporting must never change the outcome of backup creation. */
export async function reportBackupStorage(
  root: string,
  outputMode: OutputMode,
  summary: boolean,
  dependencies = {
    capacity: getFilesystemCapacity,
    catalog: collectBackupCatalog,
    stdout: (text: string) => {
      process.stdout.write(text);
    },
    stderr: (text: string) => {
      process.stderr.write(text);
    }
  },
  warn = true
): Promise<boolean> {
  let available: number | null = null;
  try {
    available = (await dependencies.capacity(root)).availableBytes;
  } catch (error) {
    getRunLogger().debug("backup.storage", "Storage capacity unavailable", {
      error: String(error)
    });
  }
  const low = available !== null && available < LOW_SPACE_BYTES;
  if (warn && low && available !== null) {
    dependencies.stderr(
      `Warning: backup storage is low (${formatBytes(available)} available; below 1.0 GiB). Run 'dbh backup list' to review backups and 'dbh backup delete --backup <name>' to remove a selected backup.\n`
    );
  }
  if (!summary || outputMode === "quiet") return low;
  let inventory = "backup inventory unavailable";
  try {
    const report = await dependencies.catalog(root);
    if (report.status !== "error") {
      const count = report.data.backups.length;
      inventory = `${count} backup${count === 1 ? "" : "s"} · ${report.data.allocationComplete ? "" : "at least "}${formatBytes(report.data.knownAllocatedBytes)} allocated`;
    }
  } catch (error) {
    getRunLogger().debug("backup.storage", "Storage inventory unavailable", {
      error: String(error)
    });
  }
  dependencies.stdout(
    `Storage: ${inventory} · ${available === null ? "available space unknown" : `${formatBytes(available)} available`}.\n`
  );
  return low;
}
