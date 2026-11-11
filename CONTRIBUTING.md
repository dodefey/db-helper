# Contributing to db-helper

Bug fixes, tests, documentation improvements, and useful bug reports are welcome.
For feature work, open an issue and discuss the proposal with a maintainer before
implementing it. Also discuss new dependencies, larger refactors, and changes to
backup, sync, restore, or production safeguards before starting.

## Get started

Fork [dodefey/db-helper](https://github.com/dodefey/db-helper) and clone your fork.
Base ordinary contributions on `development` and open pull requests against
`development`. `main` is reserved for releases and narrowly scoped hotfixes.

Use the Node.js version pinned in [.nvmrc](.nvmrc) with its bundled npm for
development. The published CLI declares
Node.js `>=20`, but the locked formatter and linter require Node.js `^20.19.0` or
`>=22.12.0`. Development commands and some test fixtures assume a POSIX shell;
use macOS or Linux. Native Windows development has not been verified.

From your cloned fork, add the original repository as `upstream`:

```bash
# Keep origin pointing to your fork and upstream pointing to the project.
git remote add upstream https://github.com/dodefey/db-helper.git
```

Fetch the integration branch, even if your fork only contains `main`:

```bash
# Get the current development branch from the original repository.
git fetch upstream development
```

Create a branch for your contribution from that fetched branch:

```bash
# Choose a short branch name describing your change.
git switch --no-track -c improve-contributor-docs upstream/development
```

If you already configured an `upstream` remote, check that it points to the
original repository instead of adding it again. Push your contribution branch
to `origin` (your fork), then select `development` in the original repository as
the pull request's base branch.

If you use [nvm](https://github.com/nvm-sh/nvm), install the pinned Node.js
version from the repository root:

```bash
# Install the exact Node.js version recorded in .nvmrc.
nvm install
```

Select that version in each new shell before working on the project:

```bash
# Use the repository's pinned development runtime.
nvm use
```

Other version managers are fine if they select the same version. Then install
the dependencies recorded in the lockfile:

```bash
# Install the repository's locked development dependencies.
npm ci
```

Run the CLI from source:

```bash
# Show help without loading database configuration.
npm start -- --help
```

No global installation, MongoDB server, database credentials, or SSH access is
needed for help or the ordinary test suite. For manual database operations, use
disposable data and an explicit `--config` path: the CLI can otherwise discover
configuration in the working directory or your user config directory. See the
[README](README.md) for configuration and operator workflows.

## Find your way around

- `src/cli.ts` and `src/cliHelp.ts`: command routing and help.
- `src/commands/`: command arguments, prompts, and operator output.
- `src/lib/`: execution, MongoDB transport, verification, storage, and logging.
- `src/config/`: configuration loading and types.
- `tests/`: tests using Node's test runner, dependency stubs, and local fixtures.
- `scripts/restore-integration.ts`: the disposable real-MongoDB lifecycle test.
- `docs/`: command specifications and design history. The older
  `db-helper-cli-plan.md` and `db-helper-tool-spec.md` are historical; use current
  command specs and source code when changing behavior.

## Make and validate changes

Keep changes focused and preserve unrelated work. Use Oxfmt for formatting,
Oxlint for linting, and TypeScript for typechecking. Format only the files you
changed to avoid unrelated churn. Follow [output-standards.md](output-standards.md)
when changing CLI output, including the default, quiet, and verbose modes.

For example, after editing this guide, format just that file:

```bash
# Replace CONTRIBUTING.md with the files you changed.
npm run format -- CONTRIBUTING.md
```

Add or update tests for behavior, validation, safety, and execution-flow changes.
Documentation-only and purely mechanical changes do not need new tests. If a
behavior change has no test update, explain why in the pull request.

Before committing, format the files you changed and run local checks focused on
the affected behavior. Use targeted linting or TypeScript checks where useful;
documentation-only changes need formatting and link/consistency checks rather
than application tests. This example checks restore behavior:

```bash
# Run one test file using the same TypeScript loader as the test suite.
node --import tsx --test tests/restore.test.ts
```

You can also run the complete repository validation locally when useful, but it
is not required before every commit or before submitting a PR:

```bash
# Check formatting, lint, all ordinary tests, TypeScript, and the build.
npm run validate
```

The [GitHub Actions workflow](.github/workflows/validate.yml) runs `npm ci` and
`npm run validate` on pull requests targeting `development` and `main`, and on
pushes to other branches, using the Node.js version in `.nvmrc` on an Ubuntu
runner. Push validation lets an exact commit pass before a fast-forward release
promotion; a branch with an open PR can trigger both push and PR validation.

Full GitHub validation is required before merging into either branch. Fix failed
checks and wait for `Repository validation` to pass for the current PR revision.
If you push more changes, wait for the updated revision to pass. For direct
fast-forward promotions, the push-triggered check must pass on the exact commit
being promoted; a local result or a check on a different commit is not a
substitute.

`npm run validate` does not run the real-MongoDB integration test. The workflow
runs it in a separate `MongoDB integration` job on the same push and PR events.
That job uses Ubuntu 24.04, MongoDB Server 8.0.38, Database Tools 100.16.1, and
mongosh 2.9.2, with archive SHA-256 pins recorded in the workflow. It is not a
required merge or promotion check; `Repository validation` remains the required
check.

For changes affecting backup, sync, restore, or their execution paths, integration
testing is useful additional evidence. You can use the CI job or run it locally;
neither is a mandatory pre-commit or merge gate. Report relevant results or
failures, and ask a maintainer for help when needed. Missing local MongoDB tooling
does not prevent you from contributing.

With `mongod`, `mongosh`, `mongodump`, and `mongorestore` on `PATH`, run the
integration test separately:

```bash
# Exercise backup, restore, sync, and interruption recovery on disposable data.
npm run test:restore-integration
```

Use MongoDB server 8.0 and Database Tools 100.16.1 or newer supported tools, as
described in the [README integration instructions](README.md#disposable-lifecycle-integration-test).
Install `mongosh` separately if necessary; `doctor` requires version 2.9.2 or
newer. Database Tools provide `mongodump` and `mongorestore`, not the server or
shell.
The fixture creates its own temporary authenticated server, credentials, port,
and filesystem, and attempts cleanup when the run completes or throws an error.
It does not need your operational configuration or access to an existing
database. The fixture exercises local database workflows, not remote SSH/SCP
transport. For remote transport changes, describe a relevant disposable remote
smoke test or ask a maintainer to help verify it.

For changes to backup, sync, restore, configuration bootstrap, or install/publish
flows, run at least one relevant real smoke test when practical and report the
result. The disposable integration test can cover local database lifecycle
changes. Otherwise, explain what you need a maintainer to verify.

## Submit a pull request

- Target `development` and link the issue for discussed feature work.
- Explain the problem, resulting behavior, and any safety implications.
- List the checks you ran and their results. Identify checks you could not run
  and any integration or smoke testing needed from maintainers.
- Update `CHANGELOG.md` under `Unreleased` for user-visible behavior, packaging,
  installation, configuration, safety, or workflow changes. Update the README
  when setup, configuration resolution, or command naming changes.
- Use concise imperative commit subjects without a trailing period.

Maintainers review scope, correctness, safety, tests, and documentation before
merging. Respond to review feedback in the PR; if a change needs more discussion,
use the linked issue to agree on its direction. Release version bumps, tags, and
publication follow the separate [release policy](docs/release-policy.md).

[AGENTS.md](AGENTS.md) contains additional instructions for coding agents working
in a maintainer's checkout. Its approval requirements for local branch changes
and commits do not require external contributors to obtain permission to create
branches or commits in their own forks.

## Report bugs and ask questions

Use [GitHub issues](https://github.com/dodefey/db-helper/issues) for reproducible
bugs, questions, and feature discussions. For bugs, include your CLI version,
Node.js version, OS, relevant MongoDB tool versions, reproduction steps, and
expected versus actual results. Use synthetic data and redact passwords,
connection strings, private host details, and customer data from examples and
logs before sharing them.

Keep discussion respectful and focused on the work. Contributions are made under
the repository's [MIT license](LICENSE).
