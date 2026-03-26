# Repo Standards

## Tooling Checks

- Use Prettier for formatting and ESLint for linting in addition to TypeScript typechecking.
- Do not run formatters or linters on every small edit. Apply them to files you touched before finishing a change.
- Before creating a commit, run the full repo checks:
  - `npm run format:check`
  - `npm run lint`
  - `npm run typecheck`

## Editing Expectations

- Prefer formatting only touched files during active work to avoid unrelated churn.
- If lint or format rules require broader cleanup to make a touched change valid, include that cleanup in the same change rather than bypassing the tool.
