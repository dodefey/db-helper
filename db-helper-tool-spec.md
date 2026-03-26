# Standalone DB Tool Spec

## Purpose

Build a standalone CLI tool that manages database backup, sync, restore, recovery, and diagnostic operations across three environments:

- `development`
- `test`
- `production`

The tool must use a profile-based configuration file rather than `.env` files.

The tool is intended to replace scattered shell scripts with a single safe, interactive, scriptable interface.

## Scope

The tool must support these operational functions:

- create full DB backups
- list and inspect backups
- sync DB contents across allowed environment pairs
- restore a full DB from backup
- restore a single collection from backup
- verify DB tooling and environment connectivity before risky operations

## Inventoried Existing Behaviors To Cover

### Backup / snapshot behavior

Current source scripts:

- `bin/snapshot-db`

Required behavior:

- create a timestamped backup from `production`
- store it locally under a backup root
- preserve enough metadata to identify and restore it later

### Full DB sync behavior

Current source scripts:

- `bin/copydb`
- `bin/dbsync`

Required behavior:

- copy a full DB from one environment to another across allowed directions
- support `production -> development`
- support `production -> test`
- support non-production to non-production sync
- clean up temp artifacts automatically

### Targeted collection restore behavior

Current source scripts:

- `bin/restore-collection`

Required behavior:

- restore a single collection from a named backup into a target environment

## Tool Goals

### Primary goal

Make recovery from disruption or corruption fast and safe.

An operator should be able to:

1. identify a known clean backup
2. restore it into a target environment
3. verify the restore completed successfully

### Secondary goals

- reduce duplicate shell logic
- centralize environment configuration
- eliminate unsafe ad hoc environment targeting
- support both interactive and non-interactive use

## Configuration

The tool must load configuration from a checked-in config file, not from `.env`.

Preferred config file:

- `config.json`

The config should follow the same general model used elsewhere in this codebase family: one JSON file containing named deployment or runtime profiles plus tool-level defaults.

### Required `config.json` contract

The config must define all three environments explicitly and must also include global tool settings.

Example:

```json
{
	"version": 1,
	"defaults": {
		"authSource": "admin",
		"defaultDropOnRestore": true
	},
	"paths": {
		"backupRoot": "/Users/your-user/db-backups",
		"tempRoot": "/tmp/db"
	},
	"profiles": [
		{
			"name": "development",
			"label": "Local Development",
			"kind": "local",
			"mongoHost": "127.0.0.1",
			"mongoPort": 27017,
			"databaseName": "development",
			"mongoUser": "sysadmin",
			"mongoPasswordSecret": "db/development/mongo-password"
		},
		{
			"name": "test",
			"label": "Test Server",
			"kind": "remote",
			"sshConnectionString": "ubuntu@test.gnomebrewshop.com",
			"sshKeyPath": "/Users/your-user/.ssh/LightsailDefaultKey-us-east-1.pem",
			"mongoHost": "127.0.0.1",
			"mongoPort": 27017,
			"databaseName": "development",
			"mongoUser": "sysadmin",
			"mongoPasswordSecret": "db/test/mongo-password"
		},
		{
			"name": "production",
			"label": "Production Server",
			"kind": "remote",
			"sshConnectionString": "ubuntu@gnomebrewshop.com",
			"sshKeyPath": "/Users/your-user/.ssh/LightsailDefaultKey-us-east-1.pem",
			"mongoHost": "127.0.0.1",
			"mongoPort": 27017,
			"databaseName": "production",
			"mongoUser": "sysadmin",
			"mongoPasswordSecret": "db/production/mongo-password"
		}
	]
}
```

### Configuration rules

- `development`, `test`, and `production` must always exist
- each profile must declare whether it is `local` or `remote`
- remote profiles must include SSH connection details
- all profiles must include Mongo connection details
- secrets must not be hardcoded in source files
- the checked-in example file must use placeholders for secrets
- profile selection must be explicit and name-based

### Secret handling rules

The config file should contain identifiers or paths to secrets, not raw credentials, wherever practical.

Acceptable patterns:

- secret reference strings such as `mongoPasswordSecret`
- external secret-command definitions such as `mongoPasswordCommand`
- profile-local file references outside version control

The implementation may support a local development fallback for plain-text credentials during bootstrap, but the spec should treat that as transitional, not preferred.

