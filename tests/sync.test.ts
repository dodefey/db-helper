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
import { parseOutputMode } from "../src/lib/output.js";
import { runSync, RunSyncDependencies } from "../src/lib/sync.js";

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
    runSyncCalls: Array<{
      from: EnvironmentId;
      to: EnvironmentId;
      outputMode: "default" | "quiet" | "verbose";
    }>;
  };
} {
  const calls = {
    promptMessages: [] as string[],
    runSyncCalls: [] as Array<{
      from: EnvironmentId;
      to: EnvironmentId;
      outputMode: "default" | "quiet" | "verbose";
    }>
  };

  const dependencies: SyncDependencies = {
    async promptConfirm(message: string): Promise<boolean> {
      calls.promptMessages.push(message);
      return true;
    },
    async runSync(_appConfig, input): Promise<void> {
      calls.runSyncCalls.push(input);
    },
    ...overrides
  };

  return { dependencies, calls };
}

function createRunSyncDependencies(
  overrides: Partial<RunSyncDependencies> = {}
): {
  dependencies: RunSyncDependencies;
  calls: {
    output: string[];
    tempFiles: string[];
    listedCollections: EnvironmentId[];
    countedCollections: Array<{ env: EnvironmentId; collections: string[] }>;
    dumps: Array<{ source: EnvironmentId; destination: string }>;
    restores: Array<{ target: EnvironmentId; archive: string; drop: boolean }>;
    verifications: EnvironmentId[];
    unlinks: string[];
    interruptHandler?: () => void;
  };
} {
  const calls = {
    output: [] as string[],
    tempFiles: [] as string[],
    listedCollections: [] as EnvironmentId[],
    countedCollections: [] as Array<{
      env: EnvironmentId;
      collections: string[];
    }>,
    dumps: [] as Array<{ source: EnvironmentId; destination: string }>,
    restores: [] as Array<{
      target: EnvironmentId;
      archive: string;
      drop: boolean;
    }>,
    verifications: [] as EnvironmentId[],
    unlinks: [] as string[],
    interruptHandler: undefined as (() => void) | undefined
  };

  const dependencies: RunSyncDependencies = {
    writeStdout(message: string): void {
      calls.output.push(message);
    },
    isInteractiveStdout(): boolean {
      return false;
    },
    installInterruptHandler(onInterrupt: () => void): () => void {
      calls.interruptHandler = onInterrupt;
      return () => {
        calls.interruptHandler = undefined;
      };
    },
    async runWithElapsedStatus<T>(
      baseMessage: string,
      task: () => Promise<T>
    ): Promise<T> {
      calls.output.push(`${baseMessage}\n`);
      return task();
    },
    createLocalTempFile(): string {
      const path = "/tmp/db-helper/test-sync.archive.gz";
      calls.tempFiles.push(path);
      return path;
    },
    async listCollections(env): Promise<string[]> {
      calls.listedCollections.push(env.id);
      return ["orders", "customers"];
    },
    async getCollectionCounts(
      env,
      collections
    ): Promise<Record<string, number>> {
      calls.countedCollections.push({ env: env.id, collections });
      return Object.fromEntries(collections.map((name) => [name, 1]));
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
    async verifyRestore(env, manifest, options): Promise<{
      collectionsPresent: string[];
      missingCollections: string[];
      countMismatches: Array<{
        collection: string;
        expected: number;
        actual: number;
      }>;
    }> {
      calls.verifications.push(env.id);
      const collections = manifest.collectionCounts
        ? Object.keys(manifest.collectionCounts)
        : [];
      collections.forEach((collection, index) => {
        options?.onCountedCollection?.({
          completed: index + 1,
          total: collections.length,
          collection
        });
      });
      return {
        collectionsPresent: ["orders", "customers"],
        missingCollections: [],
        countMismatches: []
      };
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
    {
      from: "production",
      to: "development",
      yes: false,
      outputMode: "default"
    },
    dependencies
  );

  assert.deepEqual(calls.promptMessages, [
    "This will replace development with production. Continue?"
  ]);
  assert.deepEqual(calls.runSyncCalls, [
    { from: "production", to: "development", outputMode: "default" }
  ]);
});

test("syncDatabase skips confirmation when --yes is provided", async () => {
  const { dependencies, calls } = createDependencies();

  await syncDatabase(
    buildAppConfig(false),
    {
      from: "production",
      to: "development",
      yes: true,
      outputMode: "default"
    },
    dependencies
  );

  assert.deepEqual(calls.promptMessages, []);
  assert.deepEqual(calls.runSyncCalls, [
    { from: "production", to: "development", outputMode: "default" }
  ]);
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
      {
        from: "production",
        to: "development",
        yes: false,
        outputMode: "default"
      },
      dependencies
    ),
    /Sync cancelled\./
  );

  assert.equal(calls.runSyncCalls.length, 0);
});

