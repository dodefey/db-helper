import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EnvironmentConfig } from "../src/config/types.js";

import {
  combineRemoteTransportErrors,
  buildRestoreNamespaceContract,
  mongoDatabaseUri,
  mongoServerUri,
  parseArchiveInspection,
  parseArchiveCollections,
  parseMongoShellCollectionCounts,
  parseMongoShellCollectionList,
  parseMongoShellPingResult,
  parseMongoShellResult,
  prepareArchiveRestoreSession,
  PrepareArchiveRestoreDependencies,
  listCollections,
  RemoteOperationError,
  translateRemoteProcessError
} from "../src/lib/mongo.js";

const RESULT_MARKER = "__DBH_MONGOSH_RESULT__test__";

const TEST_ENV: EnvironmentConfig = {
  id: "test",
  name: "test",
  label: "Test",
  kind: "local",
  host: "localhost",
  mongoHost: "mongo.example",
  mongoPort: 27017,
  databaseName: "target_db",
  mongoUser: "user@example.com",
  mongoPassword: "pass word",
  authSource: "admin",
  isProduction: false
};

test("mongo URI builders distinguish database and server scope", () => {
  assert.match(
    mongoDatabaseUri(TEST_ENV),
    /@mongo\.example:27017\/target_db\?/
  );
  assert.match(mongoServerUri(TEST_ENV), /@mongo\.example:27017\/\?/);
  assert.doesNotMatch(mongoServerUri(TEST_ENV), /target_db/);
});

test("credential-less Mongo URIs omit authSource", () => {
  const noAuthEnvironment = {
    ...TEST_ENV,
    mongoUser: "",
    mongoPassword: ""
  };
  assert.equal(
    mongoServerUri(noAuthEnvironment),
    "mongodb://mongo.example:27017/"
  );
});

test("restore namespace contract covers full and collection scope", () => {
  assert.deepEqual(
    buildRestoreNamespaceContract(TEST_ENV, {
      sourceDatabaseName: "target_db"
    }),
    {
      sourceNamespace: "target_db.*",
      targetNamespace: "target_db.*",
      args: []
    }
  );
  assert.deepEqual(
    buildRestoreNamespaceContract(TEST_ENV, {
      sourceDatabaseName: "target_db",
      collection: "orders"
    }).args,
    ["--nsInclude", "target_db.orders"]
  );
  assert.deepEqual(
    buildRestoreNamespaceContract(TEST_ENV, {
      sourceDatabaseName: "archive_db"
    }).args,
    [
      "--nsInclude",
      "archive_db.*",
      "--nsFrom",
      "archive_db.*",
      "--nsTo",
      "target_db.*"
    ]
  );
  assert.deepEqual(
    buildRestoreNamespaceContract(TEST_ENV, {
      sourceDatabaseName: "archive_db",
      collection: "orders"
    }).args,
    [
      "--nsInclude",
      "archive_db.orders",
      "--nsFrom",
      "archive_db.orders",
      "--nsTo",
      "target_db.orders"
    ]
  );
});

test("restore namespace contract rejects wildcard collection filters", () => {
  assert.throws(
    () =>
      buildRestoreNamespaceContract(TEST_ENV, {
        sourceDatabaseName: "archive_db",
        collection: "orders*"
      }),
    /cannot be represented as an exact namespace filter/
  );
});

test("parseArchiveInspection returns exact mappings and requires completion", () => {
  const result = parseArchiveInspection(
    [
      "archive prelude archive_db.unrelated",
      "found collection archive_db.orders bson to restore to target_db.orders",
      "found collection metadata from archive_db.orders to restore to target_db.orders",
      "2 document(s) restored successfully. 0 document(s) failed to restore."
    ].join("\n"),
    "archive_db",
    "target_db"
  );
  assert.deepEqual(result.collections, ["orders"]);
  assert.deepEqual(result.mappings, [
    {
      sourceNamespace: "archive_db.orders",
      targetNamespace: "target_db.orders"
    }
  ]);
  assert.equal(result.completed, true);
  assert.throws(
    () =>
      parseArchiveInspection(
        "found collection archive_db.orders",
        "archive_db",
        "target_db"
      ),
    /recognized completion signal/
  );
});

test("parseMongoShellCollectionList ignores diagnostics around a tagged result", () => {
  assert.deepEqual(
    parseMongoShellCollectionList(
      "Warning: mongosh diagnostic\n" +
        `${RESULT_MARKER}["orders","customers"]\n` +
        "post-result diagnostic",
      RESULT_MARKER
    ),
    ["orders", "customers"]
  );
});

test("parseMongoShellCollectionCounts ignores diagnostics around a tagged result", () => {
  assert.deepEqual(
    parseMongoShellCollectionCounts(
      `Warning: mongosh diagnostic\n${RESULT_MARKER}{"orders":5,"customers":2}`,
      RESULT_MARKER,
      ["orders", "customers"]
    ),
    { orders: 5, customers: 2 }
  );
});

