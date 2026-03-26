import { unlink } from "node:fs/promises";
import { AppConfig, EnvironmentId } from "../config/types.js";
import { createLocalTempFile, createArchiveBackup, restoreArchiveToEnvironment } from "../lib/mongo.js";
import { promptConfirm } from "../lib/prompts.js";

const ALLOWED_SYNC_PATHS = new Set([
  "production->development",
  "production->test",
  "development->test",
  "test->development"
]);

export function assertAllowedSyncPath(from: EnvironmentId, to: EnvironmentId): void {
  const key = `${from}->${to}`;
  if (!ALLOWED_SYNC_PATHS.has(key)) {
    throw new Error(`Sync path not allowed: ${key}`);
  }
}

export async function syncDatabase(
  appConfig: AppConfig,
  input: { from: EnvironmentId; to: EnvironmentId; yes: boolean }
): Promise<void> {
  assertAllowedSyncPath(input.from, input.to);

  if (!input.yes) {
    const approved = await promptConfirm(`This will replace ${input.to} with ${input.from}. Continue?`);
    if (!approved) {
      throw new Error("Sync cancelled.");
    }
  }

  const source = appConfig.environments[input.from];
  const target = appConfig.environments[input.to];
  const tempArchive = createLocalTempFile(appConfig, ".archive.gz");

  try {
    await createArchiveBackup(source, appConfig, tempArchive);
    await restoreArchiveToEnvironment(target, appConfig, tempArchive, { drop: appConfig.defaultDropOnRestore });
  } finally {
    await unlink(tempArchive).catch(() => undefined);
  }
}
