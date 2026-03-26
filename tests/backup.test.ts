import test from "node:test";
import assert from "node:assert/strict";
import {
  AppConfig,
  BackupManifest,
  EnvironmentConfig,
  EnvironmentId
} from "../src/config/types.js";
import { runBackupCreate, RunBackupCreateDependencies } from "../src/lib/backup.js";

function buildEnvironment(id: EnvironmentId): EnvironmentConfig {
  return {
    id,
    name: id,
    label: id,
    kind: "local",
    host: "localhost",
    mongoHost: "localhost",
    mongoPort: 27017,
    databaseName: id,
    mongoUser: "user",
    mongoPassword: "pass",
    authSource: "admin",
    isProduction: id === "production"
  };
}

function buildAppConfig(): AppConfig {
  return {
    backupRoot: "/tmp/db-helper-backups",
    tempRoot: "/tmp/db-helper",
    authSource: "admin",
    defaultDropOnRestore: false,
    environments: {
      development: buildEnvironment("development"),
      test: buildEnvironment("test"),
      production: buildEnvironment("production")
    }
  };
}

function createBackupDependencies(
  overrides: Partial<RunBackupCreateDependencies> = {}
): {
  dependencies: RunBackupCreateDependencies;
  calls: {
    ensuredDirs: string[];
    listedCollections: EnvironmentId[];
    countedCollections: Array<{ env: EnvironmentId; collections: string[] }>;
    archives: string[];
    manifests: BackupManifest[];
    ensuredArtifacts: string[];
  };
} {
  const calls = {
    ensuredDirs: [] as string[],
    listedCollections: [] as EnvironmentId[],
    countedCollections: [] as Array<{ env: EnvironmentId; collections: string[] }>,
    archives: [] as string[],
    manifests: [] as BackupManifest[],
    ensuredArtifacts: [] as string[]
  };

  const dependencies: RunBackupCreateDependencies = {
    async ensureDirectory(dirPath: string): Promise<void> {
      calls.ensuredDirs.push(dirPath);
    },
    buildBackupName(): string {
      return "2026-03-26T12-00-00-development";
    },
    archivePathForBackup(root: string, backupName: string): string {
      return `${root}/${backupName}/dump.archive.gz`;
    },
    async listCollections(env): Promise<string[]> {
      calls.listedCollections.push(env.id);
      return ["orders", "system.views", "customers"];
    },
    async getCollectionCounts(env, collections): Promise<Record<string, number>> {
      calls.countedCollections.push({ env: env.id, collections });
      return Object.fromEntries(collections.map((name) => [name, 1]));
    },
    async createArchiveBackup(_env, _appConfig, archiveFile): Promise<void> {
      calls.archives.push(archiveFile);
    },
    async writeBackupManifest(_backupRoot, manifest): Promise<void> {
      calls.manifests.push(manifest);
    },
    async ensureBackupArtifacts(_backupRoot, backupName): Promise<void> {
      calls.ensuredArtifacts.push(backupName);
    },
    async readBackup(_backupRoot, backupName) {
      return {
        name: backupName,
        path: `/tmp/db-helper-backups/${backupName}`,
        manifest: calls.manifests.at(-1)!
      };
    },
    ...overrides
  };

  return { dependencies, calls };
}

test("runBackupCreate builds a valid backup record", async () => {
  const { dependencies, calls } = createBackupDependencies();

  const record = await runBackupCreate(
    buildAppConfig(),
    {
      from: "development",
      note: "known-good",
      tags: ["known-good"]
    },
    dependencies
  );

  assert.equal(record.name, "2026-03-26T12-00-00-development");
  assert.deepEqual(calls.listedCollections, ["development"]);
  assert.deepEqual(calls.countedCollections, [
    { env: "development", collections: ["orders", "customers"] }
  ]);
  assert.equal(calls.archives[0], "/tmp/db-helper-backups/2026-03-26T12-00-00-development/dump.archive.gz");
  assert.equal(calls.manifests[0].sourceEnvironment, "development");
  assert.deepEqual(calls.manifests[0].collectionList, ["orders", "customers"]);
  assert.deepEqual(calls.manifests[0].tags, ["known-good"]);
  assert.deepEqual(calls.ensuredArtifacts, ["2026-03-26T12-00-00-development"]);
});
