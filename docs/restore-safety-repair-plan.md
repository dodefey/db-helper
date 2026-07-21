# Restore Safety Repair Plan

```text
Date: 2026-07-21 (America/Chicago)
Status: Proposed for review
Branch baseline: development
Target release: 0.2.1
Sequence: repository contracts first, shared Mongo safety primitives second, restore and sync orchestration third, real lifecycle proof fourth
```

## Objective

Repair the demonstrated restore safety defects in `@dodefey/db-helper@0.2.0` and release a new patch version without reopening the completed restore-cleanup migration or expanding into unrelated CLI features.

The completed audit, reproductions, and design review are inputs to this plan and are not repeated here. Implementation begins by making the accepted behavior authoritative in the repository specifications.

The repair must establish all three outcomes:

1. Full-restore verification accepts a valid, explicitly framed `mongosh` result even when diagnostic stdout precedes it, while malformed or missing results fail closed.
2. Collection restore and collection sync mutate only the requested collection.
3. Full restore is an exact replacement for normal user collections: collections absent from the archive are removed from the target before final verification.

## Settled Decisions

These decisions should be treated as implementation constraints unless new executable evidence disproves one of them:

- publish the repair as `0.2.1`; do not alter or retag `0.2.0`
- keep `development` as the integration baseline and use an approved dedicated work branch for implementation
- preserve the current command layer versus execution layer ownership
- use an explicit, per-invocation tagged-result protocol for result-bearing `mongosh` calls
- never parse an arbitrary last stdout line as the machine result
- use a database-scoped Mongo URI for `mongosh` and `mongodump`
- use a server-scoped Mongo URI for `mongorestore`; database selection comes only from explicit namespace rules
- use `--nsInclude` alone for same-database collection restore
- add `--nsFrom` and `--nsTo` only when the source and target database names differ
- preflight the effective `mongorestore` namespace mapping before every collection mutation
- make full-restore archive inspection authoritative only after a recognized successful dry run and an exact archive-versus-manifest collection-set check
- remove target-only normal user collections during full restore; never prune `system.*` collections
- require a valid manifest document count for collection restore and fail before mutation when it is unavailable
- verify collection restore presence and count after mutation
- apply the shared collection safety repair to `sync collection` as well as `restore collection`
- keep terminal and run-log lifecycle state explicit about mutation completion versus verification completion
- do not add a public `--dry-run`, `--explain`, `--json`, version command, broader `doctor`, index-manifest redesign, or automatic collection preimage backup in this patch

## Execution Guardrails

- Branch creation or switching requires explicit user approval. The intended implementation branch is a dedicated `codex/` branch from current `development`.
- Do not modify the published global package in place. All fixes originate in this repository.
- Preserve production confirmation and pre-restore backup behavior.
- Preserve local and remote cleanup/error precedence; cleanup failure must not replace the primary database-operation failure.
- Use one shared namespace-contract builder for local and remote commands.
- For remote restore, stage the archive once per operation. Preflight and mutation should use the same staged artifact before cleanup.
- Treat any unrecognized `mongorestore --dryRun --verbose` output as a pre-mutation failure.
- Keep normal user collection filtering consistent across backup, sync, restore, pruning, and verification rather than maintaining divergent `system.*` filters.
- Add or update tests alongside every behavior change instead of deferring all coverage to the final phase.
- Pause for review before committing, as required by repository policy.

## Phase 1: Make Repository Specifications Authoritative

Status: complete

Update the behavior contracts before changing implementation.

### `docs/restore-spec.md`

- Define full restore as an exact replacement of normal user collections, not merely `mongorestore --drop` for collections present in the archive.
- Add a pre-mutation archive inspection phase.
- Require a recognized completed inspection and exact equality between the manifest collection list and inspected archive collection set after filtering internal `system.*` collections.
- Define the recognized-empty case: an explicitly empty manifest plus a successfully completed inspection with zero restorable user collections is valid; missing or unparseable inspection evidence is not.
- Add the full restore sequence: validate artifacts, inspect archive, validate archive against manifest, create any required production pre-restore backup, restore, remove target-only collections, and verify exact target state.
- State that prune authority comes from the validated archive set and that pruning never targets `system.*` collections.
- Add collection restore namespace preflight and the exact one-source-to-one-target mapping requirement.
- Require collection manifest count availability before mutation and collection-scoped presence/count verification afterward.
- Expand failure and interruption semantics for `archive_inspection`, `restore`, `prune`, and `verify`.
- Define separate mutation, verification, and target-trust outcomes in terminal output and structured logs.
- Document that quiet mode suppresses routine progress, while failures remain visible, and that verbose mode may show diagnostics but not internal tagged result payloads.

