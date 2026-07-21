import test from "node:test";
import assert from "node:assert/strict";
import {
  AppConfig,
  BackupRecord,
  EnvironmentConfig,
  EnvironmentId
} from "../src/config/types.js";
import {
  restoreCollection,
  restoreFull,
  RestoreDependencies
} from "../src/commands/restore.js";
import {
  runRestoreCollection,
  runRestoreFull,
  RunRestoreDependencies
} from "../src/lib/restore.js";
import { createCommandInvocationContext } from "../src/lib/invocationContext.js";
import {
  ArchivePreflightError,
  PreparedArchiveRestoreSession,
  RemoteOperationError
} from "../src/lib/mongo.js";
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

function buildRemoteEnvironment(id: EnvironmentId): EnvironmentConfig {
  return {
    ...buildEnvironment(id),
    kind: "remote",
    host: `${id}.example.com`,
    sshUser: "ubuntu",
    sshKeyPath: "/tmp/test-key.pem"
  };
}

function buildAppConfig(
  defaultDropOnRestore = true,
  productionName = "production"
): AppConfig {
  return {
    backupRoot: "/tmp/backups",
    tempRoot: "/tmp/db-helper",
    authSource: "admin",
    defaultDropOnRestore,
    environments: {
      development: buildEnvironment("development"),
      test: buildEnvironment("test"),
      [productionName]: {
        ...buildEnvironment(productionName),
        isProduction: true
      }
    }
  };
}

function buildBackupRecord(
  sourceEnvironment: EnvironmentId = "production"
): BackupRecord {
  return {
    name: "backup-name",
    path: "/tmp/backups/backup-name",
    manifest: {
      backupName: "backup-name",
      sourceEnvironment,
      databaseName: sourceEnvironment,
      createdAt: "2026-03-26T00:00:00.000Z",
      tags: [],
      collectionList: ["orders", "customers"],
      toolVersion: "test",
      archiveFile: "dump.archive.gz",
      collectionCounts: {
        orders: 5,
        customers: 2
      }
    }
  };
}

function createRestoreCommandDependencies(
  overrides: Partial<RestoreDependencies> = {}
): {
  dependencies: RestoreDependencies;
  calls: {
    promptMessages: string[];
    promptTexts: string[];
    readBackupArgs: string[][];
    runRestoreFullArgs: Array<{
      backup: string;
      to: EnvironmentId;
      skipPreBackup: boolean;
      outputMode: "default" | "quiet" | "verbose";
      explain?: boolean;
    }>;
    runRestoreCollectionArgs: Array<{
      backup: string;
      collection: string;
      to: EnvironmentId;
      outputMode: "default" | "quiet" | "verbose";
    }>;
  };
} {
  const calls = {
    promptMessages: [] as string[],
    promptTexts: [] as string[],
    readBackupArgs: [] as string[][],
    runRestoreFullArgs: [] as Array<{
      backup: string;
      to: EnvironmentId;
      skipPreBackup: boolean;
      outputMode: "default" | "quiet" | "verbose";
      explain?: boolean;
    }>,
    runRestoreCollectionArgs: [] as Array<{
      backup: string;
      collection: string;
      to: EnvironmentId;
      outputMode: "default" | "quiet" | "verbose";
    }>
  };

  const dependencies: RestoreDependencies = {
    async promptConfirm(message: string): Promise<boolean> {
      calls.promptMessages.push(message);
      return true;
    },
    async promptText(message: string): Promise<string> {
      calls.promptTexts.push(message);
      return "RESTORE backup-name TO PRODUCTION";
    },
    async readBackup(...args): Promise<BackupRecord> {
      calls.readBackupArgs.push(args as string[]);
      return buildBackupRecord();
    },
    async runRestoreFull(_appConfig, input): Promise<void> {
      calls.runRestoreFullArgs.push(input);
    },
    async runRestoreCollection(_appConfig, input): Promise<void> {
      calls.runRestoreCollectionArgs.push(input);
    },
    ...overrides
  };

  return { dependencies, calls };
}

