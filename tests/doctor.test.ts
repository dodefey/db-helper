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

function createDoctorDependencies(
  overrides: Partial<DoctorDependencies> = {}
): {
  dependencies: DoctorDependencies;
  calls: {
    output: string[];
    binaries: string[];
    writablePaths: string[];
    readablePaths: string[];
    preflight: EnvironmentId[];
    connectivity: EnvironmentId[];
  };
} {
  const calls = {
    output: [] as string[],
    binaries: [] as string[],
    writablePaths: [] as string[],
    readablePaths: [] as string[],
    preflight: [] as EnvironmentId[],
    connectivity: [] as EnvironmentId[]
  };

  const dependencies: DoctorDependencies = {
    async ensureBinary(name: string): Promise<void> {
      calls.binaries.push(name);
    },
    async assertWritable(path: string): Promise<void> {
      calls.writablePaths.push(path);
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
    async ensureBinary(name: string): Promise<void> {
      calls.binaries.push(name);
      if (name === "mongosh") {
        throw new Error("missing binary");
      }
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

test("runDoctor reports unreadable remote ssh key and continues", async () => {
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
  assert.deepEqual(calls.preflight, ["test"]);
  assert.deepEqual(calls.connectivity, ["development", "test", "production"]);
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
    async ensureBinary(name: string): Promise<void> {
      calls.binaries.push(name);
      if (name === "mongorestore") {
        throw new Error("missing binary");
      }
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
  assert.deepEqual(calls.preflight, ["production"]);
  assert.deepEqual(calls.connectivity, ["development", "production"]);
});

test("runDoctor throws an already-reported doctor error on failure", async () => {
  const { dependencies } = createDoctorDependencies({
    async ensureBinary(): Promise<void> {
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
