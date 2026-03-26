# DB CLI Plan

## Goal

Replace the scattered DB shell scripts with one cohesive, interactive TypeScript CLI that makes these workflows safe and obvious:

- sync production data down into development environments
- sync development data between non-production environments
- create backups
- restore a full database quickly from a known clean backup
- restore one collection when a targeted fix is enough

The primary UX requirement is recovery: if data is disrupted or corrupted, an operator should be able to restore a known clean DB with minimal decisions and minimal risk.

## Existing Inventory

### Current operational scripts

`bin/copydb`

- one-shot production dump from `gnomebrewshop.com`
- restores into local `development`

`bin/dbsync`

- interactive full-db sync
- source is production
- destinations currently include local and remote non-production targets

`bin/snapshot-db`

- creates timestamped backups under a local snapshot root

`bin/restore-collection`

- restores a single collection from a backup
- targets development today, with production restore friction for exceptional recovery work

### Existing code helpers

`gb_modules/Database/GnomeDB.ts`

- current TS DB connection helper

`modules/gnomedb.ts`

- deprecated duplicate helper

## Core Problem

The current scripts are fragmented, duplicate the same dump/copy/restore mechanics, and do not enforce one clear safety model.

The new CLI should center on four operations only:

1. `backup`
2. `sync`
3. `restore`
4. `doctor`

Everything else should be support for those operations, not separate top-level concepts.

## Safety Model

The CLI should enforce allowed data movement rather than trusting the operator to remember it.

### Allowed sync directions

Production to non-production:

- `production -> development`
- `production -> test`

Non-production to non-production:

- `development -> test`
- `test -> development`

### Disallowed sync directions

Never allow:

- any sync into `production`
- any sync from a backup directly into production outside the explicit restore flow
- any generic “copy whatever to whatever” mode

### Restore rules

Restore is broader than sync, but must still be guarded.

Allowed restore targets:

- development DB
- test DB
- production only through an explicit high-friction restore command

Production restore should require:

- selecting a named backup
- a typed confirmation, not just `yes/no`
- a pre-restore backup of current production unless explicitly skipped

## Primary Operator Workflows

These should be the first-class interactive menu options.

### 1. Restore known clean DB

This is the most important workflow.

Operator flow:

1. choose target profile
2. choose a known clean backup
3. review backup metadata
4. confirm destructive restore
5. restore full DB
6. verify basic collection counts

This should be available as both:

- `db restore full`
- `db recover`

`db recover` should just be a more obvious entry point to the safest full-restore workflow.

### 2. Backup production

Operator flow:

1. connect to production
2. create timestamped backup
3. store locally in backup root
4. capture metadata so the backup is easy to identify later

### 3. Sync production into non-production

Operator flow:

1. choose target: `development` or `test`
2. create a temporary dump from production
3. restore into target DB
4. clean temp artifacts

### 4. Sync non-production into non-production

Operator flow:

1. choose non-production source
2. choose non-production target
3. confirm overwrite
4. dump and restore

### 5. Restore one collection

Operator flow:

1. choose target profile
2. choose backup
3. choose collection
4. confirm targeted restore

## Recommended Command Surface

Use one top-level command:

`db`

The CLI should use the same simple command system as the current standalone DB tool shape:

- top-level executable `db`
- positional subcommands such as `backup`, `sync`, `restore`, and `doctor`
- explicit named profiles instead of free-form environment variables
- a `--config <path>` flag to override the default config file location when needed

Keep the top-level subcommands minimal:

- `db interactive`
- `db backup`
- `db sync`
- `db restore`
- `db doctor`

### `db interactive`

This should open a simple menu with the exact workflows operators care about:

- restore known clean DB
- back up production
- sync production to development
- sync production to test
- sync one non-production DB to another
- restore one collection from backup
- check DB tooling / connectivity

### `db backup`

Purpose:

- create and manage backups

Subcommands:

- `db backup create --from production`
- `db backup list`
- `db backup inspect --backup <name>`

Avoid splitting this into a separate top-level `snapshot` family. Backup is the clearer user concept.

### `db sync`

Purpose:

- move data only across allowed safe paths

Examples:

```bash
node ./bin/db sync --from production --to development --yes
node ./bin/db sync --from production --to test --yes
node ./bin/db sync --from development --to test --yes
```

The CLI should reject invalid pairs before any dump starts.

