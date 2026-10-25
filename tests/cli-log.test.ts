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
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
