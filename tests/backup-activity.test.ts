import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  beginBackupCreation,
  readBackupActivity
} from "../src/lib/backupActivity.js";
import { collectBackupCatalog } from "../src/lib/backupCatalog.js";
import {
  withQueryFixture,
  writeFixtureBackup,
  runQuery
} from "./backup-query-helpers.js";

test("active creation lists without warnings through metadata, archive, and manifest phases", async () => {
  await withQueryFixture(async ({ backupRoot, configPath }) => {
    const release = await beginBackupCreation(
      backupRoot,
      "creating",
      "production",
      ["repair"]
    );
    const directory = path.join(backupRoot, "creating");
    try {
      for (const phase of ["metadata", "archive", "manifest"]) {
        if (phase === "archive")
          await writeFile(path.join(directory, "dump.archive.gz"), "");
        if (phase === "manifest")
          await writeFile(path.join(directory, "manifest.json"), "{");
        const result = await runQuery(configPath, "list", "--json");
        assert.equal(result.code, 0);
        assert.equal(result.stderr, "");
        const report = JSON.parse(result.stdout);
        assert.equal(report.status, "ok");
        assert.deepEqual(report.issues, []);
        assert.equal(report.debugLogPath, null);
        assert.equal(report.data.backups[0].inProgress.pid, process.pid);
        assert.equal(report.data.backups[0].manifest, null);
        assert.equal(report.data.backups[0].archive.status, "not-inspected");
      }
      for (const mode of [[], ["--quiet"], ["--verbose"]]) {
        const result = await runQuery(configPath, "list", ...mode);
        assert.equal(result.code, 0);
        assert.equal(result.stderr, "");
        assert.match(result.stdout, /creating\s+production\s+in progress/);
      }
      assert.equal(
        (await collectBackupCatalog(backupRoot, { tag: "other" })).data.backups
          .length,
        0
      );
      assert.equal(
        (await collectBackupCatalog(backupRoot, { from: "development" })).data
          .backups.length,
        0
      );
    } finally {
      await release();
    }
    // A failed writer must not leave the entry classified as active.
    const abandoned = await collectBackupCatalog(backupRoot);
    assert.equal(abandoned.status, "partial");
    assert.equal(abandoned.data.backups[0].inProgress, undefined);
    assert.ok(
      abandoned.issues.some((issue) => issue.code === "MANIFEST_INVALID")
    );
  });
});

test("completed backups use artifact validation after activity is released", async () => {
  await withQueryFixture(async ({ backupRoot }) => {
    const release = await beginBackupCreation(
      backupRoot,
      "snapshot",
      "production",
      []
    );
    await rm(path.join(backupRoot, "snapshot"), { recursive: true });
    await writeFixtureBackup(backupRoot, "snapshot");
    await release();
    assert.equal(await readBackupActivity(backupRoot, "snapshot"), null);
    const report = await collectBackupCatalog(backupRoot);
    assert.equal(report.status, "ok");
    assert.equal(report.data.backups[0].manifestStatus, "valid");
    assert.equal(report.data.backups[0].inProgress, undefined);
  });
});

test("stale, malformed, foreign-host, and linked markers cannot hide incomplete backups", async () => {
  await withQueryFixture(async ({ backupRoot, root }) => {
    const release = await beginBackupCreation(
      backupRoot,
      "snapshot",
      "production",
      []
    );
    const markerName = (await readdir(backupRoot)).find((name) =>
      name.startsWith(".dbh-creating-")
    );
    assert.ok(markerName);
    const marker = path.join(backupRoot, markerName);
    const active = JSON.parse(await readFile(marker, "utf8"));
    try {
      for (const content of [
        JSON.stringify({ ...active, pid: 2147483647 }),
        JSON.stringify({ ...active, hostname: "different-host" }),
        JSON.stringify({ ...active, pid: -1 }),
        "null",
        "{"
      ]) {
        await writeFile(marker, content);
        const report = await collectBackupCatalog(backupRoot);
        assert.equal(report.status, "partial");
        assert.deepEqual(
          report.issues.map((issue) => issue.code),
          ["MANIFEST_MISSING", "ARCHIVE_MISSING"]
        );
      }
      const outside = path.join(root, "outside-marker");
      await writeFile(outside, JSON.stringify(active));
      await rm(marker);
      await symlink(outside, marker);
      assert.equal(await readBackupActivity(backupRoot, "snapshot"), null);
    } finally {
      await release();
    }
  });
});

test("duplicate creation refuses to overwrite backups or remove another writer's activity", async () => {
  await withQueryFixture(async ({ backupRoot }) => {
    const release = await beginBackupCreation(
      backupRoot,
      "active",
      "production",
      []
    );
    try {
      await assert.rejects(
        beginBackupCreation(backupRoot, "active", "production", []),
        { code: "EEXIST" }
      );
      assert.ok(await readBackupActivity(backupRoot, "active"));
    } finally {
      await release();
    }
    const directory = await writeFixtureBackup(backupRoot, "existing");
    const before = await readFile(
      path.join(directory, "manifest.json"),
      "utf8"
    );
    await assert.rejects(
      beginBackupCreation(backupRoot, "existing", "production", []),
      { code: "EEXIST" }
    );
    assert.equal(await readBackupActivity(backupRoot, "existing"), null);
    assert.equal(
      await readFile(path.join(directory, "manifest.json"), "utf8"),
      before
    );
  });
});

test("filesystem-length backup names can register activity and list without warnings", async () => {
  await withQueryFixture(async ({ backupRoot, configPath }) => {
    const name = "x".repeat(240);
    const release = await beginBackupCreation(
      backupRoot,
      name,
      "production",
      []
    );
    try {
      const result = await runQuery(configPath, "list", "--json");
      assert.equal(result.code, 0);
      assert.equal(result.stderr, "");
      const report = JSON.parse(result.stdout);
      assert.equal(report.data.backups[0].name, name);
      assert.equal(report.data.backups[0].inProgress.pid, process.pid);
      assert.deepEqual(report.issues, []);
    } finally {
      await release();
    }
    assert.equal(await readBackupActivity(backupRoot, name), null);
  });
});
