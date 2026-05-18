import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

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
          mongoPassword: "pass"
        }
      }
    },
    null,
    2
  );
}

async function runCli(
  args: string[],
  cwd: string
): Promise<{
  stdout: string;
  stderr: string;
}> {
  return execFileAsync(
    path.join(cwd, "node_modules", ".bin", "tsx"),
    ["src/cli.ts", ...args],
    { cwd }
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
          "development",
          "--to",
          "production",
          "--config",
          configPath
        ],
        cwd
      ),
      (error: NodeJS.ErrnoException & { stderr?: string }) => {
        assert.match(error.stderr ?? "", /Sync path not allowed/);
        assert.match(error.stderr ?? "", /Debug log saved: .+\.log/);
        return true;
      }
    );

    const logFiles = await readdir(path.join(tempRoot, "logs"));
    assert.equal(logFiles.length, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
