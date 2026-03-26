import { AppConfig, EnvironmentId } from "../config/types.js";
import { promptConfirm } from "../lib/prompts.js";
import { runSync } from "../lib/sync.js";

const ALLOWED_SYNC_PATHS = new Set([
  "production->development",
  "production->test",
  "development->test",
  "test->development"
]);

export interface SyncDependencies {
  promptConfirm: (message: string) => Promise<boolean>;
  runSync: typeof runSync;
}

const DEFAULT_SYNC_DEPENDENCIES: SyncDependencies = {
  promptConfirm,
  runSync
};

export function assertAllowedSyncPath(
  from: EnvironmentId,
  to: EnvironmentId
): void {
  const key = `${from}->${to}`;
  if (!ALLOWED_SYNC_PATHS.has(key)) {
    throw new Error(`Sync path not allowed: ${key}`);
  }
}

export async function syncDatabase(
  appConfig: AppConfig,
  input: { from: EnvironmentId; to: EnvironmentId; yes: boolean },
  dependencies: SyncDependencies = DEFAULT_SYNC_DEPENDENCIES
): Promise<void> {
  assertAllowedSyncPath(input.from, input.to);

  if (!input.yes) {
    const approved = await dependencies.promptConfirm(
      `This will replace ${input.to} with ${input.from}. Continue?`
    );
    if (!approved) {
      throw new Error("Sync cancelled.");
    }
  }

  await dependencies.runSync(appConfig, { from: input.from, to: input.to });
}
