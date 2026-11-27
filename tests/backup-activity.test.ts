import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  activityPath,
  createBackupArchiveCommand,
  deletionGuardPath,
  beginBackupCreation,
  readBackupActivity
} from "../src/lib/backupActivity.js";
import { collectBackupCatalog } from "../src/lib/backupCatalog.js";
import { deleteBackup } from "../src/lib/backupDelete.js";
import { executeBackupPrune, planBackupPrune } from "../src/lib/backupPrune.js";
import { backupPrune } from "../src/commands/backupPrune.js";
import { loadConfig } from "../src/config/loadConfig.js";
import {
  withQueryFixture,
  writeFixtureBackup,
  runQuery
} from "./backup-query-helpers.js";

async function waitForFixture(
  condition: () => Promise<boolean>,
  description: string
): Promise<void> {
  const deadline = Date.now() + 15000;
  while (!(await condition())) {
    assert.ok(Date.now() < deadline, description);
    await delay(15);
  }
}

function withOrphanWriter(
  pidRecord: "complete" | "partial",
  run: (fixture: {
    backupRoot: string;
    configPath: string;
    name: string;
    crashCreator: () => Promise<void>;
    stopWriter: () => Promise<void>;
  }) => Promise<void>
): Promise<void> {
  return withQueryFixture(async ({ root, backupRoot, configPath }) => {
    const name = "writing";
    const bin = path.join(root, "bin");
    const ready = path.join(root, "writer-ready");
    const stop = path.join(root, "writer-stop");
    const archive = path.join(backupRoot, name, "dump.archive.gz");
    await mkdir(bin);
    await writeFile(
      path.join(bin, "mongosh"),
      `#!${process.execPath}
const marker = process.argv.at(-1).match(/__DBH_MONGOSH_RESULT__[a-f0-9-]+__/)[0];
console.log(marker + "[]");
`,
      { mode: 0o700 }
    );
    await writeFile(
      path.join(bin, "mongodump"),
      `#!${process.execPath}
const fs = require("node:fs");
const archive = process.argv.find((arg) => arg.startsWith("--archive=")).slice(10);
const deadline = Date.now() + 60000;
fs.writeFileSync(archive, "starting");
fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));
const writer = setInterval(() => {
  if (fs.existsSync(${JSON.stringify(stop)}) || Date.now() >= deadline) {
    clearInterval(writer);
    return;
  }
  fs.appendFileSync(archive, " writing");
}, 20);
`,
      { mode: 0o700 }
    );
    const preloadArgs: string[] = [];
    if (pidRecord === "partial") {
      const preload = path.join(root, "partial-pid.mjs");
      await writeFile(
        preload,
        `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const write = fs.writeFileSync;
fs.writeFileSync = (file, data, ...options) => {
  if (typeof file === "number" && typeof data === "string" && /^[0-9]+\\n$/.test(data)) {
    // Leave the newline unwritten and hold dbh here until the test terminates it.
    write(file, data.trim(), ...options);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
    write(file, "\\n", ...options);
    return;
  }
  return write(file, data, ...options);
};
syncBuiltinESMExports();
`
      );
      preloadArgs.push("--import", preload);
    }
    let writerPid: number | undefined;
    const crashCreator = async () => {
      const creator = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          ...preloadArgs,
          "src/cli.ts",
          "backup",
          "create",
          "--config",
          configPath,
          "--from",
          "production",
          "--name",
          name,
          "--quiet"
        ],
        {
          env: {
            ...process.env,
            PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`
          },
          stdio: "ignore"
        }
      );
      const creatorExit = once(creator, "exit");
      try {
        await waitForFixture(
          () =>
            readFile(ready, "utf8").then(
              (value) => /^\d+$/.test(value),
              () => false
            ),
          "archive writer did not start"
        );
        writerPid = Number(await readFile(ready, "utf8"));
        const writerMarker = `${activityPath(backupRoot, name)}.writer`;
        const expectedRecord =
          pidRecord === "partial" ? String(writerPid) : `${writerPid}\n`;
        await waitForFixture(
          () =>
            readFile(writerMarker, "utf8").then(
              (value) => value === expectedRecord
            ),
          "writer PID record did not reach the expected state"
        );
        assert.ok(creator.kill("SIGKILL"));
        assert.deepEqual(await creatorExit, [null, "SIGKILL"]);
        const contentAtExit = await readFile(archive, "utf8");
        await waitForFixture(
          async () =>
            (await readFile(archive, "utf8")).length > contentAtExit.length,
          "archive writer did not append after dbh exited"
        );
      } finally {
        if (creator.exitCode === null && creator.signalCode === null)
          creator.kill("SIGKILL");
        await creatorExit;
      }
    };
    const stopWriter = async () => {
      await writeFile(stop, "");
      const pid = writerPid;
      if (pid === undefined) return;
      await waitForFixture(async () => {
        try {
          process.kill(pid, 0);
          return false;
        } catch (error) {
          assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
          return true;
        }
      }, "archive writer did not exit");
      writerPid = undefined;
    };
    try {
      await run({ backupRoot, configPath, name, crashCreator, stopWriter });
    } finally {
      await stopWriter();
    }
  });
}

test("delete and prune protect a live archive writer after its dbh process exits", async () => {
  await withOrphanWriter(
    "complete",
    async ({ backupRoot, name, crashCreator, stopWriter }) => {
      const directory = await writeFixtureBackup(backupRoot, name, {
        createdAt: "2026-10-24T00:00:00.000Z"
      });
      const manifest = path.join(directory, "manifest.json");
      const manifestContent = await readFile(manifest, "utf8");
      await writeFixtureBackup(backupRoot, "retained");
      const preview = await planBackupPrune(backupRoot, 1);
      assert.deepEqual(
        preview.remove.map((backup) => backup.name),
        [name]
      );
      await rm(directory, { recursive: true });
      await crashCreator();

      await assert.rejects(
        deleteBackup(backupRoot, name),
        /Backup archive writer is active/
      );

      // Make the fixture look complete so pruning must check writer liveness.
      await writeFile(manifest, manifestContent);
      const prune = await planBackupPrune(backupRoot, 1);
      assert.deepEqual(prune.remove, []);
      assert.deepEqual(prune.skip, [
        {
          name,
          environment: "production",
          reason: `Backup archive writer is active: ${name}`
        }
      ]);
      await assert.rejects(
        executeBackupPrune(preview),
        /Backup archive writer is active/
      );
      assert.ok((await readdir(directory)).includes("dump.archive.gz"));

      await stopWriter();
      assert.equal(await deleteBackup(backupRoot, name), "deleted");
      assert.deepEqual(await readdir(backupRoot), ["retained"]);
    }
  );
});

test("confirming prune refuses a writer whose dbh exited before recording the full PID", async () => {
  await withOrphanWriter(
    "partial",
    async ({ backupRoot, configPath, name, crashCreator }) => {
      const directory = await writeFixtureBackup(backupRoot, name, {
        createdAt: "2026-10-24T00:00:00.000Z"
      });
      const retained = await writeFixtureBackup(backupRoot, "retained");
      const retainedManifest = path.join(retained, "manifest.json");
      const original = await readFile(retainedManifest, "utf8");
      const config = await loadConfig(configPath);
      let preview = "";
      await assert.rejects(
        backupPrune(
          config,
          { keepLast: 1, dryRun: false, yes: false, outputMode: "default" },
          {
            interactive: () => true,
            write: (text) => {
              preview += text;
            },
            confirm: async () => {
              assert.ok(preview.includes(`  DELETE ${name} (`));
              await rm(directory, { recursive: true });
              await crashCreator();
              return true;
            }
          }
        ),
        /Prune stopped\. Deleted 0: none\..*Cannot verify backup archive writer has stopped/
      );
      assert.equal(await readFile(retainedManifest, "utf8"), original);
      assert.ok((await readdir(directory)).includes("dump.archive.gz"));
      assert.ok(
        (await readdir(backupRoot)).every((entry) => !entry.endsWith(".guard"))
      );
    }
  );
});

test("interrupting a tracked writer waits for it to close before releasing the marker", async () => {
  await withQueryFixture(async ({ root, backupRoot }) => {
    const name = "interrupted";
    const release = await beginBackupCreation(
      backupRoot,
      name,
      "production",
      []
    );
    const ready = path.join(root, "ready");
    const closed = path.join(root, "closed");
    const signal = new AbortController();
    const run = createBackupArchiveCommand(backupRoot, name);
    const interrupted = assert.rejects(
      run(
        process.execPath,
        [
          "-e",
          `const fs = require("node:fs");
        const keepAlive = setTimeout(() => process.exit(1), 5000);
        process.on("SIGINT", () => {
          setTimeout(() => {
            fs.writeFileSync(process.argv[2], "finished");
            clearTimeout(keepAlive);
          }, 100);
        });
        fs.writeFileSync(process.argv[1], "ready");`,
          ready,
          closed
        ],
        { signal: signal.signal, streamOutput: false }
      ),
      /Command interrupted/
    );
    try {
      await waitForFixture(
        () =>
          readFile(ready).then(
            () => true,
            () => false
          ),
        "archive writer did not install its signal handler"
      );
      signal.abort();
      await interrupted;
      assert.equal(await readFile(closed, "utf8"), "finished");
      assert.deepEqual(
        (await readdir(backupRoot)).sort(),
        [path.basename(activityPath(backupRoot, name)), name].sort()
      );
    } finally {
      signal.abort();
      await interrupted;
      await release();
    }
  });
});

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

test(
  "macOS list and delete recognize a creation marker after a hostname change",
  {
    skip: process.platform !== "darwin"
  },
  async () => {
    await withQueryFixture(async ({ backupRoot, configPath }) => {
      const name = "renamed-host";
      const release = await beginBackupCreation(
        backupRoot,
        name,
        "production",
        []
      );
      const marker = activityPath(backupRoot, name);
      try {
        const original = JSON.parse(await readFile(marker, "utf8"));
        assert.match(original.machineId, /^[a-f0-9]{64}$/);
        const activity = {
          ...original,
          hostname: `previous-${original.hostname}`
        };
        await writeFile(marker, JSON.stringify(activity));

        const list = await runQuery(configPath, "list", "--json");
        assert.equal(list.code, 0, list.stderr);
        const report = JSON.parse(list.stdout);
        assert.deepEqual(report.issues, []);
        assert.deepEqual(report.data.backups[0].inProgress, {
          pid: process.pid,
          hostname: activity.hostname,
          sourceEnvironment: "production",
          startedAt: original.startedAt,
          tags: []
        });

        const active = await runQuery(
          configPath,
          "delete",
          "--backup",
          name,
          "--yes"
        );
        assert.equal(active.code, 1);
        assert.match(active.stderr, /Backup creation is active/);
        assert.ok((await readdir(backupRoot)).includes(name));

        await writeFile(
          marker,
          JSON.stringify({ ...activity, pid: 2147483647 })
        );
        const stopped = await runQuery(
          configPath,
          "delete",
          "--backup",
          name,
          "--yes"
        );
        assert.equal(stopped.code, 0, stopped.stderr);
        assert.deepEqual(await readdir(backupRoot), []);
      } finally {
        await release();
      }
    });
  }
);

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
        JSON.stringify({
          ...active,
          hostname: "different-host",
          machineId: undefined
        }),
        JSON.stringify({ ...active, machineId: "0".repeat(64) }),
        JSON.stringify({ ...active, machineId: null }),
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

test("setup guard cleanup failure removes only a newly created empty directory", async () => {
  await withQueryFixture(async ({ backupRoot }) => {
    const original = fs.rm;
    const guard = deletionGuardPath(backupRoot, "retry");
    fs.rm = async (file, options) => {
      if (String(file) === guard)
        throw new Error("injected guard cleanup failure");
      return original(file, options);
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        beginBackupCreation(backupRoot, "retry", "production", []),
        /guard cleanup failed/
      );
      assert.deepEqual(await readdir(backupRoot), [path.basename(guard)]);
    } finally {
      fs.rm = original;
      syncBuiltinESMExports();
      await rm(guard);
    }
    const release = await beginBackupCreation(
      backupRoot,
      "retry",
      "production",
      []
    );
    await release();
    await writeFile(path.join(backupRoot, "retry", "keep"), "preserved");
    await assert.rejects(
      beginBackupCreation(backupRoot, "retry", "production", []),
      /EEXIST/
    );
    assert.equal(
      await readFile(path.join(backupRoot, "retry", "keep"), "utf8"),
      "preserved"
    );
  });
});
