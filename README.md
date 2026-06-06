# db-helper

`db-helper` is a standalone TypeScript CLI for safe Mongo backup, sync, restore, recovery, and maintenance operations across one or more named environments. The executable command is `dbh`.

## Setup

The standalone setup flow is now:

1. `dbh init`
2. `dbh config validate`
3. `dbh doctor`

### Init Walkthrough

`dbh init` creates a config at the default user location unless you pass `--config <path>`.

Press Enter to accept the default shown in brackets.

Prompt-by-prompt:

```bash
# Mongo auth database used by generated connection URIs
Mongo auth source [admin]:
```

Use `admin` unless your Mongo users authenticate against a different auth DB.

```bash
# default restore behavior for commands that still honor this setting
Default drop on restore [true]:
```

Use `true` unless you have a specific reason to keep restore non-dropping by default.

```bash
# local directory where db-helper stores backup folders
Backup root [/tmp/db-helper-backups]:
```

Use a durable path if you want backups to survive reboots and temp cleanup.

```bash
# temp working directory for archives and intermediate files
Temp root [/tmp/db-helper]:
```

Usually the default is fine.

Environment prompts:

```bash
# environment key used with --from and --to
Environment name [development]:
```

```bash
# human label shown in menus and output
development label [Local Development]:
```

```bash
# local or remote
development kind [local]:
```

```bash
# machine or DNS name for the environment
development host [localhost]:
```

```bash
# Mongo host used in the connection string
development mongo host [localhost]:
```

```bash
# Mongo TCP port
development mongo port [27017]:
```

```bash
# actual database name on the server
development database name [development]:
```

```bash
# Mongo username
development mongo user []:
```

```bash
# Mongo password
development mongo password []:
```

```bash
# mark the environment that should receive production-only safeguards
development is production [y/N]:
```

Remote environments use the same fields, plus SSH prompts:

```bash
# SSH username
staging ssh user []:
```

```bash
# SSH private key path
staging ssh key path []:
```

Leave this blank to use your SSH agent, macOS keychain-backed identities, or `~/.ssh/config`.

After each environment, `dbh init` asks whether to add another environment. At least one environment is required. No specific environment names are required.

Current limitation:

- passwords are currently visible while typing

Typical first-run flow:

```bash
# install the CLI globally
npm install -g @dodefey/db-helper
```

```bash
# create the config interactively
dbh init
```

```bash
# validate config shape
dbh config validate
```

```bash
# validate tooling and connectivity
dbh doctor
```

If you already have the old env-file format, import it instead:

```bash
# import a legacy env file into config.json format
dbh init --from-env-file /path/to/.env
```

By default, the CLI looks for configuration in this order:

- `./config.json`
- `~/.config/db-helper/config.json`
- a repo-local fallback config during development

You can always override that with `--config <path>`.

## Install

```bash
# install the published CLI globally for normal operator use
npm install -g @dodefey/db-helper
```

```bash
# bootstrap the user-level config interactively
dbh init
```

```bash
# validate config shape without network checks
dbh config validate
```

```bash
# validate config and connectivity
dbh doctor
```

For repo-local development, you can still install from the current checkout instead:

```bash
# install directly from the current repo checkout
npm install -g .
```

```bash
# show which config file dbh will use
dbh config path
```

```bash
# inspect config safely with secrets redacted by default
dbh config show
```

```bash
# print config with secrets included only when you explicitly need them
dbh config show --unredacted
```

```bash
# import a config from the legacy env-file format
dbh init --from-env-file /path/to/.env
```

```bash
# run the CLI in place during development
npm install && npm start -- --help
```

```bash
# validate a non-default config file explicitly
dbh config validate --config /path/to/config.json
```

## Command Reference

```bash
# open the interactive workflow menu
dbh interactive
```

```bash
# create a timestamped backup
dbh backup create --from live
```

```bash
# list backups, newest first
dbh backup list
```

```bash
# inspect one backup manifest
dbh backup inspect --backup 2026-03-16T10-30-00-production
```

```bash
# sync between configured environments
dbh sync --from live --to local --yes
```

