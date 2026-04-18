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
- Release publication is from `main` only.
- Never run a release publish flow from `development` or feature branches.
- Branch creation/switching requires explicit user approval.
- Treat any non-hotfix commit discovered on `main` as a policy violation and stop for user direction.
- Do not assume any specific remote name.

## Workflow

### 1) Readiness Check Mode

When asked "are we ready for a release?":

- Check for a clean working tree (`tracked` and `untracked`).
- Confirm branch context is release-safe (`main` expected for publish flow).
- Confirm version/changelog readiness:
  - `CHANGELOG.md` has `## Unreleased` entries reconciled for the intended release
  - `package.json`, `package-lock.json`, and `src/version.ts` can be aligned for the target version
- Report repository readiness only.
- Do not run full validation unless asked to start release execution.

### 2) Release Execution Mode

When asked to start or run a release:

1. Verify current branch is `main`.
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
9. Commit release prep with exact version as subject (example: `0.1.7`).
10. Create annotated tag on the release commit.
11. Push commit and tag.
12. Keep `npm publish` manual and provide exact command handoff:
    - stable: `npm publish`
    - pre-release: `npm publish --tag next`
13. After user publishes, verify published version and run at least one real install/executable smoke test.

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
# Create release commit and annotated SemVer tag.
git add package.json package-lock.json src/version.ts CHANGELOG.md
git commit -m "X.Y.Z"
git tag -a "vX.Y.Z" -m "vX.Y.Z"
```

```bash
# Push release commit and tag to the selected remote.
git push
git push origin "vX.Y.Z"
```

## Guardrails

- Keep all release behavior aligned with:
  - [docs/release-policy.md](/Users/davidodefey/projects/dbtools/docs/release-policy.md)
  - [AGENTS.md](/Users/davidodefey/projects/dbtools/AGENTS.md)
- Do not perform manual or scripted `npm publish` unless the user explicitly asks.
- Do not republish, retag, or rewrite a published version; cut a new patch release instead.
