import test from "node:test";
import assert from "node:assert/strict";
import {
  AppConfig,
  EnvironmentConfig,
  EnvironmentId
} from "../src/config/types.js";
import {
  DoctorCommandError,
  DoctorDependencies,
  runDoctor
} from "../src/commands/doctor.js";
import { createCommandInvocationContext } from "../src/lib/invocationContext.js";
import { withTestRunLogger } from "./run-log-helpers.js";

function buildEnvironment(
  id: EnvironmentId,
  overrides: Partial<EnvironmentConfig> = {}
): EnvironmentConfig {
  return {
    id,
    name: id,
    label: id,
    kind: "local",
    host: "localhost",
    mongoHost: "localhost",
    mongoPort: 27017,
    databaseName: id,
    mongoUser: "user",
    mongoPassword: "pass",
    authSource: "admin",
    isProduction: id === "production",
    ...overrides
  };
}

function buildAppConfig(
  overrides: Partial<AppConfig> = {},
  environmentOverrides: Partial<
    Record<EnvironmentId, Partial<EnvironmentConfig>>
  > = {}
): AppConfig {
  return {
    backupRoot: "/tmp/backups",
    tempRoot: "/tmp/db-helper",
    authSource: "admin",
    defaultDropOnRestore: true,
    environments: {
      development: buildEnvironment(
        "development",
        environmentOverrides.development
      ),
      test: buildEnvironment("test", environmentOverrides.test),
      production: buildEnvironment(
        "production",
        environmentOverrides.production
      )
    },
    ...overrides
  };
}

function doctorVersion(name: string): string {
  if (name === "mongosh") return "mongosh 2.9.2";
  if (name === "mongodump") return "mongodump version: 100.16.1";
  if (name === "mongorestore") return "mongorestore version: 100.16.1";
  return `${name} version 1.0.0`;
}

function createDoctorDependencies(
  overrides: Partial<DoctorDependencies> = {}
): {
  dependencies: DoctorDependencies;
  calls: {
    output: string[];
    binaries: string[];
    writablePaths: string[];
    freeSpacePaths: string[];
    readablePaths: string[];
    stateProbes: number;
    preflight: EnvironmentId[];
    connectivity: EnvironmentId[];
  };
} {
  const calls = {
    output: [] as string[],
    binaries: [] as string[],
    writablePaths: [] as string[],
    freeSpacePaths: [] as string[],
    readablePaths: [] as string[],
    stateProbes: 0,
    preflight: [] as EnvironmentId[],
    connectivity: [] as EnvironmentId[]
  };

  const dependencies: DoctorDependencies = {
    async ensureBinary(name: string): Promise<string> {
      calls.binaries.push(name);
      return doctorVersion(name);
    },
    async assertWritable(path: string): Promise<void> {
      calls.writablePaths.push(path);
    },
    async getFreeSpace(path: string): Promise<number> {
      calls.freeSpacePaths.push(path);
      return 2 * 1024 * 1024 * 1024;
    },
    async probeMongoShellState(): Promise<string> {
      calls.stateProbes += 1;
      return "/tmp/mongosh";
    },
    async assertReadable(path: string): Promise<void> {
      calls.readablePaths.push(path);
    },
    async ensureRemotePreflight(
      _context,
      env: EnvironmentConfig
    ): Promise<void> {
      calls.preflight.push(env.id);
    },
    async verifyConnectivity(env: EnvironmentConfig): Promise<void> {
      calls.connectivity.push(env.id);
    },
    writeStdout(message: string): void {
      calls.output.push(message);
    },
    ...overrides
  };

  return { dependencies, calls };
}

test("runDoctor reports success when all checks pass", async () => {
  const { dependencies, calls } = createDoctorDependencies();

  await runDoctor(buildAppConfig(), dependencies);

  assert.ok(calls.output.includes("Doctor checks passed.\n"));
  assert.ok(
    calls.output.some((line) =>
      line.includes("PASS binary mongodump: mongodump version: 100.16.1")
    )
  );
  assert.ok(
    calls.output.some((line) =>
      line.includes(
        "PASS environment development connectivity (tagged result probe)"
      )
    )
  );
  assert.deepEqual(calls.binaries, [
    "mongodump",
    "mongorestore",
    "mongosh",
    "ssh",
    "scp"
  ]);
  assert.deepEqual(calls.preflight, []);
  assert.deepEqual(calls.connectivity, ["development", "test", "production"]);
});

test("runDoctor reports binary failure and continues", async () => {
  const { dependencies, calls } = createDoctorDependencies({
    async ensureBinary(name: string): Promise<string> {
      calls.binaries.push(name);
      if (name === "mongosh") {
        throw new Error("missing binary");
      }
      return doctorVersion(name);
    }
  });

  await assert.rejects(
    runDoctor(buildAppConfig(), dependencies),
    /1 issue\(s\)/
  );

  assert.deepEqual(calls.binaries, [
    "mongodump",
    "mongorestore",
    "mongosh",
    "ssh",
    "scp"
  ]);
  assert.deepEqual(calls.preflight, []);
  assert.ok(calls.output.some((line) => line.includes("FAIL binary mongosh")));
  assert.deepEqual(calls.connectivity, ["development", "test", "production"]);
});

