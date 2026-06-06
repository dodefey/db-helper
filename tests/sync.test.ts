import test from "node:test";
import assert from "node:assert/strict";
import {
  AppConfig,
  EnvironmentConfig,
  EnvironmentId
} from "../src/config/types.js";
import { syncDatabase, SyncDependencies } from "../src/commands/sync.js";
import { RemoteOperationError } from "../src/lib/mongo.js";
import { parseOutputMode } from "../src/lib/output.js";
import { runSync, RunSyncDependencies } from "../src/lib/sync.js";
import { createCommandInvocationContext } from "../src/lib/invocationContext.js";
import { withTestRunLogger } from "./run-log-helpers.js";

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
    sessions: unknown[];
    dumps: Array<{ source: EnvironmentId; destination: string }>;
    inspectedArchives: Array<{
      target: EnvironmentId;
      archive: string;
      sourceDatabaseName: string;
    }>;
    restores: Array<{
      target: EnvironmentId;
      archive: string;
      drop: boolean;
      sourceDatabaseName?: string;
      collection?: string;
    }>;
    droppedCollections: Array<{ target: EnvironmentId; collections: string[] }>;
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
    sessions: [] as unknown[],
    dumps: [] as Array<{ source: EnvironmentId; destination: string }>,
    inspectedArchives: [] as Array<{
      target: EnvironmentId;
      archive: string;
      sourceDatabaseName: string;
    }>,
    restores: [] as Array<{
      target: EnvironmentId;
      archive: string;
      drop: boolean;
      sourceDatabaseName?: string;
      collection?: string;
    }>,
    droppedCollections: [] as Array<{
      target: EnvironmentId;
      collections: string[];
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
      collections,
      options
    ): Promise<Record<string, number>> {
      calls.countedCollections.push({ env: env.id, collections });
      calls.sessions.push(options?.remotePreflightSession);
      return Object.fromEntries(collections.map((name) => [name, 1]));
    },
    async createArchiveBackup(
      env,
      _appConfig,
      destinationFile,
      options
    ): Promise<void> {
      calls.dumps.push({ source: env.id, destination: destinationFile });
      calls.sessions.push(options?.remotePreflightSession);
    },
    async inspectArchiveCollections(
      env,
      _appConfig,
      archiveFile,
      options
    ): Promise<string[]> {
      calls.sessions.push(options?.remotePreflightSession);
      calls.inspectedArchives.push({
        target: env.id,
        archive: archiveFile,
        sourceDatabaseName: options.sourceDatabaseName
      });
      return ["orders", "customers"];
    },
    async restoreArchiveToEnvironment(
      env,
      _appConfig,
      archiveFile,
      options
    ): Promise<void> {
      const restoreCall: {
        target: EnvironmentId;
        archive: string;
        drop: boolean;
        sourceDatabaseName?: string;
        collection?: string;
      } = {
        target: env.id,
        archive: archiveFile,
        drop: options.drop,
        sourceDatabaseName: options.sourceDatabaseName
      };
      if (options.collection) {
        restoreCall.collection = options.collection;
      }
      calls.sessions.push(options.remotePreflightSession);
      calls.restores.push(restoreCall);
    },
    async dropCollections(env, collections, options): Promise<void> {
      calls.droppedCollections.push({ target: env.id, collections });
      calls.sessions.push(options?.remotePreflightSession);
    },
    async verifyRestore(
      env,
      manifest,
      options
    ): Promise<{
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
      calls.sessions.push(options?.remotePreflightSession);
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
    "This will replace development with an exact copy of production. Continue?"
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

test("syncDatabase prompts with collection scope when syncing one collection", async () => {
  const { dependencies, calls } = createDependencies();

  await syncDatabase(
    buildAppConfig(false),
    {
      from: "production",
      to: "development",
      collection: "orders",
      yes: false,
      outputMode: "default"
    },
    dependencies
  );

  assert.deepEqual(calls.promptMessages, [
    "This will replace development.orders with an exact copy of production.orders. Continue?"
  ]);
  assert.deepEqual(calls.runSyncCalls, [
    {
      from: "production",
      to: "development",
      collection: "orders",
      outputMode: "default"
    }
  ]);
});

test("syncDatabase allows same-environment paths under the flexible policy", async () => {
  const { dependencies, calls } = createDependencies();

  await syncDatabase(
    buildAppConfig(true),
    {
      from: "development",
      to: "development",
      yes: true,
      outputMode: "default"
    },
    dependencies
  );

  assert.deepEqual(calls.promptMessages, []);
  assert.deepEqual(calls.runSyncCalls, [
    { from: "development", to: "development", outputMode: "default" }
  ]);
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
  assert.deepEqual(calls.droppedCollections, [
    { target: "development", collections: [] }
  ]);
});

test("runSync preserves summary output in default mode", async () => {
  const { dependencies, calls } = createRunSyncDependencies();
  const context = createCommandInvocationContext();

  await runSync(
    buildAppConfig(false),
    { from: "production", to: "development", outputMode: "default" },
    dependencies,
    context
  );

  assert.deepEqual(calls.output, [
    "Starting sync production -> development\n",
    "Dumping source production...\n",
    "Restoring target development...\n",
    "Removing target-only collections from development...\n",
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
  assert.deepEqual(calls.droppedCollections, [
    { target: "development", collections: [] }
  ]);
  assert.ok(
    calls.sessions.every(
      (session) => session === context.remotePreflightSession
    )
  );
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
    "Removing target-only collections from development...\n",
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
        drop: options.drop,
        sourceDatabaseName: options.sourceDatabaseName
      });
    },
    async dropCollections(env, collections): Promise<void> {
      events.push(`prune:${env.id}:${collections.join(",")}`);
      calls.droppedCollections.push({ target: env.id, collections });
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
    "prune:development:",
    "cleanup:/tmp/db-helper/test-sync.archive.gz"
  ]);
  assert.deepEqual(calls.output, [
    "Starting sync production -> development\n",
    "Dumping source production...\n",
    "Restoring target development...\n",
    "Removing target-only collections from development...\n",
    "Verifying target development...\n",
    "Checking collection presence...\n",
    "Checking collection counts...\n",
    "Checked collection counts: 1/2 (orders)\n",
    "Checked collection counts: 2/2 (customers)\n",
    "Cleaning up sync temp artifacts...\n",
    "Sync production -> development complete. Verified 2 collections.\n"
  ]);
  assert.deepEqual(calls.listedCollections, ["production", "development"]);
  assert.deepEqual(calls.inspectedArchives, [
    {
      target: "development",
      archive: "/tmp/db-helper/test-sync.archive.gz",
      sourceDatabaseName: "production"
    }
  ]);
  assert.deepEqual(calls.countedCollections, [
    { env: "production", collections: ["orders", "customers"] }
  ]);
  assert.deepEqual(calls.verifications, ["development"]);
});

