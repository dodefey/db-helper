import { AppConfig, EnvironmentId } from "../config/types.js";
import {
  CommandInvocationContext,
  createCommandInvocationContext
} from "../lib/invocationContext.js";
import { promptConfirm } from "../lib/prompts.js";
import { OutputMode } from "../lib/output.js";
import { getRunLogger } from "../lib/runLog.js";
import { runSync } from "../lib/sync.js";
import {
  formatCollectionSelection,
  validateCollectionSelection
} from "../lib/collections.js";

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
    collections?: readonly string[];
    outputMode: OutputMode;
  },
  dependencies: SyncDependencies = DEFAULT_SYNC_DEPENDENCIES,
  context: CommandInvocationContext = createCommandInvocationContext()
): Promise<void> {
  const runLogger = getRunLogger();
  const targetEnv = appConfig.environments[input.to];

  if (input.from === input.to) {
    runLogger.warn("sync.command", "Blocked self-sync target", {
      from: input.from,
      to: input.to,
      collections: input.collections
    });
    throw new Error(`Sync source and target must be different: ${input.to}.`);
  }

  if (targetEnv.isProduction) {
    runLogger.warn("sync.command", "Blocked sync into production target", {
      from: input.from,
      to: input.to,
      collections: input.collections
    });
    throw new Error(
      `Sync into production environment ${input.to} is not allowed. Create a backup and use restore instead.`
    );
  }

  if (input.collections) validateCollectionSelection(input.collections);

  if (!input.yes) {
    const scope = input.collections
      ? ` [${formatCollectionSelection(input.collections)}]`
      : "";
    runLogger.info("sync.command", "Prompting for sync confirmation", {
      from: input.from,
      to: input.to,
      collections: input.collections
    });
    const approved = await dependencies.promptConfirm(
      `This will replace ${input.to}${scope} with an exact copy of ${input.from}${scope}. Continue?`
    );
    if (!approved) {
      runLogger.warn("sync.command", "Sync confirmation declined", {
        from: input.from,
        to: input.to,
        collections: input.collections
      });
      throw new Error("Sync cancelled.");
    }
  }

  runLogger.info("sync.command", "Starting sync execution", {
    from: input.from,
    to: input.to,
    collections: input.collections,
    outputMode: input.outputMode
  });
  await dependencies.runSync(
    appConfig,
    {
      from: input.from,
      to: input.to,
      ...(input.collections ? { collections: input.collections } : {}),
      outputMode: input.outputMode
    },
    undefined,
    context
  );
}
