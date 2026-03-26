# Repo Standards

## Tooling Checks

- Use Prettier for formatting and ESLint for linting in addition to TypeScript typechecking.
- Do not run formatters or linters on every small edit. Apply them to files you touched before finishing a change.
- Any file you touch should be reconciled to current repo standards before you finish the change.
- For code files, that includes bringing the touched file into compliance with formatting, linting, and adjacent code-quality expectations rather than leaving known standards drift behind in edited sections.
- Add or update tests for behavior changes whenever it is reasonable to do so.
- Purely mechanical changes do not require new tests, but changes to behavior, validation, safety rules, or execution flow should usually include test coverage.
- If a touched change affects behavior, the touched area should be reconciled to current testing expectations too, including adding or updating tests when reasonable.
- If a behavior change ships without new or updated tests, explain why in the work summary or commit context.
- Before creating a commit, run the full repo checks:
  - `npm run format:check`
  - `npm run lint`
  - `npm test`
  - `npm run typecheck`

## Editing Expectations

- Prefer formatting only touched files during active work to avoid unrelated churn.
- If lint or format rules require broader cleanup to make a touched change valid, include that cleanup in the same change rather than bypassing the tool.
