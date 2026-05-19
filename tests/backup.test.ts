import test from "node:test";
import assert from "node:assert/strict";
import {
  AppConfig,
  BackupManifest,
  EnvironmentConfig,
  EnvironmentId
} from "../src/config/types.js";
import {
  backupCreate as commandBackupCreate,
  backupInspect,
  backupList,
  BackupCommandDependencies
} from "../src/commands/backup.js";
import {
  runBackupCreate,
  RunBackupCreateDependencies
} from "../src/lib/backup.js";
import { createCommandInvocationContext } from "../src/lib/invocationContext.js";
import { RemoteOperationError } from "../src/lib/mongo.js";
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
    stdout: string[];
    removeInterruptHandlerCount: number;
    ensuredDirs: string[];
    listedCollections: EnvironmentId[];
    countedCollections: Array<{ env: EnvironmentId; collections: string[] }>;
    listedCollectionOutputModes: Array<string | undefined>;
    countedCollectionOutputModes: Array<string | undefined>;
    sessions: unknown[];
    archives: string[];
    archiveOutputModes: Array<string | undefined>;
    manifests: BackupManifest[];
    ensuredArtifacts: string[];
    removedBackups: string[];
  };
  triggerInterrupt: () => void;
} {
  let interruptHandler: (() => void) | undefined;
  const calls = {
    stdout: [] as string[],
    removeInterruptHandlerCount: 0,
    ensuredDirs: [] as string[],
    listedCollections: [] as EnvironmentId[],
    countedCollections: [] as Array<{
      env: EnvironmentId;
      collections: string[];
    }>,
    listedCollectionOutputModes: [] as Array<string | undefined>,
    countedCollectionOutputModes: [] as Array<string | undefined>,
    sessions: [] as unknown[],
    archives: [] as string[],
    archiveOutputModes: [] as Array<string | undefined>,
    manifests: [] as BackupManifest[],
    ensuredArtifacts: [] as string[],
    removedBackups: [] as string[]
  };

  const dependencies: RunBackupCreateDependencies = {
    installInterruptHandler(onInterrupt): () => void {
      interruptHandler = onInterrupt;
      return () => {
        calls.removeInterruptHandlerCount += 1;
        interruptHandler = undefined;
      };
    },
    writeStdout(message: string): void {
      calls.stdout.push(message);
    },
    isInteractiveStdout(): boolean {
      return false;
    },
    async runWithElapsedStatus<T>(
      baseMessage: string,
      task: () => Promise<T>
    ): Promise<T> {
      calls.stdout.push(`${baseMessage}\n`);
      return task();
    },
    async ensureDirectory(dirPath: string): Promise<void> {
      calls.ensuredDirs.push(dirPath);
    },
    buildBackupName(): string {
      return "2026-03-26T12-00-00-development";
    },
    archivePathForBackup(root: string, backupName: string): string {
      return `${root}/${backupName}/dump.archive.gz`;
    },
    async listCollections(env, options): Promise<string[]> {
      calls.listedCollections.push(env.id);
      calls.listedCollectionOutputModes.push(options?.outputMode);
      calls.sessions.push(options?.remotePreflightSession);
      return ["orders", "system.views", "customers"];
    },
    async getCollectionCounts(
      env,
      collections,
      options
    ): Promise<Record<string, number>> {
      calls.countedCollections.push({ env: env.id, collections });
      calls.countedCollectionOutputModes.push(options?.outputMode);
      calls.sessions.push(options?.remotePreflightSession);
      return Object.fromEntries(collections.map((name) => [name, 1]));
    },
    async createArchiveBackup(
      _env,
      _appConfig,
      archiveFile,
      options
    ): Promise<void> {
      calls.archives.push(archiveFile);
      calls.archiveOutputModes.push(options?.outputMode);
      calls.sessions.push(options?.remotePreflightSession);
    },
    async writeBackupManifest(_backupRoot, manifest): Promise<void> {
      calls.manifests.push(manifest);
    },
    async ensureBackupArtifacts(_backupRoot, backupName): Promise<void> {
      calls.ensuredArtifacts.push(backupName);
    },
    async removeBackupArtifacts(_backupRoot, backupName): Promise<void> {
      calls.removedBackups.push(backupName);
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

  return {
    dependencies,
    calls,
    triggerInterrupt: () => interruptHandler?.()
  };
}

test("runBackupCreate builds a valid backup record", async () => {
  const { dependencies, calls } = createBackupDependencies();
  const context = createCommandInvocationContext();

  const record = await runBackupCreate(
    buildAppConfig(),
    {
      from: "development",
      note: "known-good",
      tags: ["known-good"],
      outputMode: "default"
    },
    dependencies,
    context
  );

  assert.equal(record.name, "2026-03-26T12-00-00-development");
  assert.deepEqual(calls.stdout, [
    "Starting backup from development\n",
    "Collecting source metadata...\n",
    "Creating archive...\n",
    "Writing manifest...\n",
    "Validating backup...\n",
    "Backup complete: 2026-03-26T12-00-00-development\n",
    "Path: /tmp/db-helper-backups/2026-03-26T12-00-00-development\n"
  ]);
  assert.deepEqual(calls.listedCollections, ["development"]);
  assert.deepEqual(calls.listedCollectionOutputModes, ["default"]);
  assert.deepEqual(calls.countedCollections, [
    { env: "development", collections: ["orders", "customers"] }
  ]);
  assert.deepEqual(calls.countedCollectionOutputModes, ["default"]);
  assert.equal(
    calls.archives[0],
    "/tmp/db-helper-backups/2026-03-26T12-00-00-development/dump.archive.gz"
  );
  assert.deepEqual(calls.archiveOutputModes, ["default"]);
  assert.equal(calls.manifests[0].sourceEnvironment, "development");
  assert.deepEqual(calls.manifests[0].collectionList, ["orders", "customers"]);
  assert.deepEqual(calls.manifests[0].tags, ["known-good"]);
  assert.deepEqual(calls.ensuredArtifacts, ["2026-03-26T12-00-00-development"]);
  assert.deepEqual(calls.removedBackups, []);
  assert.equal(calls.removeInterruptHandlerCount, 1);
  assert.ok(
    calls.sessions.every(
      (session) => session === context.remotePreflightSession
    )
  );
});

test("runBackupCreate attempts cleanup when archive creation fails", async () => {
  const { dependencies, calls } = createBackupDependencies({
    async createArchiveBackup(): Promise<void> {
      throw new Error("archive write failed");
    }
  });

  await assert.rejects(
    () =>
      runBackupCreate(
        buildAppConfig(),
        { from: "development", outputMode: "default" },
        dependencies
      ),
    /Backup failed during archive creation for development\.\nThe backup may be incomplete or invalid and must not be trusted\.\nCleanup of incomplete backup artifacts was attempted\.\narchive write failed/
  );

  assert.deepEqual(calls.removedBackups, ["2026-03-26T12-00-00-development"]);
  assert.equal(calls.removeInterruptHandlerCount, 1);
});

test("runBackupCreate preserves the primary failure when cleanup fails", async () => {
  const { dependencies, calls } = createBackupDependencies({
    async ensureBackupArtifacts(): Promise<void> {
      throw new Error("backup validation failed");
    },
    async removeBackupArtifacts(_backupRoot, backupName): Promise<void> {
      calls.removedBackups.push(backupName);
      throw new Error("cleanup failed");
    }
  });

  await assert.rejects(
    () =>
      runBackupCreate(
        buildAppConfig(),
        { from: "development", outputMode: "default" },
        dependencies
      ),
    /Backup failed during validation for development\.\nThe backup may be incomplete or invalid and must not be trusted\.\nCleanup of incomplete backup artifacts was attempted but may not have completed\.\nbackup validation failed/
  );

  assert.deepEqual(calls.removedBackups, ["2026-03-26T12-00-00-development"]);
  assert.equal(calls.removeInterruptHandlerCount, 1);
});

test("runBackupCreate reports interruption during archive creation", async () => {
  const { dependencies, calls, triggerInterrupt } = createBackupDependencies({
    async createArchiveBackup(
      _env,
      _appConfig,
      _archiveFile,
      options
    ): Promise<void> {
      triggerInterrupt();
      if (options?.signal?.aborted) {
        throw new Error("Command interrupted: mongodump");
      }
      throw new Error("expected interrupt");
    }
  });

  await assert.rejects(
    () =>
      runBackupCreate(
        buildAppConfig(),
        { from: "development", outputMode: "default" },
        dependencies
      ),
    /Backup interrupted during archive creation for development\.\nThe backup may be incomplete or invalid and must not be trusted\.\nCleanup of incomplete backup artifacts was attempted\.\nThe backup was interrupted by the operator\./
  );

  assert.deepEqual(calls.removedBackups, ["2026-03-26T12-00-00-development"]);
  assert.equal(calls.removeInterruptHandlerCount, 1);
});

test("runBackupCreate reports remote interruption during archive creation", async () => {
  const { dependencies, calls, triggerInterrupt } = createBackupDependencies({
    async createArchiveBackup(): Promise<void> {
      triggerInterrupt();
      throw new RemoteOperationError({
        code: "scpTransport",
        host: "development.example.com",
        operation: "scp-download",
        remoteTempPath: "/tmp/db-helper/source.archive.gz",
        details:
          "SCP transport to development.example.com failed during scp-download.\nconnection reset",
        interrupted: true
      });
    }
  });

  await assert.rejects(
    () =>
      runBackupCreate(
        buildAppConfig(),
        { from: "development", outputMode: "default" },
        dependencies
      ),
    /Backup interrupted during archive creation for development\.\nThe backup may be incomplete or invalid and must not be trusted\.\nCleanup of incomplete backup artifacts was attempted\.\nThe backup was interrupted by the operator\./
  );

  assert.deepEqual(calls.removedBackups, ["2026-03-26T12-00-00-development"]);
  assert.equal(calls.removeInterruptHandlerCount, 1);
});

test("runBackupCreate suppresses summary output in quiet mode", async () => {
  const { dependencies, calls } = createBackupDependencies();

  await runBackupCreate(
    buildAppConfig(),
    { from: "development", outputMode: "quiet" },
    dependencies
  );

  assert.deepEqual(calls.stdout, []);
  assert.deepEqual(calls.listedCollectionOutputModes, ["quiet"]);
  assert.deepEqual(calls.countedCollectionOutputModes, ["quiet"]);
  assert.deepEqual(calls.archiveOutputModes, ["quiet"]);
});

test("runBackupCreate rewrites elapsed status in interactive mode", async () => {
  const { dependencies, calls } = createBackupDependencies({
    isInteractiveStdout(): boolean {
      return true;
    },
    async runWithElapsedStatus<T>(
      baseMessage: string,
      task: () => Promise<T>
    ): Promise<T> {
      calls.stdout.push(`\r${baseMessage} 00:00`);
      calls.stdout.push(`\r${baseMessage} 00:01`);
      const result = await task();
      calls.stdout.push("\n");
      return result;
    }
  });

  await runBackupCreate(
    buildAppConfig(),
    { from: "development", outputMode: "default" },
    dependencies
  );

  assert.deepEqual(calls.stdout, [
    "Starting backup from development\n",
    "\rCollecting source metadata... 00:00",
    "\rCollecting source metadata... 00:01",
    "\n",
    "\rCreating archive... 00:00",
    "\rCreating archive... 00:01",
    "\n",
    "Writing manifest...\n",
    "Validating backup...\n",
    "Backup complete: 2026-03-26T12-00-00-development\n",
    "Path: /tmp/db-helper-backups/2026-03-26T12-00-00-development\n"
  ]);
});

test("runBackupCreate does not rewrite elapsed status in verbose mode", async () => {
  const { dependencies, calls } = createBackupDependencies({
    isInteractiveStdout(): boolean {
      return true;
    },
    async runWithElapsedStatus<T>(
      baseMessage: string,
      task: () => Promise<T>
    ): Promise<T> {
      calls.stdout.push(`UNEXPECTED:${baseMessage}`);
      return task();
    }
  });

  await runBackupCreate(
    buildAppConfig(),
    { from: "development", outputMode: "verbose" },
    dependencies
  );

  assert.deepEqual(calls.stdout, [
    "Starting backup from development\n",
    "Collecting source metadata...\n",
    "Creating archive...\n",
    "Writing manifest...\n",
    "Validating backup...\n",
    "Backup complete: 2026-03-26T12-00-00-development\n",
    "Path: /tmp/db-helper-backups/2026-03-26T12-00-00-development\n"
  ]);
  assert.deepEqual(calls.listedCollectionOutputModes, ["default"]);
  assert.deepEqual(calls.countedCollectionOutputModes, ["default"]);
  assert.deepEqual(calls.archiveOutputModes, ["verbose"]);
});

test("backupCreate delegates to runBackupCreate with output mode", async () => {
  const appConfig = buildAppConfig();
  const expectedRecord = {
    name: "backup-name",
    path: "/tmp/db-helper-backups/backup-name",
    manifest: {
      backupName: "backup-name",
      sourceEnvironment: "development",
      databaseName: "development",
      createdAt: "2026-03-26T12:00:00.000Z",
      note: undefined,
      tags: [],
      collectionList: [],
      toolVersion: "test",
      archiveFile: "dump.archive.gz",
      collectionCounts: {}
    }
  };
  const calls: unknown[][] = [];
  const dependencies: BackupCommandDependencies = {
    async runBackupCreate(...args) {
      calls.push(args);
      return expectedRecord;
    },
    async listBackups() {
      throw new Error("not used");
    },
    async ensureBackupArtifacts() {
      throw new Error("not used");
    },
    async readBackup() {
      throw new Error("not used");
    }
  };

  const result = await commandBackupCreate(
    appConfig,
    {
      from: "development",
      note: "known-good",
      tags: ["known-good"],
      backupName: "backup-name",
      outputMode: "verbose"
    },
    dependencies
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][0], appConfig);
  assert.deepEqual(calls[0][1], {
    from: "development",
    note: "known-good",
    tags: ["known-good"],
    backupName: "backup-name",
    outputMode: "verbose"
  });
  assert.equal(calls[0].length, 4);
  assert.deepEqual(result, expectedRecord);
});

test("backupList filters backups by source environment and tag", async () => {
  const dependencies: BackupCommandDependencies = {
    async runBackupCreate() {
      throw new Error("not used");
    },
    async listBackups() {
      return [
        {
          name: "prod-known-good",
          path: "/tmp/db-helper-backups/prod-known-good",
          manifest: {
            backupName: "prod-known-good",
            sourceEnvironment: "production",
            databaseName: "production",
            createdAt: "2026-03-26T12:00:00.000Z",
            note: undefined,
            tags: ["known-good"],
            collectionList: [],
            toolVersion: "test",
            archiveFile: "dump.archive.gz",
            collectionCounts: {}
          }
        },
        {
          name: "prod-pre-restore",
          path: "/tmp/db-helper-backups/prod-pre-restore",
          manifest: {
            backupName: "prod-pre-restore",
            sourceEnvironment: "production",
            databaseName: "production",
            createdAt: "2026-03-26T11:00:00.000Z",
            note: undefined,
            tags: ["pre-restore"],
            collectionList: [],
            toolVersion: "test",
            archiveFile: "dump.archive.gz",
            collectionCounts: {}
          }
        },
        {
          name: "dev-known-good",
          path: "/tmp/db-helper-backups/dev-known-good",
          manifest: {
            backupName: "dev-known-good",
            sourceEnvironment: "development",
            databaseName: "development",
            createdAt: "2026-03-26T10:00:00.000Z",
            note: undefined,
            tags: ["known-good"],
            collectionList: [],
            toolVersion: "test",
            archiveFile: "dump.archive.gz",
            collectionCounts: {}
          }
        }
      ];
    },
    async ensureBackupArtifacts() {
      throw new Error("not used");
    },
    async readBackup() {
      throw new Error("not used");
    }
  };

  const filtered = await backupList(
    buildAppConfig(),
    {
      from: "production",
      tag: "known-good"
    },
    dependencies
  );

  assert.deepEqual(
    filtered.map((backup) => backup.name),
    ["prod-known-good"]
  );
});

test("backupInspect validates artifacts before reading the backup", async () => {
  const appConfig = buildAppConfig();
  const calls: { ensured: unknown[][]; read: unknown[][] } = {
    ensured: [],
    read: []
  };
  const expectedRecord = {
    name: "backup-name",
    path: "/tmp/db-helper-backups/backup-name",
    manifest: {
      backupName: "backup-name",
      sourceEnvironment: "production",
      databaseName: "production",
      createdAt: "2026-03-26T12:00:00.000Z",
      note: undefined,
      tags: [],
      collectionList: [],
      toolVersion: "test",
      archiveFile: "dump.archive.gz",
      collectionCounts: {}
    }
  };
  const dependencies: BackupCommandDependencies = {
    async runBackupCreate() {
      throw new Error("not used");
    },
    async listBackups() {
      throw new Error("not used");
    },
    async ensureBackupArtifacts(...args) {
      calls.ensured.push(args);
    },
    async readBackup(...args) {
      calls.read.push(args);
      return expectedRecord;
    }
  };

  const result = await backupInspect(appConfig, "backup-name", dependencies);

  assert.deepEqual(calls.ensured, [[appConfig.backupRoot, "backup-name"]]);
  assert.deepEqual(calls.read, [[appConfig.backupRoot, "backup-name"]]);
  assert.deepEqual(result, expectedRecord);
});

test("runBackupCreate writes workflow events to the run log", async () => {
  const { dependencies } = createBackupDependencies();

  const { logContent } = await withTestRunLogger("backup", async () => {
    await runBackupCreate(
      buildAppConfig(),
      { from: "development", outputMode: "default" },
      dependencies
    );
  });

  assert.match(logContent, /\[backup\] Backup workflow started/);
  assert.match(logContent, /\[backup\] Backup workflow completed/);
});