```bash
# restore a full backup
dbh restore full --backup 2026-03-16T10-30-00-live --to local --yes
```

```bash
# restore a single collection
dbh restore collection --backup 2026-03-16T10-30-00-live --collection orders --to staging --yes
```

```bash
# guided recovery workflow
dbh recover
```

```bash
# validate local tooling and connectivity
dbh doctor
```

## Backup

`backup` is the command for capturing a full snapshot of one configured environment into a local archive plus manifest. In practice, it is most useful before risky work, before replacing a target with `sync` or `restore`, or when you want to preserve a known-good production snapshot for later recovery.

It creates a timestamped backup directory under the configured backup root, writes `dump.archive.gz`, writes `manifest.json`, and validates the result before reporting success. If backup creation fails or is interrupted, `dbh` treats the result as invalid and attempts cleanup of incomplete artifacts.

### Usage

Run `doctor` first if tooling, SSH, or database connectivity is in doubt.

Common workflows:

```bash
# create a production backup before maintenance
dbh backup create --from production
```

```bash
# create a manual recovery point before syncing into development
dbh backup create --from development --note "pre-sync recovery point" --tag pre-sync
```

```bash
# create a known-good snapshot with a note and tag
dbh backup create --from production --note "known good after deploy" --tag known-good
```

```bash
# list backups for one environment
dbh backup list --from production
```

```bash
# inspect one backup manifest before restore or review
dbh backup inspect --backup 2026-03-16T10-30-00-production
```

If `backup create` is interrupted during archive creation, manifest write, or validation, do not trust the partial result. The command will attempt cleanup, but an interrupted run should be treated as not having produced a usable backup unless it completed successfully.

### Backup API

CLI forms:

```bash
dbh backup create --from <environment> [--note <text>] [--tag <tag>] [--quiet] [--verbose] [--log]
dbh backup list [--from <environment>] [--tag <tag>]
dbh backup inspect --backup <backup-name>
```

Required flags:

- `backup create`: `--from`
- `backup inspect`: `--backup`

Optional flags:

- `backup create`: `--note`, `--tag`, `--quiet`, `--verbose`, `--log`
- `backup list`: `--from`, `--tag`

Output modes for `backup create`:

- `--quiet` reduces normal operator output
- `--verbose` allows raw subprocess output

Debug log retention:

- every `dbh` run captures a temp debug log
- failed runs keep the log automatically and print its saved path
- `--log` keeps the log on success and prints its saved path

## Sync

`sync` is the command for replacing one configured database with another environment. It also supports syncing one named collection between configured environments.

It is an exact target-replacement workflow, not a merge or replication tool. The intended end state is that the target matches the source database snapshot taken during sync for normal user collections: existing target data is overwritten, collections restored from the source replace their target counterparts, and collections that exist only in the target are removed. Internal Mongo namespaces such as `system.*` are the only exception to that exact-copy rule. An interrupted restore can still leave the target in a dirty state.

### Usage

Run `doctor` first if tooling, SSH, or database connectivity is in doubt. If the target matters and you want a recovery point, create a backup before running `sync`.

Common workflows:

```bash
# refresh development from production
dbh sync --from production --to development
```

```bash
# refresh test from production without a confirmation prompt
dbh sync --from production --to test --yes
```

```bash
# move test data into development
dbh sync --from test --to development --yes
```

```bash
# sync one collection from production into development
dbh sync collection --from production --to development --collection orders
```

```bash
# create a manual backup of the target before syncing
dbh backup create --from development
```

If `sync` is interrupted during `restore`, target-only collection cleanup, or `verify`, treat the target as dirty. The normal recovery path is to rerun `sync` from a known-good source so the target returns to an exact copy of the source snapshot for normal user collections, or restore the target from backup.

### Sync API

CLI form:

```bash
dbh sync --from <environment> --to <environment> [--yes] [--quiet] [--verbose] [--log]
dbh sync collection --from <environment> --to <environment> --collection <name> [--yes] [--quiet] [--verbose] [--log]
```

Required flags:

- `--from`
- `--to`

