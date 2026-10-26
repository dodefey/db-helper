import test from "node:test";
import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import {
  collectBackupCatalog,
  CatalogDependencies
} from "../src/lib/backupCatalog.js";
import { getDirectoryDiskUsage } from "../src/lib/diskUsage.js";
import {
  withQueryFixture,
  writeFixtureBackup
} from "./backup-query-helpers.js";

const dependencies: CatalogDependencies = {
  lstat,
  readdir,
  readFile,
  measureUsage: getDirectoryDiskUsage
};

test("catalog exposes typed metadata, exact sizes, normalized UTC, and no implied verification", async () => {
  await withQueryFixture(async ({ backupRoot }) => {
    const directory = await writeFixtureBackup(backupRoot, "snapshot", {
      tags: ["comma,tag", "tab\ttag"],
      createdAt: "2026-10-25T08:34:56.789-04:00"
    });
    const report = await collectBackupCatalog(backupRoot);
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.status, "ok");
    assert.equal(report.data.backupRoot.status, "available");
    const [backup] = report.data.backups;
    assert.equal(backup.manifestStatus, "valid");
    assert.equal(backup.manifest?.createdAt, "2026-10-25T12:34:56.789Z");
    assert.deepEqual(backup.manifest?.tags, ["comma,tag", "tab\ttag"]);
    assert.deepEqual(backup.manifest?.collectionCounts, { orders: 2 });
    assert.equal(backup.archive.sizeBytes, 4097);
    assert.equal(backup.archive.verification, "not-performed");
    assert.equal(
      backup.diskUsage.allocatedBytes,
      await getDirectoryDiskUsage(directory)
    );
    assert.equal(
      report.data.knownAllocatedBytes,
      backup.diskUsage.allocatedBytes
    );
    assert.equal(report.data.allocationComplete, true);
  });
});

test("catalog keeps healthy entries alongside missing, malformed, and empty artifacts", async () => {
  await withQueryFixture(async ({ backupRoot }) => {
    await writeFixtureBackup(backupRoot, "healthy");
    const missing = await writeFixtureBackup(backupRoot, "missing-archive");
    await rm(path.join(missing, "dump.archive.gz"));
    const empty = await writeFixtureBackup(backupRoot, "empty-archive");
    await writeFile(path.join(empty, "dump.archive.gz"), "");
    const broken = await writeFixtureBackup(backupRoot, "malformed");
    await writeFile(path.join(broken, "manifest.json"), "{broken");
    await mkdir(path.join(backupRoot, "manifest-missing"));
    const report = await collectBackupCatalog(backupRoot);
    assert.equal(report.status, "partial");
    assert.equal(report.data.backups.length, 5);
    assert.deepEqual(
      report.issues.map((issue) => issue.code).sort(),
      [
        "ARCHIVE_EMPTY",
        "ARCHIVE_MISSING",
        "ARCHIVE_MISSING",
        "MANIFEST_INVALID",
        "MANIFEST_MISSING"
      ].sort()
    );
    assert.equal(
      report.data.backups.find((backup) => backup.name === "healthy")?.archive
        .status,
      "present"
    );
    assert.equal(
      report.data.backups.find((backup) => backup.name === "malformed")
        ?.manifest,
      null
    );
  });
});

test("catalog distinguishes missing, non-directory, and unreadable roots from an empty catalog", async () => {
  await withQueryFixture(async ({ root, backupRoot }) => {
    assert.equal((await collectBackupCatalog(backupRoot)).status, "ok");
    const missing = await collectBackupCatalog(path.join(root, "missing"));
    assert.equal(missing.status, "error");
    assert.equal(missing.data.backupRoot.status, "missing");
    const file = path.join(root, "file");
    await writeFile(file, "content");
    assert.equal(
      (await collectBackupCatalog(file)).data.backupRoot.status,
      "not-directory"
    );
    const denied = await collectBackupCatalog(
      backupRoot,
      {},
      {
        ...dependencies,
        readdir: async () => {
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        }
      }
    );
    assert.equal(denied.data.backupRoot.status, "unreadable");
    assert.equal(denied.data.allocationComplete, false);
  });
});

test("catalog filters known metadata but retains unclassifiable entries and totals only included entries", async () => {
  await withQueryFixture(async ({ backupRoot }) => {
    await writeFixtureBackup(backupRoot, "production");
    await writeFixtureBackup(backupRoot, "development", {
      sourceEnvironment: "development"
    });
    await writeFixtureBackup(backupRoot, "other-tag", { tags: ["other"] });
    await mkdir(path.join(backupRoot, "unknown"));
    const report = await collectBackupCatalog(backupRoot, {
      from: "production",
      tag: "recovery"
    });
    assert.deepEqual(
      report.data.backups.map((backup) => backup.name),
      ["production", "unknown"]
    );
    assert.equal(report.data.backups[0].matchesFilters, true);
    assert.equal(report.data.backups[1].matchesFilters, null);
    assert.equal(
      report.data.knownAllocatedBytes,
      (await getDirectoryDiskUsage(path.join(backupRoot, "production"))) +
        (await getDirectoryDiskUsage(path.join(backupRoot, "unknown")))
    );
  });
});

