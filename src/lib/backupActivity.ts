import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, writeFileSync } from "node:fs";
import { lstat, mkdir, open, readdir, rm, rmdir } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { errorCode } from "./queryReport.js";
import { backupPath } from "./backups.js";
import { runCommand } from "./exec.js";
import { getRunLogger } from "./runLog.js";

export interface BackupActivity {
  pid: number;
  hostname: string;
  sourceEnvironment: string;
  startedAt: string;
  tags: string[];
}

interface BackupCreationMarker extends BackupActivity {
  machineId?: string;
}

const execFileAsync = promisify(execFile);
let machineIdLookup: Promise<string | undefined> | undefined;

async function readMacMachineId(): Promise<string | undefined> {
  if (process.platform !== "darwin") return undefined;
  try {
    const { stdout } = await execFileAsync(
      "/usr/sbin/ioreg",
      ["-rd1", "-c", "IOPlatformExpertDevice"],
      { timeout: 2000, maxBuffer: 64 * 1024 }
    );
    const uuid = stdout
      .match(
        /"IOPlatformUUID"\s*=\s*"([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})"/i
      )?.[1]
      .toLowerCase();
    if (!uuid || uuid === "00000000-0000-0000-0000-000000000000")
      return undefined;
    return createHash("sha256").update(`dbh:macos:${uuid}`).digest("hex");
  } catch {
    return undefined;
  }
}

function localMachineId(): Promise<string | undefined> {
  return (machineIdLookup ??= readMacMachineId());
}

async function markerIsLocal(marker: BackupCreationMarker): Promise<boolean> {
  if (typeof marker.hostname !== "string" || marker.hostname.length === 0)
    return false;
  if (marker.machineId === undefined) return marker.hostname === hostname();
  // A marker with a machine ID requires a match even when hostnames agree.
  return marker.machineId === (await localMachineId());
}

export function activityPath(root: string, name: string): string {
  // Validate the name before deriving the sibling marker path.
  backupPath(root, name);
  // Preserve exact-name identity for catalog metadata and existing markers.
  const key = createHash("sha256").update(name).digest("hex");
  return path.join(root, `.dbh-creating-${key}.json`);
}

export function deletionGuardPath(root: string, name: string): string {
  return `${activityPath(root, name.toLowerCase())}.guard`;
}

function archiveWriterPath(root: string, name: string): string {
  return `${activityPath(root, name)}.writer`;
}

/** Publish the writer marker before spawn, so an unrecorded PID blocks removal. */
export function createBackupArchiveCommand(
  root: string,
  name: string
): typeof runCommand {
  return async (command, args, options) => {
    const marker = archiveWriterPath(root, name);
    const handle = await open(marker, "wx", 0o600);
    let output: string;
    let cleanupError: unknown;
    try {
      output = await runCommand(command, args, {
        ...options,
        trackProcess: (pid) => writeFileSync(handle.fd, `${pid}\n`)
      });
    } finally {
      try {
        await handle.close();
        await rm(marker);
      } catch (error) {
        cleanupError = error;
        getRunLogger().warn(
          "backup",
          "Could not remove archive writer marker",
          {
            backupName: name,
            error
          }
        );
      }
    }
    if (cleanupError) throw cleanupError;
    return output;
  };
}

/** Serialize creation setup and deletion, including filesystem case aliases. */
export async function acquireBackupGuard(
  root: string,
  name: string
): Promise<() => Promise<void>> {
  const guard = deletionGuardPath(root, name);
  try {
    const handle = await open(guard, "wx", 0o600);
    await handle.close();
  } catch (error) {
    if (errorCode(error) === "EEXIST")
      throw new Error(
        `Backup creation/deletion is already guarded: ${guard}. If a prior operation was forcibly terminated, confirm it has stopped before removing this guard file.`,
        { cause: error }
      );
    throw error;
  }
  return () => rm(guard);
}