test("runDoctor rejects MongoDB tools below the supported floor", async () => {
  const { dependencies, calls } = createDoctorDependencies({
    async ensureBinary(name: string): Promise<string> {
      calls.binaries.push(name);
      return name === "mongodump"
        ? "mongodump version: 100.15.9"
        : doctorVersion(name);
    }
  });

  await assert.rejects(
    runDoctor(buildAppConfig(), dependencies),
    /1 issue\(s\)/
  );
  assert.ok(
    calls.output.some((line) =>
      line.includes("FAIL binary mongodump: mongodump version 100.15.9")
    )
  );
});

test("runDoctor fails closed when a MongoDB tool version is unparseable", async () => {
  const { dependencies, calls } = createDoctorDependencies({
    async ensureBinary(name: string): Promise<string> {
      calls.binaries.push(name);
      return name === "mongosh"
        ? "mongosh development build"
        : doctorVersion(name);
    }
  });

  await assert.rejects(
    runDoctor(buildAppConfig(), dependencies),
    /1 issue\(s\)/
  );
  assert.ok(
    calls.output.some((line) =>
      line.includes("FAIL binary mongosh: Could not parse mongosh version")
    )
  );
});

test("runDoctor blocks when a root has less than 1 GiB free", async () => {
  const { dependencies, calls } = createDoctorDependencies({
    async getFreeSpace(path: string): Promise<number> {
      calls.freeSpacePaths.push(path);
      return path === "/tmp/db-helper" ? 512 * 1024 * 1024 : 2 * 1024 ** 3;
    }
  });

  await assert.rejects(
    runDoctor(buildAppConfig(), dependencies),
    /1 issue\(s\)/
  );
  assert.ok(
    calls.output.some((line) =>
      line.includes(
        "FAIL tempRoot free space: 0.50 GiB available; minimum is 1.00 GiB"
      )
    )
  );
});

test("runDoctor reports mongosh state problems as warnings", async () => {
  const { dependencies, calls } = createDoctorDependencies({
    async probeMongoShellState(): Promise<string> {
      calls.stateProbes += 1;
      throw new Error("state directory is not writable");
    }
  });

  await runDoctor(buildAppConfig(), dependencies);
  assert.ok(
    calls.output.some((line) =>
      line.includes("WARN mongosh state: state directory is not writable")
    )
  );
  assert.ok(calls.output.includes("Doctor checks passed with 1 warning(s).\n"));
});

test("runDoctor preserves blockers alongside warnings", async () => {
  const { dependencies, calls } = createDoctorDependencies({
    async ensureBinary(name: string): Promise<string> {
      calls.binaries.push(name);
      if (name === "mongodump") throw new Error("missing binary");
      return doctorVersion(name);
    },
    async probeMongoShellState(): Promise<string> {
      calls.stateProbes += 1;
      throw new Error("state directory is not writable");
    }
  });

  await assert.rejects(
    runDoctor(buildAppConfig(), dependencies),
    /1 issue\(s\)/
  );
  assert.ok(calls.output.some((line) => line.includes("WARN mongosh state")));
  assert.ok(calls.output.includes("Doctor checks failed: 1 issue(s).\n"));
});

test("runDoctor warning logs redact credential-like content", async () => {
  const { dependencies } = createDoctorDependencies({
    async probeMongoShellState(): Promise<string> {
      throw new Error(
        "mongosh state probe failed for mongodb://user:secret-pass@localhost"
      );
    }
  });

  const { logContent } = await withTestRunLogger("doctor-warning", async () => {
    await runDoctor(buildAppConfig(), dependencies);
  });

  assert.doesNotMatch(logContent, /secret-pass/);
  assert.match(logContent, /Doctor checks passed with warnings/);
});

test("runDoctor reports writable path failures and continues", async () => {
  const { dependencies, calls } = createDoctorDependencies({
    async assertWritable(path: string): Promise<void> {
      calls.writablePaths.push(path);
      if (path === "/tmp/backups") {
        throw new Error("not writable");
      }
    }
  });

  await assert.rejects(
    runDoctor(buildAppConfig(), dependencies),
    /1 issue\(s\)/
  );

  assert.deepEqual(calls.writablePaths, ["/tmp/backups", "/tmp/db-helper"]);
  assert.deepEqual(calls.preflight, []);
  assert.deepEqual(calls.connectivity, ["development", "test", "production"]);
});

test("runDoctor reports unreadable remote ssh key and skips remote checks", async () => {
  const appConfig = buildAppConfig(
    {},
    {
      test: {
        kind: "remote",
        sshKeyPath: "/tmp/test-key.pem",
        sshUser: "ubuntu"
      }
    }
  );
  const { dependencies, calls } = createDoctorDependencies({
    async assertReadable(path: string): Promise<void> {
      calls.readablePaths.push(path);
      throw new Error(`cannot read ${path}`);
    }
  });

  await assert.rejects(runDoctor(appConfig, dependencies), /1 issue\(s\)/);

  assert.deepEqual(calls.readablePaths, ["/tmp/test-key.pem"]);
  assert.deepEqual(calls.preflight, []);
  assert.deepEqual(calls.connectivity, ["development", "production"]);
});