test("parseMongoShellResult fails closed for missing, duplicate, or malformed results", () => {
  assert.throws(
    () => parseMongoShellResult("Warning only", RESULT_MARKER),
    /no tagged machine-readable result/
  );
  assert.throws(
    () =>
      parseMongoShellResult(
        `${RESULT_MARKER}{"orders":1}\n${RESULT_MARKER}{"orders":1}`,
        RESULT_MARKER
      ),
    /multiple tagged machine-readable results/
  );
  assert.throws(
    () => parseMongoShellResult(`${RESULT_MARKER}{invalid}`, RESULT_MARKER),
    /malformed tagged machine-readable result/
  );
});

test("parseMongoShellPingResult ignores diagnostics and requires a successful ping", () => {
  assert.doesNotThrow(() =>
    parseMongoShellPingResult(
      `warning\n${RESULT_MARKER}{"ok":1}\npost-result diagnostic`,
      RESULT_MARKER
    )
  );
  assert.throws(
    () => parseMongoShellPingResult(`${RESULT_MARKER}{"ok":0}`, RESULT_MARKER),
    /invalid ping result/
  );
});

test("parseMongoShellCollectionCounts fails closed for incomplete or invalid counts", () => {
  assert.throws(
    () =>
      parseMongoShellCollectionCounts(
        `${RESULT_MARKER}{"orders":5}`,
        RESULT_MARKER,
        ["orders", "customers"]
      ),
    /incomplete or ambiguous collection counts/
  );
  assert.throws(
    () =>
      parseMongoShellCollectionCounts(
        `${RESULT_MARKER}{"orders":-1}`,
        RESULT_MARKER,
        ["orders"]
      ),
    /invalid count for orders/
  );
});

test("listCollections preserves a nonzero mongosh failure", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "db-helper-mongosh-failure-"));
  const mongoshPath = path.join(root, "mongosh");
  await writeFile(
    mongoshPath,
    "#!/bin/sh\nprintf 'shell failed\\n' >&2\nexit 7\n",
    "utf8"
  );
  await chmod(mongoshPath, 0o755);

  const env: EnvironmentConfig = {
    id: "test",
    name: "test",
    label: "Test",
    kind: "local",
    host: "localhost",
    mongoHost: "localhost",
    mongoPort: 27017,
    databaseName: "test",
    mongoUser: "user",
    mongoPassword: "pass",
    authSource: "admin",
    isProduction: false
  };

  try {
    await assert.rejects(
      listCollections(env, { outputMode: "quiet", env: { PATH: root } }),
      /Command failed \(7\): mongosh/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parseArchiveCollections recognizes mongorestore dry-run restore targets", () => {
  const output = [
    "2026-04-28T21:31:04.842-0500\tarchive prelude source_db.alpha",
    "2026-04-28T21:31:04.842-0500\tarchive prelude source_db.beta",
    "2026-04-28T21:31:04.842-0500\tfound collection source_db.alpha bson to restore to target_db.alpha",
    "2026-04-28T21:31:04.842-0500\tfound collection metadata from source_db.alpha to restore to target_db.alpha",
    "2026-04-28T21:31:04.842-0500\tfound collection source_db.beta bson to restore to target_db.beta",
    "2026-04-28T21:31:04.842-0500\tfound collection metadata from source_db.beta to restore to target_db.beta"
  ].join("\n");

  assert.deepEqual(parseArchiveCollections(output, "source_db", "target_db"), [
    "alpha",
    "beta"
  ]);
});

test("parseArchiveCollections recognizes source-namespace-only dry-run output", () => {
  const output = [
    "2026-04-28T21:31:04.842-0500\treading metadata for source_db.alpha from archive",
    "2026-04-28T21:31:04.842-0500\treading metadata for source_db.beta from archive",
    "2026-04-28T21:31:04.842-0500\trestoring to existing collection source_db.alpha without dropping",
    "2026-04-28T21:31:04.842-0500\trestoring source_db.beta from archive"
  ].join("\n");

  assert.deepEqual(parseArchiveCollections(output, "source_db", "target_db"), [
    "alpha",
    "beta"
  ]);
});

test("parseArchiveCollections recognizes backtick-quoted dry-run namespaces", () => {
  const output = [
    "2026-04-30T16:49:30.637-0500\tarchive prelude `production.newsletters`",
    "2026-04-30T16:49:30.638-0500\tfound collection `production.newsletters` bson to restore to `development.newsletters`",
    "2026-04-30T16:49:30.638-0500\tfound collection metadata from `production.newsletters` to restore to `development.newsletters`"
  ].join("\n");

  assert.deepEqual(
    parseArchiveCollections(output, "production", "development"),
    ["newsletters"]
  );
});

test("parseArchiveCollections still supports direct target namespace matches", () => {
  const output = [
    "2026-04-28T21:31:04.842-0500\treading metadata for target_db.orders from archive",
    "2026-04-28T21:31:04.842-0500\trestoring to collection target_db.customers without dropping"
  ].join("\n");

  assert.deepEqual(parseArchiveCollections(output, "source_db", "target_db"), [
    "customers",
    "orders"
  ]);
});

