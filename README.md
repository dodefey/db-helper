# db-helper

`db-helper` is a standalone TypeScript CLI for safe Mongo backup, sync, restore, recovery, and maintenance operations across `development`, `test`, and `production`.

## Setup

Copy `.env.example` to `.env` and fill in the connection details for all three environments. The CLI loads configuration only from `.env` plus runtime flags such as `--env-file`.

## Install

```bash
# install dependencies
npm install
```

```bash
# run the CLI in place
npm start -- --help
```

## Command Reference

```bash
# open the interactive workflow menu
db-helper interactive
```

```bash
# create a timestamped backup
db-helper backup create --from production
```

```bash
# list backups, newest first
db-helper backup list
```

```bash
# inspect one backup manifest
db-helper backup inspect --backup 2026-03-16T10-30-00-production
```

```bash
# sync between allowed environments
db-helper sync --from production --to development --yes
```

```bash
# restore a full backup
db-helper restore full --backup 2026-03-16T10-30-00-production --to development --yes
```

```bash
# restore a single collection
db-helper restore collection --backup 2026-03-16T10-30-00-production --collection orders --to test --yes
```

```bash
# guided recovery workflow
db-helper recover
```

```bash
# validate local tooling and connectivity
db-helper doctor
```

## Backup

`backup` is the command for capturing a full snapshot of one configured environment into a local archive plus manifest. In practice, it is most useful before risky work, before replacing a target with `sync` or `restore`, or when you want to preserve a known-good production snapshot for later recovery.

It creates a timestamped backup directory under the configured backup root, writes `dump.archive.gz`, writes `manifest.json`, and validates the result before reporting success. If backup creation fails or is interrupted, `db-helper` treats the result as invalid and attempts cleanup of incomplete artifacts.

### Usage

Run `doctor` first if tooling, SSH, or database connectivity is in doubt.

Common workflows:

```bash
# create a production backup before maintenance
db-helper backup create --from production
```

```bash
# create a manual recovery point before syncing into development
db-helper backup create --from development --note "pre-sync recovery point" --tag pre-sync
```

```bash
# create a known-good snapshot with a note and tag
db-helper backup create --from production --note "known good after deploy" --tag known-good
```

```bash
# list backups for one environment
db-helper backup list --from production
```

```bash
# inspect one backup manifest before restore or review
db-helper backup inspect --backup 2026-03-16T10-30-00-production
```

If `backup create` is interrupted during archive creation, manifest write, or validation, do not trust the partial result. The command will attempt cleanup, but an interrupted run should be treated as not having produced a usable backup unless it completed successfully.

### Backup API

CLI forms:

```bash
db-helper backup create --from <environment> [--note <text>] [--tag <tag>] [--quiet] [--verbose]
db-helper backup list [--from <environment>] [--tag <tag>]
db-helper backup inspect --backup <backup-name>
```

Required flags:

- `backup create`: `--from`
- `backup inspect`: `--backup`

Optional flags:

- `backup create`: `--note`, `--tag`, `--quiet`, `--verbose`
- `backup list`: `--from`, `--tag`

Output modes for `backup create`:

- `--quiet` reduces normal operator output
- `--verbose` allows raw subprocess output

## Sync

`sync` is the command for refreshing one non-production database from another environment. In practice, that usually means replacing `development` or `test` with a fresh copy of `production`, or moving data between `development` and `test`.

It is a full-database replacement workflow, not a merge or replication tool. `sync` will copy the source database, restore it into the target with drop enabled, verify the result, and try to clean up temporary artifacts afterward. It never syncs into `production`, it does not support collection-only syncs, and an interrupted restore can still leave the target in a dirty state.

### Usage

Run `doctor` first if tooling, SSH, or database connectivity is in doubt. If the target matters and you want a recovery point, create a backup before running `sync`.

Common workflows:

```bash
# refresh development from production
db-helper sync --from production --to development
```

```bash
# refresh test from production without a confirmation prompt
db-helper sync --from production --to test --yes
```