test("runSync filters internal system collections from prune and verification input", async () => {
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
  assert.deepEqual(calls.droppedCollections, [
    { target: "development", collections: [] }
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
      drop: true,
      sourceDatabaseName: "production"
    }
  ]);
});

test("runSync syncs a single collection without pruning target-only collections", async () => {
  const { dependencies, calls } = createRunSyncDependencies();

  await runSync(
    buildAppConfig(false),
    {
      from: "production",
      to: "development",
      collection: "orders",
      outputMode: "default"
    },
    dependencies
  );

  assert.deepEqual(calls.output, [
    "Starting sync production.orders -> development.orders\n",
    "Dumping source production.orders...\n",
    "Restoring target development.orders...\n",
    "Verifying target development.orders...\n",
    "Checking collection presence...\n",
    "Checking collection counts...\n",
    "Checked collection counts: 1/1 (orders)\n",
    "Cleaning up sync temp artifacts...\n",
    "Sync production.orders -> development.orders complete. Verified 1 collection.\n"
  ]);
  assert.deepEqual(calls.listedCollections, ["production"]);
  assert.deepEqual(calls.countedCollections, [
    { env: "production", collections: ["orders"] }
  ]);
  assert.deepEqual(calls.inspectedArchives, []);
  assert.deepEqual(calls.droppedCollections, []);
  assert.deepEqual(calls.restores, [
    {
      target: "development",
      archive: "/tmp/db-helper/test-sync.archive.gz",
      drop: true,
      sourceDatabaseName: "production",
      collection: "orders"
    }
  ]);
  assert.deepEqual(calls.verifications, ["development"]);
});

