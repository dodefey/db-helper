# Restore Spec

## Purpose

`restore` applies a named backup archive to a target environment.

The command exists for operational workflows such as:

- restoring a known-good backup into `development` or `test`
- recovering a corrupted or disrupted environment from a validated backup
- restoring one collection from a backup without replacing the full database
- restoring production from a known backup with additional safeguards

`restore` is not a generic migration tool, merge tool, or arbitrary data
patching interface.

## Command Surface

CLI forms:

```bash
dbh restore full --backup <backup-name> --to <environment> [--yes] [--skip-pre-backup] [--force-production-restore] [--quiet] [--verbose]
dbh restore collection --backup <backup-name> --collection <name> --to <environment> [--yes] [--force-production-restore] [--quiet] [--verbose]
```

Required flags:

- `restore full`: `--backup`, `--to`
- `restore collection`: `--backup`, `--collection`, `--to`

Optional flags:

- `restore full`: `--yes`, `--skip-pre-backup`,
  `--force-production-restore`, `--quiet`, `--verbose`
- `restore collection`: `--yes`, `--force-production-restore`, `--quiet`,
  `--verbose`

No selective multi-collection restore mode is supported.

## Data Semantics

### Full restore

`restore full` applies a named archive as an exact replacement for normal user
collections in the target environment.

Normal user collections are every collection except internal Mongo namespaces
such as `system.*`. Internal namespaces are never prune targets.

Required behavior:

- validate the named backup artifacts and read their manifest before target
  mutation
- inspect the archive with the effective restore namespace contract before
  target mutation
- accept inspection only when the archive tool exits successfully and produces
  a recognized, unambiguous completed result
- require the inspected normal-user collection set to exactly equal the backup
  manifest collection list after the same internal-namespace filtering
- treat an empty archive as valid only when both the manifest and a recognized
  completed inspection explicitly contain zero normal user collections
- create a required production pre-restore backup only after the named archive
  has passed inspection
- restore the archive with drop enabled
- remove target-only normal user collections that are absent from the validated
  archive set
- verify collection presence, collection counts, and the absence of unexpected
  normal user collections before reporting success

The validated archive set, not an uninspected manifest alone, authorizes
target-only collection removal. A full restore that cannot establish that set
must fail before mutation.

### Collection restore

`restore collection` restores one named collection from a backup into the
target environment.

Required behavior:

- validate the named backup artifacts before restore
- require the requested collection to exist in the backup manifest and to have
  a finite, nonnegative manifest document count
- require confirmation before restoring into the target
- apply extra protections before restoring into production
- inspect the archive with the exact effective namespace contract before target
  mutation
- require inspection to identify exactly one source-to-target mapping for the
  requested collection
- restore only the requested collection with drop enabled
- verify the requested collection exists and its document count matches the
  manifest before reporting success
- never prune or verify unrelated target collections as part of collection
  restore

For same-database collection restore, the effective contract uses an exact
namespace include only. Namespace remapping is used only when the source and
target database names differ. A collection name that cannot be represented as
an exact namespace filter must fail before subprocess execution.

## Safety Contract

### General restore protections

Required behavior:

- the backup must be validated before restore begins
- target confirmation is required unless `--yes` is provided
- full restore verification must run after `restore full`
- collection-scoped verification must run after `restore collection`
- a failed or interrupted restore may leave the target dirty

### Verification result framing

Result-bearing `mongosh` operations must frame their machine-readable result
with a unique per-invocation marker. Parsers must accept only that exact marked
result and must fail closed when it is missing, duplicated, malformed, or has
the wrong shape.

Diagnostic stdout before or after a valid marked result is not result data. A
nonzero shell, connection, authentication, or JavaScript failure remains a
failure and must not be reclassified as a result-framing failure.

### Production restore protections

Required behavior:

- production restore requires `--force-production-restore`
- production restore requires an additional typed confirmation unless `--yes`
  is provided
- production restore creates a pre-restore production backup by default
- `--skip-pre-backup` may bypass that automatic production backup

### Target-trust contract

The restore command must track mutation, pruning, and verification separately.

- failure before mutation, including archive inspection failure:
  - target is unchanged
- failure or interruption while mutation is in progress:
  - target may be partially modified
- failure or interruption after a successful restore subprocess during prune or
  verification:
  - target requires independent verification or a rerun before it is trusted
- successful restore, prune, and verification:
  - target is verified

Operator-facing failure output must distinguish at least:

- restore subprocess outcome
- post-restore pruning outcome
- post-restore verification outcome
- target trust state

Cleanup failure must not hide the primary restore, prune, or verification
failure.

## Execution Model

### Full restore

`restore full` must perform this workflow:

1. validate the named backup artifacts
2. read the backup manifest
3. confirm the target restore
4. if target is production, require production-specific confirmation
5. inspect the archive and require its normal-user collection set to match the
   manifest
6. if target is production, optionally create a pre-restore production backup
   after archive inspection succeeds
