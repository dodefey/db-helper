import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  archivePathForBackup,
  backupPath,
  listBackups,
  manifestPathForBackup,
  validateBackupName
} from "../src/lib/backups.js";

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "db-helper-backups-"));
  return run(dir);
}

test("listBackups returns an empty list when the backup root is missing", async () => {
  const missingRoot = path.join(
    tmpdir(),
    `db-helper-missing-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );

  const backups = await listBackups(missingRoot);

  assert.deepEqual(backups, []);
});

test("listBackups surfaces directory read errors instead of swallowing them", async () => {
  await withTempDir(async (dir) => {
    const rootFile = path.join(dir, "not-a-directory");
    await writeFile(rootFile, "content", "utf8");

    await assert.rejects(listBackups(rootFile), /ENOTDIR|not a directory/i);
  });
});

test("listBackups returns backup directories with manifests", async () => {
  await withTempDir(async (dir) => {
    const backupDir = path.join(dir, "backup-name");
    await mkdir(backupDir, { recursive: true });
    await writeFile(
      path.join(backupDir, "manifest.json"),
      JSON.stringify({
        backupName: "backup-name",
        sourceEnvironment: "production",
        databaseName: "production",
        createdAt: "2026-03-30T00:00:00.000Z",
        tags: [],
        collectionList: [],
        toolVersion: "test",
        archiveFile: "dump.archive.gz",
        collectionCounts: {}
      }),
      "utf8"
    );

    const backups = await listBackups(dir);

    assert.deepEqual(
      backups.map((backup) => backup.name),
      ["backup-name"]
    );
  });
});

test("validateBackupName rejects traversal and path-like names", () => {
  assert.throws(
    () => validateBackupName("../prod-snapshot"),
    /Invalid backup name/
  );
  assert.throws(
    () => validateBackupName("/tmp/outside"),
    /Invalid backup name/
  );
  assert.throws(() => validateBackupName("nested/name"), /Invalid backup name/);
  assert.throws(
    () => validateBackupName("nested\\name"),
    /Invalid backup name/
  );
});

test("backup path helpers stay contained under the backup root", () => {
  const backupRoot = "/tmp/db-helper-backups";

  assert.equal(
    backupPath(backupRoot, "manual-name"),
    path.resolve(backupRoot, "manual-name")
  );
  assert.equal(
    archivePathForBackup(backupRoot, "manual-name"),
    path.resolve(backupRoot, "manual-name", "dump.archive.gz")
  );
  assert.equal(
    manifestPathForBackup(backupRoot, "manual-name"),
    path.resolve(backupRoot, "manual-name", "manifest.json")
  );
});

test("backup path helpers reject names that would escape backup root", () => {
  const backupRoot = "/tmp/db-helper-backups";

  assert.throws(
    () => backupPath(backupRoot, "../outside"),
    /Invalid backup name/
  );
  assert.throws(
    () => archivePathForBackup(backupRoot, "/tmp/outside"),
    /Invalid backup name/
  );
  assert.throws(
    () => manifestPathForBackup(backupRoot, "nested/name"),
    /Invalid backup name/
  );
});