test("runDoctor skips ssh key readability checks when remote ssh key path is omitted", async () => {
  const appConfig = buildAppConfig(
    {},
    {
      test: {
        kind: "remote",
        sshUser: "",
        sshKeyPath: ""
      },
      production: {
        kind: "remote",
        sshUser: ""
      }
    }
  );
  const { dependencies, calls } = createDoctorDependencies();

  await runDoctor(appConfig, dependencies);

  assert.deepEqual(calls.readablePaths, []);
  assert.deepEqual(calls.preflight, ["test", "production"]);
  assert.deepEqual(calls.connectivity, ["development", "test", "production"]);
});

test("runDoctor reports missing credentials and skips connectivity for that environment", async () => {
  const appConfig = buildAppConfig(
    {},
    {
      test: {
        mongoUser: "",
        mongoPassword: ""
      }
    }
  );
  const { dependencies, calls } = createDoctorDependencies();

  await assert.rejects(runDoctor(appConfig, dependencies), /1 issue\(s\)/);

  assert.deepEqual(calls.preflight, []);
  assert.deepEqual(calls.connectivity, ["development", "production"]);
  assert.ok(
    calls.output.some((line) =>
      line.includes("FAIL environment test credentials")
    )
  );
});

test("runDoctor reports connectivity failure and continues checking other environments", async () => {
  const { dependencies, calls } = createDoctorDependencies({
    async verifyConnectivity(env: EnvironmentConfig): Promise<void> {
      calls.connectivity.push(env.id);
      if (env.id === "test") {
        throw new Error("connection refused");
      }
    }
  });
  const appConfig = buildAppConfig(
    {},
    {
      test: {
        kind: "remote",
        sshUser: "ubuntu"
      }
    }
  );

  await assert.rejects(runDoctor(appConfig, dependencies), /1 issue\(s\)/);

  assert.deepEqual(calls.preflight, ["test"]);
  assert.deepEqual(calls.connectivity, ["development", "test", "production"]);
  assert.ok(
    calls.output.some((line) =>
      line.includes("FAIL environment test connectivity")
    )
  );
});

test("runDoctor reports host-key preflight failure and skips connectivity for that environment", async () => {
  const { dependencies, calls } = createDoctorDependencies({
    async ensureRemotePreflight(
      _context,
      env: EnvironmentConfig
    ): Promise<void> {
      calls.preflight.push(env.id);
      if (env.id === "test") {
        throw new Error("known_hosts not readable");
      }
    }
  });

  const appConfig = buildAppConfig(
    {},
    {
      test: {
        kind: "remote",
        sshUser: "ubuntu"
      },
      production: {
        kind: "remote",
        sshUser: "ubuntu"
      }
    }
  );

  await assert.rejects(runDoctor(appConfig, dependencies), /1 issue\(s\)/);

  assert.deepEqual(calls.preflight, ["test", "production"]);
  assert.deepEqual(calls.connectivity, ["development", "production"]);
  assert.ok(
    calls.output.some((line) =>
      line.includes("FAIL environment test SSH preflight")
    )
  );
});

test("runDoctor reports multiple failures and summarizes the total", async () => {
  const appConfig = buildAppConfig(
    {},
    {
      test: {
        mongoUser: "",
        mongoPassword: ""
      },
      production: {
        kind: "remote",
        sshKeyPath: "/tmp/prod-key.pem",
        sshUser: "ubuntu"
      }
    }
  );
  const { dependencies, calls } = createDoctorDependencies({
    async ensureBinary(name: string): Promise<string> {
      calls.binaries.push(name);
      if (name === "mongorestore") {
        throw new Error("missing binary");
      }
      return doctorVersion(name);
    },
    async assertReadable(path: string): Promise<void> {
      calls.readablePaths.push(path);
      throw new Error(`cannot read ${path}`);
    }
  });

  await assert.rejects(runDoctor(appConfig, dependencies), /3 issue\(s\)/);

  assert.ok(
    calls.output.some((line) =>
      line.includes("Doctor checks failed: 3 issue(s).")
    )
  );
  assert.deepEqual(calls.preflight, []);
  assert.deepEqual(calls.connectivity, ["development"]);
});

test("runDoctor throws an already-reported doctor error on failure", async () => {
  const { dependencies } = createDoctorDependencies({
    async ensureBinary(): Promise<string> {
      throw new Error("missing binary");
    }
  });

  await assert.rejects(
    runDoctor(buildAppConfig(), dependencies),
    (error: unknown) =>
      error instanceof DoctorCommandError && error.alreadyReported === true
  );
});

test("runDoctor writes workflow events to the run log", async () => {
  const { dependencies } = createDoctorDependencies();
  const context = createCommandInvocationContext();

  const { logContent } = await withTestRunLogger("doctor", async () => {
    await runDoctor(buildAppConfig(), dependencies, context);
  });

  assert.match(logContent, /\[doctor\] Starting doctor checks/);
  assert.match(logContent, /\[doctor\] Doctor checks passed/);
});
