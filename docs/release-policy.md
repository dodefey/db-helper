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

- All non-hotfix work must be performed on `development` or dedicated short-lived work branches that merge back into `development`.
- `main` is reserved for release publication and narrowly scoped production hotfixes.
- Updates to `development` and `main`, including release promotions and hotfixes, must satisfy the GitHub Actions `Repository validation` check. The active repository ruleset has no bypass actors; unchecked direct pushes are blocked.
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
- the documentation gate below passed, including reviewed GitHub release notes

Validation is still required as part of the release flow.

## Documentation Gate

Complete this review on the release work branch **before committing the release
candidate**. Missing, stale, contradictory, or unreviewed release documentation
blocks promotion, tagging, and publication, even if code validation passes.

Review the net changes since the last release against the shipped command help
and implementation. Cover each applicable surface; record reviewed paths,
checks, and justified non-applicable surfaces in the checked-in review record
described below.

| Surface                   | Required evidence                                                                                                                                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| README                    | Quick start, install/update instructions, command forms, required/optional flags, examples, safety limits, and output descriptions match the candidate.                                                                                     |
| Command and recovery docs | Affected command specs, query/output contracts, and recovery guidance agree with the README and implementation; supported features are not still labeled deferred.                                                                          |
| Changelog                 | All shipped user-visible changes are in the target version section, including compatibility changes and limitations; shipped entries are removed from Unreleased.                                                                           |
| Release notes             | `docs/releases/X.Y.Z.md` contains the complete reviewed GitHub release body: changes, applicable safety/migration notes, install/update command, version check, and links to the tagged README, changelog, and previous-version comparison. |
| GitHub presentation       | The default-branch README and any configured Pages/site or repository metadata have been checked for release-related changes. Prepare required updates with the candidate; no new site is required.                                         |
| Package documentation     | The packed README, recovery guide, and example config are the intended versions; referenced documentation is included or deliberately linked to its hosted location.                                                                        |

Format touched files, check file links and anchors, compare command references
with CLI help, and smoke-test changed install/setup instructions when practical.
Check links for the future release tag against paths and anchors in the candidate
tree; verify those hosted links after tagging. Do not count a filename inventory
or a passing code check as a documentation review.

### Editorial acceptance criteria

Documentation review must confirm all of the following:

- Use consistent command, flag, environment, and artifact names across README,
  help, specs, recovery instructions, changelog, and release notes.
- Put required flags in required lists and optional flags in optional lists;
  descriptions, defaults, output modes, and exit codes must match implementation.
- Examples must state their prerequisites and substitutions, use annotated,
  copy/paste-safe commands, and identify destructive effects before execution.
- Keep operator guidance self-contained and concise. Explain limitations and
  migration actions directly; remove unfinished prose and stale placeholders
  from release notes. Syntax placeholders in command reference forms are valid.
- Maintain one canonical description for each contract and link to it where
  practical. Reconcile duplicated command references and label historical plans
  and deferred behavior so readers cannot mistake them for current guidance.
- Verify local links and anchors, release-version links, and package/hosted doc
  destinations. Do not describe artifact presence or a successful build as proof
  of restorability or successful publication.

### Durable review record and executable gate

Create `docs/releases/X.Y.Z.review.json` from
[the review-record example](release-review.example.json). Record the version,
previous release tag, reviewer identity, `result: "pass"`, `editorial: "pass"`,
an empty `openFindings` array, and evidence for each surface in the gate table.
Use statuses `reviewed` or `not-applicable`; exclusions require a reason.
README, changelog, and release notes always require review. Evidence must name
reviewed paths and relevant commands/results or external readbacks. The reviewer
identity must identify the actual human or separate reviewer pass that inspected
accuracy and the editorial criteria, not merely the author running a script.

After final edits and formatting, run `npm run --silent release:check -- --fingerprint`
and put its digest in `contentSha256`. It covers all tracked and non-ignored
candidate files except this review record, using Git-cleaned content so checkout
line endings do not change the digest. Documentation or code edits
invalidate the review; staging and committing unchanged files do not. Re-review
changed content before updating the fingerprint. Commit the notes and review
record with the release candidate. No transient chat or post-publication handoff
can replace this record.

Run `npm run release:check` before committing, promoting, and tagging. It rejects
missing/empty notes sections, missing or incomplete review evidence, open findings,
stale candidate fingerprints, mismatched package/lockfile/CLI versions, missing
changelog entries, shipped entries duplicated under Unreleased, an incorrect
previous release tag, and broken local file/Markdown-heading links in release notes,
README, recovery guidance, and changed Markdown files. Notes must use sections
`Changes`, `Safety and compatibility`, `Install and verify`, and `Documentation`,
and link the tagged README, changelog, and previous-version comparison. Future-tag
links are checked against candidate files; external URL reachability and prose
accuracy still require the recorded review.