```bash
# move test data into development
db-helper sync --from test --to development --yes
```

```bash
# create a manual backup of the target before syncing
db-helper backup create --from development
```

If `sync` is interrupted during `restore` or `verify`, treat the target as dirty. The normal recovery path is to rerun `sync` from a known-good source or restore the target from backup.

### Sync API

CLI form:

```bash
db-helper sync --from <environment> --to <environment> [--yes] [--quiet] [--verbose]
```

Required flags:

- `--from`
- `--to`

Optional flags:

- `--yes`
- `--quiet`
- `--verbose`

Allowed paths:

- `production -> development`
- `production -> test`
- `development -> test`
- `test -> development`

Blocked paths:

- any sync into `production`
- self-syncs such as `development -> development`
- any path not explicitly listed above

Output modes:

- `--quiet` reduces normal operator output
- `--verbose` allows raw subprocess output

Operator expectations:

- interruption during `dump` means the target database was not modified
- interruption during `restore` or `verify` means the target database may be dirty
- if the target may be dirty, restore it from a known good backup or rerun sync before trusting it
- if target recovery matters, create a backup explicitly before running sync

## Restore

`restore` is the command for applying a named backup to a target environment. In practice, it is most useful when you want to recover `development`, `test`, or `production` from a known-good backup, or when you need to restore one collection without replacing the full database.

It is a backup-to-target recovery workflow, not a merge tool. `restore full` validates the named backup, replaces the target with drop enabled, verifies the result, and enforces stronger safeguards for `production`. `restore collection` restores only one named collection from the backup with drop enabled.

### Usage

Run `doctor` first if tooling, SSH, or database connectivity is in doubt. Before restoring into `production`, review the backup manifest with `backup inspect` so you know exactly which snapshot you are applying.

Common workflows:

```bash
# restore a known-good production backup into development
db-helper restore full --backup 2026-03-16T10-30-00-production --to development
```

```bash
# restore a test environment from a known backup without a confirmation prompt
db-helper restore full --backup 2026-03-16T10-30-00-production --to test --yes
```

```bash
# restore one collection from a backup into development
db-helper restore collection --backup 2026-03-16T10-30-00-production --collection orders --to development
```

```bash
# restore production from a named backup with the required production safeguards
db-helper restore full --backup 2026-03-16T10-30-00-production --to production --force-production-restore
```

If `restore` is interrupted during `restore` or `verify`, treat the target as dirty. The safe recovery path is to rerun the restore from a known-good backup or restore the target again before trusting it.

### Restore API

CLI forms:

```bash
db-helper restore full --backup <backup-name> --to <environment> [--yes] [--skip-pre-backup] [--force-production-restore] [--quiet] [--verbose]
db-helper restore collection --backup <backup-name> --collection <name> --to <environment> [--yes] [--force-production-restore] [--quiet] [--verbose]
```

Required flags:

- `restore full`: `--backup`, `--to`
- `restore collection`: `--backup`, `--collection`, `--to`

Optional flags:

- `restore full`: `--yes`, `--skip-pre-backup`, `--force-production-restore`, `--quiet`, `--verbose`
- `restore collection`: `--yes`, `--force-production-restore`, `--quiet`, `--verbose`

Production restore expectations:

- `restore full --to production` requires `--force-production-restore`
- `restore collection --to production` requires `--force-production-restore`
- interactive production restore requires an additional typed confirmation
- production restore creates a pre-restore production backup by default
- `--skip-pre-backup` bypasses that automatic production backup

Output modes:

- `--quiet` reduces normal operator output
- `--verbose` allows raw subprocess output

## Safety Model

- Sync is only allowed for `production -> development`, `production -> test`, `development -> test`, and `test -> development`.
- Sync into `production` is blocked in code.
- Production restore requires a named backup, `--force-production-restore` for non-interactive use, and an extra typed confirmation in interactive mode.
- Production restore creates a pre-restore production backup by default.

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
