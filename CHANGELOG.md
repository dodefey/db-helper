# Changelog

## Unreleased

- added `restore full --explain` to inspect archive contents and planned pruning without mutation
- enhanced `dbh doctor` with tool-version diagnostics and tagged Mongo ping probes
- added `dbh --version` for config-free executable version reporting
- fixed full restore so archive inspection happens before mutation and target-only normal-user collections are removed before exact final verification
- fixed collection restore so namespace selection is isolated to the requested collection and post-restore presence/count verification is required, including valid empty collections
- fixed `mongosh` verification parsing so warnings and diagnostics cannot corrupt machine-readable collection or count results
- added explicit restore lifecycle outcomes and an archive-backed integration harness for regression coverage
- changed full restore and full sync to prepare, inspect, mutate, and clean up one owned archive session so remote archives are uploaded and dry-run exactly once
- fixed cleanup-only restore and sync failures so successful mutation and verification states remain visible instead of being reported as database-operation failures

## 0.2.0

- changed `config.json` to support arbitrary named environments instead of requiring fixed `development`, `test`, and `production` keys
- added explicit `isProduction` environment marking so production safeguards follow config intent rather than reserved environment names
- changed `init` to create one named environment first and optionally add more environments interactively
- changed `sync` to allow configured source-target pairs with environment existence checked at command time, while still blocking targets marked `isProduction: true` and self-syncs
- added `dbh backup create --name` so operators can choose an explicit backup directory name instead of always using the generated timestamp form

## 0.1.13

- added session-scoped SSH host-key preflight across remote `backup`, `sync`, `restore`, and `doctor` so repeated SSH and SCP steps fail early and consistently when host trust or `known_hosts` access is broken
- improved remote `sync` and `restore` failure reporting by translating SSH and SCP transport errors into clearer operator messages and surfacing remote temp archive paths when cleanup may need manual follow-up
- fixed remote `backup` interruption handling so cleanup and operator messaging stay consistent when a backup is cancelled mid-run
- fixed `doctor` remote checks to stop after an unreadable SSH key instead of continuing into follow-up remote probes with misleading downstream failures

## 0.1.12

- added run-scoped debug logs for `dbh` commands: a temp log is created for every run, kept automatically on failure, and kept on success when `--log` is passed
- added retained-log reporting to CLI failures and `--log` success paths without changing the existing `default`, `quiet`, and `verbose` terminal output contract

## 0.1.11

- fixed full `sync` archive inspection for backtick-quoted `mongorestore --dryRun --verbose` namespaces and added a guard that refuses target pruning when archive inspection finds no restorable collections

## 0.1.10

- fixed full `sync` archive inspection so current `mongorestore --dryRun --verbose` output is parsed correctly and restored collections are not pruned away after restore

## 0.1.9

- fixed full `sync` archive inspection so current `mongorestore --dryRun --verbose` output is parsed correctly and restored collections are not pruned away after restore

## 0.1.8

- added `sync collection` for restoring one named collection between allowed environments without pruning unrelated target collections
- tightened release instructions to require `npm login` and `npm whoami` immediately before every publish attempt because npm auth verification can expire quickly
- changed branch policy to require non-hotfix work on `development` (or branches from it), reserve `main` for release/hotfix, and switch back to `development` automatically after release publication

## 0.1.7

- changed `sync` to prune target-only collections so successful runs leave the target as an exact copy of the source snapshot for normal user collections, with only internal Mongo namespaces such as `system.*` excluded
- added a canonical SemVer-based release policy document at `docs/release-policy.md`, including tagging, changelog, and publish sequencing standards for open-source releases
- added explicit branch and release enforcement bullets in `AGENTS.md`, including canonical references to `docs/release-policy.md` and the release skill workflow
- added a repository-local release skill at `.ai/skills/release/SKILL.md` for SemVer readiness checks and release execution handoff

## 0.1.6

- fixed `sync` so source metadata failures are reported with phase-aware sync errors instead of bypassing sync failure handling
- fixed `sync` so full restores remap the source database namespace into the target database instead of no-oping until verification catches count mismatches
- fixed remote archive cleanup so dump/restore cleanup failures are surfaced instead of being silently swallowed

## 0.1.5

- `init` now fails before prompting when the destination config already exists and `--force` is not set

## 0.1.4

- fixed the published `dbh` executable packaging so global installs resolve the CLI correctly

## 0.1.3

- renamed the primary executable command from `db-helper` to `dbh`
- made interactive `init` more standalone-friendly:
  - staged environment setup prompts
  - generic Mongo defaults
  - prompt-by-prompt README walkthrough
- added SSH agent / keychain / `~/.ssh/config` support for remote environments by making SSH user and SSH key path optional
- improved packaging and install behavior for the standalone CLI
- added the `dbh` release workflow documentation and ongoing changelog maintenance policy

## 0.1.0

Initial public release.

Highlights:

- standalone `dbh` CLI packaging
- `backup create`, `backup list`, and `backup inspect`
- `sync` with verification, interruption handling, and practical dirty-target guidance
- `restore full` and `restore collection` with production safety gates
- `doctor` for local tooling, path, SSH key, and connectivity checks
- `config` management commands:
  - `init`
  - `init --from-env-file <path>`
  - `config validate`
  - `config path`
  - `config show --redacted`

Operational work completed before release:

- backup hardening and cleanup contract
- sync hardening and interrupt-aware operator messaging
- restore hardening, namespace remapping fixes, and live validation
- migration from `.env` to `config.json`
- standalone CLI packaging cleanup
