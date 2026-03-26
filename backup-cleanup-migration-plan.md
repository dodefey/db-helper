# Backup Cleanup Migration Plan

```text
Date: 2026-03-26 (America/Chicago)
Status: Phase 5 complete; Phase 6 pending
Branch baseline: main
Sequence: backup contract first, backup execution second, backup output and interruption hardening third
```

## Objective

Harden `backup` into a clear, reliable archive-and-manifest workflow that matches [backup-spec.md](/Users/davidodefey/projects/dbtools/backup-spec.md), without expanding scope into retention, offsite storage, or encryption features.

This document is the canonical working record for backup cleanup. It should be updated as work lands so later tasks can rely on a current inventory of what is complete, what remains to be done, and what is intentionally deferred.

## Current State

### Current backup state

- [src/cli.ts](/Users/davidodefey/projects/dbtools/src/cli.ts) exposes `backup create`, `backup list`, and `backup inspect`
- [src/commands/backup.ts](/Users/davidodefey/projects/dbtools/src/commands/backup.ts) now delegates `backup create` into a dedicated backup execution layer
- [src/lib/backup.ts](/Users/davidodefey/projects/dbtools/src/lib/backup.ts) now owns backup name resolution, destination path setup, metadata collection, archive creation, manifest writing, and artifact validation for `backup create`
- [src/lib/backups.ts](/Users/davidodefey/projects/dbtools/src/lib/backups.ts) owns backup path helpers, manifest read/write helpers, listing, and artifact validation
- [src/lib/mongo.ts](/Users/davidodefey/projects/dbtools/src/lib/mongo.ts) owns Mongo and SSH transport, metadata collection helpers, and archive creation
- [backup-spec.md](/Users/davidodefey/projects/dbtools/backup-spec.md) now defines the intended backup behavior for this cleanup

### Current safety state

- backup metadata now excludes `system.*` collections
- archive and manifest validation exists through [src/lib/backups.ts](/Users/davidodefey/projects/dbtools/src/lib/backups.ts)
- backup create now has a phase-aware interruption and failure contract in [src/lib/backup.ts](/Users/davidodefey/projects/dbtools/src/lib/backup.ts)
- incomplete backup artifacts are now cleanup-attempted when create fails or is interrupted
- cleanup failure is now reported without replacing the primary backup failure
- backup create now has a dedicated operator-output model with `default`, `quiet`, and `verbose` behavior

### Current repo state

- the repo currently typechecks and builds
- sync has already been hardened with output, verification, cleanup, and interruption behavior
- backup create is the highest-value backup refactor target because list and inspect are comparatively simple catalog operations
- backup now has direct tests for successful backup creation through [tests/backup.test.ts](/Users/davidodefey/projects/dbtools/tests/backup.test.ts)

## Findings

### Backup create is the real utility; list and inspect are catalog helpers

The operational value of backup comes from `backup create`.

`backup list` and `backup inspect` are useful, but they depend on backup artifacts being reliable. Cleanup should focus on create first, then let the catalog behavior inherit stronger artifacts.

### Backup command logic was too concentrated in one file

[src/commands/backup.ts](/Users/davidodefey/projects/dbtools/src/commands/backup.ts) previously mixed:

- backup naming
- destination path setup
- metadata collection
- archive creation
- manifest creation
- artifact validation

That concentration made output, interruption, and cleanup behavior harder to evolve cleanly.

Phase 2 resolves this by moving the create flow into [src/lib/backup.ts](/Users/davidodefey/projects/dbtools/src/lib/backup.ts). Later phases should continue to keep the command layer thin instead of moving orchestration back into it.

### Incomplete-backup handling is now explicit, but output is still behind

Current code now treats incomplete backup directories as invalid and cleanup-attempts them when create fails or is interrupted.

The remaining gap is operator experience, not failure semantics: backup still needs phase-oriented output and a clearer success summary.

### Backup output now has a usable baseline, but README and broader coverage still remain

Backup create now emits phase-oriented output in default mode and suppresses summaries in quiet mode while still allowing raw subprocess output in verbose mode.

