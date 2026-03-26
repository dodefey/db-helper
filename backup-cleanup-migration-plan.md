# Backup Cleanup Migration Plan

```text
Date: 2026-03-26 (America/Chicago)
Status: Draft; cleanup not started
Branch baseline: main
Sequence: backup contract first, backup execution second, backup output and interruption hardening third
```

## Objective

Harden `backup` into a clear, reliable archive-and-manifest workflow that matches [backup-spec.md](/Users/davidodefey/projects/dbtools/backup-spec.md), without expanding scope into retention, offsite storage, or encryption features.

This document is the canonical working record for backup cleanup. It should be updated as work lands so later tasks can rely on a current inventory of what is complete, what remains to be done, and what is intentionally deferred.

## Current State

### Current backup state

- [src/cli.ts](/Users/davidodefey/projects/dbtools/src/cli.ts) exposes `backup create`, `backup list`, and `backup inspect`
- [src/commands/backup.ts](/Users/davidodefey/projects/dbtools/src/commands/backup.ts) currently owns backup naming, metadata collection, archive creation, manifest writing, and artifact validation directly
- [src/lib/backups.ts](/Users/davidodefey/projects/dbtools/src/lib/backups.ts) owns backup path helpers, manifest read/write helpers, listing, and artifact validation
- [src/lib/mongo.ts](/Users/davidodefey/projects/dbtools/src/lib/mongo.ts) owns Mongo and SSH transport, metadata collection helpers, and archive creation
- [backup-spec.md](/Users/davidodefey/projects/dbtools/backup-spec.md) now defines the intended backup behavior for this cleanup

### Current safety state

- backup metadata now excludes `system.*` collections
- archive and manifest validation exists through [src/lib/backups.ts](/Users/davidodefey/projects/dbtools/src/lib/backups.ts)
- backup create does not yet have an explicit interruption contract
- cleanup of incomplete backup artifacts is not yet a first-class contract

### Current repo state

- the repo currently typechecks and builds
- sync has already been hardened with output, verification, cleanup, and interruption behavior
- backup create is the highest-value backup refactor target because list and inspect are comparatively simple catalog operations

## Findings

### Backup create is the real utility; list and inspect are catalog helpers

The operational value of backup comes from `backup create`.

`backup list` and `backup inspect` are useful, but they depend on backup artifacts being reliable. Cleanup should focus on create first, then let the catalog behavior inherit stronger artifacts.

### Backup command logic is still too concentrated in one file

[src/commands/backup.ts](/Users/davidodefey/projects/dbtools/src/commands/backup.ts) currently mixes:

- backup naming
- destination path setup
- metadata collection
- archive creation
- manifest creation
- artifact validation

That makes output, interruption, and cleanup behavior harder to evolve cleanly.

### Incomplete-backup handling is not yet a stable contract

Current code validates a finished archive and manifest, but it does not yet define the cleanup behavior for partial backup directories created during failure or interruption.

This is the main operational gap in backup create.

### Backup output is still closer to raw command output than operator output

Backup create currently inherits subprocess chatter more directly than sync does.

It does not yet have a clean default-mode phase model, final success summary, or interruption messaging contract.

### Backup now has a spec, but not yet a dedicated execution layer

[backup-spec.md](/Users/davidodefey/projects/dbtools/backup-spec.md) is now detailed enough to act as the behavior authority for backup cleanup.

The implementation should treat that spec as the source of truth and avoid expanding into retention or storage-product work during this cleanup.

## Proposed Target Shape

### Command layer

Keep [src/commands/backup.ts](/Users/davidodefey/projects/dbtools/src/commands/backup.ts) responsible only for:

- parsing user intent
- delegating create/list/inspect to backup services
- writing user-facing summaries

### Backup execution layer

Introduce a dedicated backup runner, preferably in [src/lib/backup.ts](/Users/davidodefey/projects/dbtools/src/lib/backup.ts).

That runner should own:

- backup name resolution
- destination path setup
- metadata collection
- archive creation
- manifest writing
- artifact validation
- cleanup attempts for incomplete artifacts

The execution layer should remain non-interactive so it is straightforward to test.

### Shared storage and artifact layer

Keep [src/lib/backups.ts](/Users/davidodefey/projects/dbtools/src/lib/backups.ts) focused on backup artifact and manifest helpers:

- path helpers
- manifest read/write helpers
- list helpers
- artifact validation helpers

Do not let command-level orchestration leak back into this layer.

### Shared mongo layer

Keep [src/lib/mongo.ts](/Users/davidodefey/projects/dbtools/src/lib/mongo.ts) as the low-level Mongo and SSH transport layer.

Refine it only as needed for backup cleanup:

- metadata collection helpers
- archive creation helpers
- remote temp cleanup behavior

Avoid broad redesign outside what backup cleanup requires.

### Error and output behavior

Add backup-level progress output for:

- metadata collection
- archive creation
- manifest write
- validation
- cleanup

Preserve the original backup failure when cleanup also fails, rather than replacing the operational error with a cleanup-only error.

## Cleanup Sequence

### Phase 1

- add backup spec and cleanup-plan docs
- lock the backup artifact-validity contract
- define interruption and incomplete-backup cleanup behavior

Status:

- complete with docs only

### Phase 2

- add a dedicated backup execution API
- move archive lifecycle and manifest orchestration out of the command layer

Status:

- pending

### Phase 3

- add failure and interruption handling for incomplete backup artifacts
- make cleanup and error precedence explicit in the implementation

Status:

- pending

### Phase 4

- add output modes and phase-aware operator output
- add a final success summary for backup create

Status:

- pending

### Phase 5

- add direct tests for backup creation, validation, cleanup, and interruption behavior
- verify `npm run typecheck` and `npm run build`

Status:

- pending

### Phase 6

- add a dedicated backup section to the README in the same style now used for sync

Status:

- pending

## Acceptance Criteria

- a backup is not reported as valid until archive and manifest both exist and validation passes
- internal `system.*` collections are excluded from backup metadata
- incomplete backup artifacts are cleanup-attempted on failure or interruption
- cleanup failure does not replace the original backup failure
- interruption messaging states whether a usable backup was created
- tests cover backup creation, validation, cleanup, and interruption handling
- `npm run typecheck` passes
- `npm run build` passes

## Deferred Work

- automatic retention/pruning
- offsite upload
- encryption
- collection-level backup filters
- incremental backups
- broader backup/restore product redesign beyond what backup cleanup needs
