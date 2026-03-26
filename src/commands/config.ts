import { loadConfig, resolveConfigPath } from "../config/loadConfig.js";
import { AppConfig } from "../config/types.js";

export class ConfigCommandError extends Error {
  readonly alreadyReported = true;
}

export interface ConfigCommandDependencies {
  resolveConfigPath: (configPath?: string) => Promise<string>;
  loadConfig: (configPath?: string) => Promise<AppConfig>;
  writeStdout: (message: string) => void;
}

const DEFAULT_CONFIG_COMMAND_DEPENDENCIES: ConfigCommandDependencies = {
  resolveConfigPath,
  loadConfig,
  writeStdout: (message: string): void => {
    process.stdout.write(message);
  }
};

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
