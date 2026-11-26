import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { COLLECTION_ARCHIVE, writeBackupManifest } from "../src/lib/backups.js";
import { TOOL_VERSION } from "../src/version.js";

const execFileAsync = promisify(execFile);

function buildConfig(tempRoot: string, backupRoot: string): string {
  return JSON.stringify(
    {
      defaults: {
        authSource: "admin",
        defaultDropOnRestore: true
      },
      paths: {
        backupRoot,
        tempRoot
      },
      environments: {
        development: {
          label: "Development",
          kind: "local",
          host: "localhost",
          mongoHost: "localhost",
          mongoPort: 27017,
          databaseName: "development",
          mongoUser: "user",
          mongoPassword: "pass"
        },
        test: {
          label: "Test",
          kind: "local",
          host: "localhost",
          mongoHost: "localhost",
          mongoPort: 27017,
          databaseName: "test",
          mongoUser: "user",
          mongoPassword: "pass"
        },
        production: {
          label: "Production",
          kind: "local",
          host: "localhost",
          mongoHost: "localhost",
          mongoPort: 27017,
          databaseName: "production",
          mongoUser: "user",
          mongoPassword: "pass",
          isProduction: true
        }
      }
    },
    null,
    2
  );
}

async function runCli(
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv
): Promise<{
  stdout: string;
  stderr: string;
}> {
  return execFileAsync(
    path.join(cwd, "node_modules", ".bin", "tsx"),
    ["src/cli.ts", ...args],
    { cwd, env: { ...process.env, ...env } }
  );
}

async function runInteractiveCli(
  configPath: string,
  replies: ReadonlyArray<readonly [prompt: string, answer: string]>
) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "interactive", "--config", configPath],
    {
      env: { ...process.env, PATH: path.dirname(configPath) },
      timeout: 20_000
    }
  );
  const closed = once(child, "close");
  let stdout = "";
  let stderr = "";
  let nextReply = 0;
  let offset = 0;
  child.stdin.on("error", (error) => {
    stderr += error.message;
  });
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
    while (nextReply < replies.length) {
      const [prompt, answer] = replies[nextReply];
      const index = stdout.indexOf(prompt, offset);
      if (index === -1) break;
      offset = index + prompt.length;
      nextReply += 1;
      child.stdin.write(`${answer}\n`);
    }
    if (nextReply === replies.length && !child.stdin.writableEnded) {
      child.stdin.end();
    }
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const [code, signal] = await closed;
  assert.equal(signal, null, stdout + stderr);
  assert.equal(nextReply, replies.length, stdout + stderr);
  return { code, stdout, stderr };
}

test("interactive collection selection preserves leading and trailing spaces", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "dbh-interactive-collections-")
  );
  const config = path.join(root, "config.json");
  try {
    await writeFile(
      config,
      buildConfig(path.join(root, "temp"), path.join(root, "backups")),
      { mode: 0o600 }
    );
    const syncChoices = [
      ["Select a number: ", "5"],
      ["Select a number: ", "1"],
      ["Select a number: ", "2"]
    ] as const;
    const nextName = "Next collection name (leave blank to finish): ";
    const cancelled = await runInteractiveCli(config, [
      ...syncChoices,
      ["Collection name: ", " leading"],
      [nextName, "trailing "],
      [nextName, ""],
      ["Continue? [y/N]: ", "n"]
    ]);
    assert.equal(cancelled.code, 1);
    assert.match(cancelled.stderr, /Sync cancelled/);
    const logPath = cancelled.stderr.match(/Debug log saved: (.+\.log)/)?.[1];
    assert.ok(logPath);
    const log = await readFile(logPath, "utf8");
    assert.match(
      log,
      /Prompting for sync confirmation .*"collections":\[" leading","trailing "\]/
    );

    const invalid = await runInteractiveCli(config, [
      ...syncChoices,
      ["Collection name: ", "orders"],
      [nextName, " "],
      [nextName, "weather"],
      [nextName, ""]
    ]);
    assert.equal(invalid.code, 1);
    assert.match(invalid.stderr, /exact namespace filter: " "/);
    assert.doesNotMatch(invalid.stdout, /Continue\?/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI rejects ambiguous or incomplete collection selection before loading config", async () => {
  const cwd = path.resolve(".");
  const config = [
    "--config",
    path.join(tmpdir(), "dbh-missing-collection-test.json")
  ];
  await assert.rejects(
    runCli(
      ["sync", "collection", "--collections", "orders", "--yes", ...config],
      cwd
    ),
    /Use --collections=name1,name2 or repeat --collection/
  );
  await assert.rejects(
    runCli(
      ["restore", "collection", "--collections=orders,--yes", ...config],
      cwd
    ),
    /Collection names cannot start with --/
  );
  await assert.rejects(
    runCli(["restore", "collection", "--collection=--yes", ...config], cwd),
    /Collection names cannot start with --/
  );
  await assert.rejects(
    runCli(["sync", "collection", "--collection", "--yes", ...config], cwd),
    /Flag --collection requires a collection name/
  );
  await assert.rejects(
    runCli(["sync", "collection", "--yes", ...config], cwd),
    /Missing collection selection/
  );
  await assert.rejects(
    runCli(
      [
        "backup",
        "create",
        "--collections=orders",
        "--collection",
        "customers",
        ...config
      ],
      cwd
    ),
    /Use either one --collections=name1,name2 flag or repeat --collection/
  );
  await assert.rejects(
    runCli(["restore", "full", "--collections=orders", ...config], cwd),
    /--collections is supported by backup create, sync collection, and restore collection/
  );
  await assert.rejects(
    runCli(
      [
        "sync",
        "collection",
        "--collection",
        "orders",
        "--collection=orders",
        ...config
      ],
      cwd
    ),
    /Collection orders was selected more than once/
  );
  await assert.rejects(
    runCli(
      ["backup", "create", "--collections=orders,,customers", ...config],
      cwd
    ),
    /Flag --collections requires a collection name/
  );
});

