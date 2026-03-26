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
