#!/usr/bin/env node
import path from "node:path";
import { tmpdir } from "node:os";
import {
  getRecommendedUserConfigPath,
  loadConfig
} from "./config/loadConfig.js";
import {
  printBackupHelp,
  printConfigHelp,
  printHelp,
  printRestoreHelp,
  printSyncHelp
} from "./cliHelp.js";
import { AppConfig, EnvironmentId } from "./config/types.js";
import { backupPrune } from "./commands/backupPrune.js";
import { backupDelete } from "./commands/backupDelete.js";
import { backupCreate, backupInspect } from "./commands/backup.js";
import {
  formatBackupList,
  formatBackupUsage
} from "./commands/backupListOutput.js";
import { collectBackupCatalog } from "./lib/backupCatalog.js";
import { collectBackupUsage } from "./lib/storage.js";
import {
  QueryError,
  QueryReport,
  queryExitCode,
  queryIssue,
  queryReport
} from "./lib/queryReport.js";
import {
  runConfigPath,
  runConfigShow,
  runConfigShowRedacted,
  runConfigValidate,
  runInitFromEnvFile,
  runInteractiveInit
} from "./commands/config.js";
import { runDoctor } from "./commands/doctor.js";
import { runInteractive } from "./commands/interactive.js";
import { recoverDatabase } from "./commands/recover.js";
import { restoreCollection, restoreFull } from "./commands/restore.js";
import { validateCollectionSelection } from "./lib/collections.js";
import { syncDatabase } from "./commands/sync.js";
import { createCommandInvocationContext } from "./lib/invocationContext.js";
import { parseOutputMode } from "./lib/output.js";
import {
  createRunLogger,
  getRunLogger,
  setRunLogger,
  redactText
} from "./lib/runLog.js";
import { TOOL_VERSION } from "./version.js";

type ParsedArgs = {
  positional: string[];
  flags: Record<string, string | boolean>;
  flagEntries: Array<[name: string, value: string | boolean]>;
  collectionSelections: Array<{ flag: string; names: string[] }>;
};

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: ParsedArgs["flags"] = Object.create(null);
  const flagEntries: ParsedArgs["flagEntries"] = [];
  const collectionSelections: ParsedArgs["collectionSelections"] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }

    const name = token.slice(2);
    const next = argv[index + 1];
    const collectionFlag = /^(collection|collections)(?:=(.*))?$/s.exec(name);
    if (collectionFlag) {
      const [, flag, attached] = collectionFlag;
      if (flag === "collections") {
        collectionSelections.push({
          flag,
          names: attached === undefined ? [] : attached.split(",")
        });
      } else {
        const hasSeparateValue =
          attached === undefined &&
          next !== undefined &&
          !next.startsWith("--");
        const value = hasSeparateValue ? next : attached;
        collectionSelections.push({
          flag,
          names: value === undefined ? [] : [value]
        });
        if (hasSeparateValue) index += 1;
      }
      continue;
    }
    const missingValue =
      next === undefined ||
      (next === "" && name !== "note") ||
      next.startsWith("--");
    const value = missingValue ? true : next;
    flagEntries.push([name, value]);
    flags[name] = value;
    if (typeof value === "string") index += 1;
  }

  return { positional, flags, flagEntries, collectionSelections };
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
    throw new QueryError(
      "INVALID_ARGUMENTS",
      `Missing required flag ${flagName}`
    );
  }
  if (!appConfig.environments[value]) {
    throw new QueryError(
      "INVALID_ARGUMENTS",
      `Unknown environment ${flagName}: ${value}`
    );
  }

  return value;
}

const args = parseArgs(process.argv.slice(2));
const jsonRequested = process.argv
  .slice(2)
  .some((argument) => argument === "--json" || argument.startsWith("--json="));
const backupQuery =
  args.positional[0] === "backup" &&
  ["list", "usage"].includes(args.positional[1]);

