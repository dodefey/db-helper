# Init Cleanup Migration Plan

## Goal

Add a real standalone setup path for `db-helper` so operators can create or import `config.json` without manually building the file from scratch.

This migration covers:

- `db-helper init`
- `db-helper config validate`

It does not expand into secret manager integration or richer config lifecycle tooling.

## Current State

The repo now has:

- `config.json` as the active configuration format
- config loading in [src/config/loadConfig.ts](../src/config/loadConfig.ts)
- a user-level config path in the default search order
- a `config.example.json`

What is still missing:

- no bootstrap command
- no config-only validation command
- users must still copy and edit JSON by hand

## Target State

The repo should have:

- a config validation command
- an interactive config bootstrap command
- an env-file import path for migration
- README setup guidance that points operators to `init`

## Phases

### Phase 1: Spec and plan

- add [init-spec.md](init-spec.md)
- add this migration plan

### Phase 2: Config validation command

- add `db-helper config validate`
- test config validation success and failure output
- keep it local-only and non-networked

Status:

- complete

### Phase 3: Env-file import init

- add `db-helper init --from-env-file <path>`
- map known legacy env keys into the current config shape
- add overwrite protection and tests

Status:

- complete

### Phase 4: Interactive init

- add prompt-driven config creation
- support destination override with `--config`
- add overwrite protection and tests

### Phase 5: Docs and standalone setup flow

- update README setup/install guidance
- record final status in [hardening-migration-status.md](hardening-migration-status.md)

## Notes for Implementation

- keep config parsing/building logic out of the CLI entrypoint
- prefer a dedicated config command layer plus a small config helper library
- `config validate` should share the exact same loader path resolution used by the rest of the CLI
- `init` should write atomically when practical
- `init` should not silently overwrite existing files

## Acceptance

The migration is complete when:

- all five phases are complete
- tests cover validation, import, interactive init, and overwrite behavior
- README describes the preferred standalone setup path
