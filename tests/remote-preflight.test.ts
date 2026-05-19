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
      },
      async pathExists(): Promise<boolean> {
        return true;
      }
    }
  );

  assert.equal(commandCount, 0);
});

test("ensureRemotePreflight succeeds when a trusted host entry is found", async () => {
  const session = createRemotePreflightSession();
  const commands: Array<{ command: string; args: string[] }> = [];

  await ensureRemotePreflight(session, buildEnvironment(), ["hostKeyAccess"], {
    async runCommand(command, args): Promise<string> {
      commands.push({ command, args });
      if (command === "ssh") {
        return [
          "hostname prod.example.com",
          "userknownhostsfile /tmp/known_hosts"
        ].join("\n");
      }
      return "# Host prod.example.com found: line 1\n";
    },
    async pathExists(): Promise<boolean> {
      return true;
    }
  });

  assert.deepEqual(commands, [
    {
      command: "ssh",
      args: ["-G", "-i", "/tmp/test-key.pem", "ubuntu@prod.example.com"]
    },
    {
      command: "ssh-keygen",
      args: ["-F", "prod.example.com", "-f", "/tmp/known_hosts"]
    }
  ]);
});

test("ensureRemotePreflight reports hostNotTrusted when no entry is found", async () => {
  const session = createRemotePreflightSession();

  await assert.rejects(
    ensureRemotePreflight(session, buildEnvironment(), ["hostKeyAccess"], {
      async runCommand(command): Promise<string> {
        if (command === "ssh") {
          return [
            "hostname prod.example.com",
            "userknownhostsfile /tmp/known_hosts"
          ].join("\n");
        }
        throw new Error("Command failed (1): ssh-keygen");
      },
      async pathExists(): Promise<boolean> {
        return true;
      }
    }),
    (error: unknown) =>
      error instanceof RemotePreflightError &&
      error.code === "hostNotTrusted" &&
      error.knownHostsPaths.includes("/tmp/known_hosts")
  );
});

test("ensureRemotePreflight reports knownHostsAccess for unreadable known_hosts", async () => {
  const session = createRemotePreflightSession();

  await assert.rejects(
    ensureRemotePreflight(session, buildEnvironment(), ["hostKeyAccess"], {
      async runCommand(command): Promise<string> {
        if (command === "ssh") {
          return [
            "hostname prod.example.com",
            "userknownhostsfile /tmp/known_hosts"
          ].join("\n");
        }
        throw new Error(
          "Command failed (255): ssh-keygen\nhostkeys_foreach failed: Operation not permitted"
        );
      },
      async pathExists(): Promise<boolean> {
        return true;
      }
    }),
    (error: unknown) =>
      error instanceof RemotePreflightError &&
      error.code === "knownHostsAccess" &&
      error.knownHostsPaths[0] === "/tmp/known_hosts"
  );
});

test("ensureRemotePreflight parses multiple known_hosts files and prefers hostkeyalias", async () => {
  const session = createRemotePreflightSession();
  const lookups: string[][] = [];

  await ensureRemotePreflight(session, buildEnvironment(), ["hostKeyAccess"], {
    async runCommand(command, args): Promise<string> {
      if (command === "ssh") {
        return [
          "hostkeyalias prod-alias",
          "hostname prod.example.com",
          "userknownhostsfile /tmp/first /tmp/second"
        ].join("\n");
      }
      lookups.push(args);
      if (args[3] === "/tmp/first") {
        throw new Error("Command failed (1): ssh-keygen");
      }
      return "# Host prod-alias found: line 1\n";
    },
    async pathExists(): Promise<boolean> {
      return true;
    }
  });

  assert.deepEqual(lookups, [
    ["-F", "prod-alias", "-f", "/tmp/first"],
    ["-F", "prod.example.com", "-f", "/tmp/first"],
    ["-F", "prod-alias", "-f", "/tmp/second"]
  ]);
});

test("ensureRemotePreflight caches successful checks for the session", async () => {
  const session = createRemotePreflightSession();
  let commandCount = 0;

  const dependencies = {
    async runCommand(command: string): Promise<string> {
      commandCount += 1;
      if (command === "ssh") {
        return [
          "hostname prod.example.com",
          "userknownhostsfile /tmp/known_hosts"
        ].join("\n");
      }
      return "# Host prod.example.com found: line 1\n";
    },
    async pathExists(): Promise<boolean> {
      return true;
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

  assert.equal(commandCount, 2);
});

test("ensureRemotePreflight caches failed checks for the session", async () => {
  const session = createRemotePreflightSession();
  let commandCount = 0;

  const dependencies = {
    async runCommand(command: string): Promise<string> {
      commandCount += 1;
      if (command === "ssh") {
        return [
          "hostname prod.example.com",
          "userknownhostsfile /tmp/known_hosts"
        ].join("\n");
      }
      throw new Error("Command failed (1): ssh-keygen");
    },
    async pathExists(): Promise<boolean> {
      return true;
    }
  };

  await assert.rejects(
    ensureRemotePreflight(
      session,
      buildEnvironment(),
      ["hostKeyAccess"],
      dependencies
    ),
    /not trusted yet/
  );
  await assert.rejects(
    ensureRemotePreflight(
      session,
      buildEnvironment(),
      ["hostKeyAccess"],
      dependencies
    ),
    /not trusted yet/
  );

  assert.equal(commandCount, 2);
});