function validateQueryArguments(): void {
  if (
    jsonRequested &&
    (!backupQuery ||
      args.flags.json !== true ||
      args.flags.help ||
      args.flags.version)
  ) {
    throw new QueryError(
      "INVALID_ARGUMENTS",
      "Use --json without a value on backup list or backup usage; help and version cannot be combined with --json."
    );
  }
  if (!backupQuery) return;
  const allowed = new Set([
    "config",
    "log",
    "quiet",
    "verbose",
    "json",
    "help",
    ...(args.positional[1] === "list" ? ["from", "tag"] : [])
  ]);
  if (args.positional.length !== 2)
    throw new QueryError(
      "INVALID_ARGUMENTS",
      "Unexpected positional arguments for backup query."
    );
  for (const [name, value] of Object.entries(args.flags)) {
    if (!allowed.has(name))
      throw new QueryError("INVALID_ARGUMENTS", `Unknown flag --${name}`);
    const takesValue = ["config", "from", "tag"].includes(name);
    if (
      takesValue ? typeof value !== "string" || !value.trim() : value !== true
    ) {
      throw new QueryError(
        "INVALID_ARGUMENTS",
        `Flag --${name} ${takesValue ? "requires a value" : "does not accept a value"}.`
      );
    }
  }
  if (args.flags.quiet && args.flags.verbose)
    throw new QueryError(
      "INVALID_ARGUMENTS",
      "Flags --quiet and --verbose cannot be used together"
    );
}

