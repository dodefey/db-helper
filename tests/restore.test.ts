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
    }>;
    runRestoreCollectionArgs: Array<{
      backup: string;
      collection: string;
      to: EnvironmentId;
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
    }>,
    runRestoreCollectionArgs: [] as Array<{
      backup: string;
      collection: string;
      to: EnvironmentId;
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
    }>;
    verifications: EnvironmentId[];
    interruptHandler?: () => void;
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
    }>,
    verifications: [] as EnvironmentId[],
    interruptHandler: undefined as (() => void) | undefined
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
        drop: options.drop
      });
    },
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
      forceProductionRestore: false
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
      skipPreBackup: false
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
      forceProductionRestore: true
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
      skipPreBackup: false
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
      yes: false
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
      to: "development"
    }
  ]);
});

test("runRestoreFull performs pre-restore backup for production targets", async () => {
  const { dependencies, calls } = createRunRestoreDependencies();

  await runRestoreFull(
    buildAppConfig(false),
    {
      backup: "backup-name",
      to: "production",
      skipPreBackup: false
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
      drop: false
    }
  ]);
  assert.deepEqual(calls.verifications, ["production"]);
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
          skipPreBackup: true
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
          skipPreBackup: false
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
          skipPreBackup: false
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
      to: "test"
    },
    dependencies
  );

  assert.deepEqual(calls.restores, [
    {
      target: "test",
      archivePath: "/tmp/backups/backup-name/dump.archive.gz",
      collection: "orders",
      drop: true
    }
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
          to: "development"
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
          to: "development"
        },
        dependencies
      ),
    /Restore failed during restore for backup-name -> development\.\nTarget database may be dirty\. Restore it from a known good backup or rerun restore before trusting it\.\nrestore failed/
  );
});
