#!/usr/bin/env node
import path from "node:path";
import {
  getRecommendedUserConfigPath,
  loadConfig
} from "./config/loadConfig.js";
import { AppConfig, EnvironmentId } from "./config/types.js";
import { backupCreate, backupInspect, backupList } from "./commands/backup.js";
import {
  runConfigPath,
  runConfigShowRedacted,
  runConfigValidate,
  runInitFromEnvFile,
  runInteractiveInit
} from "./commands/config.js";
import { runDoctor } from "./commands/doctor.js";
import { runInteractive } from "./commands/interactive.js";
import { recoverDatabase } from "./commands/recover.js";
import { restoreCollection, restoreFull } from "./commands/restore.js";
import { syncDatabase } from "./commands/sync.js";
import { createCommandInvocationContext } from "./lib/invocationContext.js";
import { parseOutputMode } from "./lib/output.js";
import { createRunLogger, getRunLogger, setRunLogger } from "./lib/runLog.js";

type ParsedArgs = {
  positional: string[];
  flags: Record<string, string | boolean>;
};

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }

    const name = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      flags[name] = true;
      continue;
    }

    flags[name] = next;
    index += 1;
  }

  return { positional, flags };
}

function getFlag(
  flags: ParsedArgs["flags"],
  name: string,
  required = false
): string | undefined {
  const value = flags[name];
  if (typeof value === "string") {
    return value;
  }
  if (required) {
    throw new Error(`Missing required flag --${name}`);
  }
  return undefined;
}

function getBooleanFlag(flags: ParsedArgs["flags"], name: string): boolean {
  return flags[name] === true;
}

function resolveEnvironment(
  appConfig: AppConfig,
  value: string | undefined,
  flagName: string
): EnvironmentId {
  if (!value) {
    throw new Error(`Missing required flag ${flagName}`);
  }
  if (!appConfig.environments[value]) {
    throw new Error(`Unknown environment ${flagName}: ${value}`);
  }

  return value;
}

