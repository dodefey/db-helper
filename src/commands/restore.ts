import { AppConfig, BackupRecord, EnvironmentId } from "../config/types.js";
import {
  readBackup
} from "../lib/backups.js";
import { promptConfirm, promptText } from "../lib/prompts.js";
import {
  runRestoreCollection,
  runRestoreFull
} from "../lib/restore.js";
import { OutputMode } from "../lib/output.js";

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
  to: EnvironmentId,
  yes: boolean,
  dependencies: RestoreDependencies
): Promise<void> {
  if (yes) {
    return;
  }

  const approved = await dependencies.promptConfirm(
    `This will restore data into ${to}. Continue?`
  );
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
  },
  dependencies: RestoreDependencies = DEFAULT_RESTORE_DEPENDENCIES
): Promise<void> {
  const backup = await dependencies.readBackup(appConfig.backupRoot, input.backup);
  const target = appConfig.environments[input.to];

  await confirmRestore(input.to, input.yes, dependencies);

  if (target.isProduction) {
    await confirmProductionRestore(
      backup,
      input.yes,
      input.forceProductionRestore,
      dependencies
    );
  }

  await dependencies.runRestoreFull(appConfig, {
    backup: input.backup,
    to: input.to,
    skipPreBackup: input.skipPreBackup,
    outputMode: input.outputMode
  });
}

export async function restoreCollection(
  appConfig: AppConfig,
  input: {
    backup: string;
    collection: string;
    to: EnvironmentId;
    yes: boolean;
    outputMode: OutputMode;
  },
  dependencies: RestoreDependencies = DEFAULT_RESTORE_DEPENDENCIES
): Promise<void> {
  await confirmRestore(input.to, input.yes, dependencies);
  await dependencies.runRestoreCollection(appConfig, {
    backup: input.backup,
    collection: input.collection,
    to: input.to,
    outputMode: input.outputMode
  });
}