function createRunRestoreDependencies(
  overrides: Partial<RunRestoreDependencies> = {}
): {
  dependencies: RunRestoreDependencies;
  calls: {
    ensuredArtifacts: string[];
    readBackups: string[];
    archivePaths: string[];
    backupCreates: Array<{
      from: EnvironmentId;
      note?: string;
      tags?: string[];
      outputMode: "default" | "quiet" | "verbose";
      context?: unknown;
    }>;
    restores: Array<{
      target: EnvironmentId;
      archivePath: string;
      sourceDatabaseName?: string;
      collection?: string;
      drop: boolean;
      outputMode?: "default" | "quiet" | "verbose";
      session?: unknown;
    }>;
    verifications: Array<{
      target: EnvironmentId;
      outputMode?: "default" | "quiet" | "verbose";
      session?: unknown;
    }>;
    interruptHandler?: () => void;
    output: string[];
  };
} {
  const calls = {
    ensuredArtifacts: [] as string[],
    readBackups: [] as string[],
    archivePaths: [] as string[],
    backupCreates: [] as Array<{
      from: EnvironmentId;
      note?: string;
      tags?: string[];
      outputMode: "default" | "quiet" | "verbose";
      context?: unknown;
    }>,
    restores: [] as Array<{
      target: EnvironmentId;
      archivePath: string;
      sourceDatabaseName?: string;
      collection?: string;
      drop: boolean;
      outputMode?: "default" | "quiet" | "verbose";
      session?: unknown;
    }>,
    verifications: [] as Array<{
      target: EnvironmentId;
      outputMode?: "default" | "quiet" | "verbose";
      session?: unknown;
    }>,
    interruptHandler: undefined as (() => void) | undefined,
    output: [] as string[]
  };

  const dependencies: RunRestoreDependencies = {
    async ensureBackupArtifacts(_backupRoot, backupName): Promise<void> {
      calls.ensuredArtifacts.push(backupName);
    },
    async readBackup(_backupRoot, backupName): Promise<BackupRecord> {
      calls.readBackups.push(backupName);
      return buildBackupRecord();
    },
    archivePathForBackup(_backupRoot, backupName): string {
      calls.archivePaths.push(backupName);
      return `/tmp/backups/${backupName}/dump.archive.gz`;
    },
    async backupCreate(
      _appConfig,
      input,
      _dependencies,
      context
    ): Promise<BackupRecord> {
      calls.backupCreates.push({ ...input, context });
      return buildBackupRecord("production");
    },
    async prepareArchiveRestoreSession(
      env,
      appConfig,
      archivePath,
      options
    ): Promise<PreparedArchiveRestoreSession> {
      return {
        inspection: {
          mappings: [],
          collections: ["customers", "orders"],
          completed: true
        },
        async restore(restoreOptions): Promise<void> {
          restoreOptions.onMutationState?.("in_progress");
          await dependencies.restoreArchiveToEnvironment(
            env,
            appConfig,
            archivePath,
            {
              sourceDatabaseName: options.sourceDatabaseName,
              drop: restoreOptions.drop,
              outputMode: restoreOptions.outputMode,
              signal: restoreOptions.signal,
              onMutationState: restoreOptions.onMutationState,
              remotePreflightSession: options.remotePreflightSession
            }
          );
          restoreOptions.onMutationState?.("subprocess_succeeded");
        },
        async cleanup(): Promise<void> {}
      };
    },
    async restoreArchiveToEnvironment(
      env,
      _appConfig,
      archivePath,
      options
    ): Promise<void> {
      calls.restores.push({
        target: env.id,
        archivePath,
        sourceDatabaseName: options.sourceDatabaseName,
        collection: options.collection,
        drop: options.drop,
        outputMode: options.outputMode,
        session: options.remotePreflightSession
      });
    },
    async listCollections(): Promise<string[]> {
      return ["customers", "orders"];
    },
    async dropCollections(): Promise<void> {},
    async verifyRestore(
      env,
      _manifest,
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
      calls.verifications.push({
        target: env.id,
        outputMode: options?.outputMode,
        session: options?.remotePreflightSession
      });
      return {
        collectionsPresent: ["orders", "customers"],
        missingCollections: [],
        countMismatches: []
      };
    },
    installInterruptHandler(onInterrupt): () => void {
      calls.interruptHandler = onInterrupt;
      return () => {
        calls.interruptHandler = undefined;
      };
    },
    writeStdout(message: string): void {
      calls.output.push(message);
    },
    ...overrides
  };

  return { dependencies, calls };
}

test("restoreFull prompts before running restore when --yes is false", async () => {
  const { dependencies, calls } = createRestoreCommandDependencies();

  await restoreFull(
    buildAppConfig(),
    {
      backup: "backup-name",
      to: "development",
      yes: false,
      skipPreBackup: false,
      forceProductionRestore: false,
      outputMode: "default"
    },
    dependencies
  );

  assert.deepEqual(calls.promptMessages, [
    "This will restore data into development. Continue?"
  ]);
  assert.deepEqual(calls.runRestoreFullArgs, [
    {
      backup: "backup-name",
      to: "development",
      skipPreBackup: false,
      outputMode: "default"
    }
  ]);
});

