import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRunLogger, setRunLogger } from "../src/lib/runLog.js";

export async function withTestRunLogger<T>(
  commandName: string,
  run: (context: { logPath: string }) => Promise<T>
): Promise<{ result: T; logPath: string; logContent: string }> {
  const logRoot = await mkdtemp(path.join(tmpdir(), "db-helper-test-log-"));
  const logger = await createRunLogger({ commandName, logRoot });
  setRunLogger(logger);

  try {
    const result = await run({ logPath: logger.logPath });
    await logger.finalizeFailure();
    const logContent = await readFile(logger.logPath, "utf8");
    return { result, logPath: logger.logPath, logContent };
  } finally {
    setRunLogger();
  }
}
