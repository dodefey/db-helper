# Changelog

## Unreleased

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
