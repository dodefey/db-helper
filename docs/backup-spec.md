# Backup Spec

## Purpose

`backup` captures a full Mongo database or selected collections from one configured environment into a local archive plus manifest.

The command exists for operational workflows such as:

- creating a recovery point before risky work
- capturing a known-good production snapshot
- preserving the current target before a manual sync or restore
- inspecting or restoring a previously saved snapshot later

`backup` also supports exact-name deletion and manual pruning by retained count.
Automatic retention and replication are outside its scope.

## Command Surface

CLI forms:

```bash
dbh backup create --from <environment> [--name <name>] [--collections=<name>[,<name>...] | --collection <name> [--collection <name> ...]] [--note <text>] [--tag <tag>] [--quiet] [--verbose] [--log]
dbh backup list [--from <environment>] [--tag <tag>] [--json] [--quiet] [--verbose] [--log]
dbh backup usage [--json] [--quiet] [--verbose] [--log]
dbh backup delete --backup <name> [--yes] [--quiet] [--verbose] [--log]
dbh backup prune --keep-last <N> [--dry-run] [--yes] [--quiet] [--verbose] [--log]
dbh backup inspect --backup <backup-name>
```

Required flags:

- `backup create`: `--from`
- `backup inspect`: `--backup`
- `backup delete`: `--backup`
- `backup prune`: `--keep-last` (integer of at least 1)

Optional flags:

- `backup create` accepts `--collections=name1,name2` or repeatable `--collection <name>`, plus `--name`, `--note`, `--tag`, `--quiet`, `--verbose`, and `--log`
- `backup list`: `--from`, `--tag`, `--json`, `--quiet`, `--verbose`, `--log`
- `backup usage`: `--json`, `--quiet`, `--verbose`, `--log`
- `backup delete`: `--yes`, `--quiet`, `--verbose`, `--log`
- `backup prune`: `--dry-run`, `--yes`, `--quiet`, `--verbose`, `--log`

## Data Semantics

`backup create` captures a full database by default. With a collection selection, it requires every requested name to exist in the source and verifies that the new archive contains exactly that selection before writing a manifest.

Collection backup requires data collections. A selected view fails metadata collection, and the error names the view and its backing collection. Time-series collections are eligible.

Current behavior:

- create a timestamped backup directory under the configured backup root
- create `dump.archive.gz` for a full backup or `collections.archive.gz` for a collection backup
- register a local creation marker before exposing a new backup directory; refuse existing directories and same-name creation markers
- write `manifest.json`
- remove the creation marker after validation or failure cleanup
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

- `dump.archive.gz` for a full backup or `collections.archive.gz` for a collection backup
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

`backup list` displays a padded table, newest first, with backup name, source
environment, creation time in UTC, allocated disk usage, and tags. Its summary
totals only the displayed backups after filtering. Usage includes the complete
backup directory and directory entries, uses filesystem allocation in 512-byte
blocks, skips symlink targets, and counts hard links once within each backup.
Shared blocks across backups or copy-on-write clones may be counted more than
once; the total does not promise reclaimable space. A measurement failure keeps
the backup visible with `unknown` usage and labels the total as known usage with
an unavailable count. Missing archives are not interpreted as zero-size archives;
listing remains a catalog operation rather than artifact validation.

Live same-host backup creation is listed as `in progress` without artifact warnings. Unmarked or stale incomplete backups retain normal checks. See [backup query output](backup-query-output.md) for marker semantics.

For list output, `--quiet` emits only tab-separated rows in this order: name,
environment, createdAt, tags, allocated bytes (or `unknown`). `--verbose` includes
the default table and summary plus backup paths and paths with unavailable
usage. An existing empty root prints `No backups found.` by default or nothing
in quiet mode. A missing or unreadable root fails explicitly. Per-entry manifest,
archive, and allocation issues retain healthy results and exit with status 2;
issues are printed to stderr for text output. Metadata that cannot be classified
by a filter remains visible with unknown metadata. Quiet and verbose flags are
mutually exclusive.

`backup list --json` and `backup usage --json` follow the versioned contract in
[backup-query-output.md](backup-query-output.md). They emit one JSON document on
stdout, including errors, and keep diagnostics on stderr. Both queries only
inspect local filesystems and write diagnostic logs in the OS temporary directory;
they do not create configured storage directories or invoke MongoDB/SSH checks.
Capacity reporting never aggregates free space across locations. Archive
verification is explicitly not performed by listing.

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

`backup delete` owns exact-name removal. `backup prune` owns manual selection by
retained full-backup count per environment and guarded removal of the confirmed candidates.

`backup` does not own:

- automatic retention or pruning
- offsite upload
- encryption
- incremental backup strategy

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
- incremental backups

## Delete

`dbh backup delete --backup <name> [--yes] [--quiet] [--verbose] [--log]`
permanently removes one exact backup directory. Wildcards, multiple names,
retention policies, dry-run, and undo are outside this command's scope.