test("translateRemoteProcessError normalizes host trust failures", () => {
  const error = translateRemoteProcessError({
    host: "gnomebrewshop.com",
    operation: "ssh",
    error: new Error(
      "Command failed (255): ssh 'host'\n" +
        "hostkeys_foreach failed: Operation not permitted"
    )
  });

  assert.ok(error instanceof RemoteOperationError);
  assert.equal(error.code, "sshTransport");
  assert.equal(
    error.details,
    "SSH could not verify or access host-key trust for gnomebrewshop.com. Check known_hosts access and trust the host before retrying."
  );
});

test("translateRemoteProcessError keeps generic ssh transport failures typed", () => {
  const error = translateRemoteProcessError({
    host: "gnomebrewshop.com",
    operation: "ssh",
    error: new Error("Command failed (255): ssh 'host'\nconnection reset")
  });

  assert.equal(error.code, "sshTransport");
  assert.match(error.details, /SSH transport to gnomebrewshop\.com failed/);
  assert.match(error.details, /connection reset/);
});

test("translateRemoteProcessError marks scp upload and preserves remote temp path", () => {
  const error = translateRemoteProcessError({
    host: "gnomebrewshop.com",
    operation: "scp-upload",
    remoteTempPath: "/tmp/db-helper/upload.archive.gz",
    error: new Error("Command failed (1): scp\npermission denied")
  });

  assert.equal(error.code, "scpTransport");
  assert.equal(error.operation, "scp-upload");
  assert.equal(error.remoteTempPath, "/tmp/db-helper/upload.archive.gz");
  assert.match(error.details, /SCP transport to gnomebrewshop\.com failed/);
});

test("combineRemoteTransportErrors preserves primary failure and remote temp path", () => {
  const primary = new RemoteOperationError({
    code: "scpTransport",
    host: "gnomebrewshop.com",
    operation: "scp-download",
    remoteTempPath: "/tmp/db-helper/source.archive.gz",
    details:
      "SCP transport to gnomebrewshop.com failed during scp-download.\nnetwork error"
  });
  const cleanup = new RemoteOperationError({
    code: "remoteCleanupFailed",
    host: "gnomebrewshop.com",
    operation: "remote-cleanup",
    remoteTempPath: "/tmp/db-helper/source.archive.gz",
    details: "Remote cleanup failed on gnomebrewshop.com.\npermission denied"
  });

  const combined = combineRemoteTransportErrors(
    primary,
    cleanup,
    "/tmp/db-helper/source.archive.gz"
  );

  assert.equal(combined.code, "scpTransport");
  assert.equal(combined.remoteTempPath, "/tmp/db-helper/source.archive.gz");
  assert.match(combined.details, /network error/);
  assert.match(
    combined.details,
    /Remote temporary archive cleanup failed: Remote cleanup failed on gnomebrewshop\.com/
  );
});

test("prepared remote archive session uploads, dry-runs, mutates, and cleans exactly once", async () => {
  const events: string[] = [];
  const remoteEnvironment: EnvironmentConfig = {
    ...TEST_ENV,
    kind: "remote",
    id: "remote",
    name: "remote",
    host: "remote.example.com"
  };
  const dependencies: PrepareArchiveRestoreDependencies = {
    async runRemote(_env, command): Promise<string> {
      if (command.startsWith("mkdir")) {
        events.push("mkdir");
        return "";
      }
      if (command.includes("--dryRun")) {
        events.push("dry-run");
        return [
          "found collection archive_db.orders bson to restore to target_db.orders",
          "found collection metadata from archive_db.orders to restore to target_db.orders",
          "2 document(s) restored successfully. 0 document(s) failed to restore."
        ].join("\n");
      }
      events.push("mutation");
      return "";
    },
    async copyToRemote(): Promise<void> {
      events.push("upload");
    },
    async cleanupRemoteArchive(): Promise<void> {
      events.push("cleanup");
    },
    async runCommandViaShell(): Promise<string> {
      throw new Error("local shell should not run");
    },
    async runCommand() {
      throw new Error("local restore should not run");
    }
  };

  const session = await prepareArchiveRestoreSession(
    remoteEnvironment,
    {
      backupRoot: "/tmp/backups",
      tempRoot: "/tmp/db-helper",
      authSource: "admin",
      defaultDropOnRestore: true,
      environments: { remote: remoteEnvironment }
    },
    "/tmp/source.archive.gz",
    { sourceDatabaseName: "archive_db", outputMode: "quiet" },
    dependencies
  );
  const mutationStates: string[] = [];
  await session.restore({
    drop: true,
    outputMode: "quiet",
    onMutationState: (state) => mutationStates.push(state)
  });
  await session.cleanup();
  await session.cleanup();

  assert.deepEqual(events, [
    "mkdir",
    "upload",
    "dry-run",
    "mutation",
    "cleanup"
  ]);
  assert.deepEqual(mutationStates, ["in_progress", "subprocess_succeeded"]);
  assert.deepEqual(session.inspection.collections, ["orders"]);
});
