# Sync Spec

## Purpose

`sync` copies a full Mongo database from one configured environment to another across a small set of explicitly allowed paths.

The command exists for operational refresh workflows such as:

- refresh `development` from `production`
- refresh `test` from `production`
- copy one non-production environment into the other

`sync` is not a generic "copy anything to anywhere" command.

## Command Surface

CLI form:

```bash
db-helper sync --from <environment> --to <environment> [--yes]
```

Required flags:

- `--from`
- `--to`

Optional flags:

- `--yes`

No other sync modes are supported in phase 1.

## Allowed Paths

The command must allow only these source and target pairs:

- `production -> development`
- `production -> test`
- `development -> test`
- `test -> development`

The command must reject all other pairs before starting any dump, copy, or restore work.

Specifically rejected:

- any sync into `production`
- `development -> production`
- `test -> production`
- `production -> production`
- `development -> development`
- `test -> test`
- any future environment pair not explicitly added to the allowlist

## Data Semantics

`sync` is a full target replacement workflow.

Meaning:

- the source database is dumped as a full archive
- the target database is restored from that archive
- target collections included in the archive are dropped before restore

This command is destructive to the target environment.

Phase 1 behavior:

- use `mongorestore --drop`
- do not support merge mode
- do not support collection-level sync
- do not support partial namespace filters

Collection-level or selective restore belongs under `restore`, not `sync`.

## Confirmation Rules

If `--yes` is not provided, the operator must confirm before any destructive work starts.

Minimum confirmation text must clearly state:

- source environment
- target environment
- that target data will be replaced

Baseline prompt:

```text
This will replace <to> with <from>. Continue?
```

If `--yes` is provided, the command may proceed without interactive confirmation.

Phase 1 does not require typed confirmation for non-production targets.

## Backups

Phase 1 does not create an automatic pre-sync backup of the target.

Reason:

- the main use cases are environment refreshes into non-production targets
- mandatory pre-sync target backup adds time, storage, and operational complexity
- backup creation already exists as a separate explicit workflow

Operator expectation:

- if target recovery matters, create a backup explicitly before running sync

Future enhancement, not part of this spec:

- optional `--pre-backup-target`

## Verification

Phase 1 does not require post-sync verification.

Reason:

- sync currently operates as a dump-and-restore transport workflow
- verification policy should be added deliberately, not implied

Future enhancement, not part of this spec:

- verify source and target collection counts after restore
- verify expected collection set exists on target

## Execution Model

The command must perform sync using an archive-based workflow:

1. validate source and target path
2. confirm with operator unless `--yes`
3. create a temporary archive from the source database
4. restore that archive into the target database with drop enabled
5. clean up temporary artifacts

The implementation may use:

- local temp archive files
- remote temp archive files
- `ssh`
- `scp`
- `mongodump`
- `mongorestore`

The implementation must keep those details internal to the execution layer.

## Cleanup Guarantees

The command must attempt cleanup even when sync fails.

Phase 1 required cleanup behavior:

- local temp archive should be deleted in a `finally` path
- remote temp archive should be deleted in a `finally` path when remote execution was used

Cleanup failure should not hide the original sync failure.

If cleanup itself fails after an otherwise successful sync, the command may report cleanup failure as an error.

## Failure Semantics

The command must fail fast and exit non-zero when any required step fails.

Failure cases include:

- invalid source/target path
- operator declines confirmation
- source dump fails
- remote copy fails
- target restore fails
- required local or remote temp path cannot be used

No rollback is guaranteed.

If restore fails after target drop has started, the target may be left partially restored. This is acceptable for phase 1 because `sync` targets only non-production environments.

## Logging and Operator Output

Phase 1 output should be concise and operationally useful.

At minimum, output should make clear:

- source environment
- target environment
- whether sync started
- whether sync completed

The low-level command runner may stream subprocess output.

Future enhancement:

- structured step logging with explicit phases such as `dump`, `transfer`, `restore`, and `cleanup`

## Environment Assumptions

The command assumes:

- source and target environments are defined in config
- Mongo credentials are valid
- remote environments include required SSH configuration
- required binaries are installed where needed

`doctor` is the preflight command for validating those assumptions.

## Boundaries

`sync` owns:

- allowed path enforcement
- operator confirmation
- full-database transport from source to target
- temp artifact cleanup

`sync` does not own:

- backup catalog management
- named backup restore
- collection-level restore
- maintenance or migration tasks
- generic replication or continuous sync

## Refactor Guidance

Any refactor of the sync flow should preserve these invariants:

- invalid paths fail before any destructive work
- sync never targets `production`
- sync always performs full target replacement in phase 1
- sync always attempts temp artifact cleanup
- sync behavior is expressed in terms of clear source and target environments, not arbitrary URIs

## Deferred Decisions

These are intentionally out of scope for phase 1 and should not be added implicitly during refactor:

- target pre-backup
- post-sync verification
- merge mode
- partial sync
- typed confirmation for non-production sync
- support for arbitrary user-defined environments beyond the current allowlist model
