import {
  BackupManifest,
  EnvironmentConfig,
  VerifyRestoreResult
} from "../config/types.js";
import { CommandInvocationContext } from "./invocationContext.js";
import { OutputMode } from "./output.js";
import { getCollectionCounts, listCollections } from "./mongo.js";

export async function verifyRestore(
  env: EnvironmentConfig,
  manifest: BackupManifest,
  options: {
    outputMode?: OutputMode;
    signal?: AbortSignal;
    remotePreflightSession?: CommandInvocationContext["remotePreflightSession"];
    onCountedCollection?: (progress: {
      completed: number;
      total: number;
      collection: string;
    }) => void;
  } = {}
): Promise<VerifyRestoreResult> {
  const presentCollections = await listCollections(env, options);
  const presentSet = new Set(presentCollections);
  const missingCollections = manifest.collectionList.filter(
    (collection) => !presentSet.has(collection)
  );
  const countMismatches: VerifyRestoreResult["countMismatches"] = [];

  if (
    manifest.collectionCounts &&
    Object.keys(manifest.collectionCounts).length > 0
  ) {
    const collections = Object.keys(manifest.collectionCounts);
    const total = collections.length;
    let completed = 0;

    for (const [collection, expected] of Object.entries(
      manifest.collectionCounts
    )) {
      const restoredCounts = await getCollectionCounts(
        env,
        [collection],
        options
      );
      const actual = restoredCounts[collection];
      completed += 1;
      options.onCountedCollection?.({ completed, total, collection });
      if (actual !== expected) {
        countMismatches.push({ collection, expected, actual });
      }
    }
  }

  return {
    collectionsPresent: presentCollections,
    missingCollections,
    countMismatches
  };
}
