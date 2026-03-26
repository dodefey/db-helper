# Restore Cleanup Migration Plan

```text
Date: 2026-03-26 (America/Chicago)
Status: Phase 2 complete; later phases pending
Branch baseline: main
Sequence: restore contract first, restore execution second, restore output and interruption hardening third
```

## Objective

Harden `restore` into a clear, reliable backup-to-target workflow that matches [restore-spec.md](/Users/davidodefey/projects/dbtools/docs/restore-spec.md), without expanding scope into merge behavior, schema migration features, or broader recovery-product redesign.

This document is the canonical working record for restore cleanup. It should be updated as work lands so later tasks can rely on a current inventory of what is complete, what remains to be done, and what is intentionally deferred.

## Current State

### Current restore state

- [src/cli.ts](/Users/davidodefey/projects/dbtools/src/cli.ts) exposes `restore full` and `restore collection`
- [src/commands/restore.ts](/Users/davidodefey/projects/dbtools/src/commands/restore.ts) now delegates restore execution into a dedicated restore layer while keeping confirmation and production safety gates in the command layer
- [src/lib/restore.ts](/Users/davidodefey/projects/dbtools/src/lib/restore.ts) now owns backup validation, pre-restore production backup orchestration, restore execution, and verification
- [src/lib/backups.ts](/Users/davidodefey/projects/dbtools/src/lib/backups.ts) owns backup artifact validation and manifest reading
- [src/lib/mongo.ts](/Users/davidodefey/projects/dbtools/src/lib/mongo.ts) owns archive restore transport
- [src/lib/verify.ts](/Users/davidodefey/projects/dbtools/src/lib/verify.ts) owns restore verification
- [docs/restore-spec.md](/Users/davidodefey/projects/dbtools/docs/restore-spec.md) now defines the intended restore behavior for this cleanup

### Current safety state

- named backup artifacts are validated before restore
- target confirmation exists unless `--yes` is provided
- production restore requires `--force-production-restore` and an extra typed confirmation
- production restore creates a pre-restore production backup by default
- restore verification exists for `restore full`
- restore does not yet have a dedicated interruption contract or output model

### Current repo state

- sync and backup have already been hardened with execution layers, output modes, cleanup contracts, and interruption handling
- restore is now the highest-risk remaining command surface because it can modify `production`
- restore now has direct tests for command delegation and extracted execution behavior through [tests/restore.test.ts](/Users/davidodefey/projects/dbtools/tests/restore.test.ts)

## Findings

### Restore is the highest-risk remaining workflow

Unlike sync, restore can target `production`.

That makes restore the command surface where safety messaging, interruption handling, and execution boundaries matter most.

### Restore logic was too concentrated in one command file

[src/commands/restore.ts](/Users/davidodefey/projects/dbtools/src/commands/restore.ts) previously mixed:

- backup validation
- target confirmation
- production-specific confirmation
- pre-restore safety backup orchestration
- archive restore execution
- verification

That concentration made failure behavior and testing harder to evolve safely.

Phase 2 resolves the core of that problem by moving restore execution into [src/lib/restore.ts](/Users/davidodefey/projects/dbtools/src/lib/restore.ts).

### Restore has safety rules, but not yet a full operational contract

The current code has strong production protections and verification, but it does not yet make interruption behavior, cleanup guarantees, or dirty-target messaging explicit enough.

This is the main operational gap in restore today.

### Restore now has the same execution-layer shape sync and backup use

Sync, backup, and now restore are easier to reason about because they each have:

- a thin command layer
- a dedicated execution layer
- direct tests around the execution contract

The next restore phases should build on that structure instead of moving orchestration back into the command layer.

## Proposed Target Shape

### Command layer

Keep [src/commands/restore.ts](/Users/davidodefey/projects/dbtools/src/commands/restore.ts) responsible only for:

