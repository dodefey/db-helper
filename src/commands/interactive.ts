import { AppConfig, EnvironmentId } from "../config/types.js";
import { promptChoice, promptText } from "../lib/prompts.js";
import { backupCreate } from "./backup.js";
import { runDoctor } from "./doctor.js";
import { recoverDatabase } from "./recover.js";
import { restoreCollection, restoreFull } from "./restore.js";
import { syncDatabase } from "./sync.js";
import { getRunLogger } from "../lib/runLog.js";

function environmentChoices(appConfig: AppConfig): Array<{
  label: string;
  value: EnvironmentId;
}> {
  return Object.values(appConfig.environments).map((env) => ({
    label: `${env.label} (${env.name})`,
    value: env.name
  }));
}

export async function runInteractive(appConfig: AppConfig): Promise<void> {
  const runLogger = getRunLogger();
  const action = await promptChoice("Select a workflow", [
    { label: "Restore known clean backup", value: "recover" },
    { label: "Back up one environment", value: "backup-environment" },
    { label: "Sync full environment", value: "sync-environment" },
    { label: "Sync one collection", value: "sync-collection" },
    { label: "Restore full backup", value: "restore-full" },
    { label: "Restore one collection", value: "restore-collection" },
    { label: "Run doctor checks", value: "doctor" }
  ]);
  runLogger.info("interactive", "Selected interactive workflow", { action });

  switch (action) {
    case "recover":
      await recoverDatabase(appConfig);
      return;
    case "backup-environment": {
      const from = await promptChoice<EnvironmentId>(
        "Source environment",
        environmentChoices(appConfig)
      );
      await backupCreate(appConfig, {
        from,
        outputMode: "default"
      });
      return;
    }
    case "sync-environment": {
      const from = await promptChoice<EnvironmentId>(
        "Source environment",
        environmentChoices(appConfig)
      );
      const to = await promptChoice<EnvironmentId>(
        "Target environment",
        environmentChoices(appConfig)
      );
      await syncDatabase(appConfig, {
        from,
        to,
        yes: false,
        outputMode: "default"
      });
      return;
    }
    case "sync-collection": {
      const from = await promptChoice<EnvironmentId>(
        "Source environment",
        environmentChoices(appConfig)
      );
      const to = await promptChoice<EnvironmentId>(
        "Target environment",
        environmentChoices(appConfig)
      );
      const collection = await promptText("Collection name");
      await syncDatabase(appConfig, {
        from,
        to,
        collection,
        yes: false,
        outputMode: "default"
      });
      return;
    }
    case "restore-full": {
      const backup = await promptText("Backup name");
      const target = await promptChoice<EnvironmentId>(
        "Target environment",
        environmentChoices(appConfig)
      );
      await restoreFull(appConfig, {
        backup,
        to: target,
        yes: false,
        skipPreBackup: false,
        forceProductionRestore: appConfig.environments[target].isProduction,
        outputMode: "default"
      });
      return;
    }
    case "restore-collection": {
      const backup = await promptText("Backup name");
      const collection = await promptText("Collection name");
      const target = await promptChoice<EnvironmentId>(
        "Target environment",
        environmentChoices(appConfig)
      );
      await restoreCollection(appConfig, {
        backup,
        collection,
        to: target,
        yes: false,
        forceProductionRestore: appConfig.environments[target].isProduction,
        outputMode: "default"
      });
      return;
    }
    case "doctor":
      await runDoctor(appConfig);
      return;
    default:
      throw new Error(`Unknown interactive action: ${String(action)}`);
  }
}