test("runSync rejects missing source collections before restore begins", async () => {
  const { dependencies, calls } = createRunSyncDependencies({
    async listCollections(env): Promise<string[]> {
      calls.listedCollections.push(env.id);
      return ["customers"];
    }
  });

  await assert.rejects(
    runSync(
      buildAppConfig(false),
      {
        from: "production",
        to: "development",
        collection: "orders",
        outputMode: "default"
      },
      dependencies
    ),
    /Collection orders was not found in source production\./
  );

  assert.deepEqual(calls.countedCollections, []);
  assert.deepEqual(calls.restores, []);
  assert.deepEqual(calls.unlinks, []);
});

test("runSync drops target-only collections before verify", async () => {
  const events: string[] = [];
  const { dependencies, calls } = createRunSyncDependencies();
  const baseVerifyRestore = dependencies.verifyRestore;

  dependencies.inspectArchiveCollections = async (
    env,
    _appConfig,
    archiveFile,
    options
  ): Promise<string[]> => {
    calls.inspectedArchives.push({
      target: env.id,
      archive: archiveFile,
      sourceDatabaseName: options.sourceDatabaseName
    });
    return ["orders", "customers"];
  };
  dependencies.listCollections = async (env): Promise<string[]> => {
    calls.listedCollections.push(env.id);
    return env.id === "production"
      ? ["orders", "customers"]
      : ["orders", "customers", "stale"];
  };
  dependencies.dropCollections = async (env, collections): Promise<void> => {
    events.push(`prune:${collections.join(",")}`);
    calls.droppedCollections.push({ target: env.id, collections });
  };
  dependencies.verifyRestore = async (env, manifest, options) => {
    events.push("verify");
    return baseVerifyRestore(env, manifest, options);
  };

  await runSync(
    buildAppConfig(false),
    { from: "production", to: "development", outputMode: "default" },
    dependencies
  );

  assert.deepEqual(calls.droppedCollections, [
    { target: "development", collections: ["stale"] }
  ]);
  assert.deepEqual(events, ["prune:stale", "verify"]);
});

test("runSync does not prune collections that appear in the source during dump", async () => {
  const { dependencies, calls } = createRunSyncDependencies();

  dependencies.inspectArchiveCollections = async (
    env,
    _appConfig,
    archiveFile,
    options
  ): Promise<string[]> => {
    calls.inspectedArchives.push({
      target: env.id,
      archive: archiveFile,
      sourceDatabaseName: options.sourceDatabaseName
    });
    return ["orders", "customers", "during_dump"];
  };
  dependencies.listCollections = async (env): Promise<string[]> => {
    calls.listedCollections.push(env.id);
    if (env.id === "production") {
      return ["orders", "customers"];
    }
    return ["orders", "customers", "during_dump", "stale"];
  };

  await runSync(
    buildAppConfig(false),
    { from: "production", to: "development", outputMode: "default" },
    dependencies
  );

  assert.deepEqual(calls.droppedCollections, [
    { target: "development", collections: ["stale"] }
  ]);
});

test("runSync refuses to prune when archive inspection finds no collections", async () => {
  const { dependencies, calls } = createRunSyncDependencies({
    async inspectArchiveCollections(
      env,
      _appConfig,
      archiveFile,
      options
    ): Promise<string[]> {
      calls.inspectedArchives.push({
        target: env.id,
        archive: archiveFile,
        sourceDatabaseName: options.sourceDatabaseName
      });
      return [];
    },
    async listCollections(env): Promise<string[]> {
      calls.listedCollections.push(env.id);
      return env.id === "production"
        ? ["orders", "customers"]
        : ["orders", "customers", "stale"];
    }
  });

  await assert.rejects(
    runSync(
      buildAppConfig(false),
      { from: "production", to: "development", outputMode: "default" },
      dependencies
    ),
    /Archive inspection found no restorable collections; refusing to prune development\./
  );

  assert.deepEqual(calls.droppedCollections, []);
});

