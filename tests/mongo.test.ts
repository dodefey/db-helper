import test from "node:test";
import assert from "node:assert/strict";

import {
  combineRemoteTransportErrors,
  parseArchiveCollections,
  RemoteOperationError,
  translateRemoteProcessError
} from "../src/lib/mongo.js";

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