### `docs/sync-spec.md`

- Remove stale statements that say collection sync is unsupported or outside sync ownership.
- Make `sync collection` explicitly inherit the same exact namespace preflight and server-scoped restore URI contract as `restore collection`.
- State that collection sync mutates and verifies only the requested collection and never prunes unrelated collections.
- Preserve full-sync exact-copy behavior and its existing target-only pruning contract.
- Align sync lifecycle wording with the new mutation-versus-verification state model where the shared helper provides better phase evidence.

### `output-standards.md`

- Specify that internal machine-readable subprocess results are framed and parsed separately from diagnostics.
- Require default and quiet output to hide internal result envelopes.
- Allow verbose output to retain useful diagnostics without printing internal tagged payloads.
- Require failure summaries to distinguish mutation failure, post-mutation prune failure, and post-mutation verification failure.
- Preserve redacted retained run logs as the detailed diagnostic record.

### Phase 1 validation

- Re-read the three documents together and remove contradictory restore/sync ownership or lifecycle statements.
- Confirm all deferred wishlist items remain explicitly outside the patch boundary.
- Run Prettier on the touched Markdown files and `npm run format:check` before moving to implementation.

Completion notes:

- Updated `docs/restore-spec.md`, `docs/sync-spec.md`, and
  `output-standards.md` on 2026-07-21.
- Reconciled stale collection-sync statements and made archive inspection,
  exact full replacement, scoped collection verification, result framing, and
  lifecycle truth explicit.

## Phase 2: Add Explicit `mongosh` Result Framing

Status: complete

Refactor result-bearing shell calls in `src/lib/mongo.ts` without changing command-facing APIs.

- Separate result-bearing shell evaluation from command-only shell evaluation.
- Generate a unique marker for each result-bearing invocation.
- Wrap the JavaScript so the marker and JSON payload are printed exactly once after successful evaluation.
- Parse only the exact marker for that invocation.
- Require exactly one tagged payload.
- Validate collection-list results as arrays of strings.
- Validate count results as objects containing a finite, nonnegative count for every requested collection and no ambiguous values.
- Remove empty-output fallbacks to `[]` and `{}`.
- Keep nonzero subprocess, spawn, connection, authentication, and JavaScript errors authoritative.
- Suppress tagged payloads from terminal streaming while retaining redacted raw subprocess evidence in the run log.
- In verbose mode, surface non-result diagnostics without exposing the internal payload.

### Phase 2 tests

- warning before valid collection-list result succeeds
- warning before valid count result succeeds
- warning after a valid result does not corrupt the result
- tagless, duplicate-tagged, empty-payload, malformed-JSON, and wrong-shaped results fail
- missing or invalid requested count entries fail
- nonzero `mongosh` exit still fails and is not converted into a protocol error
- real verification mismatches still report missing collections and count differences
- default, quiet, verbose, redaction, and retained-log behavior remain covered

Completion notes:

- Added per-invocation tagged result framing and fail-closed payload/shape
  validation for collection listing and count verification.
- Preserved authoritative subprocess failures and retained raw subprocess
  evidence while suppressing internal result envelopes from normal output.
- Added focused parser, integration-seam, and nonzero-exit tests.
- Validation passed: `npm run format:check`, `npm run lint`, `npm test` (128
  tests), and `npm run typecheck`.

## Phase 3: Centralize Restore URI And Namespace Contracts

Status: complete

Make low-level restore argument construction explicit and independently testable.

- Split the current Mongo URI builder into database-scoped and server-scoped forms.
- Preserve credentials, host, port, and `authSource` in both forms.
- Make `sourceDatabaseName` required for archive restore calls.
- Introduce one namespace-contract builder that returns the expected source and target mappings plus command arguments.
- Implement the exact matrix:

| Scope      | Database relation | Namespace arguments                                                                 |
| ---------- | ----------------- | ----------------------------------------------------------------------------------- |
| full       | same database     | none                                                                                |
| full       | cross database    | `--nsInclude source.* --nsFrom source.* --nsTo target.*`                            |
| collection | same database     | `--nsInclude source.collection`                                                     |
| collection | cross database    | `--nsInclude source.collection --nsFrom source.collection --nsTo target.collection` |