test("runSync includes remote temp path for archive inspection transport failures", async () => {
  const { dependencies } = createRunSyncDependencies({
    async inspectArchiveCollections(): Promise<string[]> {
      throw new RemoteOperationError({
        code: "scpTransport",
        host: "gnomebrewshop.com",
        operation: "scp-upload",
        remoteTempPath: "/tmp/db-helper/inspect.archive.gz",
        details:
          "SCP transport to gnomebrewshop.com failed during scp-upload.\nconnection reset"
      });
    }
  });

  await assert.rejects(
    runSync(
      buildAppConfig(false),
      { from: "production", to: "development", outputMode: "default" },
      dependencies
    ),
    /Sync failed during removing target-only collections.*Target database may be dirty\..*Remote temporary archive path: \/tmp\/db-helper\/inspect\.archive\.gz.*SCP transport to gnomebrewshop\.com failed during scp-upload\.\nconnection reset/s
  );
});

test("runSync reports source metadata failures with sync phase context", async () => {
  const { dependencies, calls } = createRunSyncDependencies({
    async listCollections(): Promise<string[]> {
      throw new Error("metadata failed");
    }
  });

  await assert.rejects(
    runSync(
      buildAppConfig(false),
      { from: "production", to: "development", outputMode: "default" },
      dependencies
    ),
    /Sync failed during source metadata.*Target database was not modified\..*metadata failed/s
  );

  assert.deepEqual(calls.unlinks, []);
  assert.equal(calls.interruptHandler, undefined);
});

test("runSync passes the source database name into restore remapping", async () => {
  const appConfig = buildAppConfig(false);
  appConfig.environments.production.databaseName = "prod_db";
  appConfig.environments.development.databaseName = "dev_db";
  const { dependencies, calls } = createRunSyncDependencies();

  await runSync(
    appConfig,
    { from: "production", to: "development", outputMode: "default" },
    dependencies
  );

  assert.deepEqual(calls.restores, [
    {
      target: "development",
      archive: "/tmp/db-helper/test-sync.archive.gz",
      drop: true,
      sourceDatabaseName: "prod_db"
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
    /Sync failed during restore.*Target database may be dirty\./s
  );

  assert.deepEqual(calls.unlinks, ["/tmp/db-helper/test-sync.archive.gz"]);
});

test("runSync reports prune failures as dirty-target failures", async () => {
  const { dependencies, calls } = createRunSyncDependencies({
    async inspectArchiveCollections(
      env,
      _appConfig,
      archiveFile,
      options
    ): Promise<string[]> {
      calls.inspectedArchives.push({
        target: env.id,
        archive: archiveFile,
        sourceDatabaseName: options.sourceDatabaseName
      });
      return ["orders", "customers"];
    },
    async listCollections(env): Promise<string[]> {
      calls.listedCollections.push(env.id);
      return env.id === "production"
        ? ["orders", "customers"]
        : ["orders", "customers", "stale"];
    },
    async dropCollections(): Promise<void> {
      throw new Error("prune failed");
    }
  });

  await assert.rejects(
    runSync(
      buildAppConfig(false),
      { from: "production", to: "development", outputMode: "default" },
      dependencies
    ),
    /Sync failed during removing target-only collections.*Target database may be dirty\..*prune failed/s
  );

  assert.deepEqual(calls.unlinks, ["/tmp/db-helper/test-sync.archive.gz"]);
});

test("runSync fails when verification finds mismatches or unexpected collections", async () => {
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
        collectionsPresent: ["orders", "legacy"],
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
    /Sync failed during verify.*Target database may be dirty\..*Unexpected collections: legacy/s
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
    /Sync failed during dump.*Target database was not modified\..*dump failed/s
  );

  assert.deepEqual(calls.unlinks, ["/tmp/db-helper/test-sync.archive.gz"]);
  assert.equal(calls.restores.length, 0);
});

test("runSync includes remote temp path for remote dump transport failures", async () => {
  const { dependencies } = createRunSyncDependencies({
    async createArchiveBackup(): Promise<void> {
      throw new RemoteOperationError({
        code: "scpTransport",
        host: "gnomebrewshop.com",
        operation: "scp-download",
        remoteTempPath: "/tmp/db-helper/source.archive.gz",
        details:
          "SCP transport to gnomebrewshop.com failed during scp-download.\nconnection reset"
      });
    }
  });

  await assert.rejects(
    runSync(
      buildAppConfig(false),
      { from: "production", to: "development", outputMode: "default" },
      dependencies
    ),
    /Sync failed during dump.*Target database was not modified\..*Remote temporary archive path: \/tmp\/db-helper\/source\.archive\.gz.*SCP transport to gnomebrewshop\.com failed during scp-download\.\nconnection reset/s
  );
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
    /Sync failed during restore.*Target database may be dirty\..*Attempted to delete temporary sync artifacts, but cleanup may not have finished\..*restore failed/s
  );
});

