import { AppConfig, EnvironmentId } from "../config/types.js";
import { backupList } from "./backup.js";
import { promptChoice, promptConfirm } from "../lib/prompts.js";
import { getRunLogger } from "../lib/runLog.js";
import { restoreFull } from "./restore.js";

export async function recoverDatabase(appConfig: AppConfig): Promise<void> {
  const runLogger = getRunLogger();
  const backups = await backupList(appConfig, {});
  if (backups.length === 0) {
    runLogger.warn("recover", "No backups available for recovery");
    throw new Error("No backups available.");
  }

  const sorted = [...backups].sort((left, right) => {
    const leftKnownClean = left.manifest.tags.includes("known-clean") ? 1 : 0;
    const rightKnownClean = right.manifest.tags.includes("known-clean") ? 1 : 0;
    return (
      rightKnownClean - leftKnownClean ||
      right.manifest.createdAt.localeCompare(left.manifest.createdAt)
    );
  });

  const backup = await promptChoice(
    "Select a backup to restore",
    sorted.slice(0, 15).map((item) => ({
      value: item.name,
      label: `${item.name} (${item.manifest.sourceEnvironment}, tags: ${item.manifest.tags.join(", ") || "none"})`
    }))
  );

  const target = await promptChoice<EnvironmentId>(
    "Select a restore target",
    Object.values(appConfig.environments).map((env) => ({
      label: `${env.label} (${env.name})`,
      value: env.name
    }))
  );

  const approved = await promptConfirm(`Restore ${backup} into ${target}?`);
  if (!approved) {
    runLogger.warn("recover", "Recovery confirmation declined", {
      backup,
      target
    });
    throw new Error("Recovery cancelled.");
  }

  runLogger.info("recover", "Starting recovery restore", {
    backup,
    target
  });
  await restoreFull(appConfig, {
    backup,
    to: target,
    yes: false,
    skipPreBackup: false,
    forceProductionRestore: appConfig.environments[target].isProduction,
    outputMode: "default"
  });
}
