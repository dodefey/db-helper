import test from "node:test";
import assert from "node:assert/strict";
import {
  ConfigCommandDependencies,
  runInitFromEnvFile,
  runInteractiveInit
} from "../src/commands/config.js";

const SAMPLE_ENV_FILE = `# Shared settings
DB_BACKUP_ROOT=/tmp/db-backups
DB_TEMP_ROOT=/tmp/db-helper
DB_AUTH_SOURCE=admin
DB_DEFAULT_DROP_ON_RESTORE=true

# Development environment
DB_DEVELOPMENT_LABEL=Local Development
DB_DEVELOPMENT_KIND=local
DB_DEVELOPMENT_HOST=localhost
DB_DEVELOPMENT_PORT=7854
DB_DEVELOPMENT_NAME=development
DB_DEVELOPMENT_MONGO_HOST=localhost
DB_DEVELOPMENT_MONGO_USER=sysadmin
DB_DEVELOPMENT_MONGO_PASSWORD=dev-pass

# Test environment
DB_TEST_LABEL=Test Server
DB_TEST_KIND=remote
DB_TEST_HOST=test.example.com
DB_TEST_PORT=7854
DB_TEST_NAME=development
DB_TEST_USER=ubuntu
DB_TEST_SSH_KEY=/tmp/test.pem
DB_TEST_MONGO_HOST=localhost
DB_TEST_MONGO_USER=sysadmin
DB_TEST_MONGO_PASSWORD=test-pass

# Production environment
DB_PRODUCTION_LABEL=Production Server
DB_PRODUCTION_KIND=remote
DB_PRODUCTION_HOST=prod.example.com
DB_PRODUCTION_PORT=7854
DB_PRODUCTION_NAME=production
DB_PRODUCTION_USER=ubuntu
DB_PRODUCTION_SSH_KEY=/tmp/prod.pem
DB_PRODUCTION_MONGO_HOST=localhost
DB_PRODUCTION_MONGO_USER=sysadmin
DB_PRODUCTION_MONGO_PASSWORD=prod-pass
`;

function createDependencies(
  overrides: Partial<ConfigCommandDependencies> = {}
): {
  dependencies: ConfigCommandDependencies;
  output: string[];
  writes: Array<{ path: string; content: string }>;
} {
  const output: string[] = [];
  const writes: Array<{ path: string; content: string }> = [];

  return {
    output,
    writes,
    dependencies: {
      async resolveConfigPath(configPath?: string): Promise<string> {
        return configPath ?? "/tmp/config.json";
      },
      async loadConfig() {
        throw new Error("not used");
      },
      async fileExists(): Promise<boolean> {
        return false;
      },
      async readFile(): Promise<string> {
        return SAMPLE_ENV_FILE;
      },
      async ensureDirectory(): Promise<void> {},
      async writeFile(filePath: string, content: string): Promise<void> {
        writes.push({ path: filePath, content });
      },
      async promptText(): Promise<string> {
        return "";
      },
      writeStdout(message: string): void {
        output.push(message);
      },
      ...overrides
    }
  };
}

test("runInitFromEnvFile imports legacy env config into config json", async () => {
  const { dependencies, writes, output } = createDependencies();

  await runInitFromEnvFile(
    {
      fromEnvFile: "/tmp/.env.test",
      configPath: "/tmp/config.json",
      force: false
    },
    dependencies
  );

  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, "/tmp/config.json");
  const written = JSON.parse(writes[0].content) as {
    defaults: { authSource: string; defaultDropOnRestore: boolean };
    paths: { backupRoot: string; tempRoot: string };
    environments: {
      development: { mongoPassword: string };
      test: { sshUser: string };
      production: { host: string };
    };
  };
  assert.equal(written.defaults.authSource, "admin");
  assert.equal(written.defaults.defaultDropOnRestore, true);
  assert.equal(written.paths.backupRoot, "/tmp/db-backups");
  assert.equal(written.environments.development.mongoPassword, "dev-pass");
  assert.equal(written.environments.test.sshUser, "ubuntu");
  assert.equal(written.environments.production.host, "prod.example.com");
  assert.deepEqual(output, [
    "Importing config from env file /tmp/.env.test...\n",
    "Config written: /tmp/config.json\n",
    "Next: db-helper config validate\n"
  ]);
});

test("runInitFromEnvFile refuses to overwrite without force", async () => {
  const { dependencies } = createDependencies({
    async fileExists(): Promise<boolean> {
      return true;
    }
  });

  await assert.rejects(
    runInitFromEnvFile(
      {
        fromEnvFile: "/tmp/.env.test",
        configPath: "/tmp/config.json",
        force: false
      },
      dependencies
    ),
    /Re-run with --force/
  );
});

test("runInitFromEnvFile allows overwrite with force", async () => {
  const { dependencies, writes } = createDependencies({
    async fileExists(): Promise<boolean> {
      return true;
    }
  });

  await runInitFromEnvFile(
    {
      fromEnvFile: "/tmp/.env.test",
      configPath: "/tmp/config.json",
      force: true
    },
    dependencies
  );

  assert.equal(writes.length, 1);
});

test("runInteractiveInit writes a config from prompts", async () => {
  const answers = [
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "dev-pass",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "test-pass",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "prod-pass",
    "",
    ""
  ];
  const { dependencies, writes, output } = createDependencies({
    async promptText(): Promise<string> {
      return answers.shift() ?? "";
    }
  });

  await runInteractiveInit(
    {
      configPath: "/tmp/config.json",
      force: false
    },
    dependencies
  );

  assert.equal(writes.length, 1);
  const written = JSON.parse(writes[0].content) as {
    defaults: { authSource: string; defaultDropOnRestore: boolean };
    environments: {
      development: { mongoPassword: string };
      test: { sshUser: string };
      production: { sshKeyPath: string };
    };
  };
  assert.equal(written.defaults.authSource, "admin");
  assert.equal(written.defaults.defaultDropOnRestore, true);
  assert.equal(written.environments.development.mongoPassword, "dev-pass");
  assert.equal(written.environments.test.sshUser, "ubuntu");
  assert.equal(
    written.environments.production.sshKeyPath,
    "~/.ssh/db-helper-production.pem"
  );
  assert.deepEqual(output, [
    "Starting interactive config setup...\n",
    "Writing config to /tmp/config.json. Press Enter to accept defaults.\n",
    "Config written: /tmp/config.json\n",
    "Next: db-helper config validate\n"
  ]);
});

test("runInteractiveInit refuses to overwrite without force", async () => {
  const { dependencies } = createDependencies({
    async fileExists(): Promise<boolean> {
      return true;
    }
  });

  await assert.rejects(
    runInteractiveInit(
      {
        configPath: "/tmp/config.json",
        force: false
      },
      dependencies
    ),
    /Re-run with --force/
  );
});
