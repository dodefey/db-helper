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
- Before creating a commit, pause for review unless the user explicitly says to commit without review.
- Before creating a commit, run the full repo checks:
  - `npm run format:check`
  - `npm run lint`
  - `npm test`
  - `npm run typecheck`

## Editing Expectations

- Prefer formatting only touched files during active work to avoid unrelated churn.
- If lint or format rules require broader cleanup to make a touched change valid, include that cleanup in the same change rather than bypassing the tool.
- Do not bake in operator-specific ports, usernames, hosts, or SSH assumptions when setting defaults, examples, prompts, or docs for standalone CLI behavior.
- Keep [CHANGELOG.md](CHANGELOG.md) up to date for user-visible behavior, packaging, install, config, safety, or workflow changes.
- Record unreleased work under an `## Unreleased` section until it is shipped in a tagged/published release.
- When cutting a release, move the relevant `Unreleased` entries into the new versioned section instead of leaving them duplicated.
- Tag releases in git when a version is actually cut and published so the changelog, package version, and repo history stay aligned.
- If `init`, install, config resolution, or command naming changes, update the README walkthrough and setup flow in the same change.
- For changes to backup, sync, restore, config bootstrap, or install/publish flows, do at least one real smoke test when practical and note material findings in the work summary.

## Git And Release Expectations

- Use concise imperative commit subjects for normal development commits, with no trailing period and no tool chatter.
- Check branch context before starting substantive edits.
- Branch creation or branch switching requires explicit user approval.
- `development` is the default branch for all non-hotfix work.
- Run feature work and larger refactors on dedicated work branches that branch from `development` and merge back to `development`.
- `main` is release and hotfix only. Treat any non-hotfix commit on `main` as a policy violation and move that work to `development` or an approved work branch before continuing.
- Hotfixes may target `main`, but must stay narrowly scoped and must be merged back to any long-lived integration branch immediately after landing.
- Release preparation starts on `development`, then is promoted to `main` for publication.
- Production release publication must run from `main`. Never publish from `development` or feature branches.
- After release publication, switch local branch context back to `development` and fast-forward sync from `main`.
- Use [docs/release-policy.md](docs/release-policy.md) as the canonical human-facing release and publish policy.
- For release readiness checks and release execution, use [`.ai/skills/release/SKILL.md`](.ai/skills/release/SKILL.md) as the canonical agent workflow.
- If release prep needs its own commit, use `Prepare X.Y.Z release`.
- The version-cut commit should use the exact version as its subject, for example `0.1.5`.
- Cut releases only from a clean `main` branch, and publish only from the exact tagged release commit.
- Before cutting a release, move shipped work out of `## Unreleased`, update every shipped version reference in `package.json`, `package-lock.json`, and `src/version.ts`, then run the full repo checks.
- Release tags must be annotated tags named `vX.Y.Z`.
- Before publishing, have the agent run `npm pack` and inspect the tarball contents. If `~/.npm` is blocked by root-owned files, use `npm pack --cache /tmp/dbh-npm-cache` instead of changing the operator's home directory.
- Immediately before every publish attempt, require fresh npm authentication with `npm login` followed by `npm whoami`. Do not rely on earlier-session auth checks.
- Keep `npm publish` manual. The handoff must include the exact publish command, any temporary-cache variant, and the post-publish verification commands.
- Treat any `npm publish` warning that npm auto-corrected `package.json` as a release blocker. Fix the metadata in repo and cut a new patch release instead of publishing a corrected package from an existing tag.
- After publishing, verify the published version and do at least one real install/executable smoke test.
- If a release is wrong after tagging or publishing, do not rewrite the old tag or version; cut a new patch release instead.

## Output Expectations

- Follow [output-standards.md](output-standards.md) when changing CLI command output.
- Treat `default`, `quiet`, and `verbose` output modes as the repo standard for command-facing output behavior.
- When touching command output, reconcile the touched command to those standards within reason instead of adding one-off output patterns.
