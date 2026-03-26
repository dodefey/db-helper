# Sync Cleanup Migration Plan

```text
Date: 2026-03-25 (America/Chicago)
Status: Phases 1-3 complete within current scope; Phase 4 still pending
Branch baseline: main
Sequence: sync contract first, sync execution second, shared mongo hardening third
```

## Objective

Harden `sync` into a clear, destructive, full-target replacement workflow that matches [sync-spec.md](/Users/davidodefey/projects/dbtools/sync-spec.md), without expanding scope into backup or restore redesign.

This document is the canonical working record for the sync cleanup. It should be updated as work lands so later tasks can rely on a current inventory of what is complete, what remains to be done, and what is intentionally deferred.

## Current State

### Current sync state

- [src/cli.ts](/Users/davidodefey/projects/dbtools/src/cli.ts) exposes `sync` as a top-level command
- [src/commands/sync.ts](/Users/davidodefey/projects/dbtools/src/commands/sync.ts) performs allowlist validation, confirmation, and delegation into the sync execution layer
- [src/lib/sync.ts](/Users/davidodefey/projects/dbtools/src/lib/sync.ts) owns local temp archive allocation, archive dump, restore, and local cleanup sequencing
- [src/lib/mongo.ts](/Users/davidodefey/projects/dbtools/src/lib/mongo.ts) owns URI building, remote execution, copy helpers, dump, restore, connectivity checks, and remote temp cleanup behavior
- [sync-spec.md](/Users/davidodefey/projects/dbtools/sync-spec.md) now defines the intended sync behavior for the cleanup

### Current safety state

- allowed path enforcement exists in code
- operator confirmation exists unless `--yes` is provided
- sync no longer depends on `appConfig.defaultDropOnRestore` and explicitly restores with `drop: true`
- cleanup still spans sync and Mongo helper layers, but command-layer archive lifecycle logic has been removed and shared remote cleanup behavior is now explicit in the Mongo layer

### Current repo state

- the broken `task` surface has been removed from the active CLI and current docs
- the repo currently typechecks and builds
- sync now has direct Phase 1 tests for allowlist behavior, confirmation behavior, and explicit drop semantics

## Findings

### Sync policy is clearer than sync execution

The current sync policy is easy to understand. The allowlist and confirmation rules in [src/commands/sync.ts](/Users/davidodefey/projects/dbtools/src/commands/sync.ts) are small and explicit.

The destructive semantics are less explicit than they should be because sync currently inherits drop behavior from config rather than owning full-target replacement behavior directly.

### The command layer is small, but execution responsibilities are mixed

[src/commands/sync.ts](/Users/davidodefey/projects/dbtools/src/commands/sync.ts) is already thin and should stay thin.

[src/lib/mongo.ts](/Users/davidodefey/projects/dbtools/src/lib/mongo.ts) currently mixes URI creation, remote execution, transfer helpers, dump behavior, restore behavior, connectivity checks, and temp path responsibilities. That makes sync cleanup harder because the sync workflow depends on a module with several overlapping concerns.

### Cleanup behavior exists but is not yet a stable contract

Local temp cleanup currently happens in a `finally` path in [src/lib/sync.ts](/Users/davidodefey/projects/dbtools/src/lib/sync.ts).

Remote temp cleanup currently happens inside lower-level helpers in [src/lib/mongo.ts](/Users/davidodefey/projects/dbtools/src/lib/mongo.ts), now through an explicit shared cleanup helper.

The current code now makes the local sync error-precedence rule explicit: cleanup is always attempted, and cleanup failure does not replace the original sync failure.

### Sync currently has no direct tests

Allowed-path behavior, confirmation behavior, explicit drop semantics, basic execution ordering, sync progress output, cleanup-on-failure behavior, and local error precedence are now covered by direct sync tests.

That test coverage is enough to support the Phase 2 extraction, but later phases still need stronger cleanup and error-contract coverage.

### The sync spec is now sufficiently stable to drive a focused refactor

[sync-spec.md](/Users/davidodefey/projects/dbtools/sync-spec.md) is now detailed enough to act as the behavior authority for sync cleanup.

The refactor should treat that spec as the source of truth and avoid introducing extra sync features that are intentionally out of scope for phase 1.

## Proposed Target Shape

### Command layer

Keep [src/commands/sync.ts](/Users/davidodefey/projects/dbtools/src/commands/sync.ts) responsible only for:

- validating the source and target path
- prompting for operator confirmation when `--yes` is not present
- delegating to one sync execution API

Sync should explicitly restore with `drop: true` so the command owns its destructive full-target replacement semantics directly.

### Sync execution layer

Introduce a dedicated sync runner, preferably in [src/lib/sync.ts](/Users/davidodefey/projects/dbtools/src/lib/sync.ts).

That runner should own:

- local temp archive allocation
- source dump
- target restore
- cleanup sequencing

The execution layer should remain non-interactive so it is straightforward to test.

### Shared mongo layer

Keep [src/lib/mongo.ts](/Users/davidodefey/projects/dbtools/src/lib/mongo.ts) as the low-level Mongo and SSH tool layer.

Refine it only enough to support a cleaner sync orchestration path by separating responsibilities such as:

- URI creation
- remote command execution
- transfer helpers
- dump helpers
- restore helpers
- connectivity helpers

Avoid broad redesign outside what sync cleanup requires.

### Error and output behavior

Add sync-level progress output for start, dump, restore, and cleanup phases.

Preserve low-level subprocess streaming as-is.

Preserve the original sync failure when cleanup also fails, rather than replacing the operational error with a cleanup-only error.

## Cleanup Sequence

### Phase 1

- add policy-level tests for allowed and disallowed sync paths
- add confirmation tests for interactive mode versus `--yes`
- lock sync to explicit `drop: true`

Status:

- complete within current scope

### Phase 2

- add a dedicated sync execution API
- move archive lifecycle logic out of the command layer and into the sync execution layer

Status:

- complete within current scope

### Phase 3

- split or clarify shared mongo helpers only as needed to support sync cleanup cleanly
- make cleanup and error precedence behavior explicit in the implementation

Status:

- complete within current scope

### Phase 4

- add execution-path tests for success, failure, and cleanup behavior
- verify `npm run typecheck` and `npm run build`

## Acceptance Criteria

- invalid sync paths fail before any dump or restore begins
- sync no longer depends on `defaultDropOnRestore`
- sync always performs full-target replacement with drop enabled
- temp cleanup is always attempted
- tests cover policy, confirmation, execution order, and cleanup on failure
- `npm run typecheck` passes
- `npm run build` passes

## Deferred Work

- automatic pre-sync target backup
- post-sync verification
- merge mode
- partial sync
- broader backup and restore refactors
- broader `mongo.ts` redesign beyond what sync cleanup needs
