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
7. Run full repository checks:
   - `npm run format:check`
   - `npm run lint`
   - `npm test`
   - `npm run typecheck`
8. Build and inspect publish artifact:
   - `npm pack`
   - fallback: `npm pack --cache /tmp/dbh-npm-cache` when default npm cache is blocked
9. Commit release prep on `development` with exact version as subject (example: `0.1.7`).
10. Push `development`.
11. Merge `development` into `main` with fast-forward-only and push `main`.
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
# Run required full-repo validation checks.
npm run format:check
npm run lint
npm test
npm run typecheck
```

```bash
# Build and inspect publish artifact before tagging.
npm pack
```

```bash
# Create release commit on development and annotated SemVer tag on main.
git add package.json package-lock.json src/version.ts CHANGELOG.md
git commit -m "X.Y.Z"
git push <remote> development
```

```bash
# Promote release into main using fast-forward-only history, then tag.
git checkout main
git fetch <remote>
git merge --ff-only <remote>/main
git merge --ff-only development
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
