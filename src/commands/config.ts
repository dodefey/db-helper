import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  getRecommendedUserConfigPath,
  loadConfig,
  resolveConfigPath
} from "../config/loadConfig.js";
import { AppConfig } from "../config/types.js";
import { exists } from "../lib/fs.js";

export class ConfigCommandError extends Error {
  readonly alreadyReported = true;
}

export interface ConfigCommandDependencies {
  resolveConfigPath: (configPath?: string) => Promise<string>;
  loadConfig: (configPath?: string) => Promise<AppConfig>;
  fileExists: (filePath: string) => Promise<boolean>;
  readFile: (filePath: string) => Promise<string>;
  ensureDirectory: (dirPath: string) => Promise<void>;
  writeFile: (filePath: string, content: string) => Promise<void>;
  writeStdout: (message: string) => void;
}

const DEFAULT_CONFIG_COMMAND_DEPENDENCIES: ConfigCommandDependencies = {
  resolveConfigPath,
  loadConfig,
  fileExists: exists,
  async readFile(filePath: string): Promise<string> {
    return readFile(filePath, "utf8");
  },
  async ensureDirectory(dirPath: string): Promise<void> {
    await mkdir(dirPath, { recursive: true });
  },
  async writeFile(filePath: string, content: string): Promise<void> {
    await writeFile(filePath, content, "utf8");
  },
  writeStdout: (message: string): void => {
    process.stdout.write(message);
  }
};

type ConfigFile = {
  defaults: {
    authSource: string;
    defaultDropOnRestore: boolean;
  };
  paths: {
    backupRoot: string;
    tempRoot: string;
  };
  environments: {
    development: ImportedEnvironment;
    test: ImportedEnvironment;
    production: ImportedEnvironment;
  };
};

type ImportedEnvironment = {
  label: string;
  kind: "local" | "remote";
  host: string;
  mongoHost: string;
  mongoPort: number;
  databaseName: string;
  mongoUser: string;
  mongoPassword: string;
  sshUser?: string;
  sshKeyPath?: string;
};

function parseBoolean(value: string, name: string): boolean {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`Invalid boolean value for ${name}: ${value}`);
}

function parseInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid numeric value for ${name}: ${value}`);
  }
  return parsed;
}

function parseEnvFile(content: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separator = line.indexOf("=");
    if (separator === -1) {
      throw new Error(`Invalid env line: ${rawLine}`);
    }

    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    values[key] = value;
  }

  return values;
}

function requireEnvValue(
  env: Record<string, string>,
  name: string
): string {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing required env value: ${name}`);
  }
  return value;
}

function buildImportedEnvironment(
  env: Record<string, string>,
  prefix: string
): ImportedEnvironment {
  const kind = requireEnvValue(env, `${prefix}_KIND`);
  if (kind !== "local" && kind !== "remote") {
    throw new Error(`Invalid ${prefix}_KIND: ${kind}`);
  }

  const imported: ImportedEnvironment = {
    label: requireEnvValue(env, `${prefix}_LABEL`),
    kind,
    host: requireEnvValue(env, `${prefix}_HOST`),
    mongoHost: requireEnvValue(env, `${prefix}_MONGO_HOST`),
    mongoPort: parseInteger(
      requireEnvValue(env, `${prefix}_PORT`),
      `${prefix}_PORT`
    ),
    databaseName: requireEnvValue(env, `${prefix}_NAME`),
    mongoUser: requireEnvValue(env, `${prefix}_MONGO_USER`),
    mongoPassword: requireEnvValue(env, `${prefix}_MONGO_PASSWORD`)
  };

  if (kind === "remote") {
    imported.sshUser = requireEnvValue(env, `${prefix}_USER`);
    imported.sshKeyPath = requireEnvValue(env, `${prefix}_SSH_KEY`);
  }

  return imported;
}

function convertEnvFileToConfig(content: string): ConfigFile {
  const env = parseEnvFile(content);

  return {
    defaults: {
      authSource: requireEnvValue(env, "DB_AUTH_SOURCE"),
      defaultDropOnRestore: parseBoolean(
        requireEnvValue(env, "DB_DEFAULT_DROP_ON_RESTORE"),
        "DB_DEFAULT_DROP_ON_RESTORE"
      )
    },
    paths: {
      backupRoot: requireEnvValue(env, "DB_BACKUP_ROOT"),
      tempRoot: requireEnvValue(env, "DB_TEMP_ROOT")
    },
    environments: {
      development: buildImportedEnvironment(env, "DB_DEVELOPMENT"),
      test: buildImportedEnvironment(env, "DB_TEST"),
      production: buildImportedEnvironment(env, "DB_PRODUCTION")
    }
  };
}

export async function runConfigValidate(
  configPath?: string,
  dependencies: ConfigCommandDependencies = DEFAULT_CONFIG_COMMAND_DEPENDENCIES
): Promise<void> {
  const resolvedPath = await dependencies.resolveConfigPath(configPath);

  dependencies.writeStdout("Validating config...\n");

  try {
    await dependencies.loadConfig(resolvedPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dependencies.writeStdout(`Config validation failed: ${message}\n`);
    throw new ConfigCommandError(message);
  }

  dependencies.writeStdout(`Config is valid: ${resolvedPath}\n`);
}

export async function runInitFromEnvFile(
  input: {
    fromEnvFile: string;
    configPath?: string;
    force: boolean;
  },
  dependencies: ConfigCommandDependencies = DEFAULT_CONFIG_COMMAND_DEPENDENCIES
): Promise<void> {
  const destinationPath = input.configPath
    ? path.resolve(input.configPath)
    : getRecommendedUserConfigPath();

  if (!input.force && (await dependencies.fileExists(destinationPath))) {
    throw new Error(
      `Config already exists at ${destinationPath}. Re-run with --force to overwrite.`
    );
  }

  dependencies.writeStdout(
    `Importing config from env file ${input.fromEnvFile}...\n`
  );

  const envFileContent = await dependencies.readFile(
    path.resolve(input.fromEnvFile)
  );
  const config = convertEnvFileToConfig(envFileContent);

  await dependencies.ensureDirectory(path.dirname(destinationPath));
  await dependencies.writeFile(
    destinationPath,
    `${JSON.stringify(config, null, 2)}\n`
  );

  dependencies.writeStdout(`Config written: ${destinationPath}\n`);
  dependencies.writeStdout("Next: db-helper config validate\n");
}