async function main(): Promise<void> {
  if (
    !jsonRequested &&
    args.flags.version === true &&
    args.positional.length === 0
  ) {
    process.stdout.write(`dbh ${TOOL_VERSION}\n`);
    return;
  }

  const [command, subcommand, third] = args.positional;
  const keepDebugLog = getBooleanFlag(args.flags, "log");
  const commandName = command || "help";
  const runLogger = await createRunLogger({
    commandName,
    ...(backupQuery ? { logRoot: tmpdir() } : {})
  });
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
  const finishQuery = async <T>(
    report: QueryReport<T>,
    humanOutput: string
  ): Promise<void> => {
    for (const issue of report.issues)
      runLogger.warn("backup.query", issue.message, issue);
    if (report.status === "ok")
      await runLogger.finalizeSuccess({ keep: keepDebugLog });
    else await runLogger.finalizeFailure();
    if (keepDebugLog || report.status !== "ok")
      report.debugLogPath = runLogger.logPath || null;
    process.stdout.write(
      jsonRequested ? `${JSON.stringify(report, null, 2)}\n` : humanOutput
    );
    if (!jsonRequested) {
      for (const issue of report.issues)
        process.stderr.write(
          `${issue.code}: ${issue.message} ${issue.path ?? ""}\n`
        );
    }
    if (report.debugLogPath)
      (jsonRequested || report.status !== "ok"
        ? process.stderr
        : process.stdout
      ).write(`Debug log saved: ${report.debugLogPath}\n`);
    setRunLogger();
    process.exitCode = queryExitCode(report.status);
  };

  validateQueryArguments();
  const pluralSelection = args.collectionSelections.find(
    ({ flag }) => flag === "collections"
  );
  if (pluralSelection?.names.length === 0) {
    throw new Error(
      "Use --collections=name1,name2 or repeat --collection <name>."
    );
  }
  const backupCreateCommand = command === "backup" && subcommand === "create";
  if (backupCreateCommand) {
    if (args.positional.length !== 2) {
      throw new Error("Unexpected positional arguments for backup create.");
    }
    const valueFlags = new Set(["from", "name", "note", "tag", "config"]);
    const booleanFlags = new Set(["quiet", "verbose", "log", "help"]);
    for (const [flag, value] of args.flagEntries) {
      const takesValue = valueFlags.has(flag);
      if (!takesValue && !booleanFlags.has(flag)) {
        throw new Error(`Unknown flag --${flag}`);
      }
      if (takesValue && typeof value !== "string") {
        throw new Error(`Flag --${flag} requires a value.`);
      }
      if (!takesValue && value !== true) {
        throw new Error(`Flag --${flag} does not accept a value.`);
      }
    }
  }
  const collectionCommand =
    (command === "sync" || command === "restore") &&
    subcommand === "collection";
  const [selection] = args.collectionSelections;
  let collections: string[] | undefined;
  if (selection) {
    if (!collectionCommand && !backupCreateCommand) {
      throw new Error(
        `--${selection.flag} is supported by backup create, sync collection, and restore collection.`
      );
    }
    if (pluralSelection && args.collectionSelections.length > 1) {
      throw new Error(
        "Use either one --collections=name1,name2 flag or repeat --collection."
      );
    }
    const missingName = args.collectionSelections.find(
      ({ names }) => names.length === 0 || names.includes("")
    );
    if (missingName) {
      throw new Error(`Flag --${missingName.flag} requires a collection name.`);
    }
    collections = args.collectionSelections.flatMap(({ names }) => names);
    validateCollectionSelection(collections);
    if (args.positional.length !== 2) {
      throw new Error(
        "Use --collections=name1,name2 or repeat --collection <name>."
      );
    }
  } else if (collectionCommand && !getBooleanFlag(args.flags, "help")) {
    throw new Error(
      "Missing collection selection. Use --collections=name1,name2 or repeat --collection <name>."
    );
  }
  if (
    command === "sync" &&
    subcommand &&
    !["collection", "full"].includes(subcommand)
  ) {
    throw new Error(`Unknown sync subcommand: ${subcommand}`);
  }
  if (command === "backup" && subcommand === "delete") {
    if (args.positional.length !== 2)
      throw new Error("Backup delete accepts one name via --backup only.");
    const allowed = new Set([
      "backup",
      "yes",
      "config",
      "quiet",
      "verbose",
      "log",
      "help"
    ]);
    for (const [flag, value] of Object.entries(args.flags)) {
      if (!allowed.has(flag)) throw new Error(`Unknown flag --${flag}`);
      const takesValue = flag === "backup" || flag === "config";
      if (
        takesValue ? typeof value !== "string" || !value.trim() : value !== true
      )
        throw new Error(`Invalid value for --${flag}`);
    }
    if (
      process.argv.slice(2).filter((value) => value === "--backup").length > 1
    )
      throw new Error("Specify --backup exactly once.");
  }

  if (command === "backup" && subcommand === "prune") {
    if (args.positional.length !== 2)
      throw new Error("Unexpected positional arguments for backup prune.");
    const allowed = new Set([
      "keep-last",
      "dry-run",
      "yes",
      "config",
      "quiet",
      "verbose",
      "log",
      "help"
    ]);
    for (const [flag, value] of Object.entries(args.flags)) {
      if (!allowed.has(flag)) throw new Error(`Unknown flag --${flag}`);
      const takesValue = flag === "keep-last" || flag === "config";
      if (
        takesValue ? typeof value !== "string" || !value.trim() : value !== true
      )
        throw new Error(`Invalid value for --${flag}`);
      if (
        process.argv.slice(2).filter((value) => value === `--${flag}`).length >
        1
      )
        throw new Error(`Specify --${flag} only once.`);
    }
    if (
      !args.flags.help &&
      !/^[0-9]+$/.test(getFlag(args.flags, "keep-last", true)!)
    )
      throw new Error("--keep-last must be an integer of at least 1.");
  }

  if (!command || command === "--help" || command === "help") {
    runLogger.info("cli", "Printing help");
    printHelp(getRecommendedUserConfigPath());
    await finishSuccess();
    return;
  }

  if (getBooleanFlag(args.flags, "help")) {
    if (command === "config") {
      runLogger.info("cli", "Printing config help");
      printConfigHelp();
      await finishSuccess();
      return;
    }
    if (command === "backup") {
      runLogger.info("cli", "Printing backup help");
      printBackupHelp();
      await finishSuccess();
      return;
    }
    if (command === "sync") {
      runLogger.info("cli", "Printing sync help");
      printSyncHelp();
      await finishSuccess();
      return;
    }
    if (command === "restore") {
      runLogger.info("cli", "Printing restore help");
      printRestoreHelp();
      await finishSuccess();
      return;
    }
    if (
      command === "init" ||
      command === "interactive" ||
      command === "recover" ||
      command === "doctor"
    ) {
      runLogger.info("cli", "Printing help");
      printHelp(getRecommendedUserConfigPath());
      await finishSuccess();
      return;
    }
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
        if (
          getBooleanFlag(args.flags, "redacted") &&
          getBooleanFlag(args.flags, "unredacted")
        ) {
          throw new Error(
            "Config show flags --redacted and --unredacted cannot be used together."
          );
        }
        if (getBooleanFlag(args.flags, "unredacted")) {
          runLogger.info("cli", "Running config show unredacted");
          await runConfigShow({
            configPath: getFlag(args.flags, "config"),
            redacted: false
          });
          await finishSuccess();
          return;
        }
        if (getBooleanFlag(args.flags, "redacted")) {
          runLogger.info("cli", "Running config show redacted");
          await runConfigShowRedacted(getFlag(args.flags, "config"));
          await finishSuccess();
          return;
        }
        runLogger.info("cli", "Running config show redacted");
        await runConfigShow({
          configPath: getFlag(args.flags, "config"),
          redacted: true
        });
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

  let appConfig: AppConfig;
  try {
    appConfig = await loadConfig(getFlag(args.flags, "config"));
  } catch (error) {
    if (backupQuery)
      throw new QueryError(
        "CONFIG_ERROR",
        redactText(error instanceof Error ? error.message : String(error))
      );
    throw error;
  }
  // Queries must not create a missing configured temp root just to relocate a log.
  if (!backupQuery)
    await runLogger.relocate(path.join(appConfig.tempRoot, "logs"));
  runLogger.info("cli", "Loaded config", {
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
            backupName: getFlag(args.flags, "name"),
            collections,
            note: getFlag(args.flags, "note") || undefined,
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
        const report = await collectBackupCatalog(appConfig.backupRoot, {
          from: getFlag(args.flags, "from")
            ? resolveEnvironment(
                appConfig,
                getFlag(args.flags, "from"),
                "--from"
              )
            : undefined,
          tag: getFlag(args.flags, "tag")
        });
        await finishQuery(
          report,
          report.status === "error"
            ? ""
            : formatBackupList(report.data.backups, outputMode)
        );
        return;
      }
      if (subcommand === "usage") {
        const report = await collectBackupUsage(appConfig);
        await finishQuery(report, formatBackupUsage(report.data, outputMode));
        return;
      }
      if (subcommand === "prune") {
        await backupPrune(appConfig, {
          keepLast: Number(getFlag(args.flags, "keep-last", true)),
          dryRun: getBooleanFlag(args.flags, "dry-run"),
          yes: getBooleanFlag(args.flags, "yes"),
          outputMode
        });
        await finishSuccess();
        return;
      }
      if (subcommand === "delete") {
        await backupDelete(appConfig, {
          backup: getFlag(args.flags, "backup", true)!,
          yes: getBooleanFlag(args.flags, "yes"),
          outputMode
        });
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
      runLogger.info(
        "cli",
        collections ? "Running sync collection" : "Running sync"
      );
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
          collections,
          yes: getBooleanFlag(args.flags, "yes"),
          outputMode
        },
        undefined,
        invocationContext
      );
      await finishSuccess();
      return;
    case "restore":
      if (
        subcommand === "full" ||
        (subcommand === undefined && getBooleanFlag(args.flags, "explain"))
      ) {
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
            outputMode,
            ...(getBooleanFlag(args.flags, "explain") ? { explain: true } : {})
          },
          undefined,
          invocationContext
        );
        await finishSuccess();
        return;
      }
      if (subcommand === "collection" && collections) {
        if (getBooleanFlag(args.flags, "explain")) {
          throw new Error("--explain is only supported for full restore.");
        }
        runLogger.info("cli", "Running restore collection");
        await restoreCollection(
          appConfig,
          {
            backup: getFlag(args.flags, "backup", true)!,
            collections,
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
    // Still return a JSON failure if diagnostic log persistence itself fails.
    try {
      await runLogger.finalizeFailure();
    } catch {
      /* The original command failure remains primary. */
    }
    if (jsonRequested) {
      const report = queryReport(
        args.positional.slice(0, 2).join("."),
        null,
        [
          queryIssue(
            error instanceof QueryError ? error.code : "COMMAND_FAILED",
            null,
            error instanceof Error ? error.message : String(error)
          )
        ],
        "error"
      );
      report.debugLogPath = runLogger.logPath || null;
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    }
    if (shouldPrint && !jsonRequested) {
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
