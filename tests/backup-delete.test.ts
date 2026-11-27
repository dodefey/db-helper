import test from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import {
  activityPath,
  beginBackupCreation,
  deletionGuardPath,
  readBackupActivity
} from "../src/lib/backupActivity.js";
import { deleteBackup } from "../src/lib/backupDelete.js";
import { backupDelete } from "../src/commands/backupDelete.js";
import {
  withQueryFixture,
  writeFixtureBackup,
  runQuery
} from "./backup-query-helpers.js";
import { loadConfig } from "../src/config/loadConfig.js";

test("delete removes exact backup including internal links without following them; repeat is absent", async () => {
  await withQueryFixture(async ({ backupRoot, root }) => {
    const target = await writeFixtureBackup(backupRoot, "remove");
    const keep = await writeFixtureBackup(backupRoot, "keep");
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "preserve"), "safe");
    await symlink(outside, path.join(target, "linked"));
    assert.equal(await deleteBackup(backupRoot, "remove"), "deleted");
    assert.equal(
      await readFile(path.join(outside, "preserve"), "utf8"),
      "safe"
    );
    assert.ok((await readdir(keep)).includes("manifest.json"));
    assert.equal(await deleteBackup(backupRoot, "remove"), "absent");
    assert.deepEqual(await readdir(backupRoot), ["keep"]);
  });
});

test("delete refuses traversal, symlink roots of backups, files, active and unknown writers", async () => {
  await withQueryFixture(async ({ backupRoot, root }) => {
    for (const name of ["..", "../outside", "*", "a/b", ""])
      await assert.rejects(deleteBackup(backupRoot, name));
    await symlink(root, path.join(backupRoot, "linked"));
    await assert.rejects(deleteBackup(backupRoot, "linked"), /real directory/);
    await writeFile(path.join(backupRoot, "file"), "safe");
    await assert.rejects(deleteBackup(backupRoot, "file"), /real directory/);
    const release = await beginBackupCreation(
      backupRoot,
      "active",
      "production",
      []
    );
    try {
      await assert.rejects(
        deleteBackup(backupRoot, "active"),
        /creation is active/
      );
    } finally {
      await release();
    }
    for (const marker of [
      "{",
      JSON.stringify({ pid: process.pid, hostname: "foreign-host" })
    ]) {
      await writeFile(activityPath(backupRoot, "active"), marker);
      await assert.rejects(deleteBackup(backupRoot, "active"));
    }
    await rm(activityPath(backupRoot, "active"));
    assert.equal(await deleteBackup(backupRoot, "active"), "deleted");
  });
});

test("delete checks machine identity before treating a missing PID as stopped", async () => {
  await withQueryFixture(async ({ backupRoot }) => {
    const name = "abandoned";
    await mkdir(path.join(backupRoot, name));
    const marker = activityPath(backupRoot, name);
    const pid = 2147483647;
    for (const activity of [
      { pid, hostname: "foreign-host" },
      { pid, hostname: hostname(), machineId: "0".repeat(64) },
      { pid, hostname: hostname(), machineId: null }
    ]) {
      await writeFile(marker, JSON.stringify(activity));
      await assert.rejects(
        deleteBackup(backupRoot, name),
        /Cannot establish ownership of backup creation marker/
      );
    }
    assert.ok((await readdir(backupRoot)).includes(name));
  });
});

test("stopped creation markers and incomplete backups can be removed and recreated", async () => {
  await withQueryFixture(async ({ backupRoot }) => {
    await mkdir(path.join(backupRoot, "abandoned"));
    await writeFile(
      activityPath(backupRoot, "abandoned"),
      JSON.stringify({ pid: 2147483647, hostname: hostname() })
    );
    assert.equal(await deleteBackup(backupRoot, "abandoned"), "deleted");
    const release = await beginBackupCreation(
      backupRoot,
      "abandoned",
      "production",
      []
    );
    await release();
    assert.equal(await deleteBackup(backupRoot, "abandoned"), "deleted");
  });
});

test("delete refuses a writer marker left before its PID was recorded", async () => {
  await withQueryFixture(async ({ backupRoot }) => {
    const name = "starting-writer";
    await mkdir(path.join(backupRoot, name));
    const marker = activityPath(backupRoot, name);
    await writeFile(
      marker,
      JSON.stringify({ pid: 2147483647, hostname: hostname() })
    );
    await writeFile(`${marker}.writer`, "");
    await assert.rejects(
      deleteBackup(backupRoot, name),
      /Cannot verify backup archive writer has stopped/
    );
    assert.ok((await readdir(backupRoot)).includes(name));
  });
});

