---
name: release
description: Use when the user asks whether this repo is ready for a release or wants to run a release. Handles SemVer bumping, changelog/version alignment, validation, tagging, and manual npm publish handoff from main.
---

# release

Purpose: interpret release-related prompts and execute this repository's SemVer release workflow.

Canonical human-facing release policy:
[docs/release-policy.md](/Users/davidodefey/projects/dbtools/docs/release-policy.md)

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

- use next `patch` from current package version

## Branch And Safety Rules

- Check branch context before any substantive mutation.
- `development` is the default branch for non-hotfix work and release preparation.
- Run feature and refactor work on dedicated work branches based on `development`.
- Prepare release commits on an approved short-lived work branch based on `development`; validate the exact commit with GitHub Actions before protected-branch promotion.
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
- Report repository readiness only.
- Do not run full validation unless asked to start release execution.

### 2) Release Execution Mode

When asked to start or run a release:

1. Verify current branch is `development`.
2. Verify fully clean working tree.
   - Fetch and reconcile `development` with the chosen remote before preparation.
   - Obtain approval to create/switch to a short-lived release work branch based on `development`, unless already authorized in the session. Perform the remaining preparation on that branch.
3. Resolve target SemVer:
   - explicit version if provided
   - otherwise bump current package version by requested bump type (`patch` default)
4. Normalize version/tag forms:
   - package version: `X.Y.Z` (or valid SemVer pre-release)
   - git tag: `vX.Y.Z` (or `vX.Y.Z-rc.N`)
5. Ensure target tag does not already exist locally or on the chosen remote.
6. Update release references:
   - `package.json`
   - `package-lock.json`
   - `src/version.ts`
   - `CHANGELOG.md`
7. Run focused local checks appropriate to the release changes. Full local `npm run validate` is optional; the complete GitHub validation gate must pass on the release commit in step 10 before promotion. MongoDB integration remains optional.
8. Build and inspect publish artifact:
   - `npm pack`
   - fallback: `npm pack --cache /tmp/dbh-npm-cache` when default npm cache is blocked
9. Commit release prep on the release work branch with exact version as subject (example: `0.1.7`).
10. Push the work branch and wait for the push-triggered `Repository validation` check from GitHub Actions to complete successfully on the exact release commit. Local checks or a passing PR merge commit are not substitutes. Any changed commit must be pushed and validated again.
11. Fetch both protected branches and confirm both can be fast-forwarded to the validated release commit. Fast-forward `development` and push it, then fast-forward `main` to that same commit and push it. If either branch diverges, stop and reconcile on the work branch, then validate the resulting commit before promotion. Never bypass the required check or create another release commit during promotion.
12. Create annotated tag on the `main` release commit and push the tag.
13. Re-authenticate npm immediately before publish:
    - `npm login`
    - `npm whoami`
14. Keep `npm publish` manual and provide exact command handoff:
    - stable: `npm publish`
    - pre-release: `npm publish --tag next`
15. Switch back to `development` and fast-forward sync it from `main`.
16. After user publishes, verify published version and run at least one real install/executable smoke test.

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
# Build and inspect publish artifact before tagging.
npm pack
```

```bash
# Commit release preparation on the approved work branch.
git add package.json package-lock.json src/version.ts CHANGELOG.md
git commit -m "X.Y.Z"
# Push the work branch, not a protected branch, to trigger validation.
git push <remote> HEAD
```

Record the release commit SHA and verify that the push-triggered
`Repository validation` check from GitHub Actions completed successfully for it.
Do not run the promotion commands until that check passes. The placeholders
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

## Guardrails

- Keep all release behavior aligned with:
  - [docs/release-policy.md](/Users/davidodefey/projects/dbtools/docs/release-policy.md)
  - [AGENTS.md](/Users/davidodefey/projects/dbtools/AGENTS.md)
- Do not perform manual or scripted `npm publish` unless the user explicitly asks.
- Treat npm auth verification as short-lived. Always run `npm login` and `npm whoami` immediately before publishing.
- Do not run release preparation on `main` except for production hotfix scenarios explicitly requested by the user.
- Do not republish, retag, or rewrite a published version; cut a new patch release instead.
