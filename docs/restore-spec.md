# Restore Spec

## Purpose

`restore` applies a named backup archive to a target environment.

The command exists for operational workflows such as:

- restoring a known-good backup into `development` or `test`
- recovering a corrupted or disrupted environment from a validated backup
- restoring one collection from a backup without replacing the full database
- restoring production from a known backup with additional safeguards

`restore` is not a generic migration tool, merge tool, or arbitrary data patching interface.

## Command Surface

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

No selective multi-collection restore mode is supported.

## Data Semantics

### Full restore

`restore full` applies the full named backup archive to the target environment and then verifies the result against the backup manifest.

Current behavior:

- validate the named backup artifacts before any restore begins
- require confirmation before restoring into any target
- apply extra protections before restoring into production
- restore the full backup archive into the target
- verify collection presence and collection counts after restore

### Collection restore

`restore collection` restores one named collection from a backup into the target environment.

Current behavior:

- validate the named backup artifacts before restore
- confirm the collection exists in the backup manifest
- require confirmation before restoring into the target
- apply extra protections before restoring into production
- restore only the requested collection with drop enabled

## Safety Contract

### General restore protections

Required behavior:

- the backup must be validated before restore begins
- target confirmation is required unless `--yes` is provided
- restore verification must run after `restore full`
- a failed or interrupted restore may leave the target dirty

### Production restore protections

Required behavior:

- production restore requires `--force-production-restore`
- production restore requires an additional typed confirmation unless `--yes` is provided
- production restore creates a pre-restore production backup by default
- `--skip-pre-backup` may bypass that automatic production backup

### Dirty-target contract

If restore fails or is interrupted after restore starts:

- the target may be partially replaced
- the target must be treated as dirty until revalidated or restored again
- cleanup failure must not hide the primary restore failure

If restore fails before restore starts:

- the target must be treated as unchanged

## Execution Model

### Full restore

`restore full` must perform this workflow:

1. validate the named backup artifacts
2. read the backup manifest
3. confirm the target restore
4. if target is production:
   - require production-specific confirmation
   - optionally create a pre-restore production backup
5. restore the full archive into the target
6. verify the target against the backup manifest

### Collection restore

`restore collection` must perform this workflow:

1. validate the named backup artifacts
2. read the backup manifest
3. confirm the requested collection exists in the manifest
4. confirm the target restore
5. restore the named collection with drop enabled

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
- whether verification succeeded
- whether the restore completed successfully

Target output shape for `restore full`:

- start line
- pre-restore backup phase when applicable
- restore phase
- verification phase
- final success summary

Target output shape for `restore collection`:

- start line
- collection restore phase
- final success summary

Output modes are expected to align with repo standards:

- default: concise operator progress
- quiet: minimal output
- verbose: raw subprocess output allowed

## Failure Semantics

The command must fail fast and exit non-zero when any required step fails.

Failure cases include:

- missing or invalid backup artifact
- invalid production-restore confirmation
- pre-restore backup failure
- restore failure
- verification failure
- requested collection missing from backup manifest

`restore collection` should fail if the named collection is not present in the backup manifest.

## Interruption Contract

Interruptions such as `Ctrl-C` must surface practical operator guidance.

The command must distinguish interruptions by phase:

- interrupted before restore starts:
  - target not modified
- interrupted during pre-restore backup:
  - target not modified
- interrupted during restore:
  - target may be dirty
- interrupted during verification:
  - target may be dirty

Interruption messaging should report:

- which restore phase was interrupted
- whether the target is still safe or may be dirty
- whether temporary artifact cleanup was attempted or may not have completed

The implementation should avoid dumping raw child-command text in normal interruption messages.

## Cleanup Guarantees

The command must attempt cleanup when restore fails or is interrupted.

Required cleanup behavior:

- local temp artifacts should be removed when practical
- remote temp archive files should be cleanup-attempted when remote execution was used
- cleanup failure should not replace the original restore failure

## Environment Assumptions

The command assumes:

- the named backup exists and is valid
- the target environment is defined in config
- Mongo credentials are valid
- remote environments include required SSH configuration
- required binaries are installed where needed

`doctor` is the preflight command for validating environment assumptions before risky restore work.

## Boundaries

`restore full` owns:

- backup validation
- target confirmation
- production-specific restore protections
- pre-restore production backup orchestration
- full archive restore
- post-restore verification
- cleanup attempts for temporary artifacts

`restore collection` owns:

- backup validation
- collection-presence validation
- target confirmation
- collection restore
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
- restore verification remains required for full restore
- interrupted or failed restore after restore starts is treated as a dirty-target risk
- cleanup failure does not mask the original operational failure
- operator-facing output stays practical and phase-aware

## Deferred Decisions

These are intentionally out of scope and should not be added implicitly during refactor:

- merge mode
- multi-collection restore mode
- transactional rollback guarantees
- schema-aware migration logic
- broader backup/restore product redesign beyond restore cleanup
