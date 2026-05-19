import test from "node:test";
import assert from "node:assert/strict";
import { EnvironmentConfig } from "../src/config/types.js";
import {
  createRemotePreflightSession,
  ensureRemotePreflight,
  RemotePreflightError
} from "../src/lib/remotePreflight.js";

function buildEnvironment(
  overrides: Partial<EnvironmentConfig> = {}
): EnvironmentConfig {
  return {
    id: "production",
    name: "production",
    label: "Production",
    kind: "remote",
    host: "prod.example.com",
    mongoHost: "localhost",
    mongoPort: 27017,
    databaseName: "production",
    mongoUser: "user",
    mongoPassword: "pass",
    authSource: "admin",
    isProduction: true,
    sshUser: "ubuntu",
    sshKeyPath: "/tmp/test-key.pem",
    ...overrides
  };
}

test("ensureRemotePreflight no-ops for local environments", async () => {
  const session = createRemotePreflightSession();
  let commandCount = 0;

  await ensureRemotePreflight(
    session,
    buildEnvironment({ kind: "local", host: "localhost", isProduction: false }),
    ["hostKeyAccess"],
    {
      async runCommand(): Promise<string> {
        commandCount += 1;
        return "";
      }
    }
  );

  assert.equal(commandCount, 0);
});

test("ensureRemotePreflight succeeds with a non-interactive SSH probe", async () => {
  const session = createRemotePreflightSession();
  const commands: Array<{ command: string; args: string[] }> = [];

  await ensureRemotePreflight(session, buildEnvironment(), ["hostKeyAccess"], {
    async runCommand(command, args): Promise<string> {
      commands.push({ command, args });
      return "";
    }
  });

  assert.deepEqual(commands, [
    {
      command: "ssh",
      args: [
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "ConnectTimeout=5",
        "-i",
        "/tmp/test-key.pem",
        "ubuntu@prod.example.com",
        "true"
      ]
    }
  ]);
});

test("ensureRemotePreflight reports hostNotTrusted for trust failures", async () => {
  const session = createRemotePreflightSession();

  await assert.rejects(
    ensureRemotePreflight(session, buildEnvironment(), ["hostKeyAccess"], {
      async runCommand(): Promise<string> {
        throw new Error(
          "Command failed (255): ssh 'host'\nHost key verification failed."
        );
      }
    }),
    (error: unknown) =>
      error instanceof RemotePreflightError &&
      error.code === "hostNotTrusted" &&
      error.lookupNames.length === 0 &&
      error.knownHostsPaths.length === 0
  );
});

test("ensureRemotePreflight reports knownHostsAccess for unreadable known_hosts", async () => {
  const session = createRemotePreflightSession();

  await assert.rejects(
    ensureRemotePreflight(session, buildEnvironment(), ["hostKeyAccess"], {
      async runCommand(): Promise<string> {
        throw new Error(
          "Command failed (255): ssh 'host'\nhostkeys_foreach failed: Operation not permitted"
        );
      }
    }),
    (error: unknown) =>
      error instanceof RemotePreflightError &&
      error.code === "knownHostsAccess" &&
      error.lookupNames.length === 0 &&
      error.knownHostsPaths.length === 0
  );
});

test("ensureRemotePreflight reports preflightFailed for generic SSH failures", async () => {
  const session = createRemotePreflightSession();

  await assert.rejects(
    ensureRemotePreflight(session, buildEnvironment(), ["hostKeyAccess"], {
      async runCommand(): Promise<string> {
        throw new Error(
          "Command failed (255): ssh 'host'\nPermission denied (publickey)."
        );
      }
    }),
    (error: unknown) =>
      error instanceof RemotePreflightError && error.code === "preflightFailed"
  );
});

test("ensureRemotePreflight caches successful checks for the session", async () => {
  const session = createRemotePreflightSession();
  let commandCount = 0;

  const dependencies = {
    async runCommand(): Promise<string> {
      commandCount += 1;
      return "";
    }
  };

  await ensureRemotePreflight(
    session,
    buildEnvironment(),
    ["hostKeyAccess"],
    dependencies
  );
  await ensureRemotePreflight(
    session,
    buildEnvironment(),
    ["hostKeyAccess"],
    dependencies
  );

  assert.equal(commandCount, 1);
});

test("ensureRemotePreflight caches failed checks for the session", async () => {
  const session = createRemotePreflightSession();
  let commandCount = 0;

  const dependencies = {
    async runCommand(): Promise<string> {
      commandCount += 1;
      throw new Error(
        "Command failed (255): ssh 'host'\nHost key verification failed."
      );
    }
  };

  await assert.rejects(
    ensureRemotePreflight(
      session,
      buildEnvironment(),
      ["hostKeyAccess"],
      dependencies
    ),
    /host is not trusted/
  );
  await assert.rejects(
    ensureRemotePreflight(
      session,
      buildEnvironment(),
      ["hostKeyAccess"],
      dependencies
    ),
    /host is not trusted/
  );

  assert.equal(commandCount, 1);
});
