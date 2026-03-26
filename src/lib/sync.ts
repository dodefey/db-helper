import { unlink } from "node:fs/promises";
import { AppConfig, EnvironmentId } from "../config/types.js";
import {
  createArchiveBackup,
  createLocalTempFile,
  restoreArchiveToEnvironment
} from "./mongo.js";
import { OutputMode, shouldPrintCommandSummary } from "./output.js";

export interface RunSyncDependencies {
  writeStdout: (message: string) => void;
  createLocalTempFile: (appConfig: AppConfig, suffix: string) => string;
  createArchiveBackup: typeof createArchiveBackup;
  restoreArchiveToEnvironment: typeof restoreArchiveToEnvironment;
  unlink: (path: string) => Promise<void>;
}

const DEFAULT_RUN_SYNC_DEPENDENCIES: RunSyncDependencies = {
  writeStdout: (message: string) => process.stdout.write(message),
  createLocalTempFile,
  createArchiveBackup,
  restoreArchiveToEnvironment,
  unlink
};

export async function runSync(
  appConfig: AppConfig,
  input: { from: EnvironmentId; to: EnvironmentId; outputMode: OutputMode },
  dependencies: RunSyncDependencies = DEFAULT_RUN_SYNC_DEPENDENCIES
): Promise<void> {
  const source = appConfig.environments[input.from];
  const target = appConfig.environments[input.to];
  const printSummary = shouldPrintCommandSummary(input.outputMode);
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
  } finally {
    if (printSummary) {
      dependencies.writeStdout(`Cleaning up sync temp artifacts...\n`);
    }
    await dependencies.unlink(tempArchive).catch(() => undefined);
  }
}