test("restoreFull enforces production confirmation before running restore", async () => {
  const { dependencies, calls } = createRestoreCommandDependencies();

  await restoreFull(
    buildAppConfig(),
    {
      backup: "backup-name",
      to: "production",
      yes: false,
      skipPreBackup: false,
      forceProductionRestore: true,
      outputMode: "default"
    },
    dependencies
  );

  assert.deepEqual(calls.promptMessages, [
    "This will restore data into production. Continue?"
  ]);
  assert.deepEqual(calls.promptTexts, [
    "Type RESTORE backup-name TO PRODUCTION to confirm"
  ]);
  assert.deepEqual(calls.runRestoreFullArgs, [
    {
      backup: "backup-name",
      to: "production",
      skipPreBackup: false,
      outputMode: "default"
    }
  ]);
});

test("restoreFull explain skips mutation confirmations", async () => {
  const { dependencies, calls } = createRestoreCommandDependencies();

  await restoreFull(
    buildAppConfig(),
    {
      backup: "backup-name",
      to: "production",
      yes: false,
      skipPreBackup: false,
      forceProductionRestore: false,
      outputMode: "default",
      explain: true
    },
    dependencies
  );

  assert.deepEqual(calls.promptMessages, []);
  assert.deepEqual(calls.promptTexts, []);
  assert.deepEqual(calls.runRestoreFullArgs, [
    {
      backup: "backup-name",
      to: "production",
      skipPreBackup: false,
      outputMode: "default",
      explain: true
    }
  ]);
});

test("restoreCollection delegates after confirmation", async () => {
  const { dependencies, calls } = createRestoreCommandDependencies();

  await restoreCollection(
    buildAppConfig(),
    {
      backup: "backup-name",
      collection: "orders",
      to: "development",
      yes: false,
      forceProductionRestore: false,
      outputMode: "default"
    },
    dependencies
  );

  assert.deepEqual(calls.promptMessages, [
    "This will restore data into development. Continue?"
  ]);
  assert.deepEqual(calls.runRestoreCollectionArgs, [
    {
      backup: "backup-name",
      collection: "orders",
      to: "development",
      outputMode: "default"
    }
  ]);
});

test("restoreCollection rejects production restores without the force flag", async () => {
  const { dependencies, calls } = createRestoreCommandDependencies();

  await assert.rejects(
    () =>
      restoreCollection(
        buildAppConfig(),
        {
          backup: "backup-name",
          collection: "orders",
          to: "production",
          yes: false,
          forceProductionRestore: false,
          outputMode: "default"
        },
        dependencies
      ),
    /Production restore requires --force-production-restore/
  );

  assert.deepEqual(calls.runRestoreCollectionArgs, []);
});

test("restoreCollection rejects mismatched production confirmation text", async () => {
  const { dependencies, calls } = createRestoreCommandDependencies({
    async promptText(message: string): Promise<string> {
      calls.promptTexts.push(message);
      return "WRONG";
    }
  });

  await assert.rejects(
    () =>
      restoreCollection(
        buildAppConfig(),
        {
          backup: "backup-name",
          collection: "orders",
          to: "production",
          yes: false,
          forceProductionRestore: true,
          outputMode: "default"
        },
        dependencies
      ),
    /Production restore confirmation did not match/
  );

  assert.deepEqual(calls.runRestoreCollectionArgs, []);
});

test("restoreFull rejects production restores without the force flag", async () => {
  const { dependencies, calls } = createRestoreCommandDependencies();

  await assert.rejects(
    () =>
      restoreFull(
        buildAppConfig(),
        {
          backup: "backup-name",
          to: "production",
          yes: false,
          skipPreBackup: false,
          forceProductionRestore: false,
          outputMode: "default"
        },
        dependencies
      ),
    /Production restore requires --force-production-restore/
  );

  assert.deepEqual(calls.runRestoreFullArgs, []);
});

test("restoreFull rejects mismatched production confirmation text", async () => {
  const { dependencies, calls } = createRestoreCommandDependencies({
    async promptText(message: string): Promise<string> {
      calls.promptTexts.push(message);
      return "WRONG";
    }
  });

  await assert.rejects(
    () =>
      restoreFull(
        buildAppConfig(),
        {
          backup: "backup-name",
          to: "production",
          yes: false,
          skipPreBackup: false,
          forceProductionRestore: true,
          outputMode: "default"
        },
        dependencies
      ),
    /Production restore confirmation did not match/
  );

  assert.deepEqual(calls.runRestoreFullArgs, []);
});

