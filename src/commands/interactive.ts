import { AppConfig, EnvironmentId } from "../config/types.js";
import { promptChoice, promptText } from "../lib/prompts.js";
import { backupCreate } from "./backup.js";
import { runDoctor } from "./doctor.js";
import { recoverDatabase } from "./recover.js";
import { restoreCollection } from "./restore.js";
import { syncDatabase } from "./sync.js";
import { getRunLogger } from "../lib/runLog.js";

export async function runInteractive(appConfig: AppConfig): Promise<void> {
  const runLogger = getRunLogger();
  const action = await promptChoice("Select a workflow", [
    { label: "Restore known clean backup", value: "recover" },
    { label: "Back up production", value: "backup-production" },
    { label: "Sync production to development", value: "sync-prod-dev" },
    { label: "Sync production to test", value: "sync-prod-test" },
    { label: "Sync development to test", value: "sync-dev-test" },
    { label: "Sync test to development", value: "sync-test-dev" },
    { label: "Sync one collection", value: "sync-collection" },
    { label: "Restore one collection", value: "restore-collection" },
    { label: "Run doctor checks", value: "doctor" }
  ]);
  runLogger.info("interactive", "Selected interactive workflow", { action });

  switch (action) {
    case "recover":
      await recoverDatabase(appConfig);
      return;
    case "backup-production":
      await backupCreate(appConfig, {
        from: "production",
        outputMode: "default"
      });
      return;
    case "sync-prod-dev":
      await syncDatabase(appConfig, {
        from: "production",
        to: "development",
        yes: false,
        outputMode: "default"
      });
      return;
    case "sync-prod-test":
      await syncDatabase(appConfig, {
        from: "production",
        to: "test",
        yes: false,
        outputMode: "default"
      });
      return;
    case "sync-dev-test":
      await syncDatabase(appConfig, {
        from: "development",
        to: "test",
        yes: false,
        outputMode: "default"
      });
      return;
    case "sync-test-dev":
      await syncDatabase(appConfig, {
        from: "test",
        to: "development",
        yes: false,
        outputMode: "default"
      });
      return;
    case "sync-collection": {
      const from = await promptChoice<EnvironmentId>("Source environment", [
        {
          label: appConfig.environments.production.label,
          value: "production"
        },
        {
          label: appConfig.environments.development.label,
          value: "development"
        },
        { label: appConfig.environments.test.label, value: "test" }
      ]);
      const to = await promptChoice<EnvironmentId>("Target environment", [
        {
          label: appConfig.environments.development.label,
          value: "development"
        },
        { label: appConfig.environments.test.label, value: "test" }
      ]);
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
    case "restore-collection": {
      const backup = await promptText("Backup name");
      const collection = await promptText("Collection name");
      const target = await promptChoice<EnvironmentId>("Target environment", [
        {
          label: appConfig.environments.development.label,
          value: "development"
        },
        { label: appConfig.environments.test.label, value: "test" },
        { label: appConfig.environments.production.label, value: "production" }
      ]);
      await restoreCollection(appConfig, {
        backup,
        collection,
        to: target,
        yes: false,
        forceProductionRestore: target === "production",
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