Optional flags:

- `--yes`
- `sync collection`: `--collection`
- `--quiet`
- `--verbose`
- `--log`

Environment rules:

- `--from` and `--to` must name real configured environments
- sync paths are not hard-coded; any configured pair is allowed
- self-syncs are allowed and use the same confirmation flow as any other sync

Collection sync expectations:

- `sync collection` restores one named collection only
- the target collection is dropped before restore
- unrelated target collections are left in place
- `sync collection` uses the same environment rules as full sync

Output modes:

- `--quiet` reduces normal operator output
- `--verbose` allows raw subprocess output

Operator expectations:

- interruption during `dump` means the target database was not modified
- interruption during `restore` or `verify` means the target database may be dirty
- if the target may be dirty, restore it from a known good backup or rerun sync before trusting it
- if target recovery matters, create a backup explicitly before running sync

## Restore

`restore` is the command for applying a named backup to a target environment. In practice, it is most useful when you want to recover any configured environment from a known-good backup, or when you need to restore one collection without replacing the full database.

It is a backup-to-target recovery workflow, not a merge tool. `restore full` validates the named backup, replaces the target with drop enabled, verifies the result, and enforces stronger safeguards for environments marked `isProduction: true`. `restore collection` restores only one named collection from the backup with drop enabled.

### Usage

Run `doctor` first if tooling, SSH, or database connectivity is in doubt. Before restoring into an environment marked `isProduction: true`, review the backup manifest with `backup inspect` so you know exactly which snapshot you are applying.

Common workflows:

```bash
# restore a known-good production backup into development
dbh restore full --backup 2026-03-16T10-30-00-production --to development
```

```bash
# restore a test environment from a known backup without a confirmation prompt
dbh restore full --backup 2026-03-16T10-30-00-production --to test --yes
```

```bash
# restore one collection from a backup into development
dbh restore collection --backup 2026-03-16T10-30-00-production --collection orders --to development
```

```bash
# restore production from a named backup with the required production safeguards
dbh restore full --backup 2026-03-16T10-30-00-production --to production --force-production-restore
```

If `restore` is interrupted during `restore` or `verify`, treat the target as dirty. The safe recovery path is to rerun the restore from a known-good backup or restore the target again before trusting it.

### Restore API

CLI forms:

```bash
dbh restore full --backup <backup-name> --to <environment> [--yes] [--skip-pre-backup] [--force-production-restore] [--quiet] [--verbose] [--log]
dbh restore collection --backup <backup-name> --collection <name> --to <environment> [--yes] [--force-production-restore] [--quiet] [--verbose] [--log]
```

Required flags:

- `restore full`: `--backup`, `--to`
- `restore collection`: `--backup`, `--collection`, `--to`

Optional flags:

- `restore full`: `--yes`, `--skip-pre-backup`, `--force-production-restore`, `--quiet`, `--verbose`, `--log`
- `restore collection`: `--yes`, `--force-production-restore`, `--quiet`, `--verbose`, `--log`

Production restore expectations:

- `restore` into an environment marked `isProduction: true` requires `--force-production-restore`
- interactive production restore requires an additional typed confirmation
- production restore creates a pre-restore backup of that same target by default
- `--skip-pre-backup` bypasses that automatic pre-restore backup

Output modes:

- `--quiet` reduces normal operator output
- `--verbose` allows raw subprocess output

## Safety Model

- `sync`, `backup`, and `restore` require real environment names from config.
- Production restore follows the environment marked `isProduction: true`, not a reserved name.
- Production restore requires a named backup, `--force-production-restore` for non-interactive use, and an extra typed confirmation in interactive mode.
- Production restore creates a pre-restore backup of the same target by default.

## Backup Layout

Each backup is stored under:

```text
<DB_BACKUP_ROOT>/<backup-name>/
```

Required contents:

- `manifest.json`
- `dump.archive.gz`

The manifest includes the backup name, source environment, database name, timestamp, tags, note, collection list, and collection counts when available.

## Recovery Guide

See [RECOVERY.md](./RECOVERY.md) for the operator-focused restore flows.
