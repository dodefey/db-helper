---
name: release
description: Use when the user asks whether this repo is ready for a release or wants to run a release. Handles SemVer bumping, changelog/version alignment, validation, tagging, and manual npm publish handoff from main.
---

# release

Purpose: interpret release-related prompts and execute this repository's SemVer release workflow.

Canonical human-facing release policy:
[docs/release-policy.md](../../../docs/release-policy.md)

## Use This Skill For

- `are we ready for a release`
- `start a release`
- `let's release`
- `release next patch`
- `release 0.2.0`
- `cut 1.0.0-rc.1`

## Inputs

Optional user-provided target:

- explicit SemVer version: `X.Y.Z` or `vX.Y.Z`
- SemVer bump keyword: `major`, `minor`, or `patch`
- pre-release version: `X.Y.Z-alpha.N`, `X.Y.Z-beta.N`, `X.Y.Z-rc.N`

Default when no target is provided:

- select the bump from the unreleased change scope using the canonical release
  policy: patch for compatible fixes, minor for new features, and major for
  breaking changes (with the policy's pre-1.0 exception)

## Branch And Safety Rules

- Check branch context before any substantive mutation.
- `development` is the default branch for non-hotfix work and release preparation.
- Run feature and refactor work on dedicated work branches based on `development`.
- Prepare release commits on an approved short-lived work branch based on `development`; validate the exact commit with GitHub Actions before protected-branch promotion.
- For release PRs, complete the [automated PR review gate](../../../AGENTS.md#automated-pr-review-gate) for the current candidate before merging or direct promotion. Verify completion, assess every finding, and obtain an explicit exception if review is unavailable. A new head requires a new review.
- Release publication is from `main` only.
- Branch creation/switching requires explicit user approval.
- Treat any non-hotfix commit discovered on `main` as a policy violation and stop for user direction.
- After release publication, switch local branch context back to `development` and sync it from `main`.
- Do not assume any specific remote name.

## Workflow

### 1) Readiness Check Mode

When asked "are we ready for a release?":

- Check for a clean working tree (`tracked` and `untracked`).
- Confirm branch context is release-safe (`development` expected for release preparation).
- Confirm version/changelog readiness:
  - `CHANGELOG.md` has `## Unreleased` entries reconciled for the intended release
  - `package.json`, `package-lock.json`, and `src/version.ts` can be aligned for the target version
- Assess the canonical [documentation gate](../../../docs/release-policy.md#documentation-gate): review the net changes since the last release against README command references, affected specs/output contracts, recovery guidance, changelog, GitHub presentation, and package documentation. Require complete reviewed notes in `docs/releases/X.Y.Z.md` and the durable `docs/releases/X.Y.Z.review.json` record for the intended candidate. Report missing or stale documentation as blockers.
- Report repository readiness only. No documentation or release mutation is authorized by a readiness question alone.
- Do not run full validation unless asked to start release execution.

### 2) Release Execution Mode

When asked to start or run a release:

1. Verify current branch is `development`.
2. Verify fully clean working tree.
   - Fetch and reconcile `development` with the chosen remote before preparation.
   - Obtain approval to create/switch to a short-lived release work branch based on `development`, unless already authorized in the session. Perform the remaining preparation on that branch.
3. Resolve target SemVer:
   - explicit version if provided
   - otherwise honor a requested bump type, or select the bump from the
     unreleased changes using the canonical release policy
4. Normalize version/tag forms:
   - package version: `X.Y.Z` (or valid SemVer pre-release)
   - git tag: `vX.Y.Z` (or `vX.Y.Z-rc.N`)
5. Ensure target tag does not already exist locally or on the chosen remote.
6. Update release references:
   - `package.json`
   - `package-lock.json`
   - `src/version.ts`
   - `CHANGELOG.md`
   - `docs/releases/X.Y.Z.md`: write the full GitHub release body now, using the documentation gate requirements.
   - README, affected command specs/output contracts, recovery and other release-facing docs: complete the canonical documentation gate and fix all applicable gaps before the release commit. Record reviewed paths, checks, and justified non-applicable surfaces in `docs/releases/X.Y.Z.review.json`, using the canonical policy and `docs/release-review.example.json`. Include actual reviewer identity, editorial pass, no open findings, and the candidate fingerprint.
7. Run focused local checks appropriate to the release changes. Full local `npm run validate` is optional; the complete GitHub validation gate must pass on the release commit in step 10 before promotion. MongoDB integration remains optional.
8. Build and inspect publish artifact:
   - Create a temporary pack destination outside the checkout; use `npm pack --pack-destination "$release_pack_dir"`. Generated archives must not become part of the candidate fingerprint.
   - fallback: add `--cache /tmp/dbh-npm-cache` while keeping that external pack destination when default npm cache is blocked
9. Review the complete release documentation and package contents against the editorial acceptance criteria. After final formatting, generate `npm run --silent release:check -- --fingerprint` for the review record. Run strict `npm run release:check` and resolve all failures. Stop for missing, stale, contradictory, or unreviewed documentation. Once the gate passes, commit release prep, release notes, review record, and documentation corrections on the release work branch with exact version as subject (example: `0.1.7`).
10. Push the work branch and wait for the push-triggered `Repository validation` check from GitHub Actions to complete successfully on the exact release commit. Local checks or a passing PR merge commit are not substitutes. Any changed commit must be pushed and validated again. If a PR covers the release candidate, wait for automated Codex review completion on that exact head and assess all findings under the automated PR review gate before promotion.
11. Fetch both protected branches and confirm both can be fast-forwarded to the validated release commit. Fast-forward `development` and push it, then fast-forward `main` to that same commit and push it. If either branch diverges, stop and reconcile on the work branch, then validate the resulting commit before promotion. Never bypass the required check or create another release commit during promotion. Run strict `npm run release:check` on the clean candidate and confirm the checked-in notes/review record apply to that exact commit before promoting either branch. Any later documentation correction requires a new work-branch commit and passing validation before promotion.
12. Run strict `npm run release:check` on the clean `main` candidate, then create annotated tag on the `main` release commit and push the tag.
13. Re-authenticate npm immediately before publish:
    - `npm login`
    - `npm whoami`
14. Keep `npm publish` manual and provide exact command handoff:
    - stable: `npm publish`
    - pre-release: `npm publish --tag next`
15. Switch back to `development` and fast-forward sync it from `main`.
16. After user publishes, verify published version and run at least one real install/executable smoke test. Use a fresh temporary install prefix and invoke its exact executable; `npm exec --package` can resolve an older global `dbh`.
17. After npm publication is confirmed, publish the already-reviewed `docs/releases/X.Y.Z.md` body from the tagged release commit as GitHub release notes. Do not author missing notes after release. Mark stable releases latest (pre-releases remain pre-release), then read back the notes, hosted links, and status. Never move the tag.

## Staged Commands

Use staged commands with explicit checks instead of one opaque shell block.

```bash
# Check branch context and current state before release mutation.
git branch --show-current
git status --porcelain
```

```bash
# Read current package version and decide target SemVer.
npm pkg get version
```

```bash
# Update package and lockfile version to the target release version.
npm pkg set version="X.Y.Z"
npm install --package-lock-only
```

```bash
# Optionally run the complete suite locally when useful for diagnosis.
# Focused local checks suffice before committing; GitHub validation gates promotion.
npm run validate
```

```bash
# Keep the inspected artifact outside the checkout and candidate fingerprint.
release_pack_dir=$(mktemp -d "${TMPDIR:-/tmp}/dbh-release-pack.XXXXXX")
npm pack --pack-destination "$release_pack_dir"
# If the default cache is blocked, repeat with --cache /tmp/dbh-npm-cache.
```

```bash
# Check the complete candidate, notes, and durable review record.
npm run release:check
# Stage release metadata and the reviewed GitHub notes on the approved work branch.
git add package.json package-lock.json src/version.ts CHANGELOG.md docs/releases/X.Y.Z.md docs/releases/X.Y.Z.review.json
# Also stage the exact README/spec/recovery paths corrected by the documentation gate.
# Review the staged candidate before the release commit.
git diff --cached
git commit -m "X.Y.Z"
# Push the work branch, not a protected branch, to trigger validation.
git push <remote> HEAD
```

Record the release commit SHA and verify that the push-triggered
`Repository validation` check from GitHub Actions completed successfully for it.
If a PR covers the candidate, also record its automated review completion and
finding dispositions for that exact head, or an explicit review-gate exception.
Do not run the promotion commands until these requirements pass. The placeholders
below must be replaced with the chosen remote and that exact validated SHA.

```bash
# Refresh protected branches and check both before mutating either one.
git fetch <remote>
git merge-base --is-ancestor <remote>/development <validated-release-sha>
git merge-base --is-ancestor <remote>/main <validated-release-sha>
```

Stop if either ancestry check fails. Reconcile on the work branch and obtain a
new passing check before trying again. Run the following stages individually;
stop on any failed merge or push.

```bash
# Promote the validated release commit into development.
git checkout development
git merge --ff-only <remote>/development
git merge --ff-only <validated-release-sha>
git push <remote> development
```

```bash
# Promote the same validated release commit into main, then tag.
git checkout main
git merge --ff-only <remote>/main
git merge --ff-only <validated-release-sha>
git push <remote> main
git tag -a "vX.Y.Z" -m "vX.Y.Z"
git push <remote> "vX.Y.Z"
```

```bash
# Re-authenticate npm immediately before each publish attempt.
npm login
npm whoami
```

```bash
# Return local context to development and sync from main.
git checkout development
git merge --ff-only main
git push <remote> development
```

## Documentation Completion

Use the canonical [documentation gate](../../../docs/release-policy.md#documentation-gate)
as a release prerequisite. Record coverage, evidence, reviewer identity, and the candidate fingerprint in
`docs/releases/X.Y.Z.review.json`. Run strict `npm run release:check` before committing
and confirm them for the exact validated SHA before promotion/tagging. Code CI
does not prove documentation accuracy. Do not substitute a promise to update
GitHub notes after publication for reviewed, checked-in notes before release.

GitHub publication uses the prepared file from the tagged commit. For a stable
release, after confirming npm publication and verifying the existing tag:

```bash
# Publish the reviewed notes for the existing release tag; substitute the repository and version.
gh release create vX.Y.Z --repo OWNER/REPO --verify-tag --latest \
  --title "vX.Y.Z" --notes-file docs/releases/X.Y.Z.md
```

Use `--prerelease` instead of `--latest` for a pre-release. Run from a checkout
whose notes match the tagged commit, and read back the release body and status.
If that GitHub release already exists, inspect it and update only mismatched
notes/status instead of creating a duplicate or moving the tag.

## Guardrails

- Keep all release behavior aligned with:
  - [docs/release-policy.md](../../../docs/release-policy.md)
  - [AGENTS.md](../../../AGENTS.md)
- Do not perform manual or scripted `npm publish` unless the user explicitly asks.
- Treat npm auth verification as short-lived. Always run `npm login` and `npm whoami` immediately before publishing.
- Do not run release preparation on `main` except for production hotfix scenarios explicitly requested by the user.
- Do not republish, retag, or rewrite a published version; cut a new patch release instead.
