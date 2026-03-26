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

function buildAppConfig(defaultDropOnRestore = true): AppConfig {
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
    }>;
    restores: Array<{
      target: EnvironmentId;
      archivePath: string;
      collection?: string;
      drop: boolean;
      outputMode?: "default" | "quiet" | "verbose";
    }>;
    verifications: Array<{
      target: EnvironmentId;
      outputMode?: "default" | "quiet" | "verbose";
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
    }>,
    restores: [] as Array<{
      target: EnvironmentId;
      archivePath: string;
      collection?: string;
      drop: boolean;
      outputMode?: "default" | "quiet" | "verbose";
    }>,
    verifications: [] as Array<{
      target: EnvironmentId;
      outputMode?: "default" | "quiet" | "verbose";
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
    async backupCreate(_appConfig, input): Promise<BackupRecord> {
      calls.backupCreates.push(input);
      return buildBackupRecord("production");
    },
    async restoreArchiveToEnvironment(env, _appConfig, archivePath, options): Promise<void> {
      calls.restores.push({
        target: env.id,
        archivePath,
        collection: options.collection,
        drop: options.drop,
        outputMode: options.outputMode
      });
    },
    async verifyRestore(env, _manifest, options): Promise<{
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
        outputMode: options?.outputMode
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

test("restoreCollection delegates after confirmation", async () => {
  const { dependencies, calls } = createRestoreCommandDependencies();

  await restoreCollection(
    buildAppConfig(),
    {
      backup: "backup-name",
      collection: "orders",
      to: "development",
      yes: false,
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

  await runRestoreFull(
    buildAppConfig(false),
    {
      backup: "backup-name",
      to: "production",
      skipPreBackup: false,
      outputMode: "default"
    },
    dependencies
  );

  assert.deepEqual(calls.ensuredArtifacts, ["backup-name"]);
  assert.deepEqual(calls.readBackups, ["backup-name"]);
  assert.deepEqual(calls.backupCreates, [
    {
      from: "production",
      note: "automatic pre-restore backup before restoring backup-name",
      tags: ["pre-restore"],
      outputMode: "default"
    }
  ]);
  assert.deepEqual(calls.restores, [
    {
      target: "production",
      archivePath: "/tmp/backups/backup-name/dump.archive.gz",
      collection: undefined,
      drop: false,
      outputMode: "default"
    }
  ]);
  assert.deepEqual(calls.verifications, [
    {
      target: "production",
      outputMode: "default"
    }
  ]);
  assert.deepEqual(calls.output, [
    "Starting restore backup-name -> production\n",
    "Creating pre-restore backup...\n",
    "Restoring target production...\n",
    "Verifying target production...\n",
    "Restore complete: backup-name -> production\n"
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

  await runRestoreCollection(
    buildAppConfig(),
    {
      backup: "backup-name",
      collection: "orders",
      to: "test",
      outputMode: "default"
    },
    dependencies
  );

  assert.deepEqual(calls.restores, [
    {
      target: "test",
      archivePath: "/tmp/backups/backup-name/dump.archive.gz",
      collection: "orders",
      drop: true,
      outputMode: "default"
    }
  ]);
  assert.deepEqual(calls.output, [
    "Starting restore backup-name:orders -> test\n",
    "Restoring collection orders into test...\n",
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

test("runRestoreFull suppresses summary output in quiet mode", async () => {
  const { dependencies, calls } = createRunRestoreDependencies();

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

  assert.deepEqual(calls.output, []);
  assert.deepEqual(calls.restores, [
    {
      target: "development",
      archivePath: "/tmp/backups/backup-name/dump.archive.gz",
      collection: undefined,
      drop: true,
      outputMode: "quiet"
    }
  ]);
  assert.deepEqual(calls.verifications, [
    {
      target: "development",
      outputMode: "quiet"
    }
  ]);
});
