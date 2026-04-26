# Sync Spec

## Purpose

`sync` copies a full Mongo database from one configured environment to another across a small set of explicitly allowed paths so the target ends as an exact copy of the source snapshot for normal user collections.

The command exists for operational refresh workflows such as:

- refresh `development` from `production`
- refresh `test` from `production`
- copy one non-production environment into the other
- refresh one named collection between allowed environments

`sync` is not a generic "copy anything to anywhere" command.

## Command Surface

CLI form:

```bash
dbh sync --from <environment> --to <environment> [--yes]
dbh sync collection --from <environment> --to <environment> --collection <name> [--yes]
```

Required flags:

- `--from`
- `--to`

Optional flags:

- `--yes`

No other sync modes are supported.
No selective multi-collection sync mode is supported.

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

`sync` is an exact full-target replacement workflow for normal user collections.

Meaning:

- the source database is dumped as a full archive
- the target database is restored from that archive
- existing target data is overwritten by the restored source data
- target collections included in the archive are dropped before restore
- target collections that do not exist in the source are removed so the final target collection set matches the source

Exception:

- internal Mongo namespaces such as `system.*` are excluded from sync prune and verification
- no other exceptions to the exact-copy rule are part of this command

This command is destructive to the target environment.

Current behavior:

- use `mongorestore --drop`
- do not support merge mode
- do not support collection-level sync
- do not support partial namespace filters

`sync collection` is the targeted collection workflow:

- restore one named collection from the source archive into the target
- drop the target collection before restore
- do not prune unrelated target collections
- verify only the requested collection

Collection-level or selective restore belongs under `sync collection` or `restore collection`, not full `sync`.

## Confirmation Rules

If `--yes` is not provided, the operator must confirm before any destructive work starts.

Minimum confirmation text must clearly state:

- source environment
- target environment
- that the target will be replaced with an exact copy of the source snapshot

Baseline prompt:

```text
This will replace <to> with an exact copy of <from>. Continue?
```

For collection sync, the confirmation must name the source and target collection as well.

If `--yes` is provided, the command may proceed without interactive confirmation.

Typed confirmation is not required for non-production targets.

## Backups

`sync` does not create an automatic pre-sync backup of the target.

Reason:

- the main use cases are environment refreshes into non-production targets
- mandatory pre-sync target backup adds time, storage, and operational complexity
- backup creation already exists as a separate explicit workflow

Operator expectation:

- if target recovery matters, create a backup explicitly before running sync

Future enhancement, not part of this spec:

- optional `--pre-backup-target`

## Verification

`sync` requires post-sync verification.

Required verification behavior:

- verify that the target collection set exactly matches the source collection set
- verify source and target collection counts after restore
- exclude internal Mongo collections such as `system.*` from sync prune and verification

Verification is part of the sync operation. A sync that restores successfully but fails verification must still be treated as a failed sync.

Current tradeoff:

- count-based verification can be slow on large collections
- that cost is accepted because the command favors explicit post-restore validation over a faster but less trustworthy default

## Execution Model

The command must perform sync using an archive-based workflow:

1. validate source and target path
2. confirm with operator unless `--yes`
3. create a temporary archive from the source database
4. restore that archive into the target database with drop enabled
5. remove target-only collections so the target collection set matches the source snapshot exactly
6. clean up temporary artifacts

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

Required cleanup behavior:

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

If restore fails after target drop has started, the target may be left partially restored. This is acceptable because `sync` targets only non-production environments.

### Dirty Target Contract

`sync` does not guarantee rollback of target database state.

The command must distinguish failures by phase and define the operator expectation for each case:

- failure before restore starts:
  - target database state is unchanged
- failure after restore starts but before restore completes:
  - target database state may be partially replaced
  - target must be treated as dirty until a fresh sync or manual inspection confirms it is usable
- failure after restore completes but during verification:
  - target database state has been modified
  - target must be treated as dirty until manual inspection or a subsequent successful sync confirms it is usable
- failure during temp artifact cleanup after successful restore and verification:
  - target database state may still be valid
  - the command should report cleanup failure separately from database-state failure

The implementation must preserve the primary operational failure and must not replace it with a cleanup-only failure.

The implementation should surface phase-aware operator messaging so a failed sync clearly states whether the target may be dirty.

Interruptions such as `Ctrl-C` must follow the same phase-aware contract:

- interrupted during dump:
  - target database state is unchanged
- interrupted during restore:
  - target database may be partially replaced and must be treated as dirty
- interrupted during verification:
  - target database has been modified and must be treated as dirty

Interruption output should be practical rather than low-level. It should report:

- which sync phase was interrupted
- whether the target database was modified or may be dirty
- whether temp artifact cleanup was attempted or may not have completed

## Logging and Operator Output

`sync` output should be concise and operationally useful.

At minimum, output should make clear:

- source environment
- target environment
- whether sync started
- whether sync completed
- current long-running phase
- verification progress while collection counts are being checked

Current output behavior:

- default mode shows sync phases, elapsed timers for dump and restore, and verification count progress
- quiet mode suppresses normal command-summary output
- verbose mode may stream low-level subprocess output

Output should avoid dumping raw underlying command text in normal interruption messaging. Operator-facing messages should focus on practical state and next steps.

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
- interruption handling preserves the same dirty-target contract as ordinary failures

## Deferred Decisions

These are intentionally out of scope and should not be added implicitly during refactor:

- target pre-backup
- merge mode
- partial sync
- typed confirmation for non-production sync
- support for arbitrary user-defined environments beyond the current allowlist model
