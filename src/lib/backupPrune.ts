import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import {
  collectBackupCatalog,
  CatalogEntry,
  parseManifest
} from "./backupCatalog.js";
import { acquireBackupGuard } from "./backupActivity.js";
import { validateBackupName } from "./backups.js";
import {
  deleteBackupUnderGuard,
  inspectBackupDeleteTarget,
  resolveBackupDeleteTarget
} from "./backupDelete.js";

export interface PruneBackup {
  name: string;
  environment: string;
  createdAt: string;
  identity: string;
}
export interface PrunePlan {
  root: string;
  keepLast: number;
  keep: PruneBackup[];
  remove: PruneBackup[];
  skip: { name: string; environment: string; reason: string }[];
}

export function validateKeepLast(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error("--keep-last must be an integer of at least 1.");
}

function qualifies(entry: CatalogEntry): boolean {
  return (
    !entry.inProgress &&
    entry.manifestStatus === "valid" &&
    entry.archive.status === "present"
  );
}

async function identity(
  root: string,
  name: string,
  expected?: CatalogEntry["manifest"]
): Promise<string> {
  const directory = path.join(root, name);
  const stats = await Promise.all(
    [
      directory,
      path.join(directory, "manifest.json"),
      path.join(directory, "dump.archive.gz")
    ].map((file) => lstat(file))
  );
  if (
    !stats[0].isDirectory() ||
    stats[0].isSymbolicLink() ||
    stats[2].size === 0 ||
    stats.slice(1).some((stat) => !stat.isFile() || stat.isSymbolicLink())
  )
    throw new Error(`Backup changed: ${name}`);
  const manifestText = await readFile(
    path.join(directory, "manifest.json"),
    "utf8"
  );
  if (expected) {
    const current = parseManifest(JSON.parse(manifestText), name);
    if (!current || JSON.stringify(current) !== JSON.stringify(expected))
      throw new Error(`Backup changed during planning: ${name}`);
  }
  return JSON.stringify([
    manifestText,
    stats.map((stat) => [
      stat.dev,
      stat.ino,
      stat.size,
      stat.mtimeMs,
      stat.ctimeMs
    ])
  ]);
}

export async function planBackupPrune(
  root: string,
  keepLast: number
): Promise<PrunePlan> {
  validateKeepLast(keepLast);
  root = await realpath(root);
  const report = await collectBackupCatalog(root);
  if (report.status === "error")
    throw new Error("Cannot enumerate the backup root; pruning stopped.");
  const plan: PrunePlan = { root, keepLast, keep: [], remove: [], skip: [] };
  const groups = new Map<string, PruneBackup[]>();
  for (const entry of report.data.backups) {
    const environment =
      entry.manifest?.sourceEnvironment ??
      entry.inProgress?.sourceEnvironment ??
      "unknown";
    let reason = entry.inProgress
      ? "creation in progress"
      : "incomplete or unclassifiable backup";
    if (qualifies(entry)) {
      try {
        validateBackupName(entry.name);
        await inspectBackupDeleteTarget(
          await resolveBackupDeleteTarget(root, entry.name)
        );
        const backup = {
          name: entry.name,
          environment,
          createdAt: entry.manifest!.createdAt,
          identity: await identity(root, entry.name, entry.manifest)
        };
        const group = groups.get(environment) ?? [];
        group.push(backup);
        groups.set(environment, group);
        continue;
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error);
      }
    }
    plan.skip.push({ name: entry.name, environment, reason });
  }
  for (const environment of [...groups.keys()].sort()) {
    const group = groups.get(environment)!;
    group.sort(
      (a, b) =>
        Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    );
    plan.keep.push(...group.slice(0, keepLast));
    plan.remove.push(...group.slice(keepLast));
  }
  return plan;
}

/** Freeze selection at preview time; guards protect retained backups from other dbh deletes. */
export async function executeBackupPrune(plan: PrunePlan): Promise<string[]> {
  const releases: (() => Promise<void>)[] = [];
  const deleted: string[] = [];
  let failure: unknown;
  try {
    const guarded = new Set<string>();
    for (const backup of [...plan.keep, ...plan.remove]) {
      const key = backup.name.toLowerCase();
      if (guarded.has(key)) continue;
      releases.push(await acquireBackupGuard(plan.root, backup.name));
      guarded.add(key);
    }
    for (const candidate of plan.remove) {
      await deleteBackupUnderGuard(
        await resolveBackupDeleteTarget(plan.root, candidate.name),
        async () => {
          for (const expected of [...plan.keep, candidate]) {
            if (
              (await identity(plan.root, expected.name).catch(() => null)) !==
              expected.identity
            )
              throw new Error(
                `Backup changed since preview: ${expected.name}; run prune again.`
              );
            await inspectBackupDeleteTarget(
              await resolveBackupDeleteTarget(plan.root, expected.name)
            );
          }
        }
      );
      deleted.push(candidate.name);
    }
  } catch (error) {
    failure = new Error(
      `Prune stopped. Deleted ${deleted.length}: ${deleted.join(", ") || "none"}. Remaining planned deletions: ${
        plan.remove
          .slice(deleted.length)
          .map((item) => item.name)
          .join(", ") || "none"
      }. ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
  // Attempt every release even if one cleanup fails.
  const results = await Promise.allSettled(
    releases.map((release) => release())
  );
  const failed = results.find((result) => result.status === "rejected");
  if (failed)
    failure = new Error(
      `Prune guard cleanup failed; deleted ${deleted.length}: ${deleted.join(", ") || "none"}. Inspect backup guard files before retrying. ${failure instanceof Error ? failure.message : ""}`,
      { cause: failed.reason }
    );
  if (failure) throw failure;
  return deleted;
}
