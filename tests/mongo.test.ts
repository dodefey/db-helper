import test from "node:test";
import assert from "node:assert/strict";

import { parseArchiveCollections } from "../src/lib/mongo.js";

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