test("syncDatabase delegates execution to runSync", async () => {
  const { dependencies, calls } = createDependencies();

  await syncDatabase(
    buildAppConfig(false),
    {
      from: "production",
      to: "development",
      yes: true,
      outputMode: "default"
    },
    dependencies
  );

  assert.deepEqual(calls.runSyncCalls, [
    { from: "production", to: "development", outputMode: "default" }
  ]);
});

test("syncDatabase rejects invalid paths before confirmation or dump work begins", async () => {
  const { dependencies, calls } = createDependencies();

  await assert.rejects(
    syncDatabase(
      buildAppConfig(true),
      {
        from: "development",
        to: "production",
        yes: false,
        outputMode: "default"
      },
      dependencies
    ),
    /Sync path not allowed: development->production/
  );

  assert.deepEqual(calls.promptMessages, []);
  assert.equal(calls.runSyncCalls.length, 0);
});

test("parseOutputMode rejects quiet and verbose together", () => {
  assert.throws(
    () => parseOutputMode({ quiet: true, verbose: true }),
    /Flags --quiet and --verbose cannot be used together/
  );
});

test("runSync suppresses summary output in quiet mode", async () => {
  const { dependencies, calls } = createRunSyncDependencies();

  await runSync(
    buildAppConfig(false),
    { from: "production", to: "development", outputMode: "quiet" },
    dependencies
  );

  assert.deepEqual(calls.output, []);
  assert.deepEqual(calls.verifications, ["development"]);
  assert.deepEqual(calls.countedCollections, [
    { env: "production", collections: ["orders", "customers"] }
  ]);
});

test("runSync preserves summary output in default mode", async () => {
  const { dependencies, calls } = createRunSyncDependencies();

  await runSync(
    buildAppConfig(false),
    { from: "production", to: "development", outputMode: "default" },
    dependencies
  );

  assert.deepEqual(calls.output, [
    "Starting sync production -> development\n",
    "Dumping source production...\n",
    "Restoring target development...\n",
    "Verifying target development...\n",
    "Checking collection presence...\n",
    "Checking collection counts...\n",
    "Checked collection counts: 1/2 (orders)\n",
    "Checked collection counts: 2/2 (customers)\n",
    "Cleaning up sync temp artifacts...\n",
    "Sync production -> development complete. Verified 2 collections.\n"
  ]);
  assert.deepEqual(calls.countedCollections, [
    { env: "production", collections: ["orders", "customers"] }
  ]);
});

test("runSync rewrites count progress on one line for interactive stdout", async () => {
  const { dependencies, calls } = createRunSyncDependencies({
    isInteractiveStdout(): boolean {
      return true;
    },
    async runWithElapsedStatus<T>(
      baseMessage: string,
      task: () => Promise<T>
    ): Promise<T> {
      calls.output.push(`\r${baseMessage} 00:00`);
      const result = await task();
      calls.output.push("\n");
      return result;
    }
  });

  await runSync(
    buildAppConfig(false),
    { from: "production", to: "development", outputMode: "default" },
    dependencies
  );

  assert.deepEqual(calls.output, [
    "Starting sync production -> development\n",
    "\rDumping source production... 00:00",
    "\n",
    "\rRestoring target development... 00:00",
    "\n",
    "Verifying target development...\n",
    "Checking collection presence...\n",
    "Checking collection counts...\n",
    "\rChecked collection counts: 1/2 (orders)",
    "\rChecked collection counts: 2/2 (customers)",
    "\n",
    "Cleaning up sync temp artifacts...\n",
    "Sync production -> development complete. Verified 2 collections.\n"
  ]);
});

test("runSync performs dump then restore then cleanup", async () => {
  const events: string[] = [];
  const { dependencies, calls } = createRunSyncDependencies({
    async createArchiveBackup(env, _appConfig, destinationFile): Promise<void> {
      events.push(`dump:${env.id}:${destinationFile}`);
      calls.dumps.push({ source: env.id, destination: destinationFile });
    },
    async restoreArchiveToEnvironment(
      env,
      _appConfig,
      archiveFile,
      options
    ): Promise<void> {
      events.push(`restore:${env.id}:${archiveFile}:${options.drop}`);
      calls.restores.push({
        target: env.id,
        archive: archiveFile,
        drop: options.drop
      });
    },
    async unlink(path: string): Promise<void> {
      events.push(`cleanup:${path}`);
      calls.unlinks.push(path);
    }
  });

  await runSync(
    buildAppConfig(false),
    { from: "production", to: "development", outputMode: "default" },
    dependencies
  );

  assert.deepEqual(events, [
    "dump:production:/tmp/db-helper/test-sync.archive.gz",
    "restore:development:/tmp/db-helper/test-sync.archive.gz:true",
    "cleanup:/tmp/db-helper/test-sync.archive.gz"
  ]);
  assert.deepEqual(calls.output, [
    "Starting sync production -> development\n",
    "Dumping source production...\n",
    "Restoring target development...\n",
    "Verifying target development...\n",
    "Checking collection presence...\n",
    "Checking collection counts...\n",
    "Checked collection counts: 1/2 (orders)\n",
    "Checked collection counts: 2/2 (customers)\n",
    "Cleaning up sync temp artifacts...\n",
    "Sync production -> development complete. Verified 2 collections.\n"
  ]);
  assert.deepEqual(calls.listedCollections, ["production"]);
  assert.deepEqual(calls.countedCollections, [
    { env: "production", collections: ["orders", "customers"] }
  ]);
  assert.deepEqual(calls.verifications, ["development"]);
});