test("runRestoreFull performs pre-restore backup for production targets", async () => {
  const { dependencies, calls } = createRunRestoreDependencies();
  const context = createCommandInvocationContext();

  await runRestoreFull(
    buildAppConfig(false, "live"),
    {
      backup: "backup-name",
      to: "live",
      skipPreBackup: false,
      outputMode: "default"
    },
    dependencies,
    context
  );

  assert.deepEqual(calls.ensuredArtifacts, ["backup-name"]);
  assert.deepEqual(calls.readBackups, ["backup-name"]);
  assert.deepEqual(calls.backupCreates, [
    {
      from: "live",
      note: "automatic pre-restore backup before restoring backup-name",
      tags: ["pre-restore"],
      outputMode: "default",
      context
    }
  ]);
  assert.deepEqual(calls.restores, [
    {
      target: "live",
      archivePath: "/tmp/backups/backup-name/dump.archive.gz",
      sourceDatabaseName: "production",
      collection: undefined,
      drop: true,
      outputMode: "default",
      session: context.remotePreflightSession
    }
  ]);
  assert.deepEqual(calls.verifications, [
    {
      target: "live",
      outputMode: "default",
      session: context.remotePreflightSession
    }
  ]);
  assert.deepEqual(calls.output, [
    "Starting restore backup-name -> live\n",
    "Creating pre-restore backup...\n",
    "Restoring target live...\n",
    "Verifying target live...\n",
    "Restore complete: backup-name -> live\n"
  ]);
});

test("runRestoreFull throws when verification fails", async () => {
  const { dependencies } = createRunRestoreDependencies({
    async verifyRestore(): Promise<{
      collectionsPresent: string[];
      missingCollections: string[];
      countMismatches: Array<{
        collection: string;
        expected: number;
        actual: number;
      }>;
    }> {
      return {
        collectionsPresent: ["orders"],
        missingCollections: ["customers"],
        countMismatches: []
      };
    }
  });

  await assert.rejects(
    () =>
      runRestoreFull(
        buildAppConfig(),
        {
          backup: "backup-name",
          to: "development",
          skipPreBackup: true,
          outputMode: "default"
        },
        dependencies
      ),
    /Restore verification failed/
  );
});

test("runRestoreFull reports dirty-target risk when interrupted during restore", async () => {
  const { dependencies } = createRunRestoreDependencies({
    async restoreArchiveToEnvironment(): Promise<void> {
      throw new Error("Command interrupted: mongorestore");
    }
  });

  await assert.rejects(
    () =>
      runRestoreFull(
        buildAppConfig(),
        {
          backup: "backup-name",
          to: "development",
          skipPreBackup: false,
          outputMode: "default"
        },
        dependencies
      ),
    /Restore interrupted during restore for backup-name -> development\.\nTarget database may be dirty\./
  );
});

test("runRestoreFull preserves remote interruption details during restore", async () => {
  const appConfig = buildAppConfig();
  appConfig.environments.development = buildRemoteEnvironment("development");
  const { dependencies } = createRunRestoreDependencies({
    async restoreArchiveToEnvironment(): Promise<void> {
      throw new RemoteOperationError({
        code: "scpTransport",
        host: "development.example.com",
        operation: "scp-upload",
        remoteTempPath: "/tmp/db-helper/restore.archive.gz",
        details:
          "SCP transport to development.example.com failed during scp-upload.\nconnection reset",
        interrupted: true
      });
    }
  });

  await assert.rejects(
    () =>
      runRestoreFull(
        appConfig,
        {
          backup: "backup-name",
          to: "development",
          skipPreBackup: false,
          outputMode: "default"
        },
        dependencies
      ),
    /Restore interrupted during restore for backup-name -> development\.\nTarget database may be dirty\. Restore it from a known good backup or rerun restore before trusting it\.\nRemote temporary archive path: \/tmp\/db-helper\/restore\.archive\.gz\nThe restore was interrupted by the operator\./
  );
});

test("runRestoreFull reports target unchanged when pre-restore backup fails", async () => {
  const { dependencies } = createRunRestoreDependencies({
    async backupCreate(): Promise<BackupRecord> {
      throw new Error("pre-restore backup failed");
    }
  });

  await assert.rejects(
    () =>
      runRestoreFull(
        buildAppConfig(),
        {
          backup: "backup-name",
          to: "production",
          skipPreBackup: false,
          outputMode: "default"
        },
        dependencies
      ),
    /Restore failed during pre-restore backup for backup-name -> production\.\nTarget database was not modified\.\npre-restore backup failed/
  );
});