/** Deletion requires proof of a stopped writer; unknown ownership is not permission. */
export async function assertCreationStopped(
  root: string,
  name: string
): Promise<string[]> {
  const names = new Set([name]);
  // A typed case alias must also check the directory's original spelling.
  // On case-sensitive filesystems, distinct directories keep distinct activity.
  let target;
  try {
    target = await lstat(backupPath(root, name));
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  if (target?.isDirectory()) {
    for (const entry of await readdir(root)) {
      if (entry === name || entry.toLowerCase() !== name.toLowerCase())
        continue;
      const candidate = await lstat(backupPath(root, entry));
      if (candidate.dev === target.dev && candidate.ino === target.ino)
        names.add(entry);
    }
  }
  const staleMarkers: string[] = [];
  for (const candidate of names) {
    const ownerStopped = await markerOwnerStopped(root, candidate);
    const writer = archiveWriterPath(root, candidate);
    if (await archiveWriterStopped(writer, candidate, ownerStopped))
      staleMarkers.push(writer);
    if (ownerStopped) staleMarkers.push(activityPath(root, candidate));
  }
  return staleMarkers;
}

async function archiveWriterStopped(
  marker: string,
  name: string,
  ownerStopped: boolean
): Promise<boolean> {
  let handle;
  try {
    handle = await open(
      marker,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
  try {
    const contents = (await handle.stat()).isFile()
      ? await handle.readFile("utf8")
      : "";
    const pid = /^[1-9]\d*\n$/.test(contents) ? Number(contents) : NaN;
    if (!ownerStopped || !Number.isSafeInteger(pid) || pid > 2147483647)
      throw new Error(
        `Cannot verify backup archive writer has stopped: ${name} (${marker}).`
      );
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (errorCode(error) === "ESRCH") return true;
      if (errorCode(error) !== "EPERM") throw error;
    }
    throw new Error(`Backup archive writer is active: ${name}`);
  } finally {
    await handle.close();
  }
}

async function markerOwnerStopped(
  root: string,
  name: string
): Promise<boolean> {
  let handle;
  try {
    handle = await open(
      activityPath(root, name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return false;
    throw error;
  }
  try {
    if (!(await handle.stat()).isFile())
      throw new Error("Creation marker is not a regular file.");
    const owner: BackupCreationMarker | null = JSON.parse(
      await handle.readFile("utf8")
    );
    if (
      !owner ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0 ||
      !(await markerIsLocal(owner))
    ) {
      throw new Error(
        `Cannot establish ownership of backup creation marker: ${name}`
      );
    }
    try {
      process.kill(owner.pid, 0);
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ESRCH"
      )
        return true;
      throw error;
    }
    throw new Error(`Backup creation is active: ${name}`);
  } finally {
    await handle.close();
  }
}

/** Register before exposing the directory, and never reuse an existing backup. */
export async function beginBackupCreation(
  root: string,
  name: string,
  sourceEnvironment: string,
  tags: string[]
): Promise<() => Promise<void>> {
  const machineId = await localMachineId();
  const releaseGuard = await acquireBackupGuard(root, name);
  const marker = activityPath(root, name);
  let handle;
  let releaseActivity: (() => Promise<void>) | undefined;
  let failure: unknown;
  let createdDirectory = false;
  try {
    handle = await open(marker, "wx", 0o600);
    releaseActivity = () => rm(marker, { force: true });
    await handle.writeFile(
      JSON.stringify({
        pid: process.pid,
        hostname: hostname(),
        machineId,
        sourceEnvironment,
        startedAt: new Date().toISOString(),
        tags
      } satisfies BackupCreationMarker)
    );
    await handle.close();
    await mkdir(backupPath(root, name));
    createdDirectory = true;
  } catch (error) {
    failure = error;
  }
  try {
    await releaseGuard();
  } catch (error) {
    failure = new Error(
      `Backup setup guard cleanup failed: ${deletionGuardPath(root, name)}. ${failure instanceof Error ? failure.message : ""}`,
      { cause: error }
    );
  }
  if (failure) {
    await handle?.close().catch(() => {});
    try {
      // Remove only an empty directory created by this setup attempt.
      if (createdDirectory) await rmdir(backupPath(root, name));
    } catch (error) {
      failure = new Error(
        `Backup setup failed and directory cleanup failed: ${backupPath(root, name)}`,
        { cause: error }
      );
    }
    try {
      await releaseActivity?.();
    } catch (error) {
      throw new Error(
        `Backup setup failed and creation marker cleanup failed: ${marker}. ${failure instanceof Error ? failure.message : String(failure)}`,
        { cause: error }
      );
    }
    throw failure;
  }
  return releaseActivity!;
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
    let activity: BackupCreationMarker | null;
    try {
      if (!(await handle.stat()).isFile()) return null;
      activity = JSON.parse(await handle.readFile("utf8"));
    } finally {
      await handle.close();
    }
    if (
      !activity ||
      !Number.isSafeInteger(activity.pid) ||
      activity.pid <= 0 ||
      typeof activity.sourceEnvironment !== "string" ||
      !activity.sourceEnvironment ||
      typeof activity.startedAt !== "string" ||
      !Number.isFinite(Date.parse(activity.startedAt)) ||
      !Array.isArray(activity.tags) ||
      !activity.tags.every((tag) => typeof tag === "string") ||
      !(await markerIsLocal(activity))
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