The remaining work is documentation and any later command-surface coverage, not basic backup-create output plumbing.

### Backup now has a spec and a dedicated execution layer

[backup-spec.md](/Users/davidodefey/projects/dbtools/backup-spec.md) is now detailed enough to act as the behavior authority for backup cleanup, and [src/lib/backup.ts](/Users/davidodefey/projects/dbtools/src/lib/backup.ts) is now the correct place for later backup-create behavior changes.

The implementation should treat that spec as the source of truth and avoid expanding into retention or storage-product work during this cleanup.

### Phase 3 successfully layered cleanup and interruption behavior onto Phase 2

The backup execution layer now owns:

- cleanup attempts for incomplete backup directories
- primary-error preservation when cleanup also fails
- interruption handling that avoids low-level command text in the primary user-facing message

That confirms the Phase 2 extraction boundary was the right place to add Phase 3 behavior.

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

- complete within current scope

Notes:

- [src/lib/backup.ts](/Users/davidodefey/projects/dbtools/src/lib/backup.ts) is now the canonical backup-create execution unit
- [src/commands/backup.ts](/Users/davidodefey/projects/dbtools/src/commands/backup.ts) should stay thin
- [tests/backup.test.ts](/Users/davidodefey/projects/dbtools/tests/backup.test.ts) currently covers only the successful create path and metadata shaping
- later phases should extend the existing dependency injection rather than introducing a second backup-create path

### Phase 3

- add failure and interruption handling for incomplete backup artifacts
- make cleanup and error precedence explicit in the implementation

Status:

- complete

Notes:

- start from [src/lib/backup.ts](/Users/davidodefey/projects/dbtools/src/lib/backup.ts), not the command layer
- backup create now cleanup-attempts incomplete directories on failure and interruption
- backup create now preserves the primary failure when cleanup also fails
- backup-create phases are now explicit in code, which should be reused for later output work

### Phase 4

- add output modes and phase-aware operator output
- add a final success summary for backup create

Status:

- complete

Notes:

- reuse the existing repo output conventions from sync rather than inventing a backup-specific output model
- keep backup output practical and phase-oriented
- default-mode output should focus on real phase boundaries only: metadata, archive, manifest, validation, cleanup
- do not add synthetic progress indicators for archive creation unless they are backed by real subprocess evidence
- backup create now prints phase boundaries and a final success summary in default mode
- quiet mode suppresses summary output while still threading quiet behavior down into Mongo helpers

### Phase 5

- add direct tests for backup creation, validation, cleanup, and interruption behavior
- verify `npm run typecheck` and `npm run build`

Status:

- complete

Notes:

- current backup tests already exist and should be extended rather than replaced
- failure cleanup, interruption, output, and command-surface tests now exist
- prefer testing [src/lib/backup.ts](/Users/davidodefey/projects/dbtools/src/lib/backup.ts) directly with injected dependencies before adding command-surface tests
- when later phases add cleanup behavior, include explicit assertions for partial-directory removal attempts and primary-error preservation
- [src/commands/backup.ts](/Users/davidodefey/projects/dbtools/src/commands/backup.ts) now has a small dependency seam so command behavior can be tested without brittle module patching

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

## Next Implementation Notes

- The next code change should begin in [src/lib/backup.ts](/Users/davidodefey/projects/dbtools/src/lib/backup.ts), not in [src/commands/backup.ts](/Users/davidodefey/projects/dbtools/src/commands/backup.ts).
- Phase 6 should update README backup docs to match the current implementation and operator workflow.
- Incomplete backup cleanup is now framed around the backup directory as the unit of validity: if a create run does not complete validation, the directory is treated as invalid and cleanup-attempted.
- Interruption handling now follows the same practical pattern used for sync: phase-aware messaging, conservative claims about cleanup, and no low-level command dump in the primary user-facing message.
- [src/lib/backups.ts](/Users/davidodefey/projects/dbtools/src/lib/backups.ts) should remain the artifact helper layer; avoid moving orchestration back into it while implementing later phases.