test("runRestoreCollection validates collection membership and restores with drop", async () => {
  const { dependencies, calls } = createRunRestoreDependencies();
  const context = createCommandInvocationContext();

  await runRestoreCollection(
    buildAppConfig(),
    {
      backup: "backup-name",
      collection: "orders",
      to: "test",
      outputMode: "default"
    },
    dependencies,
    context
  );

  assert.equal(calls.restores.length, 1);
  assert.deepEqual(calls.restores[0], {
    target: "test",
    archivePath: "/tmp/backups/backup-name/dump.archive.gz",
    sourceDatabaseName: "production",
    collection: "orders",
    drop: true,
    outputMode: "default",
    session: context.remotePreflightSession
  });
  assert.deepEqual(calls.output, [
    "Starting restore backup-name:orders -> test\n",
    "Restoring collection orders into test...\n",
    "Verifying collection orders in test...\n",
    "Restore complete: backup-name:orders -> test\n"
  ]);
});

test("runRestoreCollection rejects collections missing from the backup", async () => {
  const { dependencies } = createRunRestoreDependencies({
    async readBackup(): Promise<BackupRecord> {
      return {
        ...buildBackupRecord(),
        manifest: {
          ...buildBackupRecord().manifest,
          collectionList: ["customers"]
        }
      };
    }
  });

  await assert.rejects(
    () =>
      runRestoreCollection(
        buildAppConfig(),
        {
          backup: "backup-name",
          collection: "orders",
          to: "development",
          outputMode: "default"
        },
        dependencies
      ),
    /Collection orders not present in backup backup-name/
  );
});

test("runRestoreCollection rejects a missing manifest count before restore", async () => {
  const { dependencies, calls } = createRunRestoreDependencies({
    async readBackup(): Promise<BackupRecord> {
      const backup = buildBackupRecord();
      return {
        ...backup,
        manifest: { ...backup.manifest, collectionCounts: { customers: 2 } }
      };
    }
  });

  await assert.rejects(
    () =>
      runRestoreCollection(
        buildAppConfig(),
        {
          backup: "backup-name",
          collection: "orders",
          to: "development",
          outputMode: "quiet"
        },
        dependencies
      ),
    /Collection orders has no valid manifest count/
  );
  assert.equal(calls.restores.length, 0);
});

test("runRestoreCollection reports dirty-target risk on restore failure", async () => {
  const { dependencies } = createRunRestoreDependencies({
    async restoreArchiveToEnvironment(): Promise<void> {
      throw new Error("restore failed");
    }
  });

  await assert.rejects(
    () =>
      runRestoreCollection(
        buildAppConfig(),
        {
          backup: "backup-name",
          collection: "orders",
          to: "development",
          outputMode: "default"
        },
        dependencies
      ),
    /Restore failed during restore for backup-name -> development\.\nTarget database may be dirty\. Restore it from a known good backup or rerun restore before trusting it\.\nrestore failed/
  );
});

test("runRestoreFull includes remote temp path for remote transport failures", async () => {
  const appConfig = buildAppConfig();
  appConfig.environments.development = buildRemoteEnvironment("development");
  const { dependencies } = createRunRestoreDependencies({
    async restoreArchiveToEnvironment(): Promise<void> {
      throw new RemoteOperationError({
        code: "scpTransport",
        host: "development.example.com",
        operation: "scp-upload",
        remoteTempPath: "/tmp/db-helper/restore.archive.gz",
        details:
          "SCP transport to development.example.com failed during scp-upload.\npermission denied"
      });
    }
  });

  await assert.rejects(
    () =>
      runRestoreFull(
        appConfig,
        {
          backup: "backup-name",
          to: "development",
          skipPreBackup: true,
          outputMode: "default"
        },
        dependencies
      ),
    /Restore failed during restore for backup-name -> development\.\nTarget database may be dirty\. Restore it from a known good backup or rerun restore before trusting it\.\nRemote temporary archive path: \/tmp\/db-helper\/restore\.archive\.gz\nSCP transport to development\.example\.com failed during scp-upload\.\npermission denied/
  );
});

test("runRestoreFull suppresses summary output in quiet mode", async () => {
  const { dependencies, calls } = createRunRestoreDependencies();
  const context = createCommandInvocationContext();

  await runRestoreFull(
    buildAppConfig(),
    {
      backup: "backup-name",
      to: "development",
      skipPreBackup: true,
      outputMode: "quiet"
    },
    dependencies,
    context
  );

  assert.deepEqual(calls.output, []);
  assert.deepEqual(calls.restores, [
    {
      target: "development",
      archivePath: "/tmp/backups/backup-name/dump.archive.gz",
      sourceDatabaseName: "production",
      collection: undefined,
      drop: true,
      outputMode: "quiet",
      session: context.remotePreflightSession
    }
  ]);
  assert.deepEqual(calls.verifications, [
    {
      target: "development",
      outputMode: "quiet",
      session: context.remotePreflightSession
    }
  ]);
});