test("runSync includes remote temp path for remote restore cleanup failures", async () => {
  const { dependencies } = createRunSyncDependencies({
    async restoreArchiveToEnvironment(): Promise<void> {
      throw new RemoteOperationError({
        code: "scpTransport",
        host: "gnomebrewshop.com",
        operation: "scp-upload",
        remoteTempPath: "/tmp/db-helper/restore.archive.gz",
        details:
          "SCP transport to gnomebrewshop.com failed during scp-upload.\npermission denied"
      });
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
    /Sync failed during restore.*Target database may be dirty\..*Attempted to delete temporary sync artifacts, but cleanup may not have finished\..*Remote temporary archive path: \/tmp\/db-helper\/restore\.archive\.gz.*SCP transport to gnomebrewshop\.com failed during scp-upload\.\npermission denied/s
  );
});

test("runSync reports interrupt state and cleanup attempt on ctrl-c during restore", async () => {
  const { dependencies, calls } = createRunSyncDependencies({
    async restoreArchiveToEnvironment(): Promise<void> {
      calls.interruptHandler?.();
      throw new RemoteOperationError({
        code: "scpTransport",
        host: "gnomebrewshop.com",
        operation: "scp-upload",
        remoteTempPath: "/tmp/db-helper/restore.archive.gz",
        details:
          "SCP transport to gnomebrewshop.com failed during scp-upload.\nconnection reset",
        interrupted: true
      });
    }
  });

  await assert.rejects(
    runSync(
      buildAppConfig(false),
      { from: "production", to: "development", outputMode: "default" },
      dependencies
    ),
    /Sync interrupted during restore.*Target database may be dirty\..*Attempted to delete temporary sync artifacts, but cleanup success is not confirmed\..*Remote temporary archive path: \/tmp\/db-helper\/restore\.archive\.gz.*The sync was interrupted by the operator\./s
  );

  assert.deepEqual(calls.unlinks, ["/tmp/db-helper/test-sync.archive.gz"]);
});

test("runSync writes success and failure events to the run log", async () => {
  const successRun = createRunSyncDependencies();
  const success = await withTestRunLogger("sync", async () => {
    await runSync(
      buildAppConfig(false),
      { from: "production", to: "development", outputMode: "default" },
      successRun.dependencies
    );
  });
  assert.match(success.logContent, /\[sync\] Sync workflow started/);
  assert.match(success.logContent, /\[sync\] Sync workflow completed/);

  const failureRun = createRunSyncDependencies({
    async createArchiveBackup(): Promise<void> {
      throw new Error("dump failed");
    }
  });
  const failure = await withTestRunLogger("sync", async () => {
    await assert.rejects(
      runSync(
        buildAppConfig(false),
        { from: "production", to: "development", outputMode: "default" },
        failureRun.dependencies
      )
    );
  });
  assert.match(failure.logContent, /\[sync\] Sync workflow failed/);
  assert.match(failure.logContent, /dump failed/);
});