- Reject a collection name that cannot be represented as an exact namespace filter, including wildcard-bearing names that could broaden selection.
- Use the server-scoped URI and the same namespace builder in local restore, remote restore, and dry-run inspection.
- Reuse one shared normal-user-collection filter for backup metadata, sync, restore, prune, and exact-set verification.

### Phase 3 tests

- assert all four argument combinations exactly
- prove same-database collection restore has no redundant remap arguments
- prove cross-database collection restore maps to the chosen target database
- prove full same-database restore has no implicit database selector in its URI
- prove local and remote command rendering consume the same namespace contract
- prove unsafe or ambiguous collection filter names fail before subprocess execution
- preserve credential redaction in rendered commands and logs

Completion notes:

- Added explicit database-scoped and server-scoped Mongo URI builders.
- Restore and archive inspection now use server-scoped URIs; shell and dump
  operations retain database-scoped URIs.
- Added one tested namespace-contract builder covering full/collection and
  same-database/cross-database restore mappings.
- Made `sourceDatabaseName` required for archive restore operations.
- Validation passed: `npm run lint`, focused Mongo tests (15),
  `npm run typecheck`, `npm run format:check`, and `git diff --check`.

## Phase 4: Add One-Pass Archive Preflight And Mutation State Reporting

Status: pending

Refactor archive restore transport so namespace inspection and mutation share one staged artifact and expose precise lifecycle state to orchestration.

- Run `mongorestore --dryRun --verbose` before the mutating command.
- Parse structured source-to-target mappings from actual restore-target lines; do not treat archive prelude lines as selected namespaces.
- Require a recognized dry-run completion signal in addition to a zero exit.
- Return a structured inspection result containing source mappings, target mappings, and the recognized-empty state.
- For collection scope, require exactly one mapping equal to the requested source and target namespaces.
- For full named restore, require the inspected normal-user collection set to equal the manifest collection set before mutation.
- Allow an empty full backup only when both the manifest and recognized completed inspection explicitly contain zero normal user collections.
- Fail before mutation on absent, unexpected, duplicate, malformed, or unrecognized mappings.
- For remote targets, upload once, inspect and restore that same remote archive, and cleanup once.
- Add a mutation-state callback or equivalent structured mechanism with these transitions:
  - `not_started`
  - `in_progress` immediately before the real `mongorestore`
  - `subprocess_succeeded` immediately after its zero exit and before later cleanup
- Ensure preflight/upload failures leave mutation state at `not_started`.
- Ensure remote cleanup failure after a successful subprocess preserves `subprocess_succeeded`.

### Phase 4 tests

- parse MongoDB Database Tools 100.16.1 same-database and cross-database dry-run output
- ignore unrelated archive prelude entries while accepting the one selected collection mapping
- accept an archived empty collection when its mapping and metadata exist
- reject no mapping, extra mappings, unexpected targets, and unrecognized completion output
- reject full archive-versus-manifest missing and extra collections before mutation
- accept a recognized empty archive only with an empty manifest
- prove remote preflight and restore reuse one staged path and perform one cleanup sequence
- prove mutation-state transitions for preflight failure, mutation failure, mutation success, and cleanup failure

## Phase 5: Make Full Restore An Exact Target Replacement

Status: pending

Extend `runRestoreFull` in `src/lib/restore.ts` using the validated archive collection set returned by Phase 4.

1. Validate backup artifacts and read the manifest.
2. Inspect the archive and require archive/manifest collection-set equality before target mutation or production pre-backup work.
3. Complete production pre-restore backup behavior as today after the named archive has passed inspection.
4. Restore the archive with drop enabled and the explicit namespace contract.
5. List target normal user collections.
6. Compute target-only collections relative to the validated archive set.
7. Drop only those target-only normal user collections.
8. Verify expected collection presence and counts.
9. Verify that no unexpected normal user collections remain.
10. Print success only after restore, prune, and verification all succeed.

Implementation details:

- Reuse or extract the proven sync target-only collection calculation instead of creating a restore-specific variant.
- Never use the manifest alone as prune authority; it must first match a successfully inspected archive.
- Never prune internal `system.*` collections.
- Treat prune as a distinct post-mutation phase.
- On prune failure, report that the restore subprocess succeeded, exact replacement did not complete, and the target requires independent verification or a rerun.
- Extend verification results or a shared exact-set verifier so missing, unexpected, and count-mismatched collections are reported consistently by full restore and full sync.