test("runRestoreFull forces drop semantics even when config default is false", async () => {
  const { dependencies, calls } = createRunRestoreDependencies();
  const context = createCommandInvocationContext();

  await runRestoreFull(
    buildAppConfig(false),
    {
      backup: "backup-name",
      to: "development",
      skipPreBackup: true,
      outputMode: "default"
    },
    dependencies,
    context
  );

  assert.deepEqual(calls.restores, [
    {
      target: "development",
      archivePath: "/tmp/backups/backup-name/dump.archive.gz",
      sourceDatabaseName: "production",
      collection: undefined,
      drop: true,
      outputMode: "default",
      session: context.remotePreflightSession
    }
  ]);
});

test("runRestoreFull writes success and failure events to the run log", async () => {
  const successRun = createRunRestoreDependencies();
  const success = await withTestRunLogger("restore", async () => {
    await runRestoreFull(
      buildAppConfig(),
      {
        backup: "backup-name",
        to: "development",
        skipPreBackup: true,
        outputMode: "default"
      },
      successRun.dependencies
    );
  });
  assert.match(success.logContent, /\[restore\] Restore full workflow started/);
  assert.match(
    success.logContent,
    /\[restore\] Restore full workflow completed/
  );

  const failureRun = createRunRestoreDependencies({
    async restoreArchiveToEnvironment(): Promise<void> {
      throw new Error("restore failed");
    }
  });
  const failure = await withTestRunLogger("restore", async () => {
    await assert.rejects(
      runRestoreFull(
        buildAppConfig(),
        {
          backup: "backup-name",
          to: "development",
          skipPreBackup: true,
          outputMode: "default"
        },
        failureRun.dependencies
      )
    );
  });
  assert.match(failure.logContent, /\[restore\] Restore full workflow failed/);
  assert.match(failure.logContent, /restore failed/);
});

test("runRestoreFull owns one prepared session through verification and cleanup", async () => {
  const events: string[] = [];
  const { dependencies } = createRunRestoreDependencies({
    async prepareArchiveRestoreSession(): Promise<PreparedArchiveRestoreSession> {
      events.push("prepare");
      return {
        inspection: {
          mappings: [],
          collections: ["customers", "orders"],
          completed: true
        },
        async restore(options): Promise<void> {
          events.push("restore");
          options.onMutationState?.("in_progress");
          options.onMutationState?.("subprocess_succeeded");
        },
        async cleanup(): Promise<void> {
          events.push("cleanup");
        }
      };
    },
    async restoreArchiveToEnvironment(): Promise<void> {
      throw new Error("legacy restore should not run");
    },
    async verifyRestore() {
      events.push("verify");
      return {
        collectionsPresent: ["customers", "orders"],
        missingCollections: [],
        countMismatches: []
      };
    }
  });

  await runRestoreFull(
    buildAppConfig(),
    {
      backup: "backup-name",
      to: "development",
      skipPreBackup: true,
      outputMode: "quiet"
    },
    dependencies
  );

  assert.deepEqual(events, ["prepare", "restore", "verify", "cleanup"]);
});

test("runRestoreFull explains a prepared archive without mutation", async () => {
  const events: string[] = [];
  const { dependencies, calls } = createRunRestoreDependencies({
    async prepareArchiveRestoreSession(): Promise<PreparedArchiveRestoreSession> {
      events.push("prepare");
      return {
        inspection: {
          mappings: [],
          collections: ["customers", "orders"],
          completed: true
        },
        async restore(): Promise<void> {
          events.push("restore");
        },
        async cleanup(): Promise<void> {
          events.push("cleanup");
        }
      };
    },
    async listCollections(): Promise<string[]> {
      events.push("list");
      return ["customers", "orders", "stale", "system.views"];
    },
    async verifyRestore(): Promise<never> {
      throw new Error("verification should not run during explain");
    }
  });

  await runRestoreFull(
    buildAppConfig(),
    {
      backup: "backup-name",
      to: "development",
      skipPreBackup: false,
      outputMode: "default",
      explain: true
    },
    dependencies
  );

  assert.deepEqual(events, ["prepare", "list", "cleanup"]);
  assert.deepEqual(calls.restores, []);
  assert.deepEqual(calls.backupCreates, []);
  assert.deepEqual(calls.verifications, []);
  assert.ok(calls.output.some((line) => line.includes("Restore explanation:")));
  assert.ok(
    calls.output.some((line) =>
      line.includes("Target-only collections to prune: stale")
    )
  );
  assert.ok(
    calls.output.some((line) =>
      line.includes(
        "Mutation: not performed; pre-restore backup: not performed"
      )
    )
  );
});

