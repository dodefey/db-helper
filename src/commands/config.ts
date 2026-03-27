import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  getRecommendedUserConfigPath,
  loadConfig,
  resolveConfigPath
} from "../config/loadConfig.js";
import { AppConfig } from "../config/types.js";
import { exists } from "../lib/fs.js";
import { promptText } from "../lib/prompts.js";

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
  promptText: (message: string) => Promise<string>;
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
  promptText,
  writeStdout: (message: string): void => {
    process.stdout.write(message);
  }
};

const DEFAULT_CONFIG: ConfigFile = {
  defaults: {
    authSource: "admin",
    defaultDropOnRestore: true
  },
  paths: {
    backupRoot: path.join(path.join(path.sep, "tmp"), "db-helper-backups"),
    tempRoot: path.join(path.sep, "tmp", "db-helper")
  },
  environments: {
    development: {
      label: "Local Development",
      kind: "local",
      host: "localhost",
      mongoHost: "localhost",
      mongoPort: 27017,
      databaseName: "development",
      mongoUser: "",
      mongoPassword: ""
    },
    test: {
      label: "Test Server",
      kind: "remote",
      host: "test.example.com",
      mongoHost: "localhost",
      mongoPort: 27017,
      databaseName: "development",
      mongoUser: "",
      mongoPassword: "",
      sshUser: "",
      sshKeyPath: ""
    },
    production: {
      label: "Production Server",
      kind: "remote",
      host: "prod.example.com",
      mongoHost: "localhost",
      mongoPort: 27017,
      databaseName: "production",
      mongoUser: "",
      mongoPassword: "",
      sshUser: "",
      sshKeyPath: ""
    }
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

type RedactedConfigView = {
  backupRoot: string;
  tempRoot: string;
  authSource: string;
  defaultDropOnRestore: boolean;
  environments: Record<
    string,
    {
      id: string;
      label: string;
      kind: string;
      host: string;
      mongoHost: string;
      mongoPort: number;
      databaseName: string;
      mongoUser: string;
      mongoPassword: string;
      sshUser?: string;
      sshKeyPath?: string;
      isProduction: boolean;
    }
  >;
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

function requireEnvValue(env: Record<string, string>, name: string): string {
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
    imported.sshUser = env[`${prefix}_USER`] ?? "";
    imported.sshKeyPath = env[`${prefix}_SSH_KEY`] ?? "";
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

async function promptWithDefault(
  prompt: (message: string) => Promise<string>,
  label: string,
  defaultValue: string
): Promise<string> {
  const value = await prompt(`${label} [${defaultValue}]`);
  return value.trim() ? value.trim() : defaultValue;
}

async function promptConfirmWithDefault(
  prompt: (message: string) => Promise<string>,
  label: string,
  defaultYes = true
): Promise<boolean> {
  const suffix = defaultYes ? "[Y/n]" : "[y/N]";
  const value = (await prompt(`${label} ${suffix}`)).trim().toLowerCase();
  if (!value) {
    return defaultYes;
  }

  return value === "y" || value === "yes";
}

async function promptEnvironmentConfig(
  id: "development" | "test" | "production",
  defaults: ImportedEnvironment,
  prompt: (message: string) => Promise<string>
): Promise<ImportedEnvironment> {
  const kind = await promptWithDefault(prompt, `${id} kind`, defaults.kind);
  if (kind !== "local" && kind !== "remote") {
    throw new Error(`Invalid ${id} kind: ${kind}`);
  }

  const config: ImportedEnvironment = {
    label: await promptWithDefault(prompt, `${id} label`, defaults.label),
    kind,
    host: await promptWithDefault(prompt, `${id} host`, defaults.host),
    mongoHost: await promptWithDefault(
      prompt,
      `${id} mongo host`,
      defaults.mongoHost
    ),
    mongoPort: parseInteger(
      await promptWithDefault(
        prompt,
        `${id} mongo port`,
        String(defaults.mongoPort)
      ),
      `${id} mongo port`
    ),
    databaseName: await promptWithDefault(
      prompt,
      `${id} database name`,
      defaults.databaseName
    ),
    mongoUser: await promptWithDefault(
      prompt,
      `${id} mongo user`,
      defaults.mongoUser
    ),
    mongoPassword: await promptWithDefault(
      prompt,
      `${id} mongo password`,
      defaults.mongoPassword
    )
  };

  if (kind === "remote") {
    config.sshUser = await promptWithDefault(
      prompt,
      `${id} ssh user`,
      defaults.sshUser ?? ""
    );
    config.sshKeyPath = await promptWithDefault(
      prompt,
      `${id} ssh key path`,
      defaults.sshKeyPath ?? ""
    );
  }

  return config;
}

async function writeConfigFile(
  config: ConfigFile,
  destinationPath: string,
  force: boolean,
  dependencies: ConfigCommandDependencies
): Promise<void> {
  if (!force && (await dependencies.fileExists(destinationPath))) {
    throw new Error(
      `Config already exists at ${destinationPath}. Re-run with --force to overwrite.`
    );
  }

  await dependencies.ensureDirectory(path.dirname(destinationPath));
  await dependencies.writeFile(
    destinationPath,
    `${JSON.stringify(config, null, 2)}\n`
  );
}

function redactConfig(appConfig: AppConfig): RedactedConfigView {
  return {
    backupRoot: appConfig.backupRoot,
    tempRoot: appConfig.tempRoot,
    authSource: appConfig.authSource,
    defaultDropOnRestore: appConfig.defaultDropOnRestore,
    environments: Object.fromEntries(
      Object.entries(appConfig.environments).map(([id, env]) => [
        id,
        {
          id: env.id,
          label: env.label,
          kind: env.kind,
          host: env.host,
          mongoHost: env.mongoHost,
          mongoPort: env.mongoPort,
          databaseName: env.databaseName,
          mongoUser: env.mongoUser,
          mongoPassword: env.mongoPassword ? "<redacted>" : "",
          sshUser: env.sshUser,
          sshKeyPath: env.sshKeyPath,
          isProduction: env.isProduction
        }
      ])
    )
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

export async function runConfigPath(
  configPath?: string,
  dependencies: ConfigCommandDependencies = DEFAULT_CONFIG_COMMAND_DEPENDENCIES
): Promise<void> {
  const resolvedPath = await dependencies.resolveConfigPath(configPath);
  dependencies.writeStdout(`${resolvedPath}\n`);
}

export async function runConfigShowRedacted(
  configPath?: string,
  dependencies: ConfigCommandDependencies = DEFAULT_CONFIG_COMMAND_DEPENDENCIES
): Promise<void> {
  const resolvedPath = await dependencies.resolveConfigPath(configPath);
  const config = await dependencies.loadConfig(resolvedPath);
  dependencies.writeStdout(
    `${JSON.stringify(redactConfig(config), null, 2)}\n`
  );
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

  dependencies.writeStdout(
    `Importing config from env file ${input.fromEnvFile}...\n`
  );

  const envFileContent = await dependencies.readFile(
    path.resolve(input.fromEnvFile)
  );
  const config = convertEnvFileToConfig(envFileContent);

  await writeConfigFile(config, destinationPath, input.force, dependencies);

  dependencies.writeStdout(`Config written: ${destinationPath}\n`);
  dependencies.writeStdout("Next: dbh config validate\n");
}

export async function runInteractiveInit(
  input: {
    configPath?: string;
    force: boolean;
  },
  dependencies: ConfigCommandDependencies = DEFAULT_CONFIG_COMMAND_DEPENDENCIES
): Promise<void> {
  const destinationPath = input.configPath
    ? path.resolve(input.configPath)
    : getRecommendedUserConfigPath();

  dependencies.writeStdout("Starting interactive config setup...\n");
  dependencies.writeStdout(
    `Writing config to ${destinationPath}. Press Enter to accept defaults.\n`
  );

  const config: ConfigFile = {
    defaults: {
      authSource: await promptWithDefault(
        dependencies.promptText,
        "Mongo auth source",
        DEFAULT_CONFIG.defaults.authSource
      ),
      defaultDropOnRestore: parseBoolean(
        await promptWithDefault(
          dependencies.promptText,
          "Default drop on restore",
          String(DEFAULT_CONFIG.defaults.defaultDropOnRestore)
        ),
        "default drop on restore"
      )
    },
    paths: {
      backupRoot: await promptWithDefault(
        dependencies.promptText,
        "Backup root",
        DEFAULT_CONFIG.paths.backupRoot
      ),
      tempRoot: await promptWithDefault(
        dependencies.promptText,
        "Temp root",
        DEFAULT_CONFIG.paths.tempRoot
      )
    },
    environments: {
      development: DEFAULT_CONFIG.environments.development,
      test: DEFAULT_CONFIG.environments.test,
      production: DEFAULT_CONFIG.environments.production
    }
  };

  if (
    await promptConfirmWithDefault(
      dependencies.promptText,
      "Set up development environment?"
    )
  ) {
    config.environments.development = await promptEnvironmentConfig(
      "development",
      DEFAULT_CONFIG.environments.development,
      dependencies.promptText
    );
  }

  if (
    await promptConfirmWithDefault(
      dependencies.promptText,
      "Set up test environment?"
    )
  ) {
    config.environments.test = await promptEnvironmentConfig(
      "test",
      DEFAULT_CONFIG.environments.test,
      dependencies.promptText
    );
  }

  if (
    await promptConfirmWithDefault(
      dependencies.promptText,
      "Set up production environment?"
    )
  ) {
    config.environments.production = await promptEnvironmentConfig(
      "production",
      DEFAULT_CONFIG.environments.production,
      dependencies.promptText
    );
  }

  await writeConfigFile(config, destinationPath, input.force, dependencies);

  dependencies.writeStdout(`Config written: ${destinationPath}\n`);
  dependencies.writeStdout("Next: dbh config validate\n");
}
