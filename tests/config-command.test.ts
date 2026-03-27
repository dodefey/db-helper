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
      development: {
        id: "development",
        name: "development",
        label: "Development",
        kind: "local",
        host: "localhost",
        mongoHost: "localhost",
        mongoPort: 27017,
        databaseName: "development",
        mongoUser: "user",
        mongoPassword: "pass",
        authSource: "admin",
        isProduction: false
      },
      test: {
        id: "test",
        name: "test",
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
      production: {
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
      throw new Error("Missing required environment config: test");
    }
  });

  await assert.rejects(
    runConfigValidate("/tmp/config.json", dependencies),
    ConfigCommandError
  );

  assert.deepEqual(output, [
    "Validating config...\n",
    "Config validation failed: Missing required environment config: test\n"
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
      development: { mongoPassword: string };
      test: { mongoPassword: string };
    };
  };
  assert.equal(shown.environments.development.mongoPassword, "<redacted>");
  assert.equal(shown.environments.test.mongoPassword, "<redacted>");
});