test("runRestoreFull accepts a recognized empty backup and removes all target user collections", async () => {
  const events: string[] = [];
  const dropped: string[][] = [];
  const emptyBackup: BackupRecord = {
    ...buildBackupRecord(),
    manifest: {
      ...buildBackupRecord().manifest,
      collectionList: [],
      collectionCounts: {}
    }
  };
  const { dependencies } = createRunRestoreDependencies({
    async readBackup(): Promise<BackupRecord> {
      return emptyBackup;
    },
    async prepareArchiveRestoreSession(): Promise<PreparedArchiveRestoreSession> {
      events.push("prepare");
      return {
        inspection: { mappings: [], collections: [], completed: true },
        async restore(options): Promise<void> {
          events.push("restore");
          options.onMutationState?.("in_progress");
          options.onMutationState?.("subprocess_succeeded");
        },
        async cleanup(): Promise<void> {
          events.push("cleanup");
        }
      };
    },
    async listCollections(): Promise<string[]> {
      return ["stale", "system.js"];
    },
    async dropCollections(_env, collections): Promise<void> {
      events.push("prune");
      dropped.push(collections);
    },
    async verifyRestore() {
      events.push("verify");
      return {
        collectionsPresent: ["system.js"],
        missingCollections: [],
        countMismatches: []
      };
    }
  });

  await runRestoreFull(
    buildAppConfig(),
    {
      backup: "backup-name",
      to: "development",
      skipPreBackup: true,
      outputMode: "quiet"
    },
    dependencies
  );

  assert.deepEqual(events, [
    "prepare",
    "restore",
    "prune",
    "verify",
    "cleanup"
  ]);
  assert.deepEqual(dropped, [["stale"]]);
});

test("runRestoreFull cleans a prepared session after verification failure without masking the primary error", async () => {
  const { dependencies } = createRunRestoreDependencies({
    async prepareArchiveRestoreSession(): Promise<PreparedArchiveRestoreSession> {
      return {
        inspection: {
          mappings: [],
          collections: ["customers", "orders"],
          completed: true
        },
        async restore(options): Promise<void> {
          options.onMutationState?.("in_progress");
          options.onMutationState?.("subprocess_succeeded");
        },
        async cleanup(): Promise<void> {
          throw new Error("cleanup transport failed");
        }
      };
    },
    async verifyRestore(): Promise<never> {
      throw new Error("verification primary failed");
    }
  });

  await assert.rejects(
    runRestoreFull(
      buildAppConfig(),
      {
        backup: "backup-name",
        to: "development",
        skipPreBackup: true,
        outputMode: "quiet"
      },
      dependencies
    ),
    /verification primary failed.*Remote temporary archive cleanup failed: cleanup transport failed/s
  );
});

test("runRestoreFull reports verified trust when only prepared-session cleanup fails", async () => {
  const appConfig = buildAppConfig();
  appConfig.environments.development = buildRemoteEnvironment("development");
  const { dependencies } = createRunRestoreDependencies({
    async prepareArchiveRestoreSession(): Promise<PreparedArchiveRestoreSession> {
      return {
        inspection: {
          mappings: [],
          collections: ["customers", "orders"],
          completed: true
        },
        async restore(options): Promise<void> {
          options.onMutationState?.("in_progress");
          options.onMutationState?.("subprocess_succeeded");
        },
        async cleanup(): Promise<void> {
          throw new RemoteOperationError({
            code: "remoteCleanupFailed",
            host: "development.example.com",
            operation: "remote-cleanup",
            remoteTempPath: "/tmp/db-helper/prepared.archive.gz",
            details: "Remote temporary archive cleanup failed: ssh unavailable"
          });
        }
      };
    }
  });
  const result = await withTestRunLogger("restore-cleanup", async () => {
    await assert.rejects(
      runRestoreFull(
        appConfig,
        {
          backup: "backup-name",
          to: "development",
          skipPreBackup: true,
          outputMode: "quiet"
        },
        dependencies
      ),
      /Restore failed during cleanup.*Target database restore verification succeeded; only temporary artifact cleanup failed/s
    );
  });

  assert.match(result.logContent, /"verification":"succeeded"/);
  assert.match(result.logContent, /"targetTrustState":"verified"/);
});

