import test from "node:test";
import assert from "node:assert/strict";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  truncate,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getDirectoryDiskUsage } from "../src/lib/diskUsage.js";

test("disk usage measures allocation, includes nested files, deduplicates hard links, and skips symlink targets", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dbh-disk-usage-"));
  const backup = path.join(root, "backup");
  const nested = path.join(backup, "nested");
  const archive = path.join(backup, "dump.archive.gz");
  const manifest = path.join(nested, "manifest.json");
  const sparse = path.join(backup, "sparse");
  const outside = path.join(root, "outside");
  const shortcut = path.join(backup, "shortcut");
  const cycle = path.join(backup, "cycle");
  const broken = path.join(backup, "broken");
  try {
    await mkdir(nested, { recursive: true });
    await mkdir(outside);
    await writeFile(archive, Buffer.alloc(12345, 1));
    await writeFile(manifest, "{}");
    await writeFile(path.join(outside, "unrelated"), Buffer.alloc(65536, 1));
    await writeFile(sparse, "");
    await truncate(sparse, 32 * 1024 ** 2);
    await link(archive, path.join(nested, "archive-link"));
    await symlink(outside, shortcut, "dir");
    await symlink(backup, cycle, "dir");
    await symlink(path.join(root, "missing"), broken);

    const entries = [
      backup,
      nested,
      archive,
      manifest,
      sparse,
      shortcut,
      cycle,
      broken
    ];
    const stats = await Promise.all(entries.map((entry) => lstat(entry)));
    const expected = stats.reduce((sum, entry) => sum + entry.blocks * 512, 0);
    assert.equal(await getDirectoryDiskUsage(backup), expected);
    assert.ok(
      expected < 32 * 1024 ** 2,
      "sparse file length is not disk allocation"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("disk usage surfaces missing paths instead of reporting zero", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dbh-disk-missing-"));
  try {
    await assert.rejects(getDirectoryDiskUsage(path.join(root, "missing")), {
      code: "ENOENT"
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