### Runtime config resolution requirements

At runtime, each profile must resolve to:

- `name`
- `label`
- `kind`
- `mongoHost`
- `mongoPort`
- `databaseName`
- `mongoUser`
- `mongoPassword`
- `authSource`
- `isProduction`

Remote profiles must also resolve to:

- `sshConnectionString`
- `sshKeyPath`

Top-level config must also resolve to:

- `backupRoot`
- `tempRoot`
- `defaultDropOnRestore`
- `profiles`

### CLI config behavior

The CLI should use the same profile-selection model as the reference deploy tooling:

- default to `config.json` in the project root
- allow overriding the config path with a flag such as `--config <path>`
- treat profile names as stable command values
- fail early if required profiles are missing or malformed

## Safety Rules

The tool must enforce these in code.

### Allowed sync paths

Production to non-production:

- `production -> development`
- `production -> test`

Non-production to non-production:

- `development -> test`
- `test -> development`

### Disallowed sync paths

Never allow:

- any sync into `production`
- any generic unrestricted source/target copy mode

### Allowed restore targets

- `development`
- `test`
- `production`

### Production restore protections

Any restore to `production` must require:

- an explicit named backup
- a typed confirmation phrase
- a pre-restore backup of current production by default
- an explicit `--force-production-restore` style flag for non-interactive use

## Required Commands

The standalone CLI must expose one top-level executable:

`db`

The command system should match the current DB CLI shape rather than inventing a second interface.

### 1. `db interactive`

Interactive menu for common workflows:

- restore known clean backup
- back up production
- sync production to development
- sync production to test
- sync development to test
- sync test to development
- restore one collection
- run doctor checks

### 2. `db backup create`

Creates a timestamped full backup.

Required flags:

- `--from <profile>`

Optional flags:

- `--note <text>`
- `--tag <tag>`
- `--config <path>`

### 3. `db backup list`

Lists known backups in reverse chronological order.

Optional flags:

- `--from <profile>`
- `--tag <tag>`
- `--config <path>`

### 4. `db backup inspect`

Shows the manifest for one backup.

Required flags:

- `--backup <backup-name>`

Optional flags:

- `--config <path>`

### 5. `db sync`

Copies a full DB across allowed environment pairs only.

Required flags:

- `--from <profile>`
- `--to <profile>`

Optional flags:

- `--yes`
- `--config <path>`

### 6. `db restore full`

Restores a full DB from a named backup.

Required flags:

- `--backup <backup-name>`
- `--to <profile>`

Optional flags:

- `--yes`
- `--skip-pre-backup`
- `--force-production-restore`
- `--config <path>`

### 7. `db restore collection`

Restores a single collection from a named backup.

Required flags:

- `--backup <backup-name>`
- `--collection <name>`
- `--to <profile>`

Optional flags:

- `--yes`
- `--config <path>`

### 8. `db recover`

Guided recovery entry point for the safest full-restore workflow.

Optional flags:

- `--config <path>`

### 9. `db doctor`

Checks local prerequisites and profile connectivity before risky operations.

Optional flags:

- `--config <path>`

## Backup Layout

Each backup must be stored under:

```text
<backupRoot>/<backup-name>/
```

Required contents:

- `manifest.json`
- `dump.archive.gz`

The manifest must include:

- backup name
- source profile
- database name
- timestamp
- tags
- note
- collection list
- collection counts when available

## Interactive UX Requirements

The interactive mode should optimize for the recovery workflow first.

Required menu items:

- restore known clean DB
- back up production
- sync production to development
- sync production to test
- sync one non-production DB to another
- restore one collection from backup
- run doctor checks

For destructive flows, the interactive UI must:

- show source and target profile labels clearly
- summarize the exact action before execution
- require confirmation before overwrite
- add extra friction for any production restore

## Implementation Notes

- implement the tool in TypeScript
- keep config loading separate from command execution
- treat profile validation as a first-class startup step
- keep dump / restore mechanics centralized rather than repeating shell logic per command
- preserve a non-interactive path for automation, but keep safety checks in place

## Deliverables

The implementation should ship with:

- the `db` executable
- a `config.example.json`
- a profile loader and validator
- backup / sync / restore / doctor command modules
- operator-facing recovery documentation