test("backup create rejects malformed arguments before loading config", async () => {
  const cwd = path.resolve(".");
  const root = await mkdtemp(path.join(tmpdir(), "dbh-backup-arguments-"));
  try {
    const fullBackup = [
      "backup",
      "create",
      "--from",
      "development",
      "--config",
      path.join(root, "missing.json")
    ];
    await assert.rejects(
      runCli([...fullBackup, "--collectons", "orders"], cwd),
      /Unknown flag --collectons/
    );
    await assert.rejects(
      runCli([...fullBackup, "--__proto__", "orders"], cwd),
      /Unknown flag --__proto__/
    );
    await assert.rejects(
      runCli([...fullBackup, "orders"], cwd),
      /Unexpected positional arguments for backup create/
    );
    await assert.rejects(
      runCli([...fullBackup, "--quiet", "orders"], cwd),
      /Flag --quiet does not accept a value/
    );
    await assert.rejects(
      runCli([...fullBackup, "--quiet", "orders", "--quiet"], cwd),
      /Flag --quiet does not accept a value/
    );
    await assert.rejects(
      runCli([...fullBackup, "--tag", "--tag", "maintenance"], cwd),
      /Flag --tag requires a value/
    );
    await assert.rejects(
      runCli([...fullBackup, "--from", "", "--from", "development"], cwd),
      /Unexpected positional arguments for backup create/
    );
    await assert.rejects(
      runCli(
        ["backup", "create", "--from", "development", "--config", ""],
        cwd
      ),
      /Unexpected positional arguments for backup create/
    );
    await assert.rejects(
      runCli(["backup", "list", "--tag", "", "--tag", "maintenance"], cwd),
      /Unexpected positional arguments for backup query/
    );
    await assert.rejects(runCli(fullBackup, cwd), /No config found at/);
    await assert.rejects(
      runCli([...fullBackup, "--note", ""], cwd),
      /No config found at/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("guided recovery points to collection restore when only collection backups exist", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dbh-recover-collections-"));
  const backupRoot = path.join(root, "backups");
  const config = path.join(root, "config.json");
  const recover = () => runCli(["recover", "--config", config], process.cwd());

  try {
    await writeFile(config, buildConfig(path.join(root, "temp"), backupRoot), {
      mode: 0o600
    });
    await writeBackupManifest(backupRoot, {
      backupName: "selected",
      sourceEnvironment: "development",
      databaseName: "development",
      createdAt: "2026-01-01T00:00:00.000Z",
      archiveFile: COLLECTION_ARCHIVE,
      collectionList: ["orders"],
      collectionCounts: { orders: 1 },
      tags: ["known-clean"],
      toolVersion: TOOL_VERSION
    });

    await assert.rejects(recover(), {
      code: 1,
      stderr:
        /No full backups available for guided recovery\. Use dbh restore collection to restore selected collections\./
    });

    await rm(path.join(backupRoot, "selected"), { recursive: true });
    await assert.rejects(recover(), {
      code: 1,
      stderr: /No full backups available for guided recovery\.\r?\n/
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("quiet collection backup preserves archive inspection errors with credentials redacted", async () => {
  const cwd = path.resolve(".");
  const root = await mkdtemp(path.join(tmpdir(), "dbh-archive-inspection-"));
  const binRoot = path.join(root, "bin");
  const configPath = path.join(root, "config.json");
  const backupRoot = path.join(root, "backups");
  const tempRoot = path.join(root, "temp");

  try {
    await mkdir(binRoot);
    const fixture = `#!${process.execPath}
const fs = require("node:fs");
const tool = require("node:path").basename(process.argv[1]);
const args = process.argv.slice(2);
if (tool === "mongosh") {
  const script = args[args.indexOf("--eval") + 1];
  const marker = script.match(/__DBH_MONGOSH_RESULT__[a-f0-9-]+__/)[0];
  const result = script.includes("countDocuments")
    ? { orders: 1 }
    : { collections: ["orders"], selectedViews: [] };
  process.stdout.write(marker + JSON.stringify(result) + "\\n");
} else if (tool === "mongodump") {
  const archive = args.find((arg) => arg.startsWith("--archive="));
  fs.writeFileSync(archive.slice("--archive=".length), "malformed archive");
} else if (tool === "mongorestore" && args.includes("--dryRun")) {
  console.error("archive inspection failed: invalid gzip header for " + args[args.indexOf("--uri") + 1]);
  process.exitCode = 1;
} else {
  throw new Error("unexpected fixture command");
}
`;
    for (const tool of ["mongosh", "mongodump", "mongorestore"]) {
      await writeFile(path.join(binRoot, tool), fixture, { mode: 0o700 });
    }
    const config = JSON.parse(buildConfig(tempRoot, backupRoot));
    config.environments.development.mongoPassword = "fixture@archive-password";
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });

    let logPath: string | undefined;
    const password = /fixture(?:@|%40)archive-password/;
    const diagnostic = /archive inspection failed: invalid gzip header/;
    await assert.rejects(
      runCli(
        [
          "backup",
          "create",
          "--from",
          "development",
          "--name",
          "bad-archive",
          "--collections=orders",
          "--quiet",
          "--config",
          configPath
        ],
        cwd,
        { PATH: `${binRoot}${path.delimiter}${process.env.PATH ?? ""}` }
      ),
      (error: Error & { stdout: string; stderr: string }) => {
        assert.match(error.stderr, /Backup failed during archive creation/);
        assert.doesNotMatch(error.stdout + error.stderr, password);
        assert.match(error.stderr, diagnostic);
        assert.match(error.stderr, /mongodb:\/\/user:<redacted>@localhost/);
        logPath = error.stderr.match(/Debug log saved: (.+\.log)/)?.[1];
        return true;
      }
    );
    assert.ok(logPath);
    const log = await readFile(logPath, "utf8");
    assert.match(log, diagnostic);
    assert.doesNotMatch(log, password);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cli removes successful logs by default and keeps them with --log", async () => {
  const cwd = path.resolve(".");
  const tempDir = await mkdtemp(path.join(tmpdir(), "db-helper-cli-log-"));
  const tempRoot = path.join(tempDir, "temp-root");
  const backupRoot = path.join(tempDir, "backup-root");
  const configPath = path.join(tempDir, "config.json");

  try {
    await writeFile(configPath, buildConfig(tempRoot, backupRoot), "utf8");

    await runCli(["config", "validate", "--config", configPath], cwd);
    const noLogFiles = await readdir(path.join(tempRoot, "logs")).catch(
      () => []
    );
    assert.deepEqual(noLogFiles, []);

    const { stdout } = await runCli(
      ["config", "validate", "--config", configPath, "--log"],
      cwd
    );
    assert.match(stdout, /Debug log saved: .+\.log/);
    const savedPath = stdout.match(/Debug log saved: (.+\.log)/)?.[1];
    assert.ok(savedPath);
    const savedContent = await readFile(savedPath!, "utf8");
    assert.match(savedContent, /Running config validate/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("cli preserves failure logs and reports the path without --log", async () => {
  const cwd = path.resolve(".");
  const tempDir = await mkdtemp(path.join(tmpdir(), "db-helper-cli-fail-"));
  const tempRoot = path.join(tempDir, "temp-root");
  const backupRoot = path.join(tempDir, "backup-root");
  const configPath = path.join(tempDir, "config.json");

  try {
    await writeFile(configPath, buildConfig(tempRoot, backupRoot), "utf8");

    await assert.rejects(
      runCli(
        [
          "sync",
          "--from",
          "missing",
          "--to",
          "development",
          "--config",
          configPath
        ],
        cwd
      ),
      (error: NodeJS.ErrnoException & { stderr?: string }) => {
        assert.match(error.stderr ?? "", /Unknown environment --from: missing/);
        assert.match(error.stderr ?? "", /Debug log saved: .+\.log/);
        return true;
      }
    );

    await assert.rejects(
      runCli(
        [
          "sync",
          "--from",
          "development",
          "--to",
          "missing",
          "--config",
          configPath
        ],
        cwd
      ),
      (error: NodeJS.ErrnoException & { stderr?: string }) => {
        assert.match(error.stderr ?? "", /Unknown environment --to: missing/);
        assert.match(error.stderr ?? "", /Debug log saved: .+\.log/);
        return true;
      }
    );

    const logFiles = await readdir(path.join(tempRoot, "logs"));
    assert.equal(logFiles.length, 2);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("cli prints grouped help without loading config", async () => {
  const cwd = path.resolve(".");

  const version = await runCli(["--version"], cwd);
  assert.equal(version.stdout, `dbh ${TOOL_VERSION}\n`);
  assert.equal(version.stderr, "");

  const configHelp = await runCli(["config", "--help"], cwd);
  assert.match(configHelp.stdout, /dbh config/);
  assert.match(configHelp.stdout, /Purpose:/);
  assert.match(
    configHelp.stdout,
    /config show \[--config <path>] \[--unredacted]/
  );
  assert.match(configHelp.stdout, /config show defaults to redacted output/);

  const backupHelp = await runCli(["backup", "--help"], cwd);
  assert.match(backupHelp.stdout, /dbh backup/);
  assert.match(
    backupHelp.stdout,
    /backup create --from <environment> \[--name <name>]/
  );
  assert.match(backupHelp.stdout, /Required flags:/);
  assert.match(backupHelp.stdout, /Interrupted backups should not be trusted/);

  const syncHelp = await runCli(["sync", "--help"], cwd);
  assert.match(syncHelp.stdout, /dbh sync/);
  assert.match(syncHelp.stdout, /sync collection --from <environment>/);
  assert.match(syncHelp.stdout, /Full sync overwrites the target/);

  const restoreHelp = await runCli(["restore", "--help"], cwd);
  assert.match(restoreHelp.stdout, /dbh restore/);
  assert.match(restoreHelp.stdout, /restore full --backup <backup-name>/);
  assert.match(
    restoreHelp.stdout,
    /Targets marked isProduction require --force-production-restore/
  );

  const help = await runCli(["--help"], cwd);
  assert.match(help.stdout, /--version/);
});

test("doctor CLI failure redacts credentials and retains a private log", async () => {
  const cwd = path.resolve(".");
  const root = await mkdtemp(path.join(tmpdir(), "db-helper-doctor-private-"));
  const binRoot = path.join(root, "bin");
  const tempRoot = path.join(root, "temp");
  const backupRoot = path.join(root, "backups");
  const configPath = path.join(root, "config.json");

  try {
    await mkdir(binRoot);
    const fixture = `#!${process.execPath}
const path = require("node:path");
const name = path.basename(process.argv[1]);
if (name === "mongosh" && !process.argv.includes("--version")) {
  console.error("Synthetic connection failure: " + process.argv[2]);
  process.exit(17);
}
console.log(name === "mongosh" ? "2.9.2" : "100.16.1");
`;
    for (const name of ["mongosh", "mongodump", "mongorestore", "ssh", "scp"]) {
      await writeFile(path.join(binRoot, name), fixture, { mode: 0o700 });
    }
    const config = JSON.parse(buildConfig(tempRoot, backupRoot));
    config.environments = { development: config.environments.development };
    config.environments.development.mongoPassword =
      "synthetic@private-password";
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });

    let logPath: string | undefined;
    await assert.rejects(
      runCli(["doctor", "--config", configPath], cwd, {
        PATH: `${binRoot}${path.delimiter}${process.env.PATH ?? ""}`,
        MONGOSH_CONFIG_DIR: path.join(root, "mongosh-state")
      }),
      (error: Error & { stdout?: string; stderr?: string }) => {
        const terminal = `${error.stdout ?? ""}${error.stderr ?? ""}`;
        assert.match(terminal, /Doctor checks failed: 1 issue\(s\)/);
        assert.match(terminal, /Synthetic connection failure/);
        assert.match(terminal, /mongodb:\/\/user:<redacted>@localhost/);
        assert.doesNotMatch(terminal, /synthetic(?:@|%40)private-password/);
        logPath = terminal.match(/Debug log saved: (.+\.log)/)?.[1];
        return true;
      }
    );
    assert.ok(logPath);
    assert.equal((await stat(logPath)).mode & 0o777, 0o600);
    const log = await readFile(logPath, "utf8");
    assert.match(log, /Synthetic connection failure/);
    assert.doesNotMatch(log, /synthetic(?:@|%40)private-password/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