`npm run validate` includes `validate:release`, which invokes this same gate in
`--if-release` mode. CI fetches full history and tags. Automatic mode skips ordinary
work when the package version equals the nearest ancestor release tag's package
version; it enforces the gate for a new version. This avoids retroactive records
for already-tagged releases such as 0.4.0. Missing release history fails rather
than silently skipping. Explicit `release:check` never skips. Neither a green
format check nor a fabricated pass record proves editorial accuracy.

The checked-in release notes are the publication source, not a post-release
writing task. Include them and every required documentation correction in the
release candidate. Before promotion and tagging, confirm the gate evidence still
applies to that exact validated commit. If documentation changes afterward,
commit it on the work branch and validate the new commit before promotion.
Never defer a known documentation gap until after the tag or npm publication.

## Canonical Release Flow

1. Start from a clean, current `development` and create an approved short-lived release work branch. Keep release preparation on that branch until its exact commit passes GitHub validation.
2. Decide the SemVer bump (`major`, `minor`, or `patch`) using the documented change scope.
3. Update `package.json`, `package-lock.json`, `src/version.ts`, and `CHANGELOG.md` to the target version. Complete the [documentation gate](#documentation-gate), including `docs/releases/X.Y.Z.md` and `docs/releases/X.Y.Z.review.json`, and review all release documentation before committing the candidate.
4. Run changed-file formatting as needed during normal work.
5. Run focused local checks appropriate to the release changes. Full local `npm run validate` is optional; the complete validation gate runs on GitHub before promotion in step 8. MongoDB integration remains optional.
6. Build and inspect the publish artifact:
   - Create a temporary pack destination outside the checkout and run `npm pack --pack-destination "$release_pack_dir"`. Do not leave generated archives in the candidate; they would change its fingerprint and be absent from CI.
   - If default npm cache access is blocked, add `--cache /tmp/dbh-npm-cache` while keeping that external pack destination.
7. Run `npm run release:check` and resolve all failures. Commit release prep on the release work branch with the version as the commit subject (for example `0.1.7`).
8. Push the work branch and wait for its push-triggered `Repository validation` check from GitHub Actions to complete successfully on that exact commit. Local checks or a passing PR merge commit do not substitute for this check. If the commit changes, push and validate it again.
9. Fetch the protected branches and confirm both can be fast-forwarded to the validated release commit. Fast-forward `development` to that commit and push it, then fast-forward `main` to the same commit and push it. If either branch has diverged, stop and reconcile on the work branch, then validate the resulting commit before promotion. Do not bypass the required check or create a replacement release commit during promotion. Run `npm run release:check` on the clean candidate and confirm the documentation gate passed for that exact commit before promoting either branch.
10. Run `npm run release:check` on the clean `main` candidate, then create annotated tag `vX.Y.Z` on the release commit in `main`, then push the tag.
11. Authenticate to npm immediately before publish:
    - `npm login`
    - `npm whoami`
12. Manually publish from that exact tagged commit.
13. Switch local context back to `development` and fast-forward sync `development` from `main`.
14. Verify the published package version and run at least one real install/executable smoke test. Install into a fresh temporary prefix and invoke that install's exact executable; `npm exec --package` alone can resolve an older global `dbh`.
15. After confirming npm publication, publish the already-reviewed body from `docs/releases/X.Y.Z.md` at the tagged release commit as the GitHub release notes. Mark stable releases latest and pre-releases as pre-releases; do not move the tag. Read back the published notes, version links, and latest/pre-release status to confirm they match the prepared content.

## Publish And Verification Handoff

Manual publish remains required. Handoff details must include:

- confirmation that `npm login` and `npm whoami` were run immediately before publish
- exact `npm publish` command used
- temporary-cache variant when required
- post-publish verification commands and results
- documentation-gate coverage and results, the checked-in release-notes and review-record paths,
  and the GitHub release URL once published

Treat npm authentication checks as short-lived and non-durable. Always re-authenticate immediately before publish, even if prior checks passed earlier in the session.

Treat any `npm publish` warning that npm auto-corrected package metadata as a release blocker. Fix metadata in-repo and cut a new patch release instead of publishing corrected metadata from an existing tag.

## Source Of Truth

- Human-facing release policy: this document
- Repo guardrails and required checks: `AGENTS.md`
- Operator-level environment/deploy procedures: operational runbooks outside this policy
