# Changelog

## Unreleased

- protect backups from delete and prune while a local archive writer is still running after the backup command exits
- recognize backup creation on the same Mac after a hostname change using new creation markers, while continuing to protect live processes and markers with unknown ownership
- add `--collections=name1,name2` and repeatable `--collection <name>` to back up, sync, or restore selected collections, with selection also available in interactive mode. Collection backups use a dedicated archive filename and are excluded from full restore, guided recovery, and full-backup retention
- reject unknown flags and unexpected arguments in `backup create` before starting a backup
- reject views in scoped backup and sync and identify their backing collections in the error
- distinguish namespace mapping messages from other MongoDB archive output so valid collection names containing "found collection" can be backed up and restored
- preserve collection names as entered in interactive mode, including leading and trailing spaces, and finish selection on an empty line
- quote and escape collection names in sync and restore confirmations so the selected names are unambiguous
- clarify when guided recovery has no full backups and suggest `dbh restore collection` when collection backups are available

## 0.4.2

- require completed automated Codex review and assessed findings for the current PR revision before merging or promoting a PR-covered release candidate; require explicit approval when review is unavailable

- clean up newly created empty backup directories when setup guard cleanup fails
- omit raw manifest identities from backup prune logs
- canonicalize release fingerprints through Git, require the nearest previous release tag, and reject shipped changelog entries duplicated under Unreleased

## 0.4.1

- required a pre-release documentation and editorial review with checked-in notes and candidate-bound review evidence; added release checks for version alignment, notes, evidence, and local links to repository validation
- aligned command references with backup delete/prune, required collection-sync flags, and full-restore explain support; reconciled release version selection and documented GitHub release notes and isolated package verification

## 0.4.0

- added manual `backup prune --keep-last N` per environment with dry-run previews, confirmation, skipped incomplete backups, and guarded deletion that stops when the plan changes or a deletion fails

- added a post-backup storage summary and advisory warnings below 1 GiB available on the backup-root filesystem; quiet mode retains warnings but omits the summary

- added exact-name `backup delete` with confirmation, noninteractive `--yes`, active-creation coordination, symlink safeguards, incomplete-backup cleanup, and reusable deletion logic

- show live local backup creation as “in progress” in backup listings without missing-artifact warnings; stale or unmarked incomplete backups still report issues
- refuse backup creation over an existing backup directory or another creation using the same name

## 0.3.3

- corrected recovery examples to use the installed `dbh` executable
- made the example configuration structurally valid with explicit credential placeholders and a portable home-relative backup path, and documented required edits before connection checks
- added a first-backup and backup-list step to the README quick start
- included the recovery guide in the published npm package

## 0.3.2

- added short README terminal recordings covering backup-and-restore, configuration and doctor checks, backup inventory and storage, full and collection sync, restore previews, production safeguards, and guided recovery using disposable local MongoDB data, with machine-specific storage readings omitted

## 0.3.1

- clarified the README introduction with concrete MongoDB workflows, production safeguards, external tool requirements, and a quick start before the detailed setup walkthrough
- moved full pre-merge and promotion validation to GitHub Actions, with focused local checks before commits and optional MongoDB integration; retained separate release artifact and smoke-test requirements
- added a separate MongoDB integration job using Ubuntu 24.04, MongoDB Server 8.0.38, Database Tools 100.16.1, and mongosh 2.9.2, with checksum-verified tooling; the job is not a required merge check
- required the GitHub Actions `Repository validation` check before updates to `development` and `main`, with an active repository ruleset and no bypass actors
- added GitHub Actions validation for pull requests targeting `development` and `main` and pushes to other branches, using the pinned Node.js version, `npm ci`, and `npm run validate`
- reconciled release instructions to validate an exact release commit on a work branch before fast-forward promotion into protected branches
- pinned the development Node.js version to 24.20.0 in `.nvmrc` and documented runtime selection before installing dependencies
- added a contributor guide covering development setup, feature discussion, validation, pull requests targeting `development`, and maintainer help with integration testing

## 0.3.0

- added `backup list --json` with a versioned inventory, validated manifest metadata, archive presence and size, allocated disk bytes, explicit per-entry issues, and an observation timestamp
- made CLI backup listings retain damaged or unclassifiable entries instead of aborting or hiding them; missing roots now fail explicitly, and partial queries exit with status 2
- added read-only `backup usage` reporting local backup/temp filesystem capacity, user-available bytes, and shared-filesystem identity, with JSON and text output modes
- kept JSON query stdout to one document on success and failure, including `--log`; query diagnostics remain in the OS temporary directory without creating configured storage paths
- preserved JSON query failure reports when diagnostic log writes fail during collection
- aligned `backup list` columns and added allocated disk usage per backup directory plus a total for the displayed backups
- added `backup list --quiet` tab-separated output with allocated bytes as the final field, and `--verbose` backup paths; unavailable sizes are reported as unknown

## 0.2.4

- redacted MongoDB passwords from `doctor` check output, including failed subprocess commands and warnings
- created diagnostic run logs with owner-only permissions, preserved when relocated

## 0.2.3

- upgraded the TypeScript compiler to 7.0.2 for faster typechecks and builds
- expanded TypeScript validation to cover tests and scripts alongside application source without emitting test or script files in builds
- replaced ESLint and TypeScript ESLint with Oxlint, explicitly preserving the existing recommended-rule policy and TypeScript overrides
- replaced Prettier with Oxfmt for repository formatting while preserving the existing 80-column configuration
- updated tsx, Node 24 types, and compatible transitive tooling dependencies
- added `npm run validate` for formatting, lint, unit tests, TypeScript checks, and the distribution build
- replaced the ad hoc GitHub integration workflow with documented local validation and disposable MongoDB lifecycle checks

## 0.2.2

- fixed `dbh doctor` on macOS by checking SSH and SCP executable availability instead of requiring unsupported version flags

## 0.2.1

- strengthened `dbh doctor` with MongoDB tool-version floors, mongosh state-directory probes, free-space blockers, and warning summaries
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
