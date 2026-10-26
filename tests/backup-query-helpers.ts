import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BackupManifest } from "../src/config/types.js";

const execFileAsync = promisify(execFile);

export async function withQueryFixture(
  run: (fixture: {
    root: string;
    backupRoot: string;
    tempRoot: string;
    configPath: string;
  }) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "dbh-backup-query-"));
  const backupRoot = path.join(root, "backups");
  const tempRoot = path.join(root, "temp");
  const configPath = path.join(root, "config.json");
  try {
    await mkdir(backupRoot);
    await mkdir(tempRoot);
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
        paths: { backupRoot, tempRoot },
        environments: { production: environment, development: environment }
      })
    );
    await run({ root, backupRoot, tempRoot, configPath });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function writeFixtureBackup(
  backupRoot: string,
  name: string,
  overrides: Partial<BackupManifest> = {}
): Promise<string> {
  const directory = path.join(backupRoot, name);
  await mkdir(directory);
  const manifest: BackupManifest = {
    backupName: name,
    sourceEnvironment: "production",
    databaseName: "fixture",
    createdAt: "2026-10-25T12:34:56.789Z",
    tags: ["recovery"],
    note: "fixture note",
    collectionList: ["orders"],
    collectionCounts: { orders: 2 },
    toolVersion: "test",
    archiveFile: "dump.archive.gz",
    ...overrides
  };
  await writeFile(
    path.join(directory, "manifest.json"),
    JSON.stringify(manifest)
  );
  await writeFile(
    path.join(directory, "dump.archive.gz"),
    Buffer.alloc(4097, 1)
  );
  return directory;
}

export async function runQuery(
  configPath: string,
  subcommand: string,
  ...flags: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli.ts",
        "backup",
        subcommand,
        "--config",
        configPath,
        ...flags
      ],
      { cwd: path.resolve(".") }
    );
    return { code: 0, ...result };
  } catch (error) {
    const result = error as { code: number; stdout: string; stderr: string };
    if (typeof result.code !== "number") throw error;
    return result;
  }
}
