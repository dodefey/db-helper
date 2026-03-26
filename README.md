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
