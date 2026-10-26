import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { BackupRecord } from "../src/config/types.js";
import { CatalogEntry } from "../src/lib/backupCatalog.js";
import { formatBackupList } from "../src/commands/backupListOutput.js";
import { getDirectoryDiskUsage } from "../src/lib/diskUsage.js";

const execFileAsync = promisify(execFile);

function record(name: string, environment = "production"): BackupRecord {
  return {
    name,
    path: `/backups/${name}`,
    manifest: {
      backupName: name,
      sourceEnvironment: environment,
      databaseName: environment,
      createdAt: "2026-10-26T02:35:58.938Z",
      tags: [],
      collectionList: [],
      toolVersion: "test",
      archiveFile: "dump.archive.gz"
    }
  };
}

function entry(
  backup: BackupRecord,
  allocatedBytes: number | null
): CatalogEntry {
  return {
    ...backup,
    manifestStatus: "valid",
    matchesFilters: true,
    archive: {
      path: `${backup.path}/dump.archive.gz`,
      status: "present",
      sizeBytes: 1,
      verification: "not-performed"
    },
    diskUsage: {
      status: allocatedBytes === null ? "unavailable" : "measured",
      allocatedBytes
    }
  };
}

test("backup list aligns long names and environments, right-aligns disk usage, and totals displayed rows", () => {
  const longName = "sku1476-failed-adjustment-20261025-recovery-retry1";
  const backup = record(longName);
  backup.manifest.tags = ["recovery", "pre-change"];
  const records = [
    entry(backup, 1024 ** 3),
    entry(record("short", "development-with-long-name"), 512)
  ];
  const result = formatBackupList(records, "default");
  const [header, first, second] = result.split("\n");
  assert.doesNotMatch(result, /\t/);
  assert.equal(first.indexOf("production"), header.indexOf("ENVIRONMENT"));
  assert.equal(
    second.indexOf("development-with-long-name"),
    header.indexOf("ENVIRONMENT")
  );
  assert.equal(
    first.indexOf(backup.manifest.createdAt),
    header.indexOf("CREATED")
  );
  assert.equal(
    second.indexOf(backup.manifest.createdAt),
    header.indexOf("CREATED")
  );
  assert.equal(
    first.indexOf("1.0 GiB") + "1.0 GiB".length,
    second.indexOf("512 B") + "512 B".length
  );
  assert.equal(first.indexOf("recovery,pre-change"), header.indexOf("TAGS"));
  assert.ok(second.endsWith("  -"));
  assert.match(result, /2 backups; total disk usage: 1\.0 GiB\n$/);
});

test("quiet backup list preserves the original columns and appends exact allocated bytes", () => {
  const result = formatBackupList(
    [entry(record("snapshot"), 1234567)],
    "quiet"
  );
  assert.equal(
    result,
    "snapshot\tproduction\t2026-10-26T02:35:58.938Z\t-\t1234567\n"
  );
});

test("unknown usage stays visible and cannot be mistaken for a complete total", () => {
  const records = [
    entry(record("good"), 2048),
    entry(record("unreadable"), null)
  ];
  const result = formatBackupList(records, "default");
  assert.match(result, /unreadable +production +\S+ +unknown +-\n/);
  assert.match(
    result,
    /2 backups; known disk usage: 2\.0 KiB; 1 unavailable\n$/
  );
  assert.doesNotMatch(result, /total disk usage/);
  assert.ok(formatBackupList(records, "quiet").endsWith("\tunknown\n"));
  const verbose = formatBackupList(records, "verbose");
  assert.ok(verbose.startsWith(result));
  assert.match(verbose, /Backup path: \/backups\/good/);
});

test("backup list handles empty results and zero allocation", () => {
  assert.equal(formatBackupList([], "default"), "No backups found.\n");
  assert.equal(formatBackupList([], "quiet"), "");
  assert.match(
    formatBackupList([entry(record("empty"), 0)], "default"),
    /1 backup; total disk usage: 0 B\n$/
  );
});

test("backup list CLI reads existing artifacts, filters rows and totals, and supports output modes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dbh-backup-list-cli-"));
  const backupRoot = path.join(root, "backups");
  const configPath = path.join(root, "config.json");
  try {
    for (const backup of [
      record("older-production"),
      record("newer-development", "development")
    ]) {
      const directory = path.join(backupRoot, backup.name);
      if (backup.name === "older-production") {
        backup.manifest.createdAt = "2026-10-25T00:00:00.000Z";
      }
      backup.manifest.tags = ["recovery"];
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(directory, "manifest.json"),
        JSON.stringify(backup.manifest)
      );
      await writeFile(
        path.join(directory, "dump.archive.gz"),
        Buffer.alloc(4097, 1)
      );
    }
    const environment = {
      label: "Fixture",
      kind: "local",
      host: "localhost",
      databaseName: "fixture",
      mongoUser: "fixture-user",
      mongoPassword: "fixture-password"
    };
    await writeFile(
      configPath,
      JSON.stringify({
        paths: { backupRoot, tempRoot: path.join(root, "temp") },
        environments: { production: environment, development: environment }
      })
    );
    const run = async (...flags: string[]) =>
      execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          "src/cli.ts",
          "backup",
          "list",
          "--config",
          configPath,
          ...flags
        ],
        { cwd: path.resolve(".") }
      );

    const normal = await run();
    assert.equal(normal.stderr, "");
    assert.match(
      normal.stdout,
      /^BACKUP +ENVIRONMENT +CREATED \(UTC\) +DISK +TAGS\n/
    );
    assert.ok(
      normal.stdout.indexOf("newer-development") <
        normal.stdout.indexOf("older-production")
    );
    assert.match(normal.stdout, /2 backups; total disk usage:/);

    const quiet = await run(
      "--from",
      "production",
      "--tag",
      "recovery",
      "--quiet"
    );
    const bytes = await getDirectoryDiskUsage(
      path.join(backupRoot, "older-production")
    );
    assert.equal(
      quiet.stdout,
      `older-production\tproduction\t2026-10-25T00:00:00.000Z\trecovery\t${bytes}\n`
    );
    const filtered = await run("--from", "production");
    assert.doesNotMatch(filtered.stdout, /newer-development/);
    assert.match(filtered.stdout, /1 backup; total disk usage:/);

    const verbose = await run("--verbose");
    assert.match(verbose.stdout, /Backup path: .+older-production/);
    const empty = await run("--tag", "missing");
    assert.equal(empty.stdout, "No backups found.\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