test("deletion guard excludes creators and competing deletes without changing artifacts", async () => {
  await withQueryFixture(async ({ backupRoot }) => {
    await writeFixtureBackup(backupRoot, "snapshot");
    const guard = deletionGuardPath(backupRoot, "snapshot");
    await writeFile(guard, "");
    await assert.rejects(
      beginBackupCreation(backupRoot, "snapshot", "production", []),
      /deletion/
    );
    await assert.rejects(deleteBackup(backupRoot, "snapshot"), /guarded/);
    await rm(guard);
    assert.equal(await deleteBackup(backupRoot, "snapshot"), "deleted");
  });
});

test("confirmation names resolved target, cancellation preserves it, and execution rechecks activity", async () => {
  await withQueryFixture(async ({ backupRoot, configPath }) => {
    await mkdir(path.join(backupRoot, "snapshot"));
    const config = await loadConfig(configPath);
    const input = {
      backup: "snapshot",
      yes: false,
      outputMode: "quiet" as const
    };
    await assert.rejects(
      backupDelete(config, input, {
        interactive: () => true,
        write: () => {},
        confirm: async (message) => {
          assert.match(message, /Delete backup snapshot/);
          assert.ok(message.includes("/snapshot"));
          return false;
        }
      }),
      /cancelled/
    );
    assert.ok((await readdir(backupRoot)).includes("snapshot"));
    let release: (() => Promise<void>) | undefined;
    try {
      await assert.rejects(
        backupDelete(config, input, {
          interactive: () => true,
          write: () => {},
          confirm: async () => {
            await rm(path.join(backupRoot, "snapshot"), { recursive: true });
            release = await beginBackupCreation(
              backupRoot,
              "snapshot",
              "production",
              []
            );
            return true;
          }
        }),
        /creation is active/
      );
    } finally {
      await release?.();
    }
  });
});

test("CLI deletion smoke: explicit confirmation, strict arguments, modes, logs and idempotence", async () => {
  await withQueryFixture(async ({ backupRoot, configPath }) => {
    await writeFixtureBackup(backupRoot, "snapshot");
    for (const flags of [
      [],
      ["--yes", "--all"],
      ["--yes", "--backup", "other"],
      ["--yes", "extra"],
      ["--yes", "--quiet", "--verbose"]
    ]) {
      const result = await runQuery(
        configPath,
        "delete",
        "--backup",
        "snapshot",
        ...flags
      );
      assert.equal(result.code, 1);
      assert.ok((await readdir(backupRoot)).includes("snapshot"));
    }
    const result = await runQuery(
      configPath,
      "delete",
      "--backup",
      "snapshot",
      "--yes",
      "--verbose",
      "--log"
    );
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Backup path:.*snapshot/);
    assert.match(result.stdout, /Backup deleted: snapshot/);
    assert.match(result.stdout, /Debug log saved:/);
    const absent = await runQuery(
      configPath,
      "delete",
      "--backup",
      "snapshot",
      "--yes",
      "--quiet"
    );
    assert.equal(absent.code, 0, absent.stderr);
    assert.equal(absent.stdout, "Backup already absent: snapshot\n");
    await rm(backupRoot, { recursive: true });
    const missingRoot = await runQuery(
      configPath,
      "delete",
      "--backup",
      "snapshot",
      "--yes"
    );
    assert.equal(missingRoot.code, 1);
  });
});

test(
  "failed removal reports possible partial deletion and releases its guard",
  { skip: process.getuid?.() === 0 },
  async () => {
    await withQueryFixture(async ({ backupRoot }) => {
      const target = await writeFixtureBackup(backupRoot, "locked");
      await chmod(target, 0o500);
      try {
        await assert.rejects(
          deleteBackup(backupRoot, "locked"),
          /files may already have been removed/
        );
        assert.equal(
          (await readdir(backupRoot)).some((name) => name.endsWith(".guard")),
          false
        );
      } finally {
        await chmod(target, 0o700);
      }
      assert.equal(await deleteBackup(backupRoot, "locked"), "deleted");
    });
  }
);

test("configured root symlinks resolve to the same creation and deletion guards", async () => {
  await withQueryFixture(async ({ backupRoot, root }) => {
    const alias = path.join(root, "alias");
    await symlink(backupRoot, alias);
    const release = await beginBackupCreation(
      alias,
      "snapshot",
      "production",
      []
    );
    try {
      await assert.rejects(
        deleteBackup(backupRoot, "snapshot"),
        /creation is active/
      );
    } finally {
      await release();
    }
    assert.equal(await deleteBackup(alias, "snapshot"), "deleted");
  });
});

