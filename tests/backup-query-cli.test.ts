import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  runQuery,
  withQueryFixture,
  writeFixtureBackup
} from "./backup-query-helpers.js";

test("JSON list is one document with stable metadata, typed measurements, and clean stdout with --log and --verbose", async () => {
  await withQueryFixture(async ({ backupRoot, configPath }) => {
    await writeFixtureBackup(backupRoot, "snapshot", {
      tags: ["tag,with,commas", "tag\twith\ttabs"],
      note: 'quoted "note"\nnext line'
    });
    const result = await runQuery(
      configPath,
      "list",
      "--json",
      "--log",
      "--verbose"
    );
    assert.equal(result.code, 0);
    const report = JSON.parse(result.stdout);
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.command, "backup.list");
    assert.equal(report.status, "ok");
    assert.ok(Number.isFinite(Date.parse(report.observedAt)));
    assert.equal(report.data.backups[0].archive.sizeBytes, 4097);
    assert.equal(
      typeof report.data.backups[0].diskUsage.allocatedBytes,
      "number"
    );
    assert.deepEqual(report.data.backups[0].manifest.tags, [
      "tag,with,commas",
      "tag\twith\ttabs"
    ]);
    assert.equal(
      report.data.backups[0].manifest.note,
      'quoted "note"\nnext line'
    );
    assert.equal(report.issues.length, 0);
    assert.ok(report.debugLogPath);
    assert.match(
      await readFile(report.debugLogPath, "utf8"),
      /Running backup list/
    );
    assert.ok(result.stderr.includes(report.debugLogPath));
    await rm(report.debugLogPath);
  });
});

test("JSON list returns partial data and exit 2 for damaged entries, including unclassifiable filtered entries", async () => {
  await withQueryFixture(async ({ backupRoot, configPath }) => {
    await writeFixtureBackup(backupRoot, "healthy");
    await writeFixtureBackup(backupRoot, "other", {
      sourceEnvironment: "development"
    });
    await mkdir(path.join(backupRoot, "unknown"));
    const result = await runQuery(
      configPath,
      "list",
      "--json",
      "--from",
      "production",
      "--quiet"
    );
    assert.equal(result.code, 2);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, "partial");
    assert.deepEqual(
      report.data.backups.map((entry: { name: string }) => entry.name),
      ["healthy", "unknown"]
    );
    assert.equal(report.data.backups[1].matchesFilters, null);
    assert.ok(
      report.issues.some(
        (issue: { code: string }) => issue.code === "MANIFEST_MISSING"
      )
    );
    await rm(report.debugLogPath);
  });
});

test("JSON list distinguishes empty results from a missing backup root", async () => {
  await withQueryFixture(async ({ backupRoot, configPath }) => {
    const empty = await runQuery(configPath, "list", "--json");
    assert.equal(empty.code, 0);
    assert.equal(JSON.parse(empty.stdout).data.backups.length, 0);
    await rm(backupRoot, { recursive: true });
    const missing = await runQuery(configPath, "list", "--json");
    assert.equal(missing.code, 1);
    const report = JSON.parse(missing.stdout);
    assert.equal(report.data.backupRoot.status, "missing");
    assert.equal(report.status, "error");
    assert.equal(report.issues[0].code, "ROOT_MISSING");
    await assert.rejects(access(backupRoot), { code: "ENOENT" });
    await rm(report.debugLogPath);
  });
});