### Phase 5 tests

- full restore drops target-only normal user collections before verification
- full restore leaves all `system.*` collections untouched
- full restore performs no pruning when archive inspection and manifest disagree
- a legitimately empty full backup removes all target normal user collections only after recognized-empty validation
- prune failure reports successful restore mutation but incomplete exact replacement
- final verification reports unexpected collections that survive or appear after pruning
- collection restore and collection sync never enter the full-prune path
- existing production pre-backup, confirmation, interruption, and cleanup behavior remains covered

## Phase 6: Add Collection-Scoped Post-Restore Verification

Status: pending

Complete the targeted collection workflow after the namespace repair.

- Validate that the requested collection appears in the manifest.
- Require a finite, nonnegative manifest count for that collection before mutation.
- Build a one-collection verification manifest rather than passing unrelated backup collections into verification.
- Run collection presence and count verification after `mongorestore` succeeds.
- Treat count `0` as valid and verify that the empty collection exists.
- Print collection restore success only after verification passes.
- Keep unrelated target collections outside runtime verification and pruning.
- Preserve `sync collection`'s existing collection-scoped verification while routing its mutation through the same preflight-safe helper.

### Phase 6 tests

- missing manifest collection fails before preflight
- missing or invalid manifest count fails before mutation
- requested collection presence and count are the only restore-collection verification inputs
- empty collection restore succeeds when presence and count `0` match
- count mismatch reports the requested collection and expected versus actual values
- unrelated target collections do not affect collection restore or collection sync success

## Phase 7: Make Lifecycle Truth Explicit

Status: pending

Replace the current boolean dirty-target model with mutation, prune, and verification outcomes that can be formatted consistently.

- Distinguish failures before mutation, during mutation, after successful mutation during prune, and after successful mutation during verification.
- Use operator-facing outcomes equivalent to:

```text
Restore subprocess: succeeded
Post-restore pruning: failed | succeeded | not applicable
Post-restore verification: failed | interrupted | succeeded | not started
Target trust state: unchanged | may be partially modified | requires independent verification | verified
```

- Retain detailed missing, unexpected, and count-mismatch information.
- Preserve practical interruption and remote cleanup guidance.
- Add structured run-log fields for scope, phase, mutation state, prune state, verification state, and target trust state.
- Do not add run-log reconstruction to `recover` in this patch.

### Phase 7 tests

- preflight failure reports target unchanged
- mutation interruption/failure reports possible partial modification
- prune failure reports successful restore subprocess and incomplete exact replacement
- verification protocol failure reports successful restore subprocess and unknown trust
- verification mismatch reports exact missing, unexpected, and count-mismatch details
- quiet mode still reports failures
- default mode prints one failure summary
- verbose mode preserves diagnostics without exposing internal result envelopes
- structured logs preserve the phase outcomes without credentials

## Phase 8: Add Real Archive-Backed Regression Coverage

Status: pending

Add a dedicated, explicit integration command that owns its disposable Mongo lifecycle and hard-fails when required binaries are unavailable. Keep it separate from portable unit tests, but make it a mandatory safety and release gate.

Suggested command:

```bash
npm run test:restore-integration
```

The harness should:

- allocate a unique temporary root and free local port
- start a disposable authenticated `mongod`
- create real gzip archives with `mongodump`
- exercise the production restore helper with real `mongorestore`
- stop the child process and cleanup temporary artifacts in `finally`
- record MongoDB server, `mongosh`, `mongodump`, and `mongorestore` versions in diagnostics
- avoid operator-specific usernames, ports, paths, or home-directory overrides

Required scenarios:

1. Same-database collection restore with requested and unrelated populated collections.
2. Cross-database collection restore with requested and unrelated populated collections.
3. Empty requested collection with an unrelated populated collection.
4. Full restore with a target-only normal user collection, proving it is removed.
5. Cross-database full restore with a target-only collection, proving namespace remap and pruning both use the intended target database.
6. Full restore with an internal `system.*` fixture where technically practical, proving internal filtering rather than attempting destructive system collection manipulation.

For collection scenarios, prove:

