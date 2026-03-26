import { AppConfig, EnvironmentId } from "../config/types.js";
import { backupList } from "./backup.js";
import { promptChoice, promptConfirm } from "../lib/prompts.js";
import { restoreFull } from "./restore.js";

export async function recoverDatabase(appConfig: AppConfig): Promise<void> {
  const backups = await backupList(appConfig, {});
  if (backups.length === 0) {
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

  const target = await promptChoice<EnvironmentId>("Select a restore target", [
    {
      label: `${appConfig.environments.development.label} (development)`,
      value: "development"
    },
    { label: `${appConfig.environments.test.label} (test)`, value: "test" },
    {
      label: `${appConfig.environments.production.label} (production)`,
      value: "production"
    }
  ]);

  const approved = await promptConfirm(`Restore ${backup} into ${target}?`);
  if (!approved) {
    throw new Error("Recovery cancelled.");
  }

  await restoreFull(appConfig, {
    backup,
    to: target,
    yes: false,
    skipPreBackup: false,
    forceProductionRestore: target === "production"
  });
}