7. restore the full archive into the target
8. remove target-only normal user collections absent from the validated archive
9. verify the target against the backup manifest and validated archive set

### Collection restore

`restore collection` must perform this workflow:

1. validate the named backup artifacts
2. read the backup manifest
3. confirm the requested collection and its expected count exist in the
   manifest
4. confirm the target restore
5. inspect the archive and require exactly the requested source-to-target
   namespace mapping
6. restore the named collection with drop enabled
7. verify requested collection presence and count

If target is production:

- require production-specific confirmation

The implementation may use:

- local archive paths
- remote temp archive files
- `mongorestore`
- `ssh`
- `scp`

The execution details must remain internal to the execution layer.

## Output Contract

Restore output should be concise and operator-oriented.

At minimum, normal output should make clear:

- which backup is being restored
- which target is being changed
- current long-running phase
- whether pre-restore backup is running
- whether archive inspection, pruning, and verification succeeded
- whether the restore completed successfully

Target output shape for `restore full`:

- start line
- archive inspection phase
- pre-restore backup phase when applicable
- restore phase
- target-only collection removal phase when needed
- verification phase
- final success summary

Target output shape for `restore collection`:

- start line
- collection archive inspection phase
- collection restore phase
- collection verification phase
- final success summary

Output modes are expected to align with repo standards:

- default: concise operator progress
- quiet: minimal success-path output while still reporting failures
- verbose: useful subprocess diagnostics allowed, without internal
  machine-result envelopes

## Failure Semantics

The command must fail fast and exit non-zero when any required step fails.

Failure cases include:

- missing or invalid backup artifact
- invalid production-restore confirmation
- pre-restore backup failure
- archive inspection failure or archive-versus-manifest mismatch
- restore failure
- target-only collection prune failure
- verification failure
- missing requested collection or collection count in the backup manifest
- ambiguous, absent, or unexpected collection namespace mapping

`restore collection` must fail before mutation if it cannot establish both the
requested archive namespace mapping and expected count.

## Interruption Contract

Interruptions such as `Ctrl-C` must surface practical operator guidance.

The command must distinguish interruptions by phase:

- interrupted before restore starts:
  - target not modified
- interrupted during pre-restore backup:
  - target not modified
- interrupted during archive inspection:
  - target not modified
- interrupted during restore:
  - target may be partially modified
- interrupted during target-only collection removal:
  - restore subprocess may have completed, but exact replacement did not
    complete
- interrupted during verification:
  - restore subprocess may have completed, but target trust is not established

Interruption messaging should report:

- which restore phase was interrupted
- restore, prune, and verification outcomes known at interruption time
- whether the target is unchanged, may be partially modified, or requires
  independent verification
- whether temporary artifact cleanup was attempted or may not have completed

The implementation should avoid dumping raw child-command text in normal
interruption messages.

## Cleanup Guarantees

The command must attempt cleanup when restore fails or is interrupted.

Required cleanup behavior:

- local temp artifacts should be removed when practical
- remote temp archive files should be cleanup-attempted when remote execution
  was used
- cleanup failure should not replace the original restore failure

## Environment Assumptions

The command assumes:

- the named backup exists and is valid
- the target environment is defined in config
- Mongo credentials are valid
- remote environments include required SSH configuration
- required binaries are installed where needed

`doctor` is the preflight command for validating environment assumptions before
risky restore work.

## Boundaries

`restore full` owns:

- backup validation
- target confirmation
- production-specific restore protections
- pre-restore production backup orchestration
- archive inspection and archive-versus-manifest validation
- full archive restore
- removal of target-only normal user collections
- post-restore verification
- cleanup attempts for temporary artifacts

`restore collection` owns:

- backup validation
- collection-presence and expected-count validation
- target confirmation
- exact collection namespace inspection
- collection restore
- collection-scoped verification
- cleanup attempts for temporary artifacts

`restore` does not own:

- backup retention/pruning
- backup artifact creation beyond the pre-restore production safety backup
- schema migration logic
- merge behavior
- partial multi-collection restore workflows

## Refactor Guidance

Any refactor of restore should preserve these invariants:

- named backup artifacts are validated before restore
- production restore retains stronger safeguards than non-production restore
- archive inspection completes before target mutation
- full restore remains an exact replacement of normal user collections
- full and collection restore verification remain required
- interrupted or failed restore reports the strongest target-trust state
  established by the completed phases
- cleanup failure does not mask the original operational failure
- operator-facing output stays practical and phase-aware

## Deferred Decisions

These are intentionally out of scope and should not be added implicitly during
refactor:

- merge mode
- multi-collection restore mode
- transactional rollback guarantees
- schema-aware migration logic
- broader backup/restore product redesign beyond restore cleanup
- public `--dry-run` or `--explain` modes
- machine-readable `--json` command output
- index metadata manifests, document hashes, or automatic collection preimage
  backups
