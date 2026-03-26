import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { homedir } from "node:os";
import {
  getDefaultConfigCandidates,
  getRecommendedUserConfigPath,
  loadConfig,
  resolveConfigPath
} from "../src/config/loadConfig.js";

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "db-helper-config-test-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("loadConfig parses a valid config file", async () => {
  await withTempDir(async (dir) => {
    const configPath = path.join(dir, "config.json");
    await writeFile(
      configPath,
      JSON.stringify(
        {
          defaults: {
            authSource: "admin",
            defaultDropOnRestore: false
          },
          paths: {
            backupRoot: "/tmp/backups",
            tempRoot: "/tmp/db-helper"
          },
          environments: {
            development: {
              label: "Development",
              kind: "local",
              host: "localhost",
              mongoHost: "localhost",
              mongoPort: 7854,
              databaseName: "development",
              mongoUser: "dev-user",
              mongoPassword: "dev-pass"
            },
            test: {
              label: "Test",
              kind: "remote",
              host: "test.example.com",
              mongoHost: "localhost",
              mongoPort: 7854,
              databaseName: "development",
              sshUser: "ubuntu",
              sshKeyPath: "~/keys/test.pem",
              mongoUser: "test-user",
              mongoPassword: "test-pass"
            },
            production: {
              label: "Production",
              kind: "remote",
              host: "prod.example.com",
              mongoHost: "localhost",
              mongoPort: 7854,
              databaseName: "production",
              sshUser: "ubuntu",
              sshKeyPath: "/tmp/prod.pem",
              mongoUser: "prod-user",
              mongoPassword: "prod-pass"
            }
          }
        },
        null,
        2
      )
    );

    const config = await loadConfig(configPath);

    assert.equal(config.backupRoot, "/tmp/backups");
    assert.equal(config.tempRoot, "/tmp/db-helper");
    assert.equal(config.defaultDropOnRestore, false);
    assert.equal(config.environments.development.mongoUser, "dev-user");
    assert.equal(
      config.environments.test.sshKeyPath,
      path.join(homedir(), "keys/test.pem")
    );
    assert.equal(config.environments.production.databaseName, "production");
  });
});

test("loadConfig rejects missing required environments", async () => {
  await withTempDir(async (dir) => {
    const configPath = path.join(dir, "config.json");
    await writeFile(
      configPath,
      JSON.stringify(
        {
          paths: {
            backupRoot: "/tmp/backups",
            tempRoot: "/tmp/db-helper"
          },
          environments: {
            development: {
              label: "Development",
              kind: "local",
              host: "localhost",
              databaseName: "development",
              mongoUser: "dev-user",
              mongoPassword: "dev-pass"
            }
          }
        },
        null,
        2
      )
    );

    await assert.rejects(
      () => loadConfig(configPath),
      /Missing required environment config: test/
    );
  });
});

test("resolveConfigPath prefers an explicit path", async () => {
  await withTempDir(async (dir) => {
    const explicitPath = path.join(dir, "custom.json");
    await writeFile(explicitPath, "{}");

    const resolved = await resolveConfigPath(explicitPath);

    assert.equal(resolved, explicitPath);
  });
});

test("default config candidates include the user config location", () => {
  const candidates = getDefaultConfigCandidates();

  assert.equal(candidates[0], path.resolve(process.cwd(), "config.json"));
  assert.equal(candidates[1], getRecommendedUserConfigPath());
});
