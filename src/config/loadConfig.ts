import { homedir } from "node:os";
import { access, readFile } from "node:fs/promises";
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
const USER_CONFIG_PATH = path.join(homedir(), ".config", "db-helper", "config.json");

type RawConfig = {
  defaults?: {
    authSource?: string;
    defaultDropOnRestore?: boolean;
  };
  paths?: {
    backupRoot?: string;
    tempRoot?: string;
  };
  environments?: Partial<Record<EnvironmentId, RawEnvironment>>;
};

type RawEnvironment = {
  label?: string;
  kind?: EnvironmentKind;
  host?: string;
  mongoHost?: string;
  mongoPort?: number;
  databaseName?: string;
  mongoUser?: string;
  mongoPassword?: string;
  sshUser?: string;
  sshKeyPath?: string;
};

function expandHomePath(value: string): string {
  if (value === "~") {
    return homedir();
  }

  if (value.startsWith("~/")) {
    return path.join(homedir(), value.slice(2));
  }

  return value;
}

function requireString(value: string | undefined, name: string): string {
  if (!value || !value.trim()) {
    throw new Error(`Missing required config value: ${name}`);
  }

  return value;
}

function requirePositiveInteger(value: number | undefined, name: string): number {
  if (value === undefined) {
    throw new Error(`Missing required numeric config value: ${name}`);
  }

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid numeric config value ${name}: ${value}`);
  }

  return value;
}

function parseEnvironment(
  environments: RawConfig["environments"],
  id: EnvironmentId,
  authSource: string
): EnvironmentConfig {
  const raw = environments?.[id];
  if (!raw) {
    throw new Error(`Missing required environment config: ${id}`);
  }

  const kind = requireString(raw.kind, `${id}.kind`) as EnvironmentKind;
  if (kind !== "local" && kind !== "remote") {
    throw new Error(`Invalid ${id}.kind: ${String(raw.kind)}`);
  }

  const config: EnvironmentConfig = {
    id,
    name: id,
    label: requireString(raw.label, `${id}.label`),
    kind,
    host: requireString(raw.host, `${id}.host`),
    mongoHost: raw.mongoHost
      ? requireString(raw.mongoHost, `${id}.mongoHost`)
      : requireString(raw.host, `${id}.host`),
    mongoPort: raw.mongoPort === undefined
      ? 27017
      : requirePositiveInteger(raw.mongoPort, `${id}.mongoPort`),
    databaseName: requireString(raw.databaseName, `${id}.databaseName`),
    mongoUser: requireString(raw.mongoUser, `${id}.mongoUser`),
    mongoPassword: requireString(raw.mongoPassword, `${id}.mongoPassword`),
    authSource,
    isProduction: id === "production"
  };

  if (kind === "remote") {
    config.sshUser = requireString(raw.sshUser, `${id}.sshUser`);
    config.sshKeyPath = expandHomePath(
      requireString(raw.sshKeyPath, `${id}.sshKeyPath`)
    );
  }

  return config;
}

export function getRecommendedUserConfigPath(): string {
  return USER_CONFIG_PATH;
}

async function pathExists(candidatePath: string): Promise<boolean> {
  try {
    await access(candidatePath);
    return true;
  } catch {
    return false;
  }
}

export function getDefaultConfigCandidates(): string[] {
  return [
    path.resolve(process.cwd(), "config.json"),
    USER_CONFIG_PATH,
    path.resolve(__dirname, "../../config.json")
  ];
}

export async function resolveConfigPath(configPath?: string): Promise<string> {
  if (configPath) {
    return path.resolve(configPath);
  }

  for (const candidate of getDefaultConfigCandidates()) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  return getDefaultConfigCandidates()[0];
}

export async function loadConfig(configPath?: string): Promise<AppConfig> {
  const resolvedPath = await resolveConfigPath(configPath);
  const fileContent = await readFile(resolvedPath, "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      throw new Error(
        `Failed to read config file at ${resolvedPath}: ${error.message}`
      );
    }
  );

  let raw: RawConfig;
  try {
    raw = JSON.parse(fileContent) as RawConfig;
  } catch (error) {
    throw new Error(
      `Failed to parse config file at ${resolvedPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error }
    );
  }

  const authSource = raw.defaults?.authSource ?? "admin";
  const environments = Object.fromEntries(
    ENVIRONMENT_IDS.map((id) => [
      id,
      parseEnvironment(raw.environments, id, authSource)
    ])
  ) as Record<EnvironmentId, EnvironmentConfig>;

  return {
    backupRoot: expandHomePath(
      requireString(raw.paths?.backupRoot, "paths.backupRoot")
    ),
    tempRoot: expandHomePath(
      requireString(raw.paths?.tempRoot, "paths.tempRoot")
    ),
    authSource,
    defaultDropOnRestore: raw.defaults?.defaultDropOnRestore ?? true,
    environments
  };
}
