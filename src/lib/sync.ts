import { unlink } from "node:fs/promises";
import { AppConfig, BackupManifest, EnvironmentId } from "../config/types.js";
import {
  createArchiveBackup,
  createLocalTempFile,
  getCollectionCounts,
  listCollections,
  restoreArchiveToEnvironment
} from "./mongo.js";
import { OutputMode, shouldPrintCommandSummary } from "./output.js";
import { verifyRestore } from "./verify.js";

export interface RunSyncDependencies {
  writeStdout: (message: string) => void;
  createLocalTempFile: (appConfig: AppConfig, suffix: string) => string;
  createArchiveBackup: typeof createArchiveBackup;
  listCollections: typeof listCollections;
  getCollectionCounts: typeof getCollectionCounts;
  restoreArchiveToEnvironment: typeof restoreArchiveToEnvironment;
  verifyRestore: typeof verifyRestore;
  unlink: (path: string) => Promise<void>;
}

const DEFAULT_RUN_SYNC_DEPENDENCIES: RunSyncDependencies = {
  writeStdout: (message: string) => process.stdout.write(message),
  createLocalTempFile,
  createArchiveBackup,
  listCollections,
  getCollectionCounts,
  restoreArchiveToEnvironment,
  verifyRestore,
  unlink
};

function buildSyncVerificationManifest(
  from: EnvironmentId,
  collectionList: string[],
  collectionCounts: Record<string, number>
): BackupManifest {
  return {
    backupName: `sync-${from}`,
    sourceEnvironment: from,
    databaseName: from,
    createdAt: new Date(0).toISOString(),
    tags: [],
    collectionList,
    toolVersion: "sync-verification",
    archiveFile: "sync",
    collectionCounts
  };
}

export async function runSync(
  appConfig: AppConfig,
  input: { from: EnvironmentId; to: EnvironmentId; outputMode: OutputMode },
  dependencies: RunSyncDependencies = DEFAULT_RUN_SYNC_DEPENDENCIES
): Promise<void> {
  const source = appConfig.environments[input.from];
  const target = appConfig.environments[input.to];
  const printSummary = shouldPrintCommandSummary(input.outputMode);
  const collectionList = await dependencies.listCollections(source);
  const collectionCounts = await dependencies.getCollectionCounts(
    source,
    collectionList
  );
  const verificationManifest = buildSyncVerificationManifest(
    input.from,
    collectionList,
    collectionCounts
  );
  const tempArchive = dependencies.createLocalTempFile(
    appConfig,
    ".archive.gz"
  );

  try {
    if (printSummary) {
      dependencies.writeStdout(`Starting sync ${input.from} -> ${input.to}\n`);
      dependencies.writeStdout(`Dumping source ${input.from}...\n`);
    }
    await dependencies.createArchiveBackup(source, appConfig, tempArchive, {
      outputMode: input.outputMode
    });
    if (printSummary) {
      dependencies.writeStdout(`Restoring target ${input.to}...\n`);
    }
    await dependencies.restoreArchiveToEnvironment(
      target,
      appConfig,
      tempArchive,
      { drop: true, outputMode: input.outputMode }
    );
    if (printSummary) {
      dependencies.writeStdout(`Verifying target ${input.to}...\n`);
    }
    const verification = await dependencies.verifyRestore(
      target,
      verificationManifest
    );
    if (
      verification.missingCollections.length > 0 ||
      verification.countMismatches.length > 0
    ) {
      throw new Error(
        `Sync verification failed for ${input.from} -> ${input.to}\n` +
          `Missing collections: ${
            verification.missingCollections.join(", ") || "none"
          }\n` +
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
    if (printSummary) {
      dependencies.writeStdout(`Sync ${input.from} -> ${input.to} complete.\n`);
    }
  } finally {
    if (printSummary) {
      dependencies.writeStdout(`Cleaning up sync temp artifacts...\n`);
    }
    await dependencies.unlink(tempArchive).catch(() => undefined);
  }
}