test("interactive deletion confirms even an absent name before a concurrent backup can appear", async () => {
  await withQueryFixture(async ({ backupRoot, configPath }) => {
    const config = await loadConfig(configPath);
    let prompted = false;
    await assert.rejects(
      backupDelete(
        config,
        { backup: "absent", yes: false, outputMode: "default" },
        {
          interactive: () => true,
          write: () => {},
          confirm: async () => {
            prompted = true;
            await writeFixtureBackup(backupRoot, "absent");
            return false;
          }
        }
      ),
      /cancelled/
    );
    assert.equal(prompted, true);
    assert.ok((await readdir(backupRoot)).includes("absent"));
  });
});

test("deletion rechecks symlinks introduced while the confirmation is open", async () => {
  await withQueryFixture(async ({ backupRoot, configPath, root }) => {
    const config = await loadConfig(configPath);
    const directory = await writeFixtureBackup(backupRoot, "snapshot");
    await assert.rejects(
      backupDelete(
        config,
        { backup: "snapshot", yes: false, outputMode: "default" },
        {
          interactive: () => true,
          write: () => {},
          confirm: async () => {
            await rm(directory, { recursive: true });
            await symlink(root, directory);
            return true;
          }
        }
      ),
      /real directory/
    );
    assert.ok((await readdir(root)).includes("config.json"));
  });
});

test("case aliases cannot bypass a live creation marker or deletion guard", async () => {
  await withQueryFixture(async ({ backupRoot }) => {
    const release = await beginBackupCreation(
      backupRoot,
      "Snapshot",
      "production",
      []
    );
    try {
      const aliasExists = await lstat(path.join(backupRoot, "snapshot")).then(
        () => true,
        () => false
      );
      if (aliasExists)
        await assert.rejects(
          deleteBackup(backupRoot, "snapshot"),
          /creation is active/
        );
      else assert.equal(await deleteBackup(backupRoot, "snapshot"), "absent");
    } finally {
      await release();
    }
    const guard = deletionGuardPath(backupRoot, "Snapshot");
    await writeFile(guard, "");
    try {
      await assert.rejects(
        beginBackupCreation(backupRoot, "snapshot", "production", []),
        /deletion/
      );
    } finally {
      await rm(guard);
    }
  });
});

test("existing exact-case markers keep live backups protected and stale ones removable", async () => {
  await withQueryFixture(async ({ backupRoot }) => {
    const name = "BeforeMaintenance";
    await mkdir(path.join(backupRoot, name));
    // This is the persisted marker format from the parent commit.
    const marker = path.join(
      backupRoot,
      `.dbh-creating-${createHash("sha256").update(name).digest("hex")}.json`
    );
    const activity = {
      pid: process.pid,
      hostname: hostname(),
      sourceEnvironment: "production",
      startedAt: new Date().toISOString(),
      tags: ["legacy"]
    };
    await writeFile(marker, JSON.stringify(activity));
    assert.equal(
      (await readBackupActivity(backupRoot, name))?.pid,
      process.pid
    );
    await assert.rejects(deleteBackup(backupRoot, name), /creation is active/);
    const aliasExists = await lstat(
      path.join(backupRoot, name.toLowerCase())
    ).then(
      () => true,
      () => false
    );
    if (aliasExists)
      await assert.rejects(
        deleteBackup(backupRoot, name.toLowerCase()),
        /creation is active/
      );
    await writeFile(marker, JSON.stringify({ ...activity, pid: 2147483647 }));
    assert.equal(
      await deleteBackup(backupRoot, aliasExists ? name.toLowerCase() : name),
      "deleted"
    );
    assert.deepEqual(await readdir(backupRoot), []);
  });
});

test("activity metadata stays scoped to the exact directory spelling", async () => {
  await withQueryFixture(async ({ backupRoot }) => {
    const release = await beginBackupCreation(
      backupRoot,
      "Snapshot",
      "production",
      ["repair"]
    );
    try {
      assert.equal(
        (await readBackupActivity(backupRoot, "Snapshot"))?.sourceEnvironment,
        "production"
      );
      assert.equal(await readBackupActivity(backupRoot, "snapshot"), null);
      // Catalog entries use actual directory spellings; an unrelated lowercase
      // directory on a case-sensitive filesystem must not inherit this state.
    } finally {
      await release();
    }
  });
});
