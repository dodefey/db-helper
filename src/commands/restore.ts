import { AppConfig, BackupRecord, EnvironmentId } from "../config/types.js";
import { readBackup, requireFullBackup } from "../lib/backups.js";
import {
  formatCollectionSelection,
  validateCollectionSelection
} from "../lib/collections.js";
import {
  CommandInvocationContext,
  createCommandInvocationContext
} from "../lib/invocationContext.js";
import { promptConfirm, promptText } from "../lib/prompts.js";
import { runRestoreCollection, runRestoreFull } from "../lib/restore.js";
import { OutputMode } from "../lib/output.js";
import { getRunLogger } from "../lib/runLog.js";

export interface RestoreDependencies {
  promptConfirm: typeof promptConfirm;
  promptText: typeof promptText;
  readBackup: typeof readBackup;
  runRestoreFull: typeof runRestoreFull;
  runRestoreCollection: typeof runRestoreCollection;
}

const DEFAULT_RESTORE_DEPENDENCIES: RestoreDependencies = {
  promptConfirm,
  promptText,
  readBackup,
  runRestoreFull,
  runRestoreCollection
};

async function confirmRestore(
  message: string,
  yes: boolean,
  dependencies: RestoreDependencies
): Promise<void> {
  if (yes) {
    return;
  }

  const approved = await dependencies.promptConfirm(message);
  if (!approved) {
    throw new Error("Restore cancelled.");
  }
}

async function confirmProductionRestore(
  backup: BackupRecord,
  yes: boolean,
  force: boolean,
  dependencies: RestoreDependencies
): Promise<void> {
  if (!force) {
    throw new Error("Production restore requires --force-production-restore");
  }

  if (yes) {
    return;
  }

  const phrase = await dependencies.promptText(
    `Type RESTORE ${backup.name} TO PRODUCTION to confirm`
  );
  if (phrase !== `RESTORE ${backup.name} TO PRODUCTION`) {
    throw new Error("Production restore confirmation did not match.");
  }
}

export async function restoreFull(
  appConfig: AppConfig,
  input: {
    backup: string;
    to: EnvironmentId;
    yes: boolean;
    skipPreBackup: boolean;
    forceProductionRestore: boolean;
    outputMode: OutputMode;
    explain?: boolean;
  },
  dependencies: RestoreDependencies = DEFAULT_RESTORE_DEPENDENCIES,
  context: CommandInvocationContext = createCommandInvocationContext()
): Promise<void> {
  const runLogger = getRunLogger();
  const backup = await dependencies.readBackup(
    appConfig.backupRoot,
    input.backup
  );
  requireFullBackup(backup);
  const target = appConfig.environments[input.to];

  if (!input.explain) {
    await confirmRestore(
      `This will restore data into ${input.to}. Continue?`,
      input.yes,
      dependencies
    );
  }
  runLogger.info("restore.command", "Restore target confirmed", {
    backup: input.backup,
    to: input.to,
    kind: "full"
  });

  if (target.isProduction && !input.explain) {
    await confirmProductionRestore(
      backup,
      input.yes,
      input.forceProductionRestore,
      dependencies
    );
  }

  runLogger.info("restore.command", "Starting restore full execution", {
    backup: input.backup,
    to: input.to,
    skipPreBackup: input.skipPreBackup,
    outputMode: input.outputMode
  });
  await dependencies.runRestoreFull(
    appConfig,
    {
      backup: input.backup,
      to: input.to,
      skipPreBackup: input.skipPreBackup,
      outputMode: input.outputMode,
      ...(input.explain ? { explain: true } : {})
    },
    undefined,
    context
  );
}

export async function restoreCollection(
  appConfig: AppConfig,
  input: {
    backup: string;
    collections: readonly string[];
    to: EnvironmentId;
    yes: boolean;
    forceProductionRestore: boolean;
    outputMode: OutputMode;
  },
  dependencies: RestoreDependencies = DEFAULT_RESTORE_DEPENDENCIES,
  context: CommandInvocationContext = createCommandInvocationContext()
): Promise<void> {
  const runLogger = getRunLogger();
  validateCollectionSelection(input.collections);
  const backup = await dependencies.readBackup(
    appConfig.backupRoot,
    input.backup
  );
  const target = appConfig.environments[input.to];

  await confirmRestore(
    `This will replace ${input.collections.length === 1 ? "collection" : "collections"} ${formatCollectionSelection(input.collections)} in ${input.to} using backup ${backup.name}. Continue?`,
    input.yes,
    dependencies
  );
  runLogger.info("restore.command", "Restore target confirmed", {
    backup: input.backup,
    to: input.to,
    collections: input.collections,
    kind: "collection"
  });

  if (target.isProduction) {
    await confirmProductionRestore(
      backup,
      input.yes,
      input.forceProductionRestore,
      dependencies
    );
  }

  runLogger.info("restore.command", "Starting restore collection execution", {
    backup: input.backup,
    collections: input.collections,
    to: input.to,
    outputMode: input.outputMode
  });
  await dependencies.runRestoreCollection(
    appConfig,
    {
      backup: input.backup,
      collections: input.collections,
      to: input.to,
      outputMode: input.outputMode
    },
    undefined,
    context
  );
}