function printHelp(): void {
  process.stdout.write(`dbh

Global flags:
  --config <path>
  --log

Default config search:
  ./config.json
  ${getRecommendedUserConfigPath()}

Commands:
  init [--from-env-file <path>] [--config <path>] [--force]
  config validate
  config path
  config show --redacted
  interactive
  backup create --from <environment> [--note <text>] [--tag <tag>] [--quiet] [--verbose] [--log]
  backup list [--from <environment>] [--tag <tag>]
  backup inspect --backup <backup-name>
  sync --from <environment> --to <environment> [--yes] [--quiet] [--verbose] [--log]
  sync collection --from <environment> --to <environment> --collection <name> [--yes] [--quiet] [--verbose] [--log]
  restore full --backup <backup-name> --to <environment> [--yes] [--skip-pre-backup] [--force-production-restore] [--quiet] [--verbose] [--log]
  restore collection --backup <backup-name> --collection <name> --to <environment> [--yes] [--force-production-restore] [--quiet] [--verbose] [--log]
  recover
  doctor
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const [command, subcommand, third] = args.positional;
  const keepDebugLog = getBooleanFlag(args.flags, "log");
  const commandName = command || "help";
  const runLogger = await createRunLogger({ commandName });
  setRunLogger(runLogger);
  runLogger.info("cli", "CLI invocation started", {
    command,
    subcommand,
    third,
    flags: args.flags
  });
  const finishSuccess = async (): Promise<void> => {
    await runLogger.finalizeSuccess({ keep: keepDebugLog });
    if (keepDebugLog) {
      process.stdout.write(`Debug log saved: ${runLogger.logPath}\n`);
    }
    setRunLogger();
  };

  if (!command || command === "--help" || command === "help") {
    runLogger.info("cli", "Printing help");
    printHelp();
    await finishSuccess();
    return;
  }

  const outputMode = parseOutputMode({
    quiet: getBooleanFlag(args.flags, "quiet"),
    verbose: getBooleanFlag(args.flags, "verbose")
  });
  const invocationContext = createCommandInvocationContext();

  switch (command) {
    case "init":
      if (getFlag(args.flags, "from-env-file")) {
        runLogger.info("cli", "Running init from env file");
        await runInitFromEnvFile({
          fromEnvFile: getFlag(args.flags, "from-env-file", true)!,
          configPath: getFlag(args.flags, "config"),
          force: getBooleanFlag(args.flags, "force")
        });
        await finishSuccess();
        return;
      }
      runLogger.info("cli", "Running interactive init");
      await runInteractiveInit({
        configPath: getFlag(args.flags, "config"),
        force: getBooleanFlag(args.flags, "force")
      });
      await finishSuccess();
      return;
    case "config":
      if (subcommand === "validate") {
        runLogger.info("cli", "Running config validate");
        await runConfigValidate(getFlag(args.flags, "config"));
        await finishSuccess();
        return;
      }
      if (subcommand === "path") {
        runLogger.info("cli", "Running config path");
        await runConfigPath(getFlag(args.flags, "config"));
        await finishSuccess();
        return;
      }
      if (subcommand === "show") {
        if (!getBooleanFlag(args.flags, "redacted")) {
          throw new Error(
            "Config show requires --redacted. Refusing to print secrets."
          );
        }
        runLogger.info("cli", "Running config show redacted");
        await runConfigShowRedacted(getFlag(args.flags, "config"));
        await finishSuccess();
        return;
      }
      break;
    case "interactive":
      break;
    case "backup":
    case "sync":
    case "restore":
    case "recover":
    case "doctor":
      break;
    default:
      break;
  }

  const appConfig = await loadConfig(getFlag(args.flags, "config"));
  await runLogger.relocate(path.join(appConfig.tempRoot, "logs"));
  runLogger.info("cli", "Loaded config and relocated run log", {
    tempRoot: appConfig.tempRoot
  });

  switch (command) {
    case "interactive":
      runLogger.info("cli", "Running interactive command");
      await runInteractive(appConfig);
      await finishSuccess();
      return;
    case "backup":
      if (subcommand === "create") {
        runLogger.info("cli", "Running backup create");
        await backupCreate(
          appConfig,
          {
            from: resolveEnvironment(
              appConfig,
              getFlag(args.flags, "from", true),
              "--from"
            ),
            note: getFlag(args.flags, "note"),
            tags: getFlag(args.flags, "tag")
              ? [getFlag(args.flags, "tag")!]
              : [],
            outputMode
          },
          undefined,
          invocationContext
        );
        await finishSuccess();
        return;
      }
      if (subcommand === "list") {
        runLogger.info("cli", "Running backup list");
        const records = await backupList(appConfig, {
          from: getFlag(args.flags, "from")
            ? resolveEnvironment(
                appConfig,
                getFlag(args.flags, "from"),
                "--from"
              )
            : undefined,
          tag: getFlag(args.flags, "tag")
        });
        for (const record of records) {
          process.stdout.write(
            `${record.name}\t${record.manifest.sourceEnvironment}\t${record.manifest.createdAt}\t${record.manifest.tags.join(",") || "-"}\n`
          );
        }
        await finishSuccess();
        return;
      }
      if (subcommand === "inspect") {
        runLogger.info("cli", "Running backup inspect");
        const record = await backupInspect(
          appConfig,
          getFlag(args.flags, "backup", true)!
        );
        process.stdout.write(`${JSON.stringify(record.manifest, null, 2)}\n`);
        await finishSuccess();
        return;
      }
      break;
    case "sync":
      if (subcommand === "collection") {
        runLogger.info("cli", "Running sync collection");
        await syncDatabase(
          appConfig,
          {
            from: resolveEnvironment(
              appConfig,
              getFlag(args.flags, "from", true),
              "--from"
            ),
            to: resolveEnvironment(
              appConfig,
              getFlag(args.flags, "to", true),
              "--to"
            ),
            collection: getFlag(args.flags, "collection", true)!,
            yes: getBooleanFlag(args.flags, "yes"),
            outputMode
          },
          undefined,
          invocationContext
        );
        await finishSuccess();
        return;
      }
      runLogger.info("cli", "Running sync");
      await syncDatabase(
        appConfig,
        {
          from: resolveEnvironment(
            appConfig,
            getFlag(args.flags, "from", true),
            "--from"
          ),
          to: resolveEnvironment(
            appConfig,
            getFlag(args.flags, "to", true),
            "--to"
          ),
          yes: getBooleanFlag(args.flags, "yes"),
          outputMode
        },
        undefined,
        invocationContext
      );
      await finishSuccess();
      return;
    case "restore":
      if (subcommand === "full") {
        runLogger.info("cli", "Running restore full");
        await restoreFull(
          appConfig,
          {
            backup: getFlag(args.flags, "backup", true)!,
            to: resolveEnvironment(
              appConfig,
              getFlag(args.flags, "to", true),
              "--to"
            ),
            yes: getBooleanFlag(args.flags, "yes"),
            skipPreBackup: getBooleanFlag(args.flags, "skip-pre-backup"),
            forceProductionRestore: getBooleanFlag(
              args.flags,
              "force-production-restore"
            ),
            outputMode
          },
          undefined,
          invocationContext
        );
        await finishSuccess();
        return;
      }
      if (subcommand === "collection") {
        runLogger.info("cli", "Running restore collection");
        await restoreCollection(
          appConfig,
          {
            backup: getFlag(args.flags, "backup", true)!,
            collection: getFlag(args.flags, "collection", true)!,
            to: resolveEnvironment(
              appConfig,
              getFlag(args.flags, "to", true),
              "--to"
            ),
            yes: getBooleanFlag(args.flags, "yes"),
            forceProductionRestore: getBooleanFlag(
              args.flags,
              "force-production-restore"
            ),
            outputMode
          },
          undefined,
          invocationContext
        );
        await finishSuccess();
        return;
      }
      break;
    case "recover":
      runLogger.info("cli", "Running recover");
      await recoverDatabase(appConfig);
      await finishSuccess();
      return;
    case "doctor":
      runLogger.info("cli", "Running doctor");
      await runDoctor(appConfig, undefined, invocationContext);
      await finishSuccess();
      return;
  }

  throw new Error(
    `Unknown command: ${[command, subcommand, third].filter(Boolean).join(" ")}`
  );
}

main().catch((error) => {
  const runLogger = getRunLogger();
  runLogger.error("cli", "CLI invocation failed", {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined
  });
  const shouldPrint =
    !(error instanceof Error) ||
    !("alreadyReported" in error) ||
    error.alreadyReported !== true;

  void (async () => {
    await runLogger.finalizeFailure();
    if (shouldPrint) {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`
      );
    }
    if (runLogger.logPath) {
      process.stderr.write(`Debug log saved: ${runLogger.logPath}\n`);
    }
    setRunLogger();
    process.exitCode = 1;
  })();
});
