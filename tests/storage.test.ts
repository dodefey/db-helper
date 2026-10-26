import test from "node:test";
import assert from "node:assert/strict";
import { access, rm, statfs, writeFile } from "node:fs/promises";
import {
  collectBackupUsage,
  getFilesystemCapacity
} from "../src/lib/storage.js";
import { withQueryFixture } from "./backup-query-helpers.js";

test("storage capacity uses available-to-user blocks and reports the common filesystem without summing space", async () => {
  await withQueryFixture(async ({ backupRoot, tempRoot }) => {
    const capacity = await getFilesystemCapacity(backupRoot);
    const stats = await statfs(backupRoot);
    assert.equal(capacity.totalBytes, stats.blocks * stats.bsize);
    assert.ok(capacity.availableBytes <= capacity.freeBytes);
    const report = await collectBackupUsage({ backupRoot, tempRoot });
    assert.equal(report.status, "ok");
    assert.equal(report.data.sharedFilesystem, true);
    assert.equal(
      report.data.locations[0].filesystem?.id,
      report.data.locations[1].filesystem?.id
    );
    assert.equal("totalAvailableBytes" in report.data, false);
  });
});

test("storage reports missing paths without creating them", async () => {
  await withQueryFixture(async ({ backupRoot, tempRoot }) => {
    await rm(tempRoot, { recursive: true });
    const report = await collectBackupUsage({ backupRoot, tempRoot });
    assert.equal(report.status, "partial");
    assert.equal(report.data.locations[1].status, "missing");
    assert.equal(report.data.locations[1].filesystem, null);
    assert.equal(report.data.sharedFilesystem, null);
    await assert.rejects(access(tempRoot), { code: "ENOENT" });
    await rm(backupRoot, { recursive: true });
    assert.equal(
      (await collectBackupUsage({ backupRoot, tempRoot })).status,
      "error"
    );
  });
});

test("storage reports non-directory paths and unavailable filesystems explicitly", async () => {
  await withQueryFixture(async ({ backupRoot, tempRoot }) => {
    await rm(tempRoot, { recursive: true });
    await writeFile(tempRoot, "file");
    assert.equal(
      (await collectBackupUsage({ backupRoot, tempRoot })).data.locations[1]
        .status,
      "not-directory"
    );
    const report = await collectBackupUsage(
      { backupRoot, tempRoot },
      async () => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      }
    );
    assert.equal(report.status, "error");
    assert.ok(
      report.data.locations.every(
        (location) =>
          location.status === "unavailable" && location.filesystem === null
      )
    );
  });
});

test("storage identifies distinct filesystems and preserves each capacity independently", async () => {
  const report = await collectBackupUsage(
    { backupRoot: "/backups", tempRoot: "/temp" },
    async (directory) => ({
      id: directory,
      totalBytes: 10000,
      freeBytes: 5000,
      availableBytes: 4000
    })
  );
  assert.equal(report.data.sharedFilesystem, false);
  assert.equal(report.data.locations.length, 2);
  assert.ok(
    report.data.locations.every(
      (location) => location.filesystem?.availableBytes === 4000
    )
  );
});
