import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { backupPath } from "./backups.js";

export interface BackupActivity {
  pid: number;
  hostname: string;
  sourceEnvironment: string;
  startedAt: string;
  tags: string[];
}

function activityPath(root: string, name: string): string {
  // Validate the name before deriving the sibling marker path.
  backupPath(root, name);
  // Keep the marker component bounded even for filesystem-length backup names.
  const key = createHash("sha256").update(name).digest("hex");
  return path.join(root, `.dbh-creating-${key}.json`);
}

/** Register before exposing the directory, and never reuse an existing backup. */
export async function beginBackupCreation(
  root: string,
  name: string,
  sourceEnvironment: string,
  tags: string[]
): Promise<() => Promise<void>> {
  const marker = activityPath(root, name);
  const handle = await open(marker, "wx", 0o600);
  const release = () => rm(marker, { force: true });
  try {
    await handle.writeFile(
      JSON.stringify({
        pid: process.pid,
        hostname: hostname(),
        sourceEnvironment,
        startedAt: new Date().toISOString(),
        tags
      } satisfies BackupActivity)
    );
    await handle.close();
    await mkdir(backupPath(root, name));
    return release;
  } catch (error) {
    await handle.close().catch(() => {});
    await release();
    throw error;
  }
}

/** Stale, foreign-host, malformed, or linked markers cannot suppress artifact checks. */
export async function readBackupActivity(
  root: string,
  name: string
): Promise<BackupActivity | null> {
  try {
    const handle = await open(
      activityPath(root, name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    let activity: BackupActivity;
    try {
      if (!(await handle.stat()).isFile()) return null;
      activity = JSON.parse(await handle.readFile("utf8"));
    } finally {
      await handle.close();
    }
    if (
      !activity ||
      activity.hostname !== hostname() ||
      !Number.isSafeInteger(activity.pid) ||
      activity.pid <= 0 ||
      typeof activity.sourceEnvironment !== "string" ||
      !activity.sourceEnvironment ||
      typeof activity.startedAt !== "string" ||
      !Number.isFinite(Date.parse(activity.startedAt)) ||
      !Array.isArray(activity.tags) ||
      !activity.tags.every((tag) => typeof tag === "string")
    )
      return null;
    try {
      process.kill(activity.pid, 0);
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "EPERM")
      )
        return null;
    }
    return {
      pid: activity.pid,
      hostname: activity.hostname,
      sourceEnvironment: activity.sourceEnvironment,
      startedAt: activity.startedAt,
      tags: activity.tags
    };
  } catch {
    return null;
  }
}
