# Sync Spec

## Purpose

`sync` copies a full Mongo database from one configured environment to another
across a small set of explicitly allowed paths so the target ends as an exact
copy of the source snapshot for normal user collections.

The command exists for operational refresh workflows such as:

- refresh `development` from `production`
- refresh `test` from `production`
- copy one non-production environment into the other
- refresh one named collection between allowed environments

`sync` is not a generic `copy anything to anywhere` command.

## Command Surface

CLI forms:

```bash
dbh sync --from <environment> --to <environment> [--yes] [--quiet] [--verbose]
dbh sync collection --from <environment> --to <environment> --collection <name> [--yes] [--quiet] [--verbose]
```

Required flags:

- `sync`: `--from`, `--to`
- `sync collection`: `--from`, `--to`, `--collection`

Optional flags:

- `sync`: `--yes`, `--quiet`, `--verbose`
- `sync collection`: `--yes`, `--quiet`, `--verbose`

No selective multi-collection sync mode is supported.

## Allowed Paths

The command must allow only configured non-production target paths. It must
reject any sync into an environment marked `isProduction: true` before starting
any dump, copy, or restore work.

The command must also reject self-sync and any source-target pair that is not
allowed by configured policy.

## Data Semantics

### Full sync

`sync` is an exact full-target replacement workflow for normal user
collections.

Meaning:

- the source database is dumped as a full archive
- the target database is restored from that archive
- target collections included in the archive are dropped before restore
- target collections that do not exist in the validated archive are removed so
  the final normal-user collection set matches that archive

Internal Mongo namespaces such as `system.*` are excluded from full-sync prune
and verification. No other exception to exact-copy behavior is part of this
command.

### Collection sync

`sync collection` is the targeted collection workflow:

- dump the source database archive used by the sync operation
- preflight the effective archive namespace mapping before target mutation
- require exactly one source-to-target mapping for the requested collection
- restore and replace only the requested target collection
- verify only the requested collection's presence and count
- do not prune, rewrite, or verify unrelated target collections

Collection sync uses a server-scoped restore connection and explicit namespace
rules. Same-database collection sync uses an exact namespace include only;
namespace remapping is used only when source and target database names differ.
A collection name that cannot be represented as an exact namespace filter must
fail before subprocess execution.

## Confirmation Rules

If `--yes` is not provided, the operator must confirm before any destructive
work starts.

Minimum confirmation text must clearly state:

- source environment
- target environment
- whether the full target or one named collection will be replaced

If `--yes` is provided, the command may proceed without interactive
confirmation. Typed confirmation is not required for non-production sync.

## Backups

`sync` does not create an automatic pre-sync backup of the target.

If target recovery matters, the operator must create a backup explicitly before
running sync.

Future enhancement, not part of this spec:

- optional `--pre-backup-target`

## Verification

`sync` requires post-sync verification.

For full sync, verification must:

- verify that the normal-user target collection set exactly matches the
  validated archive collection set
- verify source and target collection counts after restore
- exclude internal Mongo collections such as `system.*` from prune and
  verification

For collection sync, verification is limited to the requested collection.
Unrelated target collections must not affect collection-sync verification or be
pruned by it.

Verification is part of the operation. A sync that restores successfully but
fails verification must still be treated as a failed sync.

## Execution Model

### Full sync

`sync` must perform this workflow:

1. validate the source and target path
2. confirm with the operator unless `--yes` is provided
3. create a temporary archive from the source database
4. prepare and inspect the effective archive namespace mapping before target mutation
5. restore that same prepared archive into the target database with drop enabled
6. remove target-only normal user collections
7. verify the exact target collection set and collection counts
8. clean up temporary artifacts

### Collection sync

`sync collection` must perform this workflow:

1. validate the source and target path
2. confirm with the operator unless `--yes` is provided
3. create a temporary archive from the source database
4. inspect the effective archive namespace mapping
5. require exactly the requested source-to-target collection mapping
6. restore the requested collection with drop enabled
7. verify only the requested collection
8. clean up temporary artifacts

The implementation may use local temp archive files, remote temp archive files,
`ssh`, `scp`, `mongodump`, and `mongorestore`. Those details remain internal to
the execution layer.

## Cleanup Guarantees

The command must attempt cleanup even when sync fails.

Required cleanup behavior:

- local temp archive should be deleted in a `finally` path
- remote temp archive should be deleted in a `finally` path when remote
  execution was used
- cleanup failure should not hide the original operational failure

If cleanup fails after a successful mutation, the command must report that
separately from database-state failure.

## Failure And Target-Trust Semantics

The command must fail fast and exit non-zero when any required step fails.

Failure cases include:

- invalid source or target path
- operator declines confirmation
- source dump fails
- archive inspection fails or collection mapping is ambiguous
- remote copy fails
- target restore fails
- full-sync target-only prune fails
- required verification fails
- required local or remote temp path cannot be used

No rollback is guaranteed.

The command must distinguish these target-trust states:

- failure before restore starts, including collection archive inspection failure:
  - target database is unchanged
- failure after restore starts but before restore completes:
  - target database may be partially replaced
- failure after restore completes during full-sync prune or verification:
  - target database has been modified and requires independent verification or
    a subsequent successful sync
- failure during temp artifact cleanup after successful restore and verification:
  - target database may still be valid, but cleanup failure must be reported

Interruptions follow the same contract. Operator-facing output must identify the
phase and distinguish a successful mutation from a later prune, cleanup, or
verification failure when that state is known.

## Logging And Operator Output

`sync` output should be concise and operationally useful.

At minimum, output should make clear:

- source environment
- target environment
- requested collection when applicable
- current long-running phase
- verification progress while collection counts are checked
- whether mutation, full-sync pruning, and verification succeeded

Output modes follow `output-standards.md`:

- default mode shows concise phase progress
- quiet mode suppresses normal success-path summaries but still reports failures
- verbose mode may stream useful diagnostics but not internal machine-result
  envelopes

Output should avoid dumping raw underlying command text in normal interruption
messages. Operator-facing messages should focus on practical state and next
steps.

## Environment Assumptions

The command assumes:

- source and target environments are defined in config
- Mongo credentials are valid
- remote environments include required SSH configuration
- required binaries are installed where needed

`doctor` is the preflight command for validating those assumptions.

## Boundaries

`sync` owns:

- allowed-path enforcement
- operator confirmation
- full-database transport from source to target
- targeted collection transport through `sync collection`
- full-sync target-only pruning
- verification
- temp artifact cleanup

`sync` does not own:

- backup catalog management
- named backup restore
- maintenance or migration tasks
- generic replication or continuous sync

## Refactor Guidance

Any refactor of the sync flow should preserve these invariants:

- invalid paths fail before any destructive work
- sync never targets an environment marked `isProduction: true`
- full sync always performs exact normal-user target replacement
- `sync collection` always performs an exact single-collection replacement
- collection namespace inspection completes before collection mutation
- sync always attempts temp artifact cleanup
- sync behavior is expressed in terms of clear source and target environments,
  not arbitrary URIs
- interruption handling preserves the same target-trust contract as ordinary
  failures

## Deferred Decisions

These are intentionally out of scope and should not be added implicitly during
refactor:

- target pre-backup
- merge mode
- multi-collection sync
- typed confirmation for non-production sync
- public sync `--dry-run` or `--explain` mode
- machine-readable `--json` command output
