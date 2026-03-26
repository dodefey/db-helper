import { BackupManifest, EnvironmentConfig, VerifyRestoreResult } from "../config/types.js";
import { getCollectionCounts, listCollections } from "./mongo.js";

export async function verifyRestore(env: EnvironmentConfig, manifest: BackupManifest): Promise<VerifyRestoreResult> {
  const presentCollections = await listCollections(env);
  const presentSet = new Set(presentCollections);
  const missingCollections = manifest.collectionList.filter((collection) => !presentSet.has(collection));
  const countMismatches: VerifyRestoreResult["countMismatches"] = [];

  if (manifest.collectionCounts && Object.keys(manifest.collectionCounts).length > 0) {
    const restoredCounts = await getCollectionCounts(env, Object.keys(manifest.collectionCounts));
    for (const [collection, expected] of Object.entries(manifest.collectionCounts)) {
      const actual = restoredCounts[collection];
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
