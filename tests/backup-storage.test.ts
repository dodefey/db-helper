import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { backupCreate } from "../src/commands/backup.js";
import { loadConfig } from "../src/config/loadConfig.js";
import { reportBackupStorage } from "../src/commands/backupStorage.js";
import { collectBackupCatalog } from "../src/lib/backupCatalog.js";
import { getFilesystemCapacity } from "../src/lib/storage.js";
import {
  withQueryFixture,
  writeFixtureBackup
} from "./backup-query-helpers.js";

function harness(availableBytes = 2 * 1024 ** 3) {
  const out: string[] = [],
    err: string[] = [];
  return {
    out,
    err,
    dependencies: {
      capacity: async () => ({
        id: "fixture",
        totalBytes: 10 * 1024 ** 3,
        freeBytes: availableBytes,
        availableBytes
      }),
      catalog: collectBackupCatalog,
      stdout: (text: string) => {
        out.push(text);
      },
      stderr: (text: string) => {
        err.push(text);
      }
    }
  };
}

test("post-backup summary measures a real root without inspecting archive contents", async () => {
  await withQueryFixture(async ({ backupRoot }) => {
    await writeFixtureBackup(backupRoot, "snapshot");
    const h = harness();
    await reportBackupStorage(backupRoot, "default", true, {
      ...h.dependencies,
      capacity: getFilesystemCapacity
    });
    assert.match(
      h.out.join(""),
      /^Storage: 1 backup · .* allocated · .* available\.\n$/
    );
  });
});

test("low-space warning uses available bytes, applies in quiet, and starts below 1 GiB", async () => {
  for (const mode of ["default", "quiet", "verbose"] as const) {
    const h = harness(1024 ** 3 - 1);
    await reportBackupStorage("unused", mode, false, h.dependencies);
    assert.equal(h.out.length, 0);
    assert.match(h.err.join(""), /Warning: backup storage is low/);
    assert.match(h.err.join(""), /dbh backup delete --backup <name>/);
    const enough = harness(1024 ** 3);
    await reportBackupStorage("unused", mode, false, enough.dependencies);
    assert.equal(enough.err.length, 0);
  }
});

test("quiet skips inventory, verbose includes summary, partial allocations stay explicit", async () => {
  await withQueryFixture(async ({ backupRoot }) => {
    await mkdir(path.join(backupRoot, "incomplete"));
    const h = harness();
    let calls = 0;
    const catalog: typeof collectBackupCatalog = async (...args) => {
      calls++;
      const report = await collectBackupCatalog(...args);
      report.data.allocationComplete = false;
      return report;
    };
    await reportBackupStorage(backupRoot, "quiet", true, {
      ...h.dependencies,
      catalog
    });
    assert.equal(calls, 0);
    assert.equal(h.out.length, 0);
    await reportBackupStorage(backupRoot, "verbose", true, {
      ...h.dependencies,
      catalog
    });
    assert.match(
      h.out.join(""),
      /1 backup · at least .* allocated · 2.0 GiB available/
    );
    assert.equal(h.err.length, 0);
  });
});

test("unavailable capacity or catalog remains advisory and is never reported as zero", async () => {
  const h = harness();
  await reportBackupStorage("missing", "default", true, {
    ...h.dependencies,
    capacity: async () => {
      throw new Error("unavailable");
    },
    catalog: async () => {
      throw new Error("unavailable");
    }
  });
  assert.equal(
    h.out.join(""),
    "Storage: backup inventory unavailable · available space unknown.\n"
  );
  assert.equal(h.err.length, 0);
  await withQueryFixture(async ({ backupRoot }) => {
    await rm(backupRoot, { recursive: true });
    const missing = harness();
    await reportBackupStorage(
      backupRoot,
      "default",
      true,
      missing.dependencies
    );
    assert.match(missing.out.join(""), /inventory unavailable/);
  });
});

test("failed creation does not print a post-backup storage summary", async () => {
  await withQueryFixture(async ({ configPath }) => {
    const calls: boolean[] = [];
    await assert.rejects(
      backupCreate(
        await loadConfig(configPath),
        { from: "production", outputMode: "default" },
        {
          runBackupCreate: async () => {
            throw new Error("archive failed");
          },
          reportBackupStorage: async (_root, _mode, summary) => {
            calls.push(summary);
            return false;
          },
          listBackups: async () => {
            throw new Error("not used");
          },
          ensureBackupArtifacts: async () => {},
          readBackup: async () => {
            throw new Error("not used");
          }
        }
      ),
      /archive failed/
    );
    assert.deepEqual(calls, [false]);
  });
});

test("one warning per backup, including when capacity becomes low after creation", async () => {
  await withQueryFixture(async ({ configPath }) => {
    for (const startsLow of [true, false]) {
      const config = await loadConfig(configPath);
      const h = harness();
      let completed = false;
      await backupCreate(
        config,
        { from: "production", outputMode: "quiet" },
        {
          reportBackupStorage: (root, mode, summary, _deps, warn) =>
            reportBackupStorage(
              root,
              mode,
              summary,
              {
                ...h.dependencies,
                capacity: async () => ({
                  id: "fixture",
                  totalBytes: 10 * 1024 ** 3,
                  freeBytes: 10 * 1024 ** 3,
                  availableBytes: startsLow || completed ? 512 : 2 * 1024 ** 3
                })
              },
              warn
            ),
          runBackupCreate: async () => {
            completed = true;
            return { name: "snapshot" } as never;
          },
          listBackups: async () => [],
          ensureBackupArtifacts: async () => {},
          readBackup: async () => {
            throw new Error("unused");
          }
        }
      );
      assert.equal(h.err.length, 1);
      assert.equal(h.out.length, 0);
    }
  });
});

test("automatic backup opt-out skips both storage checks without changing backup result", async () => {
  await withQueryFixture(async ({ configPath }) => {
    const config = await loadConfig(configPath);
    const record = await writeFixtureBackup(config.backupRoot, "snapshot");
    const { readBackup, ensureBackupArtifacts, listBackups } =
      await import("../src/lib/backups.js");
    const expected = await readBackup(config.backupRoot, "snapshot");
    const result = await backupCreate(
      config,
      { from: "production", outputMode: "default", reportStorage: false },
      {
        reportBackupStorage: async () => {
          throw new Error("storage must not run");
        },
        runBackupCreate: async () => expected,
        readBackup,
        ensureBackupArtifacts,
        listBackups
      }
    );
    assert.equal(result, expected);
    assert.equal(result.path, record);
  });
});
