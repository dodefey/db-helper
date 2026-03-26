import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AppConfig,
  ENVIRONMENT_IDS,
  EnvironmentConfig,
  EnvironmentId,
  EnvironmentKind
} from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function parseNumber(
  name: string,
  value: string | undefined,
  fallback?: number
): number {
  if (!value) {
    if (fallback !== undefined) {
      return fallback;
    }

    throw new Error(`Missing required numeric env var: ${name}`);
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid numeric env var ${name}: ${value}`);
  }

  return parsed;
}

function parseDotEnvFile(content: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const equalsIndex = line.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }

    const key = line.slice(0, equalsIndex).trim();
    let value = line.slice(equalsIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    values[key] = value;
  }

  return values;
}

function requireValue(source: Record<string, string>, name: string): string {
  const value = source[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }

  return value;
}

function loadEnvironment(
  source: Record<string, string>,
  id: EnvironmentId,
  authSource: string
): EnvironmentConfig {
  const prefix = `DB_${id.toUpperCase()}`;
  const kind = requireValue(source, `${prefix}_KIND`) as EnvironmentKind;
  if (kind !== "local" && kind !== "remote") {
    throw new Error(`Invalid ${prefix}_KIND: ${kind}`);
  }

  const mongoUser = source[`${prefix}_MONGO_USER`] ?? source[`${prefix}_USER`];
  const mongoPassword =
    source[`${prefix}_MONGO_PASSWORD`] ?? source[`${prefix}_PASSWORD`];
  const mongoPort = source[`${prefix}_MONGO_PORT`] ?? source[`${prefix}_PORT`];

  const config: EnvironmentConfig = {
    id,
    name: id,
    label: requireValue(source, `${prefix}_LABEL`),
    kind,
    host: requireValue(source, `${prefix}_HOST`),
    mongoHost:
      source[`${prefix}_MONGO_HOST`] ?? requireValue(source, `${prefix}_HOST`),
    mongoPort: parseNumber(`${prefix}_MONGO_PORT`, mongoPort, 27017),
    databaseName: requireValue(source, `${prefix}_NAME`),
    mongoUser: mongoUser
      ? mongoUser
      : requireValue(source, `${prefix}_MONGO_USER`),
    mongoPassword: mongoPassword
      ? mongoPassword
      : requireValue(source, `${prefix}_MONGO_PASSWORD`),
    authSource,
    isProduction: id === "production"
  };

  if (kind === "remote") {
    config.sshUser = requireValue(source, `${prefix}_USER`);
    config.sshKeyPath = requireValue(source, `${prefix}_SSH_KEY`);
  }

  return config;
}

export async function loadEnvConfig(envFilePath?: string): Promise<AppConfig> {
  const resolvedPath =
    envFilePath ??
    process.env.DB_HELPER_ENV_FILE ??
    path.resolve(__dirname, "../../.env");

  const fileContent = await readFile(resolvedPath, "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      throw new Error(
        `Failed to read .env file at ${resolvedPath}: ${error.message}`
      );
    }
  );

  const parsed = parseDotEnvFile(fileContent);
  const merged = {
    ...parsed,
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([, value]) => value !== undefined
      ) as Array<[string, string]>
    )
  };

  const authSource = merged.DB_AUTH_SOURCE ?? "admin";
  const environments = Object.fromEntries(
    ENVIRONMENT_IDS.map((id) => [id, loadEnvironment(merged, id, authSource)])
  ) as Record<EnvironmentId, EnvironmentConfig>;

  return {
    backupRoot: requireValue(merged, "DB_BACKUP_ROOT"),
    tempRoot: requireValue(merged, "DB_TEMP_ROOT"),
    authSource,
    defaultDropOnRestore: parseBoolean(merged.DB_DEFAULT_DROP_ON_RESTORE, true),
    environments
  };
}
