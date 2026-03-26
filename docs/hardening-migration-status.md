# Hardening Migration Status

```text
Date: 2026-03-26 (America/Chicago)
Status: Core hardening migration complete
Scope: doctor, backup, sync, restore
```

## Purpose

This document records the current end state of the hardening migration and the small amount of follow-up work still worth doing.

Use this as the starting point for future hardening work instead of reconstructing status from commit history or older planning docs.

## Completed Scope

The following command surfaces have been hardened and brought into a consistent structure:

- `doctor`
- `backup`
- `sync`
- `restore`

The configuration model has also been migrated to `config.json`, replacing the earlier `.env`-based setup.

Standalone config management now exists through:

- `db-helper init`
- `db-helper init --from-env-file <path>`
- `db-helper config validate`

For those surfaces, the repo now has:

- a thin command layer
- a dedicated execution layer
- explicit output modes (`default`, `quiet`, `verbose`)
- clearer interruption and failure contracts
- direct tests around execution behavior
- user-facing README sections

## Live Validation Status

The following workflows have been manually smoke-tested against the real local operator configuration used during migration:

- `doctor`
- `backup create`
- `backup inspect`
- `backup list`
- `backup create --verbose`
- `backup create --quiet`
- interrupted `backup create`
- `sync`
- interrupted `sync` during `dump`
- interrupted `sync` during `restore`
- interrupted `sync` during `verify`
- `restore full`
- `restore collection`
- `restore --verbose`
- `restore --quiet`

Important restore notes from live testing:

- full restore had to be corrected to always use destructive replacement semantics
- restore transport had to be corrected to remap archive namespaces from the backup source DB into the chosen target DB
- full restore remapping required `--nsInclude <sourceDb>.*` in addition to `--nsFrom` / `--nsTo`

Those fixes are now in the codebase and were validated by successful live restore runs.

Config loading was also manually validated through both:

- explicit `--config ./config.json`
- default `config.json` discovery

The config-management flow itself has direct test coverage for:

- config validation success/failure
- env-file import
- interactive init
- overwrite protection

## Current Architecture

### Hardened execution layers

- [src/commands/doctor.ts](src/commands/doctor.ts)
- [src/lib/backup.ts](src/lib/backup.ts)
- [src/lib/sync.ts](src/lib/sync.ts)
- [src/lib/restore.ts](src/lib/restore.ts)

### Shared transport / verification layers

- [src/lib/mongo.ts](src/lib/mongo.ts)
- [src/lib/verify.ts](src/lib/verify.ts)
- [src/lib/backups.ts](src/lib/backups.ts)

### User-facing docs

- [README.md](README.md)
- [docs/backup-spec.md](docs/backup-spec.md)
- [docs/sync-spec.md](docs/sync-spec.md)
- [docs/restore-spec.md](docs/restore-spec.md)

## Remaining Follow-up Work

These are not core migration blockers anymore. They are the main worthwhile next steps if you want to keep hardening the repo.

### 1. Audit wrapper workflows

The main remaining un-hardened surfaces are wrapper/orchestration commands:

- [src/commands/interactive.ts](src/commands/interactive.ts)
- [src/commands/recover.ts](src/commands/recover.ts)

Recommended follow-up:

- add direct tests for `interactive` routing
- add direct tests for `recover`
- do one manual smoke test through `interactive`

### 2. Restore output polish

Restore is functionally correct now, but `--verbose` still surfaces noisy verification JSON and a Mongo deprecation warning.

Recommended follow-up:

- suppress raw verification JSON in restore verbose mode the same way backup metadata output was cleaned up
- investigate whether the `mongorestore` deprecation warning can be eliminated cleanly

### 3. Doctor output polish

`doctor` is correct, but its output is still more primitive than `backup`, `sync`, and `restore`.

Recommended follow-up:

- decide whether doctor should adopt the same output-mode model
- otherwise leave it alone and treat it as intentionally simpler

### 4. Standalone CLI usability

The package is now much closer to a standalone CLI, but there is still room to improve install and first-run UX.

Recommended follow-up:

- decide whether to prefer the user config path over `./config.json` long-term
- document global install and upgrade flow more explicitly once packaging is finalized
- consider adding a config edit/update workflow later if manual JSON editing becomes a recurring pain

## Notes On Older Planning Docs

The following docs are now historical context, not the active source of truth for current CLI behavior:

- [docs/db-helper-cli-plan.md](docs/db-helper-cli-plan.md)
- [docs/db-helper-tool-spec.md](docs/db-helper-tool-spec.md)

They still reflect earlier design ideas such as:

- `db` as the executable name
- earlier config-shape proposals that may not match the current `config.json` contract exactly

Do not use those docs alone to plan incremental work without cross-checking the current code and the command-specific specs.

## If Future Hardening Resumes

Start from these assumptions:

1. Do not reopen the core backup/sync/restore migration unless a real operational bug is found.
2. Prefer small wrapper-level hardening next (`interactive`, `recover`).
3. Keep output mode semantics consistent:
   - `default`: concise operator progress
   - `quiet`: silent on success
   - `verbose`: raw subprocess detail allowed
4. Preserve the current practical failure contract:
   - clear phase
   - clear dirty-target guidance when relevant
   - cleanup-attempt language should be truthful, not overstated
