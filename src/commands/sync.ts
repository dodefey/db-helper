import { AppConfig, EnvironmentId } from "../config/types.js";
import {
  CommandInvocationContext,
  createCommandInvocationContext
} from "../lib/invocationContext.js";
import { promptConfirm } from "../lib/prompts.js";
import { OutputMode } from "../lib/output.js";
import { getRunLogger } from "../lib/runLog.js";
import { runSync } from "../lib/sync.js";

export interface SyncDependencies {
  promptConfirm: (message: string) => Promise<boolean>;
  runSync: typeof runSync;
}

const DEFAULT_SYNC_DEPENDENCIES: SyncDependencies = {
  promptConfirm,
  runSync
};

export async function syncDatabase(
  appConfig: AppConfig,
  input: {
    from: EnvironmentId;
    to: EnvironmentId;
    yes: boolean;
    collection?: string;
    outputMode: OutputMode;
  },
  dependencies: SyncDependencies = DEFAULT_SYNC_DEPENDENCIES,
  context: CommandInvocationContext = createCommandInvocationContext()
): Promise<void> {
  const runLogger = getRunLogger();
  const targetEnv = appConfig.environments[input.to];

  if (targetEnv.isProduction) {
    runLogger.warn("sync.command", "Blocked sync into production target", {
      from: input.from,
      to: input.to,
      collection: input.collection
    });
    throw new Error(
      `Sync into production environment ${input.to} is not allowed. Create a backup and use restore instead.`
    );
  }

  const source = input.collection
    ? `${input.from}.${input.collection}`
    : input.from;
  const target = input.collection
    ? `${input.to}.${input.collection}`
    : input.to;

  if (!input.yes) {
    runLogger.info("sync.command", "Prompting for sync confirmation", {
      from: input.from,
      to: input.to,
      collection: input.collection
    });
    const approved = await dependencies.promptConfirm(
      `This will replace ${target} with an exact copy of ${source}. Continue?`
    );
    if (!approved) {
      runLogger.warn("sync.command", "Sync confirmation declined", {
        from: input.from,
        to: input.to,
        collection: input.collection
      });
      throw new Error("Sync cancelled.");
    }
  }

  runLogger.info("sync.command", "Starting sync execution", {
    from: input.from,
    to: input.to,
    collection: input.collection,
    outputMode: input.outputMode
  });
  await dependencies.runSync(
    appConfig,
    {
      from: input.from,
      to: input.to,
      ...(input.collection ? { collection: input.collection } : {}),
      outputMode: input.outputMode
    },
    undefined,
    context
  );
}
