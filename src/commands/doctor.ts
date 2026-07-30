import {
  access,
  mkdir,
  stat,
  statfs,
  unlink,
  writeFile
} from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import {
  AppConfig,
  EnvironmentConfig,
  EnvironmentId
} from "../config/types.js";
import { assertWritable } from "../lib/fs.js";
import {
  CommandInvocationContext,
  createCommandInvocationContext
} from "../lib/invocationContext.js";
import { verifyConnectivity } from "../lib/mongo.js";
import { ensureRemotePreflight } from "../lib/remotePreflight.js";
import { runCommand } from "../lib/exec.js";
import { getRunLogger } from "../lib/runLog.js";

const REQUIRED_BINARIES = [
  "mongodump",
  "mongorestore",
  "mongosh",
  "ssh",
  "scp"
] as const;

type DoctorStatus = "pass" | "warn" | "fail";
type DoctorScope = "global" | "backupRoot" | "tempRoot" | EnvironmentId;

const MIN_FREE_SPACE_BYTES = 1024 * 1024 * 1024;
const TOOL_VERSION_FLOORS: Record<string, [number, number, number]> = {
  mongosh: [2, 9, 2],
  mongodump: [100, 16, 1],
  mongorestore: [100, 16, 1]
};

interface DoctorCheckResult {
  check: string;
  scope: DoctorScope;
  status: DoctorStatus;
  message: string;
}

export class DoctorCommandError extends Error {
  readonly alreadyReported = true;
}

export interface DoctorDependencies {
  ensureBinary: (name: string) => Promise<string>;
  assertWritable: (path: string) => Promise<void>;
  assertReadable: (path: string) => Promise<void>;
  getFreeSpace: (path: string) => Promise<number>;
  probeMongoShellState: () => Promise<string>;
  ensureRemotePreflight: (
    context: CommandInvocationContext,
    env: EnvironmentConfig
  ) => Promise<void>;
  verifyConnectivity: (
    env: EnvironmentConfig,
    context: CommandInvocationContext
  ) => Promise<void>;
  writeStdout: (message: string) => void;
}

const DEFAULT_DOCTOR_DEPENDENCIES: DoctorDependencies = {
  async ensureBinary(name: string): Promise<string> {
    if (!TOOL_VERSION_FLOORS[name]) {
      return findExecutable(name);
    }

    const version = await runCommand(name, ["--version"], {
      streamOutput: false
    });
    if (!version) {
      throw new Error(`${name} did not report a version`);
    }
    return version;
  },
  assertWritable,
  async getFreeSpace(path: string): Promise<number> {
    const stats = await statfs(path);
    return stats.bavail * stats.bsize;
  },
  async probeMongoShellState(): Promise<string> {
    const stateDirectory =
      process.env.MONGOSH_CONFIG_DIR ||
      path.join(homedir(), ".mongodb", "mongosh");
    await mkdir(stateDirectory, { recursive: true });
    await access(stateDirectory, constants.R_OK | constants.W_OK);
    const probePath = path.join(
      stateDirectory,
      `.dbh-doctor-${randomUUID()}.probe`
    );
    await writeFile(probePath, "doctor probe\n", { flag: "wx" });
    await unlink(probePath);
    return stateDirectory;
  },
  async assertReadable(path: string): Promise<void> {
    await access(path, constants.R_OK);
  },
  async ensureRemotePreflight(
    context: CommandInvocationContext,
    env: EnvironmentConfig
  ): Promise<void> {
    await ensureRemotePreflight(context.remotePreflightSession, env, [
      "hostKeyAccess"
    ]);
  },
  async verifyConnectivity(
    env: EnvironmentConfig,
    context: CommandInvocationContext
  ): Promise<void> {
    await verifyConnectivity(env, {
      remotePreflightSession: context.remotePreflightSession
    });
  },
  writeStdout: (message: string): void => {
    process.stdout.write(message);
  }
};

function formatDoctorLine(result: DoctorCheckResult): string {
  const label = result.status.toUpperCase();
  const scope =
    result.scope === "global"
      ? ""
      : result.scope === "backupRoot"
        ? " backupRoot"
        : result.scope === "tempRoot"
          ? " tempRoot"
          : ` environment ${result.scope}`;

  return `${label}${scope} ${result.check}: ${result.message}\n`;
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

async function findExecutable(name: string): Promise<string> {
  const pathEntries = process.env.PATH
    ? process.env.PATH.split(path.delimiter)
    : ["."];

  for (const pathEntry of pathEntries) {
    const candidate = path.join(pathEntry || ".", name);
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) {
        return candidate;
      }
    } catch {
      // Continue searching the remaining PATH entries.
    }
  }

  throw new Error(`${name} executable not found on PATH`);
}

function firstVersionLine(output: string): string {
  return output.split(/\r?\n/, 1)[0]?.trim() || output.trim();
}

function parseVersion(
  output: string,
  binary: string
): [number, number, number] {
  const match = output.match(/(?:^|\s|v)(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) {
    throw new Error(
      `Could not parse ${binary} version from ${firstVersionLine(output)}`
    );
  }
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

function compareVersions(
  actual: [number, number, number],
  minimum: [number, number, number]
): number {
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] !== minimum[index]) {
      return actual[index] - minimum[index];
    }
  }
  return 0;
}

