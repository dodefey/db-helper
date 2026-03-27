# Changelog

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