### `db restore`

Purpose:

- restore from a saved backup

Subcommands:

- `db restore full --backup <name> --to development`
- `db restore full --backup <name> --to test`
- `db restore full --backup <name> --to production`
- `db restore collection --backup <name> --collection inventory --to development`

The broad restore path is the important one. Collection restore is secondary.

### `db doctor`

Purpose:

- confirm the environment is ready before a risky operation

Checks:

- `mongodump` available
- `mongorestore` available
- `mongosh` available
- required SSH key exists
- backup root exists
- configured hosts resolve
- remote connectivity works

## Configuration Direction

The implementation plan should not assume `.env` as the primary operator interface.

Use a config file with profiles instead:

- default config file: `config.json`
- checked-in example: `config.example.json`
- override flag: `--config <path>`

The config file should follow the same general model used by the sibling deploy tooling:

- top-level tool settings
- named profiles
- explicit remote SSH metadata where applicable
- explicit Mongo connection metadata
- no hardcoded secrets in source

Preferred profile names for this tool:

- `development`
- `test`
- `production`

The loader should resolve each named profile into the runtime connection object the command layer needs, including secrets from a secure source rather than relying on a repo-local `.env`.

## Internal Package Shape

Use a small TS package under `tools/db/`.

- `bin/db`
- `tools/db/cli.ts`
- `tools/db/config.ts`
- `tools/db/profiles.ts`
- `tools/db/mongo.ts`
- `tools/db/ssh.ts`
- `tools/db/backup.ts`
- `tools/db/sync.ts`
- `tools/db/restore.ts`
- `tools/db/prompts.ts`
- `tools/db/verify.ts`

## Profile Model

Represent profiles explicitly:

- `production`
- `development`
- `test`

Each profile should define:

- display name
- whether it is production
- whether it is local or remote
- ssh connection string
- ssh key path
- mongo host
- mongo port
- mongo user
- database name
- auth source

The profile model should be the single source of truth for:

- connection targets
- per-environment DB names
- URI construction
- which operations are allowed

## Shared Primitives

The package only needs a few reusable primitives:

- `getProfile(name)`
- `buildMongoUri(profile)`
- `assertAllowedSync(source, target)`
- `createDump(profile, outDir)`
- `copyDumpToLocal(profile, remotePath, localPath)`
- `copyDumpToRemote(profile, localPath, remotePath)`
- `restoreFull(profile, dumpPath, options)`
- `restoreCollection(profile, bsonPath, options)`
- `listBackups(rootDir)`
- `inspectBackup(backupName)`
- `verifyRestore(profile)`
- `cleanupTemp(profile, path)`

If these are correct, the rest of the CLI is only orchestration and prompts.

## Recovery-First Design Details

To make recovery easy after corruption or disruption, backups need metadata and the restore flow needs good defaults.

### Backup metadata

Each backup should include a small manifest with:

- backup name
- created timestamp
- source profile
- db name
- collection list
- collection file names
- optional notes

This makes “which clean backup should I restore?” much easier to answer.

### Restore defaults

`db recover` should default to:

- showing the most recent backups first
- highlighting backups marked clean / known-good if that metadata exists
- restoring full DB, not prompting the user to choose between full and partial first
- running a lightweight verification step after restore

### Optional safety enhancements

- support a `latest` alias for the newest backup
- support a `known-clean` tag in backup metadata
- make production restore automatically create a pre-restore backup

## Migration Path

### Phase 1

- create `bin/db` and `tools/db/`
- implement profile loading and validation
- implement `doctor`
- implement `backup create/list/inspect`
- implement `sync` with enforced allowed directions
- implement `restore full`

This phase covers the core operational need, especially clean recovery.

### Phase 2

- implement `restore collection`
- add `db interactive`
- add post-restore verification and backup metadata manifests

### Phase 3

- replace old script entry points with compatibility shims if needed:
- `bin/dbsync` -> `bin/db sync`
- `bin/snapshot-db` -> `bin/db backup create`
- `bin/restore-collection` -> `bin/db restore collection`

## Concrete Recommendation

Build one recovery-first `db` CLI with four core command groups: `backup`, `sync`, `restore`, and `doctor`. Enforce sync safety in code, keep full restore from known clean backups as the most obvious workflow, and keep the operator surface focused on backup, sync, restore, recovery, and diagnostics.
