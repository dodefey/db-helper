# Release Policy

This document is the canonical human-facing release policy for this repository.
It defines versioning, tagging, branch rules, and publish sequencing for open-source releases.

Operator-specific environment commands and production runbooks belong in separate operational docs.

## Versioning Standard

- Versions follow Semantic Versioning (`MAJOR.MINOR.PATCH`).
- Git release tags are annotated tags named `vX.Y.Z`.
- `package.json`, `package-lock.json`, and `src/version.ts` must all match the same SemVer value for each release.
- `CHANGELOG.md` is the release narrative source of truth and must be reconciled before tagging.

SemVer bump rules:

- `PATCH` for backward-compatible bug fixes.
- `MINOR` for backward-compatible feature additions.
- `MAJOR` for any breaking CLI, config, behavior, or public API change.

Pre-1.0 policy:

- While the project is in `0.y.z`, `MINOR` bumps may include breaking changes.
- Use release notes to call out any breaking behavior even before `1.0.0`.

Pre-release policy:

- Pre-releases must use SemVer pre-release identifiers (for example `1.2.0-rc.1`).
- Publish pre-releases to a non-`latest` dist-tag (for example `next`).

## Branch And Tag Policy

- Release publication must occur from a clean `main` branch.
- Publish only from the exact commit that is tagged for that release.
- Do not retag, rewrite, or republish an existing released version.
- If a release is wrong after tagging or publishing, cut a new patch release.

Hotfix policy:

- Critical fixes may be developed in a short-lived hotfix branch and merged to `main`.
- Any long-lived integration branch in use must be synced from `main` immediately after the hotfix lands.

## Changelog Policy

- Maintain an `## Unreleased` section for pending changes.
- Before release, move shipped changes from `## Unreleased` into a new `## X.Y.Z` section.
- Keep entries concise and user-facing; include notable behavior, safety, install, config, and workflow changes.
- Prefer Keep a Changelog categories when practical: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`.

## Release Readiness

"Ready for release" means repository readiness:

- no unresolved ship-blocking work for the target version
- no unresolved must-fix defects for the target version
- no uncommitted or unstaged release-intended changes
- changelog and version references prepared for the target version

Validation is still required as part of the release flow.

## Canonical Release Flow

1. Prepare the release branch state on `main` (or merge the final release PR into `main`).
2. Decide the SemVer bump (`major`, `minor`, or `patch`) using the documented change scope.
3. Update `package.json`, `package-lock.json`, `src/version.ts`, and `CHANGELOG.md` to the target version.
4. Run changed-file formatting as needed during normal work.
5. Run full repository checks:
   - `npm run format:check`
   - `npm run lint`
   - `npm test`
   - `npm run typecheck`
6. Build and inspect the publish artifact:
   - `npm pack`
   - If default npm cache access is blocked, use `npm pack --cache /tmp/dbh-npm-cache`
7. Commit release prep with the version as the commit subject (for example `0.1.7`).
8. Create annotated tag `vX.Y.Z` on that commit.
9. Push commit and tag.
10. Authenticate to npm immediately before publish:
    - `npm login`
    - `npm whoami`
11. Manually publish from that exact tagged commit.
12. Verify the published package version and run at least one real install/executable smoke test.

## Publish And Verification Handoff

Manual publish remains required. Handoff details must include:

- confirmation that `npm login` and `npm whoami` were run immediately before publish
- exact `npm publish` command used
- temporary-cache variant when required
- post-publish verification commands and results

Treat npm authentication checks as short-lived and non-durable. Always re-authenticate immediately before publish, even if prior checks passed earlier in the session.

Treat any `npm publish` warning that npm auto-corrected package metadata as a release blocker. Fix metadata in-repo and cut a new patch release instead of publishing corrected metadata from an existing tag.

## Source Of Truth

- Human-facing release policy: this document
- Repo guardrails and required checks: `AGENTS.md`
- Operator-level environment/deploy procedures: operational runbooks outside this policy