test("runSync filters internal system collections from verification input", async () => {
  const { dependencies, calls } = createRunSyncDependencies({
    async listCollections(env): Promise<string[]> {
      calls.listedCollections.push(env.id);
      return ["orders", "system.views", "customers"];
    }
  });

  await runSync(
    buildAppConfig(false),
    { from: "production", to: "development", outputMode: "default" },
    dependencies
  );

  assert.deepEqual(calls.countedCollections, [
    { env: "production", collections: ["orders", "customers"] }
  ]);
});

test("runSync forces drop semantics even when config default is false", async () => {
  const { dependencies, calls } = createRunSyncDependencies();

  await runSync(
    buildAppConfig(false),
    { from: "production", to: "development", outputMode: "default" },
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

test("runSync attempts cleanup when restore fails", async () => {
  const { dependencies, calls } = createRunSyncDependencies({
    async restoreArchiveToEnvironment(): Promise<void> {
      throw new Error("restore failed");
    }
  });

  await assert.rejects(
    runSync(
      buildAppConfig(false),
      { from: "production", to: "development", outputMode: "default" },
      dependencies
    ),
    /Sync failed during restore.*Target development may be dirty\./s
  );

  assert.deepEqual(calls.unlinks, ["/tmp/db-helper/test-sync.archive.gz"]);
});

test("runSync fails when verification finds mismatches", async () => {
  const { dependencies, calls } = createRunSyncDependencies({
    async verifyRestore(env): Promise<{
      collectionsPresent: string[];
      missingCollections: string[];
      countMismatches: Array<{
        collection: string;
        expected: number;
        actual: number;
      }>;
    }> {
      calls.verifications.push(env.id);
      return {
        collectionsPresent: ["orders"],
        missingCollections: ["customers"],
        countMismatches: [
          {
            collection: "orders",
            expected: 1,
            actual: 0
          }
        ]
      };
    }
  });

  await assert.rejects(
    runSync(
      buildAppConfig(false),
      { from: "production", to: "development", outputMode: "default" },
      dependencies
    ),
    /Sync failed during verify.*Target development may be dirty\./s
  );

  assert.deepEqual(calls.unlinks, ["/tmp/db-helper/test-sync.archive.gz"]);
});

test("runSync attempts cleanup when dump fails", async () => {
  const { dependencies, calls } = createRunSyncDependencies({
    async createArchiveBackup(): Promise<void> {
      throw new Error("dump failed");
    }
  });

  await assert.rejects(
    runSync(
      buildAppConfig(false),
      { from: "production", to: "development", outputMode: "default" },
      dependencies
    ),
    /Sync failed during dump.*Target development was not modified\..*dump failed/s
  );

  assert.deepEqual(calls.unlinks, ["/tmp/db-helper/test-sync.archive.gz"]);
  assert.equal(calls.restores.length, 0);
});

test("runSync preserves the original failure when cleanup fails too", async () => {
  const { dependencies } = createRunSyncDependencies({
    async restoreArchiveToEnvironment(): Promise<void> {
      throw new Error("restore failed");
    },
    async unlink(): Promise<void> {
      throw new Error("cleanup failed");
    }
  });

  await assert.rejects(
    runSync(
      buildAppConfig(false),
      { from: "production", to: "development", outputMode: "default" },
      dependencies
    ),
    /Sync failed during restore.*Target development may be dirty\..*Temp artifact cleanup also failed\..*restore failed/s
  );
});

test("runSync reports interrupt state and cleanup attempt on ctrl-c during restore", async () => {
  const { dependencies, calls } = createRunSyncDependencies({
    async restoreArchiveToEnvironment(): Promise<void> {
      calls.interruptHandler?.();
      throw new Error("Command interrupted: mongorestore");
    }
  });

  await assert.rejects(
    runSync(
      buildAppConfig(false),
      { from: "production", to: "development", outputMode: "default" },
      dependencies
    ),
    /Sync interrupted during restore.*Target development may be dirty\..*Temp artifact cleanup attempted\..*Command interrupted: mongorestore/s
  );

  assert.deepEqual(calls.unlinks, ["/tmp/db-helper/test-sync.archive.gz"]);
});