- parsing user intent
- prompting for confirmation
- enforcing production-specific safety gates
- delegating to one restore execution API for full restore and one for collection restore

### Restore execution layer

Introduce a dedicated restore runner, preferably in [src/lib/restore.ts](/Users/davidodefey/projects/dbtools/src/lib/restore.ts).

That runner should own:

- backup validation and manifest loading
- restore phases
- optional pre-restore production backup orchestration
- verification
- cleanup attempts for temporary artifacts

The execution layer should remain non-interactive so it is straightforward to test.

### Shared backup and verify layers

Keep [src/lib/backups.ts](/Users/davidodefey/projects/dbtools/src/lib/backups.ts) focused on artifact validation and manifest helpers.

Keep [src/lib/verify.ts](/Users/davidodefey/projects/dbtools/src/lib/verify.ts) focused on restore verification logic.

Do not let command-layer orchestration leak into either layer.

### Shared mongo layer

Keep [src/lib/mongo.ts](/Users/davidodefey/projects/dbtools/src/lib/mongo.ts) as the low-level archive-restore and transport layer.

Refine it only as needed for restore cleanup:

- restore helpers
- temp artifact helpers
- interruption-aware subprocess handling

### Error and output behavior

Add restore-level progress output for:

- start
- pre-restore backup when applicable
- restore
- verify
- cleanup

Preserve the original restore failure when cleanup also fails.

## Cleanup Sequence

### Phase 1

- add restore spec and cleanup-plan docs
- lock the restore safety and dirty-target contract
- define interruption and cleanup behavior

Status:

- complete with docs only

### Phase 2

- add a dedicated restore execution API
- move restore orchestration out of the command layer

Status:

- complete within current scope

Notes:

- [src/lib/restore.ts](/Users/davidodefey/projects/dbtools/src/lib/restore.ts) is now the canonical restore execution unit
- [src/commands/restore.ts](/Users/davidodefey/projects/dbtools/src/commands/restore.ts) should stay focused on confirmation and production safety gates
- [tests/restore.test.ts](/Users/davidodefey/projects/dbtools/tests/restore.test.ts) now covers command delegation and basic execution behavior for `restore full` and `restore collection`

### Phase 3

- add failure and interruption handling for restore
- make cleanup and dirty-target messaging explicit

Status:

- pending

Notes:

- preserve the primary restore failure when cleanup also fails
- distinguish target-unchanged vs target-may-be-dirty by phase

### Phase 4

- add output modes and phase-aware operator output
- add final success summaries for full and collection restore

Status:

- pending

Notes:

- reuse the existing repo output conventions from sync and backup
- avoid synthetic progress indicators

### Phase 5

- add direct tests for restore execution, cleanup, interruption, and command-surface behavior
- verify `npm run typecheck` and `npm run build`

Status:

- pending

### Phase 6

- add a dedicated restore section to the README in the same style now used for sync and backup

Status:

- pending

## Acceptance Criteria

- named backup artifacts are validated before restore begins
- production restore retains stronger safeguards than non-production restore
- full restore verification remains required
- failed or interrupted restore after restore starts is treated as a dirty-target risk
- cleanup failure does not replace the original restore failure
- tests cover restore creation path equivalents, verification, cleanup, interruption, and command behavior
- `npm run typecheck` passes
- `npm run build` passes

## Deferred Work

- merge mode
- multi-collection restore mode
- transactional rollback guarantees
- schema-aware migration logic
- broader backup/restore product redesign beyond what restore cleanup needs

## Next Implementation Notes

- The next code change should begin in a dedicated restore execution layer, not by further growing [src/commands/restore.ts](/Users/davidodefey/projects/dbtools/src/commands/restore.ts).
- The first concrete target should be `restore full`; `restore collection` can follow once the shared restore execution boundary is established.
- Production restore protections should remain in the command layer until the execution boundary is stable, then they can be passed in as validated execution options.
- Dirty-target language should match the practical contract already used by sync.