test("runRestoreFull records an unchanged trust state when prepared-session preflight fails", async () => {
  const { dependencies } = createRunRestoreDependencies({
    async prepareArchiveRestoreSession(): Promise<PreparedArchiveRestoreSession> {
      throw new ArchivePreflightError(new Error("dry run rejected"));
    }
  });
  const result = await withTestRunLogger("restore-preflight", async () => {
    await assert.rejects(
      runRestoreFull(
        buildAppConfig(),
        {
          backup: "backup-name",
          to: "development",
          skipPreBackup: true,
          outputMode: "quiet"
        },
        dependencies
      ),
      /Target database was not modified/
    );
  });

  assert.match(result.logContent, /"restoreSubprocess":"not_started"/);
  assert.match(result.logContent, /"targetTrustState":"unchanged"/);
});

test("runRestoreFull cleans a prepared session when the production pre-backup fails", async () => {
  const events: string[] = [];
  const { dependencies } = createRunRestoreDependencies({
    async prepareArchiveRestoreSession(): Promise<PreparedArchiveRestoreSession> {
      events.push("prepare");
      return {
        inspection: {
          mappings: [],
          collections: ["customers", "orders"],
          completed: true
        },
        async restore(): Promise<void> {
          events.push("restore");
        },
        async cleanup(): Promise<void> {
          events.push("cleanup");
        }
      };
    },
    async backupCreate(): Promise<BackupRecord> {
      events.push("pre-backup");
      throw new Error("pre-backup primary failed");
    }
  });

  await assert.rejects(
    runRestoreFull(
      buildAppConfig(false, "live"),
      {
        backup: "backup-name",
        to: "live",
        skipPreBackup: false,
        outputMode: "quiet"
      },
      dependencies
    ),
    /pre-backup primary failed/
  );
  assert.deepEqual(events, ["prepare", "pre-backup", "cleanup"]);
});

test("runRestoreFull logs partial-modification trust after prepared mutation failure and cleans once", async () => {
  const events: string[] = [];
  const { dependencies } = createRunRestoreDependencies({
    async prepareArchiveRestoreSession(): Promise<PreparedArchiveRestoreSession> {
      return {
        inspection: {
          mappings: [],
          collections: ["customers", "orders"],
          completed: true
        },
        async restore(options): Promise<void> {
          events.push("restore");
          options.onMutationState?.("in_progress");
          throw new Error("mutation primary failed");
        },
        async cleanup(): Promise<void> {
          events.push("cleanup");
        }
      };
    }
  });
  const result = await withTestRunLogger("restore-mutation", async () => {
    await assert.rejects(
      runRestoreFull(
        buildAppConfig(),
        {
          backup: "backup-name",
          to: "development",
          skipPreBackup: true,
          outputMode: "quiet"
        },
        dependencies
      ),
      /mutation primary failed/
    );
  });

  assert.deepEqual(events, ["restore", "cleanup"]);
  assert.match(result.logContent, /"restoreSubprocess":"failed"/);
  assert.match(
    result.logContent,
    /"targetTrustState":"may be partially modified"/
  );
});

test("runRestoreCollection preserves subprocess success when only remote cleanup fails", async () => {
  const appConfig = buildAppConfig();
  appConfig.environments.development = buildRemoteEnvironment("development");
  const { dependencies } = createRunRestoreDependencies({
    async restoreArchiveToEnvironment(
      _env,
      _appConfig,
      _archivePath,
      options
    ): Promise<void> {
      options.onMutationState?.("in_progress");
      options.onMutationState?.("subprocess_succeeded");
      throw new RemoteOperationError({
        code: "remoteCleanupFailed",
        host: "development.example.com",
        operation: "remote-cleanup",
        remoteTempPath: "/tmp/db-helper/collection.archive.gz",
        details: "Remote cleanup failed on development.example.com."
      });
    }
  });
  const result = await withTestRunLogger(
    "restore-collection-cleanup",
    async () => {
      await assert.rejects(
        runRestoreCollection(
          appConfig,
          {
            backup: "backup-name",
            collection: "orders",
            to: "development",
            outputMode: "quiet"
          },
          dependencies
        ),
        /Restore subprocess: succeeded.*Post-restore verification: not_started/s
      );
    }
  );

  assert.match(result.logContent, /"restoreSubprocess":"succeeded"/);
  assert.match(
    result.logContent,
    /"targetTrustState":"may be partially modified"/
  );
});
