export function printHelp(recommendedUserConfigPath: string): void {
  process.stdout.write(`dbh

Global flags:
  --config <path>
  --log

Default config search:
  ./config.json
  ${recommendedUserConfigPath}

Commands:
  init [--from-env-file <path>] [--config <path>] [--force]
  config validate
  config path
  config show [--unredacted]
  interactive
  backup create --from <environment> [--name <name>] [--note <text>] [--tag <tag>] [--quiet] [--verbose] [--log]
  backup list [--from <environment>] [--tag <tag>]
  backup inspect --backup <backup-name>
  sync --from <environment> --to <environment> [--yes] [--quiet] [--verbose] [--log]
  sync collection --from <environment> --to <environment> --collection <name> [--yes] [--quiet] [--verbose] [--log]
  restore full --backup <backup-name> --to <environment> [--yes] [--skip-pre-backup] [--force-production-restore] [--quiet] [--verbose] [--log]
  restore collection --backup <backup-name> --collection <name> --to <environment> [--yes] [--force-production-restore] [--quiet] [--verbose] [--log]
  recover
  doctor

Command-specific help:
  dbh config --help
  dbh backup --help
  dbh sync --help
  dbh restore --help
`);
}

export function printConfigHelp(): void {
  process.stdout.write(`dbh config

Purpose:
  Inspect and validate CLI configuration.

Usage:
  dbh config validate [--config <path>]
  dbh config path [--config <path>]
  dbh config show [--config <path>] [--unredacted]

Commands:
  validate
    Validate config shape and required values.

  path
    Print the resolved config file path.

  show
    Print config with secrets redacted by default.
    Use --unredacted only when you explicitly need secrets in output.

Important notes:
  --config overrides the default config file search order.
  config show defaults to redacted output.
  Do not use --unredacted in shared terminals or captured logs.

Examples:
  dbh config validate
  dbh config show
  dbh config show --unredacted --config /path/to/config.json
`);
}

export function printBackupHelp(): void {
  process.stdout.write(`dbh backup

Purpose:
  Create, list, and inspect local backup snapshots.

Usage:
  dbh backup create --from <environment> [--name <name>] [--note <text>] [--tag <tag>] [--quiet] [--verbose] [--log]
  dbh backup list [--from <environment>] [--tag <tag>]
  dbh backup inspect --backup <backup-name>

Commands:
  create
    Create a backup from one configured environment.
    Use --name to set an explicit backup directory name.

  list
    List backups, newest first.

  inspect
    Print one backup manifest as JSON.

Required flags:
  create: --from
  inspect: --backup

Important notes:
  --name overrides the default timestamp-based backup name.
  Interrupted backups should not be trusted unless the command completed successfully.
  Run doctor first if tooling, SSH, or connectivity is in doubt.

Examples:
  dbh backup create --from production
  dbh backup create --from production --name before-maintenance
  dbh backup inspect --backup 2026-03-16T10-30-00-production
`);
}

export function printSyncHelp(): void {
  process.stdout.write(`dbh sync

Purpose:
  Replace one configured environment with an exact copy of another.

Usage:
  dbh sync --from <environment> --to <environment> [--yes] [--quiet] [--verbose] [--log]
  dbh sync collection --from <environment> --to <environment> --collection <name> [--yes] [--quiet] [--verbose] [--log]

Commands:
  sync
    Replace the target environment with an exact copy of the source snapshot.

  collection
    Restore one named collection from source to target.

Required flags:
  sync: --from, --to
  collection: --from, --to, --collection

Important notes:
  Full sync overwrites the target and prunes target-only non-system collections.
  Targets marked isProduction are blocked; use backup plus restore instead.
  Interrupted sync can leave the target dirty.
  If the target matters, create a backup before running sync.

Examples:
  dbh sync --from production --to development
  dbh sync collection --from production --to development --collection orders
`);
}

export function printRestoreHelp(): void {
  process.stdout.write(`dbh restore

Purpose:
  Apply a named backup to one configured environment.

Usage:
  dbh restore full --backup <backup-name> --to <environment> [--yes] [--skip-pre-backup] [--force-production-restore] [--quiet] [--verbose] [--log]
  dbh restore collection --backup <backup-name> --collection <name> --to <environment> [--yes] [--force-production-restore] [--quiet] [--verbose] [--log]

Commands:
  full
    Restore a full backup into one configured environment.

  collection
    Restore one collection from a backup into one configured environment.

Required flags:
  full: --backup, --to
  collection: --backup, --collection, --to

Important notes:
  full restore verifies the restored result before reporting success.
  Targets marked isProduction require --force-production-restore.
  Interrupted restore can leave the target dirty.

Examples:
  dbh restore full --backup 2026-03-16T10-30-00-production --to development
  dbh restore collection --backup 2026-03-16T10-30-00-production --collection orders --to development
`);
}
