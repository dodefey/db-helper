import { AppConfig, EnvironmentId } from "../config/types.js";
import { backupList } from "./backup.js";
import { promptChoice, promptConfirm } from "../lib/prompts.js";
import { getRunLogger } from "../lib/runLog.js";
import { restoreFull } from "./restore.js";
import { COLLECTION_ARCHIVE, FULL_ARCHIVE } from "../lib/backups.js";

export async function recoverDatabase(appConfig: AppConfig): Promise<void> {
  const runLogger = getRunLogger();
  const backups = await backupList(appConfig, {});
  const fullBackups = backups.filter(
    (backup) => backup.manifest.archiveFile === FULL_ARCHIVE
  );
  if (fullBackups.length === 0) {
    const hasCollectionBackups = backups.some(
      (backup) => backup.manifest.archiveFile === COLLECTION_ARCHIVE
    );
    const message = "No full backups available for guided recovery.";
    runLogger.warn("recover", message, { hasCollectionBackups });
    throw new Error(
      hasCollectionBackups
        ? `${message} Use dbh restore collection to restore selected collections.`
        : message
    );
  }

  const sorted = fullBackups.sort((left, right) => {
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