test("JSON errors cover config failures, unsupported formats, flag mistakes, and mutually exclusive modes", async () => {
  await withQueryFixture(async ({ configPath }) => {
    for (const [subcommand, flags] of [
      ["list", ["--json", "--quuet"]],
      ["list", ["--json", "--quiet", "--verbose"]],
      ["list", ["--json", "--from"]],
      ["list", ["--json", "--from", "unknown-environment"]],
      ["list", ["--json", "--version"]],
      ["list", ["--json=true"]],
      ["list", ["--json", "unexpected"]],
      ["usage", ["--json", "--tag", "recovery"]],
      ["list", ["--json", "--help"]],
      ["create", ["--json"]]
    ] as const) {
      const result = await runQuery(configPath, subcommand, ...flags);
      assert.equal(result.code, 1);
      const report = JSON.parse(result.stdout);
      assert.equal(report.status, "error");
      assert.equal(report.data, null);
      assert.equal(report.issues[0].code, "INVALID_ARGUMENTS");
      if (report.debugLogPath) await rm(report.debugLogPath);
    }
    await writeFile(configPath, "{}");
    const failure = await runQuery(configPath, "usage", "--json");
    assert.equal(failure.code, 1);
    const report = JSON.parse(failure.stdout);
    assert.equal(report.issues[0].code, "CONFIG_ERROR");
    await rm(report.debugLogPath);
  });
});

test("quiet text listing keeps partial rows on stdout and issues on stderr", async () => {
  await withQueryFixture(async ({ backupRoot, configPath }) => {
    const directory = await writeFixtureBackup(backupRoot, "missing-archive");
    await rm(path.join(directory, "dump.archive.gz"));
    const result = await runQuery(configPath, "list", "--quiet");
    assert.equal(result.code, 2);
    assert.match(
      result.stdout,
      /^missing-archive\tproduction\t.+\trecovery\t\d+\n$/
    );
    assert.match(result.stderr, /ARCHIVE_MISSING/);
    const logPath = result.stderr.match(/Debug log saved: (.+)\n/)?.[1];
    assert.ok(logPath);
    await rm(logPath);
  });
});

test("usage JSON is local, reports shared capacity, and never creates a missing configured temp root", async () => {
  await withQueryFixture(async ({ backupRoot, tempRoot, configPath }) => {
    const result = await runQuery(configPath, "usage", "--json", "--log");
    assert.equal(result.code, 0);
    const report = JSON.parse(result.stdout);
    assert.equal(report.command, "backup.usage");
    assert.equal(report.status, "ok");
    assert.equal(report.data.sharedFilesystem, true);
    assert.equal(report.data.locations.length, 2);
    assert.ok(
      report.data.locations.every(
        (location: { filesystem: { availableBytes: number } }) =>
          typeof location.filesystem.availableBytes === "number"
      )
    );
    await rm(report.debugLogPath);
    await rm(tempRoot, { recursive: true });
    const partial = await runQuery(configPath, "usage", "--json");
    assert.equal(partial.code, 2);
    const incomplete = JSON.parse(partial.stdout);
    assert.equal(incomplete.data.locations[1].status, "missing");
    assert.equal(incomplete.data.locations[1].filesystem, null);
    assert.equal(incomplete.data.sharedFilesystem, null);
    await assert.rejects(access(tempRoot), { code: "ENOENT" });
    await rm(incomplete.debugLogPath);
    await rm(backupRoot, { recursive: true });
    const failed = await runQuery(configPath, "usage", "--json");
    assert.equal(failed.code, 1);
    assert.equal(JSON.parse(failed.stdout).status, "error");
    await rm(JSON.parse(failed.stdout).debugLogPath);
  });
});

test("usage supports default, quiet, and verbose text output", async () => {
  await withQueryFixture(async ({ configPath }) => {
    const normal = await runQuery(configPath, "usage");
    assert.equal(normal.code, 0);
    assert.match(normal.stdout, /backupRoot: .+\n +\S+ \S+ available/);
    assert.match(normal.stdout, /Both locations share a filesystem/);
    const quiet = await runQuery(configPath, "usage", "--quiet");
    const lines = quiet.stdout.trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(lines[0].split("\t").length, 7);
    assert.equal(lines[0].split("\t")[0], "backupRoot");
    const verbose = await runQuery(configPath, "usage", "--verbose");
    assert.match(verbose.stdout, /available bytes; \d+ free bytes/);
  });
});
