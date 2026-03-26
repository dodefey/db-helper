import test from "node:test";
import assert from "node:assert/strict";
import {
  AppConfig,
  EnvironmentConfig,
  EnvironmentId
} from "../src/config/types.js";
import {
  assertAllowedSyncPath,
  syncDatabase,
  SyncDependencies
} from "../src/commands/sync.js";

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

function buildAppConfig(defaultDropOnRestore: boolean): AppConfig {
  return {
    backupRoot: "/tmp/backups",
    tempRoot: "/tmp/db-helper",
    authSource: "admin",
    defaultDropOnRestore,
    environments: {
      development: buildEnvironment("development"),
      test: buildEnvironment("test"),
      production: buildEnvironment("production")
    }
  };
}

function createDependencies(overrides: Partial<SyncDependencies> = {}): {
  dependencies: SyncDependencies;
  calls: {
    promptMessages: string[];
    tempFiles: string[];
    dumps: Array<{ source: EnvironmentId; destination: string }>;
    restores: Array<{ target: EnvironmentId; archive: string; drop: boolean }>;
    unlinks: string[];
  };
} {
  const calls = {
    promptMessages: [] as string[],
    tempFiles: [] as string[],
    dumps: [] as Array<{ source: EnvironmentId; destination: string }>,
    restores: [] as Array<{
      target: EnvironmentId;
      archive: string;
      drop: boolean;
    }>,
    unlinks: [] as string[]
  };

  const dependencies: SyncDependencies = {
    async promptConfirm(message: string): Promise<boolean> {
      calls.promptMessages.push(message);
      return true;
    },
    createLocalTempFile(): string {
      const path = "/tmp/db-helper/test-sync.archive.gz";
      calls.tempFiles.push(path);
      return path;
    },
    async createArchiveBackup(env, _appConfig, destinationFile): Promise<void> {
      calls.dumps.push({ source: env.id, destination: destinationFile });
    },
    async restoreArchiveToEnvironment(
      env,
      _appConfig,
      archiveFile,
      options
    ): Promise<void> {
      calls.restores.push({
        target: env.id,
        archive: archiveFile,
        drop: options.drop
      });
    },
    async unlink(path: string): Promise<void> {
      calls.unlinks.push(path);
    },
    ...overrides
  };

  return { dependencies, calls };
}

test("assertAllowedSyncPath accepts all allowed sync directions", () => {
  assert.doesNotThrow(() => assertAllowedSyncPath("production", "development"));
  assert.doesNotThrow(() => assertAllowedSyncPath("production", "test"));
  assert.doesNotThrow(() => assertAllowedSyncPath("development", "test"));
  assert.doesNotThrow(() => assertAllowedSyncPath("test", "development"));
});

test("assertAllowedSyncPath rejects disallowed sync directions", () => {
  assert.throws(
    () => assertAllowedSyncPath("development", "production"),
    /Sync path not allowed/
  );
  assert.throws(
    () => assertAllowedSyncPath("test", "production"),
    /Sync path not allowed/
  );
  assert.throws(
    () => assertAllowedSyncPath("production", "production"),
    /Sync path not allowed/
  );
  assert.throws(
    () => assertAllowedSyncPath("development", "development"),
    /Sync path not allowed/
  );
  assert.throws(
    () => assertAllowedSyncPath("test", "test"),
    /Sync path not allowed/
  );
});

test("syncDatabase prompts before syncing when --yes is not provided", async () => {
  const { dependencies, calls } = createDependencies();

  await syncDatabase(
    buildAppConfig(false),
    { from: "production", to: "development", yes: false },
    dependencies
  );

  assert.deepEqual(calls.promptMessages, [
    "This will replace development with production. Continue?"
  ]);
  assert.equal(calls.dumps.length, 1);
  assert.equal(calls.restores.length, 1);
});

test("syncDatabase skips confirmation when --yes is provided", async () => {
  const { dependencies, calls } = createDependencies();

  await syncDatabase(
    buildAppConfig(false),
    { from: "production", to: "development", yes: true },
    dependencies
  );

  assert.deepEqual(calls.promptMessages, []);
  assert.equal(calls.dumps.length, 1);
  assert.equal(calls.restores.length, 1);
});

test("syncDatabase aborts when confirmation is declined", async () => {
  const { dependencies, calls } = createDependencies({
    async promptConfirm(message: string): Promise<boolean> {
      calls.promptMessages.push(message);
      return false;
    }
  });

  await assert.rejects(
    syncDatabase(
      buildAppConfig(false),
      { from: "production", to: "development", yes: false },
      dependencies
    ),
    /Sync cancelled\./
  );

  assert.equal(calls.dumps.length, 0);
  assert.equal(calls.restores.length, 0);
  assert.equal(calls.unlinks.length, 0);
});

test("syncDatabase forces drop semantics even when config default is false", async () => {
  const { dependencies, calls } = createDependencies();

  await syncDatabase(
    buildAppConfig(false),
    { from: "production", to: "development", yes: true },
    dependencies
  );

  assert.deepEqual(calls.restores, [
    {
      target: "development",
      archive: "/tmp/db-helper/test-sync.archive.gz",
      drop: true
    }
  ]);
});

test("syncDatabase rejects invalid paths before confirmation or dump work begins", async () => {
  const { dependencies, calls } = createDependencies();

  await assert.rejects(
    syncDatabase(
      buildAppConfig(true),
      { from: "development", to: "production", yes: false },
      dependencies
    ),
    /Sync path not allowed: development->production/
  );

  assert.deepEqual(calls.promptMessages, []);
  assert.equal(calls.dumps.length, 0);
  assert.equal(calls.restores.length, 0);
  assert.equal(calls.unlinks.length, 0);
});
