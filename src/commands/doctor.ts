import { access } from "node:fs/promises";
import { constants } from "node:fs";
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

type DoctorStatus = "pass" | "fail";
type DoctorScope = "global" | "backupRoot" | "tempRoot" | EnvironmentId;

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
    const version = await runCommand(name, ["--version"], {
      streamOutput: false
    });
    if (!version) {
      throw new Error(`${name} did not report a version`);
    }
    return version;
  },
  assertWritable,
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
      () => dependencies.ensureBinary(binary)
    );
  }

  await runCheck(results, { check: "writable", scope: "backupRoot" }, () =>
    dependencies.assertWritable(appConfig.backupRoot)
  );
  await runCheck(results, { check: "writable", scope: "tempRoot" }, () =>
    dependencies.assertWritable(appConfig.tempRoot)
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

  runLogger.info("doctor", "Doctor checks passed");
  dependencies.writeStdout("Doctor checks passed.\n");
}
