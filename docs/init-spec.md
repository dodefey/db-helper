# Init Spec

## Purpose

`init` is the standalone setup command for `db-helper`.

Its job is to create or import a valid `config.json` for the operator without requiring them to hand-author the full file structure from scratch.

`init` is a bootstrap command. It does not run operational checks itself.

Use `doctor` after `init` to verify binaries, SSH, paths, and Mongo connectivity.

## Command Surface

CLI forms:

```text
db-helper init
db-helper init --config <path>
db-helper init --from-env-file <path>
db-helper init --force
db-helper config validate
db-helper config validate --config <path>
```

## Config Destination Rules

Default destination for `init`:

- `~/.config/db-helper/config.json`

If `--config <path>` is provided:

- write to that explicit path instead

`init` must create parent directories when needed.

`init` must not overwrite an existing config unless `--force` is provided.

## Modes

### Interactive mode

Used when `db-helper init` is run without `--from-env-file`.

The command should prompt for:

- backup root
- temp root
- development environment settings
- test environment settings
- production environment settings
- restore default behavior if that needs to stay configurable

Remote environments must collect:

- SSH host
- SSH user
- SSH key path
- Mongo host
- Mongo port
- database name
- Mongo user
- Mongo password

Local environments must collect:

- host
- Mongo host
- Mongo port
- database name
- Mongo user
- Mongo password

Interactive mode should:

- show sensible defaults where possible
- avoid silently inventing deployment-specific values
- write the completed config only after all prompts succeed

### Import mode

Used when `--from-env-file <path>` is provided.

The command should:

- read the env file
- map known env-style keys into the `config.json` structure
- write the resulting config
- report any missing or unmapped values that still need manual review

Import mode is primarily for migration from older repo-local setups.

## Output Contract

Default success output for `init` should be concise and practical:

- where the config was written
- whether it was created interactively or imported
- next step:
  - `db-helper config validate`
  - `db-helper doctor`

Failure output should clearly state:

- why init failed
- whether an existing config was left untouched

## Validation Command

`db-helper config validate` should:

- load the config using the same resolver as the rest of the CLI
- validate required structure and required fields
- print success or a clear failure message
- not perform network checks
- not require Mongo or SSH binaries

This is a local config-shape check only.

## Safety Contract

`init` must:

- refuse to overwrite by default
- preserve the existing file when write fails
- avoid writing partial files when practical

If init fails after beginning file creation:

- incomplete config write should be cleanup-attempted
- the error should describe whether cleanup was attempted

## Deferred Work

Out of scope for the first `init` implementation:

- secret manager integration
- keychain integration
- config editing commands
- multiple named profiles beyond the current fixed environments
- automatic infrastructure discovery

## Acceptance Criteria

The `init` migration is complete when:

- `db-helper config validate` exists and is tested
- `db-helper init --from-env-file <path>` works and is tested
- interactive `db-helper init` works and is tested
- overwrite behavior is explicit and tested
- README documents the standalone setup flow
