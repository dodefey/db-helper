import test from "node:test";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
import { mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { planBackupPrune, executeBackupPrune } from "../src/lib/backupPrune.js";
import { backupPrune } from "../src/commands/backupPrune.js";
import {
  beginBackupCreation,
  activityPath,
  deletionGuardPath
} from "../src/lib/backupActivity.js";
import { deleteBackup } from "../src/lib/backupDelete.js";
import { loadConfig } from "../src/config/loadConfig.js";
import {
  withQueryFixture,
  writeFixtureBackup,
  runQuery
} from "./backup-query-helpers.js";

async function seed(root: string): Promise<void> {
  await writeFixtureBackup(root, "older", {
    createdAt: "2026-01-01T00:00:00Z"
  });
  await writeFixtureBackup(root, "newer", {
    createdAt: "2026-02-01T00:00:00Z"
  });
}

test("plans per environment using manifest dates, deterministic ties, and counts only eligible entries", async () => {
  await withQueryFixture(async ({ backupRoot, root }) => {
    await seed(backupRoot);
    await writeFixtureBackup(backupRoot, "tie", {
      createdAt: "2026-02-01T00:00:00Z"
    });
    await writeFixtureBackup(backupRoot, "development", {
      sourceEnvironment: "development"
    });
    await writeFixtureBackup(backupRoot, "retired-environment", {
      sourceEnvironment: "retired"
    });
    const empty = await writeFixtureBackup(backupRoot, "empty");
    await writeFile(path.join(empty, "dump.archive.gz"), "");
    await mkdir(path.join(backupRoot, "unfinished"));
    await symlink(root, path.join(backupRoot, "linked"));
    await writeFixtureBackup(backupRoot, "unknown-owner");
    await writeFile(activityPath(backupRoot, "unknown-owner"), "{");
    const release = await beginBackupCreation(
      backupRoot,
      "active",
      "production",
      []
    );
    try {
      const plan = await planBackupPrune(backupRoot, 1);
      assert.deepEqual(
        plan.keep.map((item) => item.name),
        ["development", "newer", "retired-environment"]
      );
      assert.deepEqual(
        plan.remove.map((item) => item.name),
        ["tie", "older"]
      );
      assert.deepEqual(plan.skip.map((item) => item.name).sort(), [
        "active",
        "empty",
        "linked",
        "unfinished",
        "unknown-owner"
      ]);
      assert.deepEqual(await executeBackupPrune(plan), ["tie", "older"]);
      assert.ok((await readdir(backupRoot)).includes("unfinished"));
      assert.ok((await readdir(root)).includes("config.json"));
    } finally {
      await release();
    }
  });
});

test("rejects invalid counts and unavailable inventory", async () => {
  await withQueryFixture(async ({ backupRoot }) => {
    for (const count of [
      0,
      -1,
      1.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1
    ])
      await assert.rejects(planBackupPrune(backupRoot, count), /at least 1/);
    await rm(backupRoot, { recursive: true });
    await assert.rejects(planBackupPrune(backupRoot, 1));
  });
});

test("retained or candidate changes after preview stop deletion and release guards", async () => {
  for (const changed of ["newer", "older"]) {
    await withQueryFixture(async ({ backupRoot }) => {
      await seed(backupRoot);
      const plan = await planBackupPrune(backupRoot, 1);
      await writeFile(
        path.join(backupRoot, changed, "dump.archive.gz"),
        "changed"
      );
      await assert.rejects(executeBackupPrune(plan), /changed since preview/);
      assert.ok((await readdir(backupRoot)).includes("older"));
      assert.equal(
        (await readdir(backupRoot)).some((name) => name.endsWith(".guard")),
        false
      );
    });
  }
});

test("frozen plans do not add backups created after preview", async () => {
  await withQueryFixture(async ({ backupRoot }) => {
    await seed(backupRoot);
    const plan = await planBackupPrune(backupRoot, 1);
    await writeFixtureBackup(backupRoot, "additional-old", {
      createdAt: "2025-01-01T00:00:00Z"
    });
    assert.deepEqual(await executeBackupPrune(plan), ["older"]);
    assert.ok((await readdir(backupRoot)).includes("additional-old"));
  });
});

test("first failed deletion stops the batch and reports completed and remaining names", async () => {
  await withQueryFixture(async ({ backupRoot }) => {
    await seed(backupRoot);
    await writeFixtureBackup(backupRoot, "oldest", {
      createdAt: "2025-01-01T00:00:00Z"
    });
    const plan = await planBackupPrune(backupRoot, 1);
    await writeFile(
      path.join(backupRoot, "oldest", "dump.archive.gz"),
      "changed"
    );
    await assert.rejects(
      executeBackupPrune(plan),
      /Deleted 1: older.*Remaining planned deletions: oldest/
    );
    assert.ok((await readdir(backupRoot)).includes("oldest"));
    assert.equal((await readdir(backupRoot)).includes("older"), false);
  });
});

test("retained guards exclude competing deletion and fail safely on existing guards", async () => {
  await withQueryFixture(async ({ backupRoot }) => {
    await seed(backupRoot);
    const plan = await planBackupPrune(backupRoot, 1);
    await writeFile(deletionGuardPath(backupRoot, "newer"), "");
    await assert.rejects(executeBackupPrune(plan), /guarded/);
    await assert.rejects(deleteBackup(backupRoot, "newer"), /guarded/);
    assert.ok((await readdir(backupRoot)).includes("older"));
  });
});

test("confirmation previews exact names, cancellation preserves data, dry run never prompts", async () => {
  await withQueryFixture(async ({ backupRoot, configPath }) => {
    await seed(backupRoot);
    const config = await loadConfig(configPath);
    let output = "";
    const dependencies = {
      interactive: () => true,
      write: (text: string) => {
        output += text;
      },
      confirm: async () => {
        assert.match(output, /KEEP newer/);
        assert.match(output, /DELETE older/);
        return false;
      }
    };
    await assert.rejects(
      backupPrune(
        config,
        { keepLast: 1, dryRun: false, yes: false, outputMode: "quiet" },
        dependencies
      ),
      /cancelled/
    );
    await backupPrune(
      config,
      { keepLast: 1, dryRun: true, yes: false, outputMode: "default" },
      {
        ...dependencies,
        confirm: async () => {
          throw new Error("unexpected prompt");
        }
      }
    );
    assert.ok((await readdir(backupRoot)).includes("older"));
  });
});

test("CLI smoke covers strict arguments, noninteractive confirmation, dry-run, deletion, quiet, logs and no-op", async () => {
  await withQueryFixture(async ({ backupRoot, configPath }) => {
    await seed(backupRoot);
    for (const flags of [
      [],
      ["--keep-last", "0", "--yes"],
      ["--keep-last", "1.5"],
      ["--keep-last", "1", "--all"],
      ["--keep-last", "1", "--keep-last", "2"],
      ["--keep-last", "1", "extra"],
      ["--keep-last", "1", "--yes", "--quiet", "--verbose"],
      ["--keep-last", "1"]
    ]) {
      const result = await runQuery(configPath, "prune", ...flags);
      assert.equal(result.code, 1, result.stdout);
      assert.ok((await readdir(backupRoot)).includes("older"));
    }
    const dry = await runQuery(
      configPath,
      "prune",
      "--keep-last",
      "1",
      "--dry-run"
    );
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /Dry run: 1 planned deletions; 0 deleted/);
    const result = await runQuery(
      configPath,
      "prune",
      "--keep-last",
      "1",
      "--yes",
      "--quiet",
      "--log"
    );
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Prune complete: 1 deleted; 1 kept/);
    assert.match(result.stdout, /Debug log saved:/);
    assert.deepEqual(await readdir(backupRoot), ["newer"]);
    const noop = await runQuery(configPath, "prune", "--keep-last", "5");
    assert.equal(noop.code, 0, noop.stderr);
    assert.match(noop.stdout, /0 planned deletions; 0 deleted/);
  });
});

