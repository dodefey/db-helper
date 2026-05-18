# Output Standards

## Purpose

The CLI should use a consistent output model across commands so operators can:

- run commands interactively with useful progress output
- reduce noise when they only need final status
- increase detail when diagnosing failures

These standards apply to `backup`, `sync`, `restore`, `recover`, and `doctor`.

## Output Modes

The CLI should support three output modes over time:

- default
- quiet
- verbose

Phase-in rule:

- new or refactored commands should adopt this model when touched
- existing commands do not need to be rewritten all at once

## Default Mode

Default mode is the normal operator experience.

Use it when:

- a human is running the command directly
- the command may take noticeable time
- the operator benefits from stage-level progress

Default mode should print:

- high-level phase transitions
- compact success summaries
- compact failure summaries
- user prompts and confirmations

Default mode should not print:

- excessive internal detail
- duplicate summaries
- repeated low-signal status lines

Examples:

- `Starting sync test -> development`
- `Dumping source test...`
- `Restoring target development...`
- `Doctor checks passed.`

## Quiet Mode

Quiet mode is for scripts, wrappers, or operators who only want essential output.

Quiet mode should:

- suppress routine progress lines
- suppress successful per-step detail
- still print prompts if the command is interactive
- still print failures and final summary lines

Quiet mode should not hide:

- fatal errors
- validation failures
- destructive confirmation prompts

Quiet mode is intended to keep stdout small while preserving actionable failure output.

## Verbose Mode

Verbose mode is for diagnosis and operational debugging.

Verbose mode should include:

- all default-mode output
- detailed step-level output
- raw subprocess stdout and stderr when useful
- extra diagnostic context around environment, paths, and execution phases

Verbose mode should be the only mode that intentionally surfaces noisy implementation detail by default.

## Subprocess Output Rules

Subprocess output should follow these rules:

- default mode:
  - allow meaningful subprocess progress when the subprocess is long-running and operator-visible
  - avoid leaking noisy low-value subprocess output when it adds no operational value
- quiet mode:
  - suppress normal subprocess progress when possible
  - still surface subprocess failure output
- verbose mode:
  - stream subprocess output directly

If a helper cannot yet fully control subprocess streaming, the command should still target this contract when refactored.

## Summary Rules

- Every command should print at most one final success summary.
- Every command should print at most one final failure summary.
- A lower layer that already prints a final failure summary must mark the error so the top-level CLI does not print it again.

## Command Design Rules

- Command modules should own operator-facing summaries and mode decisions.
- Shared library modules should prefer structured hooks or injected writers over hard-coded stdout writes.
- Shared library modules should not assume verbose streaming unless that is explicitly requested by the caller.

## Flag Direction

The preferred future flag model is:

- `--quiet`
- `--verbose`

Rules:

- flags are mutually exclusive
- if neither is provided, use default mode
- interactive prompts still appear in quiet mode when needed

## Debug Log Retention

Persisted debug logs are separate from terminal output modes.

- a command run may capture a debug log even when terminal output stays in `default`, `quiet`, or `verbose`
- `--log` should retain the run log on success and print its saved path once
- failures should retain the run log automatically and report its saved path
- persisted run logs should not be treated as a substitute for the terminal output contract

## Current Priority

When touching command output next, prioritize:

1. `doctor`
2. `sync`
3. `restore`

Those commands are the most operator-sensitive and benefit most from a stable output contract.
