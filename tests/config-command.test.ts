import test from "node:test";
import assert from "node:assert/strict";
import { AppConfig } from "../src/config/types.js";
import {
  ConfigCommandDependencies,
  ConfigCommandError,
  runConfigPath,
  runConfigShowRedacted,
  runConfigValidate
} from "../src/commands/config.js";

function buildAppConfig(): AppConfig {
  return {
    backupRoot: "/tmp/backups",
    tempRoot: "/tmp/db-helper",
    authSource: "admin",
    defaultDropOnRestore: true,
    environments: {
      sandbox: {
        id: "sandbox",
        name: "sandbox",
        label: "Sandbox",
        kind: "local",
        host: "localhost",
        mongoHost: "localhost",
        mongoPort: 27017,
        databaseName: "sandbox",
        mongoUser: "user",
        mongoPassword: "pass",
        authSource: "admin",
        isProduction: false
      },
      qa: {
        id: "qa",
        name: "qa",
        label: "Test",
        kind: "remote",
        host: "test.example.com",
        mongoHost: "localhost",
        mongoPort: 27017,
        databaseName: "development",
        mongoUser: "user",
        mongoPassword: "pass",
        authSource: "admin",
        isProduction: false,
        sshUser: "ubuntu",
        sshKeyPath: "/tmp/test.pem"
      },
      live: {
        id: "live",
        name: "live",
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
        sshKeyPath: "/tmp/prod.pem"
      }
    }
  };
}

function createDependencies(
  overrides: Partial<ConfigCommandDependencies> = {}
): {
  dependencies: ConfigCommandDependencies;
  output: string[];
} {
  const output: string[] = [];

  return {
    output,
    dependencies: {
      async resolveConfigPath(configPath?: string): Promise<string> {
        return configPath ?? "/tmp/config.json";
      },
      async loadConfig(): Promise<AppConfig> {
        return buildAppConfig();
      },
      writeStdout(message: string): void {
        output.push(message);
      },
      ...overrides
    }
  };
}

test("runConfigValidate reports success for a valid config", async () => {
  const { dependencies, output } = createDependencies();

  await runConfigValidate("/tmp/config.json", dependencies);

  assert.deepEqual(output, [
    "Validating config...\n",
    "Config is valid: /tmp/config.json\n"
  ]);
});

test("runConfigValidate reports failure for an invalid config", async () => {
  const { dependencies, output } = createDependencies({
    async loadConfig(): Promise<AppConfig> {
      throw new Error("Config must define at least one environment.");
    }
  });

  await assert.rejects(
    runConfigValidate("/tmp/config.json", dependencies),
    ConfigCommandError
  );

  assert.deepEqual(output, [
    "Validating config...\n",
    "Config validation failed: Config must define at least one environment.\n"
  ]);
});

test("runConfigPath prints the resolved config path", async () => {
  const { dependencies, output } = createDependencies();

  await runConfigPath("/tmp/config.json", dependencies);

  assert.deepEqual(output, ["/tmp/config.json\n"]);
});

test("runConfigShowRedacted hides mongo passwords", async () => {
  const { dependencies, output } = createDependencies();

  await runConfigShowRedacted("/tmp/config.json", dependencies);

  const shown = JSON.parse(output[0]) as {
    environments: {
      sandbox: { mongoPassword: string };
      qa: { mongoPassword: string };
    };
  };
  assert.equal(shown.environments.sandbox.mongoPassword, "<redacted>");
  assert.equal(shown.environments.qa.mongoPassword, "<redacted>");
});