- requested documents exactly match the archive after restore
- unrelated documents in canonical `_id` order, indexes, and collection options remain equivalent to their pre-restore state
- logs and summaries identify only the requested mutation scope

For full scenarios, prove:

- every archive user collection is restored
- every target-only normal user collection is removed
- no unexpected normal user collection remains
- final counts match the manifest

## Phase 9: Reconcile User Documentation And Unreleased History

Status: pending

- Update the README restore and sync-collection sections with the exact replacement and targeted-isolation guarantees.
- Document full-restore archive inspection, target-only pruning, collection preflight, and post-restore verification at the operator level.
- Add `CHANGELOG.md` `Unreleased` entries for all three user-visible safety fixes and the affected `sync collection` seam.
- Keep version, doctor, public explain mode, JSON output, index verification, and preimage backup ideas deferred.
- Reconcile touched Markdown with current Prettier rules.

## Phase 10: Verification And Release Readiness

Status: pending

### Touched-file checks during implementation

- run Prettier on touched files
- run ESLint on touched TypeScript and test files
- run focused unit tests after each phase
- run the real archive-backed integration command after transport or orchestration changes

### Full repository gates before review/commit

```bash
npm run format:check
npm run lint
npm test
npm run typecheck
npm run test:restore-integration
```

Also run `npm run build` before packaging so compiled output is proved independently of `npm pack`.

### Real smoke matrix before release preparation

- full same-database restore removes a target-only collection
- full cross-database restore removes a target-only collection from the chosen target
- same-database collection restore leaves an unrelated collection unchanged
- cross-database collection restore leaves an unrelated collection unchanged
- empty collection restore leaves unrelated collections unchanged
- full verification tolerates the demonstrated prefixed `mongosh` warning
- malformed or tagless verification output fails closed
- local and remote command previews/logs show the intended namespace contract with credentials redacted

### Release preparation and publication boundary

- Stop for user review before committing.
- Follow `.ai/skills/release/SKILL.md` only after the implementation is accepted for release.
- Move `Unreleased` entries into `0.2.1` and update `package.json`, `package-lock.json`, and `src/version.ts` together.
- Run the full gates again on the exact release candidate.
- Inspect `npm pack` contents.
- Promote through `main`, create annotated tag `v0.2.1`, and keep `npm publish` manual per repository policy.
- After publication, reinstall the global package and rerun the original consumer reproductions from `gnomenuxt`, including the full-restore target-only collection case.
- Return local branch context to `development` and fast-forward it from `main` after publication.

## Acceptance Criteria

- repository specs describe the implemented behavior without contradictions
- valid tagged `mongosh` results survive diagnostic stdout pollution
- missing, malformed, duplicated, or wrong-shaped tagged results fail closed
- nonzero shell failures retain their original failure semantics
- same-database and cross-database collection restore mutate only the requested collection
- `sync collection` inherits the same namespace isolation
- collection restore fails before mutation when exact namespace selection or expected count cannot be established
- collection restore verifies requested collection presence and count before reporting success
- full restore validates archive contents against the manifest before mutation
- full restore removes target-only normal user collections absent from the validated archive
- full restore never prunes `system.*` collections
- full restore verification reports missing, unexpected, and count-mismatched collections
- failure output distinguishes pre-mutation failure, mutation failure, prune failure, and verification failure
- local and remote paths share one tested namespace and inspection contract
- real archive-backed tests prove collection isolation and full-restore exact replacement
- README and changelog match the shipped behavior
- formatting, lint, unit tests, typechecking, build, integration tests, packaging inspection, and real smoke tests pass

## Deferred Work

- `dbh --version` or `dbh version`
- broader `doctor` filesystem, free-space, state-directory, or supported-tool-range checks
- public restore `--dry-run` or `--explain`
- machine-readable `--json` command results
- index metadata in backup manifests and post-restore index parity verification
- document-level hashes or content-equivalence verification for arbitrary production collections
- automatic scoped collection preimage backups
- full backup/sync/recover/interruption lifecycle CI beyond the regression matrix above
- transactional rollback guarantees
- merge or multi-collection restore modes

## Plan Maintenance

- Update each phase status as work lands.
- Record material deviations and their executable evidence in this file rather than silently changing the contract.
- Keep completed audit evidence out of this plan unless a new result changes an implementation decision.
- When implementation and release validation are complete, add a concise completion record rather than deleting this plan.
