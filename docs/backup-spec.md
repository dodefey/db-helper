# Backup Spec

## Purpose

`backup` captures a full Mongo database from one configured environment into a local archive plus manifest.

The command exists for operational workflows such as:

- creating a recovery point before risky work
- capturing a known-good production snapshot
- preserving the current target before a manual sync or restore
- inspecting or restoring a previously saved snapshot later

`backup` is not a retention manager, replication system, or selective export tool.

## Command Surface

CLI forms:

```bash
dbh backup create --from <environment> [--note <text>] [--tag <tag>] [--quiet] [--verbose]
dbh backup list [--from <environment>] [--tag <tag>]
dbh backup inspect --backup <backup-name>
```

Required flags:

- `backup create`: `--from`
- `backup inspect`: `--backup`

Optional flags:

- `backup create`: `--note`, `--tag`, `--quiet`, `--verbose`
- `backup list`: `--from`, `--tag`

No selective collection backup mode is supported.

## Data Semantics

`backup create` captures a full database archive and a manifest for the chosen source environment.

Current behavior:

- create a timestamped backup directory under the configured backup root
- create `dump.archive.gz`
- write `manifest.json`
- include collection names and collection counts when metadata collection succeeds
- exclude internal Mongo collections such as `system.*` from backup metadata

The backup artifact is not valid until:

- the archive exists
- the manifest exists
- the archive is non-empty
- the manifest is non-empty

## Backup Layout

Each backup must be stored under:

```text
<backupRoot>/<backup-name>/
```

Required contents:

- `dump.archive.gz`
- `manifest.json`

Manifest contents must include:

- backup name
- source environment
- database name
- creation timestamp
- optional note
- tags
- collection list
- tool version
- archive file name
- collection counts when available

## Metadata Contract

Backup metadata is part of the user-facing artifact model.

Required behavior:

- collection names should be captured from the source database
- collection counts should be captured for user collections
- internal collections such as `system.*` must be excluded from metadata

Tradeoff:

- collection counts are collected from a live source database and may drift slightly if the source is changing during backup creation
- that drift is acceptable because counts are advisory metadata, not a transactional guarantee

## Execution Model

`backup create` must perform an archive-based workflow:

1. validate the source environment exists
2. ensure the backup root and destination directory exist
3. collect source metadata
4. create the archive
5. write the manifest
6. validate the resulting artifact

The implementation may use:

- local temp paths
- remote temp archive files
- `ssh`
- `scp`
- `mongodump`
- `mongosh`

The implementation must keep those details internal to the execution layer.

## Output Contract

Backup output should be concise and operator-oriented.

At minimum, normal output should make clear:

- source environment
- current long-running phase
- backup name
- backup path
- whether backup completed successfully

Current target output shape for `backup create`:

- start line
- metadata collection phase
- archive creation phase
- manifest write phase
- artifact validation phase
- final success summary

Output modes are expected to align with repo standards:

- default: concise operator progress
- quiet: minimal output
- verbose: raw subprocess output allowed

## Failure Semantics

The command must fail fast and exit non-zero when any required step fails.

Failure cases include:

- source metadata collection fails
- archive creation fails
- manifest write fails
- artifact validation fails
- required local or remote path cannot be used

`backup list` and `backup inspect` should fail if the requested backup artifact is missing or invalid.

## Incomplete Backup Contract

`backup create` may leave partial artifacts behind if it is interrupted or fails partway through.

The implementation must treat incomplete backup directories as invalid.

Required behavior:

- if archive creation, manifest creation, or validation fails, cleanup of incomplete backup artifacts should be attempted
- cleanup failure must not hide the primary backup failure
- an incomplete backup must not be reported as a valid finished backup

## Interruption Contract

Interruptions such as `Ctrl-C` must surface practical operator guidance.

The command must distinguish interruptions by phase:

- interrupted during metadata collection:
  - no valid backup was created
- interrupted during archive creation:
  - backup may be incomplete and must not be trusted
- interrupted during manifest write or validation:
  - backup may be incomplete or invalid and must not be trusted

Interruption messaging should report:

- which backup phase was interrupted
- whether a valid backup was created
- whether cleanup of incomplete artifacts was attempted or may not have completed

The implementation should avoid dumping raw child-command text in normal interruption messages.

## Cleanup Guarantees

The command must attempt cleanup when backup creation fails or is interrupted.

Required cleanup behavior:

- incomplete archive files should be removed when practical
- incomplete backup directories should be removed when practical
- remote temp archive files should be cleanup-attempted when remote execution was used

Cleanup failure should not replace the original failure.

## Environment Assumptions

The command assumes:

- the source environment is defined in config
- Mongo credentials are valid
- remote environments include required SSH configuration
- required binaries are installed where needed
- the backup root is writable

`doctor` is the preflight command for validating those assumptions.

## Boundaries

`backup create` owns:

- source metadata collection
- archive creation
- manifest creation
- artifact validation
- cleanup attempts for incomplete backup artifacts

`backup list` and `backup inspect` own:

- browsing known backups
- filtering by source environment or tag
- reading manifest metadata

`backup` does not own:

- retention/pruning policy
- offsite upload
- encryption
- incremental backup strategy
- collection-level export filters

## Refactor Guidance

Any refactor of backup should preserve these invariants:

- a backup is not valid until archive and manifest both exist and validation passes
- internal `system.*` collections are excluded from metadata
- incomplete backup artifacts are cleanup-attempted on failure or interruption
- cleanup failure does not mask the original operational failure
- operator-facing output stays practical and phase-aware

## Deferred Decisions

These are intentionally out of scope and should not be added implicitly during refactor:

- automatic retention/pruning
- offsite upload
- encryption
- collection-level backup filters
- incremental backups
