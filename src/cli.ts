#!/usr/bin/env node
import { loadConfig } from "./config/loadConfig.js";
import { ENVIRONMENT_IDS, EnvironmentId } from "./config/types.js";
import { backupCreate, backupInspect, backupList } from "./commands/backup.js";
import { runDoctor } from "./commands/doctor.js";
import { runInteractive } from "./commands/interactive.js";
import { recoverDatabase } from "./commands/recover.js";
import { restoreCollection, restoreFull } from "./commands/restore.js";
import { syncDatabase } from "./commands/sync.js";
import { parseOutputMode } from "./lib/output.js";

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

function parseEnvironment(
  value: string | undefined,
  flagName: string
): EnvironmentId {
  if (!value || !ENVIRONMENT_IDS.includes(value as EnvironmentId)) {
    throw new Error(
      `Invalid ${flagName}. Expected one of: ${ENVIRONMENT_IDS.join(", ")}`
    );
  }
  return value as EnvironmentId;
}

function printHelp(): void {
  process.stdout.write(`db-helper

Global flags:
  --config <path>

Commands:
  interactive
  backup create --from <environment> [--note <text>] [--tag <tag>] [--quiet] [--verbose]
  backup list [--from <environment>] [--tag <tag>]
  backup inspect --backup <backup-name>
  sync --from <environment> --to <environment> [--yes] [--quiet] [--verbose]
  restore full --backup <backup-name> --to <environment> [--yes] [--skip-pre-backup] [--force-production-restore] [--quiet] [--verbose]
  restore collection --backup <backup-name> --collection <name> --to <environment> [--yes] [--force-production-restore] [--quiet] [--verbose]
  recover
  doctor
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const [command, subcommand, third] = args.positional;

  if (!command || command === "--help" || command === "help") {
    printHelp();
    return;
  }

  const appConfig = await loadConfig(getFlag(args.flags, "config"));
  const outputMode = parseOutputMode({
    quiet: getBooleanFlag(args.flags, "quiet"),
    verbose: getBooleanFlag(args.flags, "verbose")
  });

  switch (command) {
    case "interactive":
      await runInteractive(appConfig);
      return;
    case "backup":
      if (subcommand === "create") {
        await backupCreate(appConfig, {
          from: parseEnvironment(getFlag(args.flags, "from", true), "--from"),
          note: getFlag(args.flags, "note"),
          tags: getFlag(args.flags, "tag") ? [getFlag(args.flags, "tag")!] : [],
          outputMode
        });
        return;
      }
      if (subcommand === "list") {
        const records = await backupList(appConfig, {
          from: getFlag(args.flags, "from")
            ? parseEnvironment(getFlag(args.flags, "from"), "--from")
            : undefined,
          tag: getFlag(args.flags, "tag")
        });
        for (const record of records) {
          process.stdout.write(
            `${record.name}\t${record.manifest.sourceEnvironment}\t${record.manifest.createdAt}\t${record.manifest.tags.join(",") || "-"}\n`
          );
        }
        return;
      }
      if (subcommand === "inspect") {
        const record = await backupInspect(
          appConfig,
          getFlag(args.flags, "backup", true)!
        );
        process.stdout.write(`${JSON.stringify(record.manifest, null, 2)}\n`);
        return;
      }
      break;
    case "sync":
      await syncDatabase(appConfig, {
        from: parseEnvironment(getFlag(args.flags, "from", true), "--from"),
        to: parseEnvironment(getFlag(args.flags, "to", true), "--to"),
        yes: getBooleanFlag(args.flags, "yes"),
        outputMode
      });
      return;
    case "restore":
      if (subcommand === "full") {
        await restoreFull(appConfig, {
          backup: getFlag(args.flags, "backup", true)!,
          to: parseEnvironment(getFlag(args.flags, "to", true), "--to"),
          yes: getBooleanFlag(args.flags, "yes"),
          skipPreBackup: getBooleanFlag(args.flags, "skip-pre-backup"),
          forceProductionRestore: getBooleanFlag(
            args.flags,
            "force-production-restore"
          ),
          outputMode
        });
        return;
      }
      if (subcommand === "collection") {
        await restoreCollection(appConfig, {
          backup: getFlag(args.flags, "backup", true)!,
          collection: getFlag(args.flags, "collection", true)!,
          to: parseEnvironment(getFlag(args.flags, "to", true), "--to"),
          yes: getBooleanFlag(args.flags, "yes"),
          forceProductionRestore: getBooleanFlag(
            args.flags,
            "force-production-restore"
          ),
          outputMode
        });
        return;
      }
      break;
    case "recover":
      await recoverDatabase(appConfig);
      return;
    case "doctor":
      await runDoctor(appConfig);
      return;
  }

  throw new Error(
    `Unknown command: ${[command, subcommand, third].filter(Boolean).join(" ")}`
  );
}

main().catch((error) => {
  const shouldPrint =
    !(error instanceof Error) ||
    !("alreadyReported" in error) ||
    error.alreadyReported !== true;

  if (shouldPrint) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`
    );
  }
  process.exitCode = 1;
});