test("catalog rejects wrong-shaped metadata and identity mismatches without aborting other entries", async () => {
  await withQueryFixture(async ({ backupRoot }) => {
    for (const [index, changes] of [
      { backupName: "different" },
      { archiveFile: "../outside" },
      { tags: [5] },
      { createdAt: "bad" },
      { collectionCounts: { orders: -1 } },
      null
    ].entries()) {
      const directory = await writeFixtureBackup(backupRoot, `bad-${index}`);
      const manifest = JSON.parse(
        await readFile(path.join(directory, "manifest.json"), "utf8")
      );
      await writeFile(
        path.join(directory, "manifest.json"),
        JSON.stringify(changes === null ? null : { ...manifest, ...changes })
      );
    }
    const report = await collectBackupCatalog(backupRoot);
    assert.equal(report.status, "partial");
    assert.ok(
      report.data.backups.every(
        (entry) => entry.manifestStatus === "invalid" && entry.manifest === null
      )
    );
  });
});

test("catalog reports failed measurements as null and retains read errors", async () => {
  await withQueryFixture(async ({ backupRoot }) => {
    await writeFixtureBackup(backupRoot, "snapshot");
    const report = await collectBackupCatalog(
      backupRoot,
      {},
      {
        ...dependencies,
        measureUsage: async () => {
          throw new Error("disappeared");
        },
        readFile: async () => {
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        }
      }
    );
    assert.equal(report.status, "partial");
    assert.equal(report.data.backups[0].manifestStatus, "unreadable");
    assert.equal(report.data.backups[0].diskUsage.allocatedBytes, null);
    assert.equal(report.data.knownAllocatedBytes, 0);
    assert.equal(report.data.allocationComplete, false);
    assert.deepEqual(
      report.issues.map((issue) => issue.code),
      ["MANIFEST_UNREADABLE", "DISK_USAGE_UNAVAILABLE"]
    );
    assert.equal(report.issues[0].systemCode, "EACCES");
    assert.equal(report.issues[1].systemCode, null);
  });
});

test("catalog supports an explicitly configured root symlink and optional legacy metadata", async () => {
  await withQueryFixture(async ({ root, backupRoot }) => {
    const directory = await writeFixtureBackup(backupRoot, "snapshot");
    const manifestFile = path.join(directory, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
    delete manifest.collectionCounts;
    delete manifest.note;
    manifest.extraStoredField = "not a public field";
    await writeFile(manifestFile, JSON.stringify(manifest));
    const alias = path.join(root, "alias");
    await symlink(backupRoot, alias, "dir");
    const report = await collectBackupCatalog(alias);
    assert.equal(report.status, "ok");
    assert.equal(report.data.backupRoot.path, alias);
    assert.equal(report.data.backups[0].manifest?.collectionCounts, undefined);
    assert.equal("extraStoredField" in report.data.backups[0].manifest!, false);
    assert.equal(
      JSON.parse(await readFile(manifestFile, "utf8")).extraStoredField,
      "not a public field"
    );
  });
});

test("catalog reports unsupported names and non-file artifacts without dropping their disk usage", async () => {
  await withQueryFixture(async ({ backupRoot }) => {
    const directory = await writeFixtureBackup(backupRoot, "unsupported name");
    await rm(path.join(directory, "dump.archive.gz"));
    await mkdir(path.join(directory, "dump.archive.gz"));
    const report = await collectBackupCatalog(backupRoot);
    assert.equal(report.status, "partial");
    assert.equal(report.data.backups[0].archive.status, "not-file");
    assert.ok(report.data.backups[0].diskUsage.allocatedBytes !== null);
    assert.deepEqual(
      report.issues.map((issue) => issue.code),
      ["INVALID_BACKUP_NAME", "ARCHIVE_NOT_FILE"]
    );
  });
});

test("catalog never follows backup, manifest, or archive symlinks", async () => {
  await withQueryFixture(async ({ root, backupRoot }) => {
    const outside = await writeFixtureBackup(root, "outside");
    await symlink(outside, path.join(backupRoot, "linked-backup"), "dir");
    const inside = await writeFixtureBackup(backupRoot, "linked-artifacts");
    for (const name of ["manifest.json", "dump.archive.gz"]) {
      await rm(path.join(inside, name));
      await symlink(path.join(outside, name), path.join(inside, name));
    }
    const report = await collectBackupCatalog(backupRoot);
    assert.equal(report.status, "partial");
    assert.equal(report.issues.length, 3);
    assert.ok(
      report.issues.every((issue) => issue.code === "SYMLINK_NOT_FOLLOWED")
    );
    const linkedBackup = report.data.backups.find(
      (entry) => entry.name === "linked-backup"
    )!;
    assert.equal(linkedBackup.manifestStatus, "not-inspected");
    assert.equal(linkedBackup.archive.status, "not-inspected");
    assert.equal(
      linkedBackup.diskUsage.allocatedBytes,
      (await lstat(linkedBackup.path)).blocks * 512
    );
  });
});