The command resolves the configured backup root, checks the target, and prompts
with its name and resolved path. Noninteractive use requires `--yes`. Refusing
the prompt leaves files unchanged. Execution acquires a per-name deletion guard
and checks creation activity and target type again after confirmation. Creation
holds that same guard while registering activity and exposing its directory,
then releases it before copying data. Names differing only in ASCII letter case
share the guard to protect case-insensitive filesystems. Activity markers keep
their original exact-name identity, so distinct backups on case-sensitive
filesystems retain separate metadata. Concurrent setup/deletion operations fail
safely rather than waiting or automatically retrying.

A readable manifest or archive is not required. A missing name succeeds as
already absent; an unavailable or missing backup root fails. Backup-directory
symlinks and non-directory targets are refused. Internal links are unlinked
without following targets. A configured root symlink is resolved before prompting.
A same-host creation marker with a confirmed stopped PID is removed with the
backup. On macOS, new markers use a hash of the hardware UUID when available,
so a hostname change does not prevent checking the local PID. Markers without
a machine ID require an exact hostname match. Live, foreign-host, unreadable,
or malformed markers block deletion because they do not establish that creation
stopped. PID reuse remains a local process-identification limitation.

Backup creation also records the PID of the local process writing the archive
(the dump or download). Delete and prune check it even after the main dbh
process exits. A confirmed stopped writer can be cleared with the backup.
If dbh exits before recording the PID, the writer marker blocks deletion.
Confirm the writer has stopped before manually removing the marker shown in
the error.

The guard is a private sibling file and is removed after creation setup or
deletion, including handled failures. Forced termination can leave the guard
behind; a later attempt reports its exact path. Confirm the old operation has
stopped before manually
removing that guard and retrying. Likewise, unknown creation markers require
operator inspection. Coordination covers updated dbh commands, not external
filesystem writers or older dbh versions. Do not alter the backup root or target
concurrently with deletion.

Recursive deletion is not transactional. On failure after removal starts, the
command exits nonzero and reports that files may already have been removed.
Guard-cleanup failures also exit nonzero and preserve the deletion outcome.
Success and already-absent results exit zero. Default and quiet modes print one
final result; verbose adds the path. Standard failure-log and `--log` behavior
apply. `deleteBackup(root, name)` acquires the per-name guard and uses the shared
`deleteBackupUnderGuard` helper for safety checks and removal. Prune holds its
plan guards and calls that same helper. Neither helper prompts or chooses a
retention policy.

## Storage awareness

Explicit `backup create` checks local backup-root filesystem capacity before
creation and after success. Below 1 GiB available (matching doctor), it prints an
advisory warning to stderr with list/delete guidance, at most once per invocation. It does not block creation,
estimate the next archive size, inspect remote capacity, or delete anything.
A missing root before first creation simply leaves the initial capacity unknown.

After success, default/verbose modes print one storage line with directory count,
allocated usage and available capacity; quiet omits it. Counts include incomplete
and active catalog entries. Partial allocation totals are labeled `at least`;
unavailable inventory/capacity are explicit, never represented as zero. Totals
can include shared blocks and do not promise reclaimable space. Measurement
failure never changes backup success or triggers artifact cleanup. Internal
pre-restore backups keep their existing output. Automatic retention is deferred.

## Prune

`dbh backup prune --keep-last <N> [--dry-run] [--yes] [--quiet] [--verbose] [--log]`
keeps the newest N eligible full backups per manifest source environment, including
historical environments absent from current config. N is a required safe integer
of at least 1. Order is descending manifest creation timestamp, then ascending
backup name (ordinal comparison) for ties. Directory dates and names do not set age.

Eligibility requires valid full-backup metadata, a present nonempty regular archive,
a supported name, a real backup directory, and proof that creation has stopped. This does not
verify archive integrity or restorability. Ineligible entries are shown with skip
reasons and never count toward N. Root enumeration failures stop the command.

Show the resolved root and keep/delete/skip entries grouped by environment before
confirmation. Tags confer no protection. Dry run never prompts or deletes.
Noninteractive deletion requires --yes; a no-op needs no confirmation. Quiet retains
the safety preview and one summary. Standard logging and failure exit status apply.

Freeze candidates before confirmation. Hold per-name guards on retained backups
and candidate backups during execution; use the shared guarded deletion helper for each candidate, rechecking retained
and candidate eligibility and identity under the candidate guard before removal.
Changes since preview stop pruning; additional backups never expand the plan.
Stop at the first failure with deleted and remaining names. Deletion is not
transactional; a failed candidate may be partially removed. Guards coordinate dbh
operations only; do not modify backup files externally during execution.

Age rules, disk budgets, protected tags, automatic retention, and free-space
reporting are outside this version's scope.
