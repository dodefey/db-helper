import { AppConfig, BackupRecord, EnvironmentId } from "../config/types.js";
import {
  archivePathForBackup,
  ensureBackupArtifacts,
  readBackup
} from "../lib/backups.js";
import { restoreArchiveToEnvironment } from "../lib/mongo.js";
import { promptConfirm, promptText } from "../lib/prompts.js";
import { verifyRestore } from "../lib/verify.js";
import { backupCreate } from "./backup.js";

async function confirmRestore(to: EnvironmentId, yes: boolean): Promise<void> {
  if (yes) {
    return;
  }

  const approved = await promptConfirm(
    `This will restore data into ${to}. Continue?`
  );
  if (!approved) {
    throw new Error("Restore cancelled.");
  }
}

async function confirmProductionRestore(
  backup: BackupRecord,
  yes: boolean,
  force: boolean
): Promise<void> {
  if (!force) {
    throw new Error("Production restore requires --force-production-restore");
  }

  if (yes) {
    return;
  }

  const phrase = await promptText(
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
  }
): Promise<void> {
  await ensureBackupArtifacts(appConfig.backupRoot, input.backup);
  const backup = await readBackup(appConfig.backupRoot, input.backup);
  const target = appConfig.environments[input.to];

  await confirmRestore(input.to, input.yes);

  if (target.isProduction) {
    await confirmProductionRestore(
      backup,
      input.yes,
      input.forceProductionRestore
    );
    if (!input.skipPreBackup) {
      await backupCreate(appConfig, {
        from: "production",
        note: `automatic pre-restore backup before restoring ${input.backup}`,
        tags: ["pre-restore"],
        outputMode: "default"
      });
    }
  }

  await restoreArchiveToEnvironment(
    target,
    appConfig,
    archivePathForBackup(appConfig.backupRoot, input.backup),
    {
      drop: appConfig.defaultDropOnRestore
    }
  );

  const verification = await verifyRestore(target, backup.manifest);
  if (
    verification.missingCollections.length > 0 ||
    verification.countMismatches.length > 0
  ) {
    throw new Error(
      `Restore verification failed for ${backup.name} -> ${input.to}\n` +
        `Missing collections: ${verification.missingCollections.join(", ") || "none"}\n` +
        `Count mismatches: ${
          verification.countMismatches
            .map(
              (item) =>
                `${item.collection} expected=${item.expected} actual=${item.actual}`
            )
            .join(", ") || "none"
        }`
    );
  }
}

export async function restoreCollection(
  appConfig: AppConfig,
  input: { backup: string; collection: string; to: EnvironmentId; yes: boolean }
): Promise<void> {
  await ensureBackupArtifacts(appConfig.backupRoot, input.backup);
  const backup = await readBackup(appConfig.backupRoot, input.backup);
  if (!backup.manifest.collectionList.includes(input.collection)) {
    throw new Error(
      `Collection ${input.collection} not present in backup ${input.backup}`
    );
  }

  await confirmRestore(input.to, input.yes);
  await restoreArchiveToEnvironment(
    appConfig.environments[input.to],
    appConfig,
    archivePathForBackup(appConfig.backupRoot, input.backup),
    { collection: input.collection, drop: true }
  );
}