function assertSupportedVersion(binary: string, output: string): string {
  const minimum = TOOL_VERSION_FLOORS[binary];
  const display = firstVersionLine(output);
  if (!minimum) {
    return display;
  }
  const actual = parseVersion(output, binary);
  if (compareVersions(actual, minimum) < 0) {
    throw new Error(
      `${binary} version ${actual.join(".")} is below the supported minimum ${minimum.join(".")}`
    );
  }
  return display;
}

async function runCheck(
  results: DoctorCheckResult[],
  result: Omit<DoctorCheckResult, "status" | "message">,
  operation: () => Promise<string | void>
): Promise<boolean> {
  try {
    const message = await operation();
    results.push({
      ...result,
      status: "pass",
      message: message || "ok"
    });
    return true;
  } catch (error) {
    results.push({
      ...result,
      status: "fail",
      message: error instanceof Error ? error.message : String(error)
    });
    return false;
  }
}

async function runWarningCheck(
  results: DoctorCheckResult[],
  result: Omit<DoctorCheckResult, "status" | "message">,
  operation: () => Promise<string | void>
): Promise<void> {
  try {
    const message = await operation();
    results.push({
      ...result,
      status: "pass",
      message: message || "ok"
    });
  } catch (error) {
    results.push({
      ...result,
      status: "warn",
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

function hasMongoCredentials(env: EnvironmentConfig): boolean {
  return Boolean(env.mongoUser && env.mongoPassword);
}

export async function runDoctor(
  appConfig: AppConfig,
  dependencies: DoctorDependencies = DEFAULT_DOCTOR_DEPENDENCIES,
  context: CommandInvocationContext = createCommandInvocationContext()
): Promise<void> {
  const runLogger = getRunLogger();
  const results: DoctorCheckResult[] = [];

  runLogger.info("doctor", "Starting doctor checks");
  dependencies.writeStdout("Running doctor checks...\n");

  for (const binary of REQUIRED_BINARIES) {
    await runCheck(
      results,
      { check: `binary ${binary}`, scope: "global" },
      async () =>
        assertSupportedVersion(binary, await dependencies.ensureBinary(binary))
    );
  }

  await runCheck(results, { check: "writable", scope: "backupRoot" }, () =>
    dependencies.assertWritable(appConfig.backupRoot)
  );
  await runCheck(results, { check: "writable", scope: "tempRoot" }, () =>
    dependencies.assertWritable(appConfig.tempRoot)
  );
  await runCheck(
    results,
    { check: "free space", scope: "backupRoot" },
    async () => {
      const available = await dependencies.getFreeSpace(appConfig.backupRoot);
      if (available < MIN_FREE_SPACE_BYTES) {
        throw new Error(
          `${formatBytes(available)} available; minimum is ${formatBytes(MIN_FREE_SPACE_BYTES)}`
        );
      }
      return `${formatBytes(available)} available`;
    }
  );
  await runCheck(
    results,
    { check: "free space", scope: "tempRoot" },
    async () => {
      const available = await dependencies.getFreeSpace(appConfig.tempRoot);
      if (available < MIN_FREE_SPACE_BYTES) {
        throw new Error(
          `${formatBytes(available)} available; minimum is ${formatBytes(MIN_FREE_SPACE_BYTES)}`
        );
      }
      return `${formatBytes(available)} available`;
    }
  );
  await runWarningCheck(
    results,
    { check: "mongosh state", scope: "global" },
    () => dependencies.probeMongoShellState()
  );

  for (const env of Object.values(appConfig.environments)) {
    if (env.kind === "remote" && env.sshKeyPath) {
      const sshKeyReadable = await runCheck(
        results,
        { check: "ssh key", scope: env.id },
        () => dependencies.assertReadable(env.sshKeyPath!)
      );
      if (!sshKeyReadable) {
        continue;
      }
    }

    if (!hasMongoCredentials(env)) {
      results.push({
        check: "credentials",
        scope: env.id,
        status: "fail",
        message: `Mongo credentials missing for ${env.id}`
      });
      continue;
    }

    if (env.kind === "remote") {
      const hostKeyReady = await runCheck(
        results,
        { check: "SSH preflight", scope: env.id },
        () => dependencies.ensureRemotePreflight(context, env)
      );
      if (!hostKeyReady) {
        continue;
      }
    }

    await runCheck(
      results,
      { check: "connectivity (tagged result probe)", scope: env.id },
      () => dependencies.verifyConnectivity(env, context)
    );
  }

  for (const result of results) {
    dependencies.writeStdout(formatDoctorLine(result));
  }

  const failures = results.filter((result) => result.status === "fail");
  const warnings = results.filter((result) => result.status === "warn");
  if (failures.length > 0) {
    runLogger.warn("doctor", "Doctor checks completed with failures", {
      failureCount: failures.length,
      failedChecks: failures.map((failure) => ({
        check: failure.check,
        scope: failure.scope,
        message: failure.message
      }))
    });
    dependencies.writeStdout(
      `Doctor checks failed: ${failures.length} issue(s).\n`
    );
    throw new DoctorCommandError(
      `Doctor checks failed: ${failures.length} issue(s).`
    );
  }

  if (warnings.length > 0) {
    runLogger.warn("doctor", "Doctor checks passed with warnings", {
      warningCount: warnings.length,
      warnings: warnings.map((warning) => ({
        check: warning.check,
        scope: warning.scope,
        message: warning.message
      }))
    });
    dependencies.writeStdout(
      `Doctor checks passed with ${warnings.length} warning(s).\n`
    );
    return;
  }

  runLogger.info("doctor", "Doctor checks passed");
  dependencies.writeStdout("Doctor checks passed.\n");
}
