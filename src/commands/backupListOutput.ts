import { CatalogEntry } from "../lib/backupCatalog.js";
import { formatBytes, OutputMode } from "../lib/output.js";
import { BackupUsage } from "../lib/storage.js";

export function formatBackupList(
  records: CatalogEntry[],
  outputMode: OutputMode
): string {
  if (records.length === 0)
    return outputMode === "quiet" ? "" : "No backups found.\n";
  let totalBytes = 0;
  let unavailable = 0;
  const rows = records.map((record) => {
    const bytes = record.diskUsage.allocatedBytes;
    if (bytes === null) unavailable += 1;
    else totalBytes += bytes;
    const columns = [
      record.name,
      record.manifest?.sourceEnvironment ?? "unknown",
      record.manifest?.createdAt ?? "unknown",
      record.manifest?.tags.join(",") || "-"
    ];
    return outputMode === "quiet"
      ? [...columns, bytes === null ? "unknown" : String(bytes)]
      : [
          ...columns.slice(0, 3),
          bytes === null ? "unknown" : formatBytes(bytes),
          columns[3]
        ];
  });
  if (outputMode === "quiet")
    return `${rows.map((row) => row.join("\t")).join("\n")}\n`;
  const headers = ["BACKUP", "ENVIRONMENT", "CREATED (UTC)", "DISK", "TAGS"];
  const widths = headers.map((header, column) =>
    rows.reduce(
      (width, row) => Math.max(width, row[column].length),
      header.length
    )
  );
  const table = [headers, ...rows]
    .map((row) =>
      row
        .map((value, column) => {
          if (column === row.length - 1) return value;
          return column === 3
            ? value.padStart(widths[column])
            : value.padEnd(widths[column]);
        })
        .join("  ")
    )
    .join("\n");
  const count = `${records.length} backup${records.length === 1 ? "" : "s"}`;
  const total = unavailable
    ? `known disk usage: ${formatBytes(totalBytes)}; ${unavailable} unavailable`
    : `total disk usage: ${formatBytes(totalBytes)}`;
  const verbose =
    outputMode === "verbose"
      ? `${records.map((record) => `Backup path: ${record.path}`).join("\n")}\n`
      : "";
  return `${table}\n\n${count}; ${total}\n${verbose}`;
}

export function formatBackupUsage(
  data: BackupUsage,
  outputMode: OutputMode
): string {
  if (outputMode === "quiet") {
    const rows = data.locations.map((location) => {
      const fs = location.filesystem;
      return [
        location.kind,
        location.path,
        location.status,
        fs?.id ?? "unknown",
        fs?.totalBytes ?? "unknown",
        fs?.availableBytes ?? "unknown",
        fs?.freeBytes ?? "unknown"
      ].join("\t");
    });
    return `${rows.join("\n")}\n`;
  }
  const lines: string[] = [];
  for (const location of data.locations) {
    lines.push(`${location.kind}: ${location.path}`);
    const fs = location.filesystem;
    if (!fs) {
      lines.push(`  ${location.status}`);
      continue;
    }
    const details = [
      `${formatBytes(fs.availableBytes)} available`,
      `${formatBytes(fs.totalBytes)} capacity`
    ];
    if (outputMode === "verbose") {
      details.push(
        `filesystem ${fs.id}`,
        `${fs.availableBytes} available bytes`,
        `${fs.freeBytes} free bytes`
      );
    }
    lines.push(`  ${details.join("; ")}`);
  }
  lines.push(
    data.sharedFilesystem === null
      ? "Shared filesystem: unknown."
      : data.sharedFilesystem
        ? "Both locations share a filesystem; available space is shared."
        : "Locations use separate filesystems."
  );
  return `${lines.join("\n")}\n`;
}