test("changes during confirmation cannot replace a retained backup or introduce an active candidate", async () => {
  for (const change of ["retained", "active"] as const) {
    await withQueryFixture(async ({ backupRoot, configPath }) => {
      await seed(backupRoot);
      let release: (() => Promise<void>) | undefined;
      try {
        await assert.rejects(
          backupPrune(
            await loadConfig(configPath),
            { keepLast: 1, dryRun: false, yes: false, outputMode: "default" },
            {
              interactive: () => true,
              write: () => {},
              confirm: async () => {
                if (change === "retained")
                  await rm(path.join(backupRoot, "newer"), { recursive: true });
                else {
                  await rm(path.join(backupRoot, "older"), { recursive: true });
                  release = await beginBackupCreation(
                    backupRoot,
                    "older",
                    "production",
                    []
                  );
                }
                return true;
              }
            }
          ),
          /changed since preview|creation is active/
        );
        assert.ok((await readdir(backupRoot)).includes("older"));
        assert.equal(
          (await readdir(backupRoot)).some((name) => name.endsWith(".guard")),
          false
        );
      } finally {
        await release?.();
      }
    });
  }
});

test("case-sensitive distinct names can share one safety guard during pruning", async (t) => {
  await withQueryFixture(async ({ backupRoot }) => {
    await writeFixtureBackup(backupRoot, "Snapshot");
    if ((await readdir(backupRoot)).includes("snapshot")) return;
    try {
      await writeFixtureBackup(backupRoot, "snapshot", {
        createdAt: "2025-01-01T00:00:00Z"
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        t.skip("case-insensitive filesystem");
        return;
      }
      throw error;
    }
    const plan = await planBackupPrune(backupRoot, 1);
    assert.deepEqual(await executeBackupPrune(plan), ["snapshot"]);
    assert.deepEqual(await readdir(backupRoot), ["Snapshot"]);
  });
});

test(
  "failed filesystem removal stops later candidates and reports partial deletion risk",
  { skip: process.getuid?.() === 0 },
  async () => {
    await withQueryFixture(async ({ backupRoot }) => {
      const { chmod } = await import("node:fs/promises");
      await seed(backupRoot);
      await writeFixtureBackup(backupRoot, "oldest", {
        createdAt: "2025-01-01T00:00:00Z"
      });
      const locked = path.join(backupRoot, "older");
      await chmod(locked, 0o500);
      try {
        const plan = await planBackupPrune(backupRoot, 1);
        await assert.rejects(
          executeBackupPrune(plan),
          /Deleted 0: none.*Remaining planned deletions: older, oldest.*files may already have been removed/
        );
        assert.ok((await readdir(backupRoot)).includes("oldest"));
      } finally {
        await chmod(locked, 0o700);
      }
    });
  }
);

test("planning rejects manifests changed after catalog validation, including non-selection metadata", async () => {
  for (const change of ["environment", "timestamp", "invalid"] as const) {
    await withQueryFixture(async ({ backupRoot }) => {
      await seed(backupRoot);
      const original = fs.readFile;
      let reads = 0;
      fs.readFile = (async (
        file: Parameters<typeof fs.readFile>[0],
        ...args: [Parameters<typeof fs.readFile>[1]?]
      ) => {
        if (String(file).endsWith("/newer/manifest.json") && ++reads === 1) {
          const manifest = JSON.parse(await original(file, "utf8"));
          if (change === "environment")
            manifest.sourceEnvironment = "development";
          if (change === "timestamp")
            manifest.createdAt = "2025-01-01T00:00:00Z";
          if (change === "invalid") delete manifest.toolVersion;
          await writeFile(file, JSON.stringify(manifest));
        }
        return original(file, args[0] ?? null);
      }) as typeof original;
      syncBuiltinESMExports();
      try {
        const plan = await planBackupPrune(backupRoot, 1);
        assert.deepEqual(
          plan.keep.map((item) => item.name),
          ["older"]
        );
        assert.deepEqual(plan.remove, []);
        assert.equal(plan.skip[0].name, "newer");
        assert.match(plan.skip[0].reason, /changed during planning/);
      } finally {
        fs.readFile = original;
        syncBuiltinESMExports();
      }
    });
  }
});
