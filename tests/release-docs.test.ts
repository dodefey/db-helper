import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  candidateFingerprint,
  checkReleaseDocs
} from "../scripts/check-release-docs.js";

const version = "0.4.1";
const recordPath = `docs/releases/${version}.review.json`;
const notesPath = `docs/releases/${version}.md`;
function git(root: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd: root,
    stdio: "pipe",
    encoding: "utf8"
  });
}
async function metadata(root: string, value: string) {
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      version: value,
      repository: { url: "git+https://github.com/example/repo.git" }
    })
  );
  await writeFile(
    path.join(root, "package-lock.json"),
    JSON.stringify({ version: value, packages: { "": { version: value } } })
  );
  await writeFile(
    path.join(root, "src/version.ts"),
    `export const TOOL_VERSION = "${value}";\n`
  );
}
async function approve(root: string, overrides = {}) {
  await writeFile(
    path.join(root, recordPath),
    JSON.stringify({
      version,
      previousTag: "v0.4.0",
      reviewer: "Fixture reviewer",
      result: "pass",
      editorial: "pass",
      openFindings: [],
      surfaces: Object.fromEntries(
        [
          "readme",
          "commands",
          "changelog",
          "releaseNotes",
          "github",
          "package"
        ].map((key) => [
          key,
          { status: "reviewed", evidence: "Fixture review evidence" }
        ])
      ),
      contentSha256: await candidateFingerprint(root, recordPath),
      ...overrides
    })
  );
}
async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "dbh-release-docs-"));
  try {
    git(root, "init");
    git(root, "config", "user.email", "fixture@example.com");
    git(root, "config", "user.name", "Fixture");
    await mkdir(path.join(root, "src"));
    await mkdir(path.join(root, "docs/releases"), { recursive: true });
    await metadata(root, "0.4.0");
    await writeFile(
      path.join(root, "README.md"),
      "# Fixture\n\n## Usage\n\nInstructions.\n"
    );
    await writeFile(
      path.join(root, "RECOVERY.md"),
      "# Recovery\n\n[Usage](README.md#usage)\n"
    );
    await writeFile(
      path.join(root, "CHANGELOG.md"),
      "# Changelog\n\n## Unreleased\n"
    );
    git(root, "add", ".");
    git(root, "-c", "commit.gpgsign=false", "commit", "-m", "Baseline");
    git(root, "tag", "v0.4.0");
    await metadata(root, version);
    await writeFile(
      path.join(root, "CHANGELOG.md"),
      `# Changelog\n\n## Unreleased\n\n## ${version}\n\n- Fixed documentation.\n`
    );
    await writeFile(
      path.join(root, notesPath),
      `# ${version}\n\n## Changes\n\nDocumentation fix.\n\n## Safety and compatibility\n\nNo behavior change.\n\n## Install and verify\n\nnpm install -g example@${version}; example --version\n\n## Documentation\n\n[README](https://github.com/example/repo/blob/v${version}/README.md#usage)\n[Changelog](https://github.com/example/repo/blob/v${version}/CHANGELOG.md#041)\n[Comparison](https://github.com/example/repo/compare/v0.4.0...v${version})\n`
    );
    await approve(root);
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("complete release passes, including future-tag links; fingerprint survives staging and commit", async () => {
  await fixture(async (root) => {
    assert.equal(await checkReleaseDocs(root), "passed");
    assert.equal(await checkReleaseDocs(root, true), "passed");
    git(root, "add", ".");
    git(root, "-c", "commit.gpgsign=false", "commit", "-m", version);
    assert.equal(await checkReleaseDocs(root), "passed");
  });
});

test("missing notes or durable review record blocks release", async () => {
  for (const file of [notesPath, recordPath])
    await fixture(async (root) => {
      await rm(path.join(root, file));
      await assert.rejects(checkReleaseDocs(root), /ENOENT/);
    });
});

test("version mismatches and missing changelog entries block release", async () => {
  for (const file of ["package-lock.json", "src/version.ts", "CHANGELOG.md"])
    await fixture(async (root) => {
      const location = path.join(root, file);
      await writeFile(
        location,
        (await readFile(location, "utf8")).replaceAll(version, "0.4.2")
      );
      await approve(root);
      await assert.rejects(checkReleaseDocs(root), /version|changelog/i);
    });
});

test("open findings, incomplete surface evidence, and failed editorial review block release", async () => {
  for (const override of [
    { openFindings: ["missing instructions"] },
    { surfaces: {} },
    { editorial: "pending" },
    { reviewer: "" }
  ])
    await fixture(async (root) => {
      await approve(root, override);
      await assert.rejects(checkReleaseDocs(root), /review|findings|evidence/i);
    });
});

test("candidate edits invalidate the review until reviewed again", async () => {
  await fixture(async (root) => {
    await writeFile(
      path.join(root, "src/behavior.ts"),
      "export const changed = true;\n"
    );
    await assert.rejects(checkReleaseDocs(root), /fingerprint is stale/);
    await approve(root);
    assert.equal(await checkReleaseDocs(root), "passed");
  });
});

test("empty notes sections and broken local files, anchors, and future-tag links are rejected", async () => {
  for (const change of [
    (s: string) => s.replace("Documentation fix.", ""),
    (s: string) => `${s}\n[Missing](../../missing.md)\n`,
    (s: string) => `${s}\n[Bad anchor](../../README.md#absent)\n`,
    (s: string) => s.replace("README.md#usage", "README.md#absent")
  ])
    await fixture(async (root) => {
      await writeFile(
        path.join(root, notesPath),
        change(await readFile(path.join(root, notesPath), "utf8"))
      );
      await approve(root);
      await assert.rejects(
        checkReleaseDocs(root),
        /empty release notes|Broken/
      );
    });
});

test("ordinary development on an already-tagged version skips only automatic mode", async () => {
  await fixture(async (root) => {
    await metadata(root, "0.4.0");
    assert.equal(await checkReleaseDocs(root, true), "not-release");
    await assert.rejects(checkReleaseDocs(root));
  });
});

test("pack artifacts outside the checkout do not change the committed candidate fingerprint", async () => {
  const packDirectory = await mkdtemp(
    path.join(tmpdir(), "dbh-release-pack-test-")
  );
  try {
    await fixture(async (root) => {
      await writeFile(
        path.join(packDirectory, "package.tgz"),
        "fixture artifact"
      );
      assert.equal(await checkReleaseDocs(root), "passed");
      git(root, "add", ".");
      git(root, "-c", "commit.gpgsign=false", "commit", "-m", version);
      await rm(packDirectory, { recursive: true, force: true });
      assert.equal(await checkReleaseDocs(root), "passed");
    });
  } finally {
    await rm(packDirectory, { recursive: true, force: true });
  }
});
