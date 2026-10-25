import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCommand } from "../src/lib/exec.js";
import {
  createRunLogger,
  redactText,
  setRunLogger
} from "../src/lib/runLog.js";

test("run logger redacts MongoDB passwords in text", () => {
  const input =
    'mongodb://sysadmin:secret-pass@localhost:27017/development?authSource=admin {"mongoPassword":"another-secret"}';

  assert.equal(
    redactText(input),
    'mongodb://sysadmin:<redacted>@localhost:27017/development?authSource=admin {"mongoPassword":"<redacted>"}'
  );
});

test("runCommand writes subprocess details to the run log with redaction", async () => {
  const logRoot = await mkdtemp(path.join(tmpdir(), "db-helper-run-log-"));
  const logger = await createRunLogger({ commandName: "exec-test", logRoot });
  setRunLogger(logger);

  try {
    await runCommand(
      "node",
      [
        "-e",
        "console.log('mongodb://user:secret@localhost:27017/test?authSource=admin')"
      ],
      {
        streamOutput: false
      }
    );

    await logger.finalizeFailure();
    const content = await readFile(logger.logPath, "utf8");
    assert.match(content, /Starting subprocess/);
    assert.match(content, /Subprocess completed/);
    assert.doesNotMatch(content, /secret@localhost/);
    assert.match(content, /<redacted>@localhost/);
  } finally {
    setRunLogger();
    await rm(logRoot, { recursive: true, force: true });
  }
});

test("run logs stay private through writes, relocation, and recreation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "db-helper-private-log-"));
  const previousUmask = process.umask(0);
  try {
    const logger = await createRunLogger({
      commandName: "privacy",
      logRoot: root
    });
    assert.equal((await stat(logger.logPath)).mode & 0o777, 0o600);
    logger.info("test", "Before relocation");

    const destination = path.join(root, "existing-shared-root");
    await mkdir(destination, { mode: 0o755 });
    await logger.relocate(destination);
    logger.info("test", "After relocation");
    await logger.finalizeFailure();

    assert.equal((await stat(logger.logPath)).mode & 0o777, 0o600);
    assert.equal((await stat(destination)).mode & 0o777, 0o755);
    const content = await readFile(logger.logPath, "utf8");
    assert.match(content, /Before relocation/);
    assert.match(content, /After relocation/);

    await rm(logger.logPath);
    logger.info("test", "Recreated log");
    await logger.finalizeFailure();
    assert.equal((await stat(logger.logPath)).mode & 0o777, 0o600);
  } finally {
    process.umask(previousUmask);
    await rm(root, { recursive: true, force: true });
  }
});
