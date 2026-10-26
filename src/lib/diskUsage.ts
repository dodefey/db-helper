import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

/** Count allocated bytes without following symlinks or recounting hard links. */
export async function getDirectoryDiskUsage(
  directory: string
): Promise<number> {
  const seen = new Set<string>();

  async function visit(entryPath: string): Promise<number> {
    const stats = await lstat(entryPath);
    const identity = `${stats.dev}:${stats.ino}`;
    if (seen.has(identity)) {
      return 0;
    }
    seen.add(identity);

    if (!Number.isFinite(stats.blocks)) {
      throw new Error(`Allocated disk usage is unavailable for ${entryPath}`);
    }
    let bytes = stats.blocks * 512;
    if (stats.isDirectory()) {
      for (const name of await readdir(entryPath)) {
        bytes += await visit(path.join(entryPath, name));
      }
    }
    return bytes;
  }

  return visit(directory);
}
