import { access, constants as fsConstants } from "node:fs";
import { promisify } from "node:util";
import { EnvironmentConfig } from "../config/types.js";
import { runCommand } from "./exec.js";
import { getRunLogger } from "./runLog.js";

const accessAsync = promisify(access);

export type RemotePreflightCapability = "hostKeyAccess";

export type RemotePreflightErrorCode =
  | "knownHostsAccess"
  | "hostNotTrusted"
  | "preflightFailed";

export class RemotePreflightError extends Error {
  readonly code: RemotePreflightErrorCode;
  readonly host: string;
  readonly lookupNames: string[];
  readonly knownHostsPaths: string[];

  constructor(input: {
    code: RemotePreflightErrorCode;
    message: string;
    host: string;
    lookupNames?: string[];
    knownHostsPaths?: string[];
    cause?: unknown;
  }) {
    super(input.message, {
      cause: input.cause instanceof Error ? input.cause : undefined
    });
    this.name = "RemotePreflightError";
    this.code = input.code;
    this.host = input.host;
    this.lookupNames = input.lookupNames ?? [];
    this.knownHostsPaths = input.knownHostsPaths ?? [];
  }
}

export interface RemotePreflightSession {
  capabilityCache: Map<string, Promise<void>>;
}

export interface RemotePreflightDependencies {
  runCommand: typeof runCommand;
  pathExists: (path: string) => Promise<boolean>;
}

const DEFAULT_REMOTE_PREFLIGHT_DEPENDENCIES: RemotePreflightDependencies = {
  runCommand,
  async pathExists(path: string): Promise<boolean> {
    try {
      await accessAsync(path, fsConstants.F_OK);
      return true;
    } catch {
      return false;
    }
  }
};

type EffectiveSshConfig = {
  hostKeyAlias?: string;
  hostname?: string;
  userKnownHostsFiles: string[];
};

export function createRemotePreflightSession(): RemotePreflightSession {
  return {
    capabilityCache: new Map()
  };
}

function buildRemoteTransportKey(env: EnvironmentConfig): string {
  return JSON.stringify({
    kind: env.kind,
    host: env.host,
    sshUser: env.sshUser ?? "",
    sshKeyPath: env.sshKeyPath ?? ""
  });
}

function buildCapabilityCacheKey(
  env: EnvironmentConfig,
  capability: RemotePreflightCapability
): string {
  return `${buildRemoteTransportKey(env)}:${capability}`;
}

function buildSshTarget(env: EnvironmentConfig): string {
  return env.sshUser ? `${env.sshUser}@${env.host}` : env.host;
}

function buildSshBaseArgs(env: EnvironmentConfig): string[] {
  const target = buildSshTarget(env);
  return env.sshKeyPath ? ["-i", env.sshKeyPath, target] : [target];
}

function parseEffectiveSshConfig(output: string): EffectiveSshConfig {
  const config: EffectiveSshConfig = {
    userKnownHostsFiles: []
  };

  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const [key, ...rest] = trimmed.split(/\s+/);
    if (!key || rest.length === 0) {
      continue;
    }

    if (key === "hostkeyalias") {
      config.hostKeyAlias = rest.join(" ");
      continue;
    }
    if (key === "hostname") {
      config.hostname = rest.join(" ");
      continue;
    }
    if (key === "userknownhostsfile") {
      config.userKnownHostsFiles = rest;
    }
  }

  return config;
}

function buildLookupNames(
  env: EnvironmentConfig,
  effectiveConfig: EffectiveSshConfig
): string[] {
  const candidates = [
    effectiveConfig.hostKeyAlias,
    effectiveConfig.hostname,
    env.host
  ];
  const names: string[] = [];
  for (const candidate of candidates) {
    if (!candidate || names.includes(candidate)) {
      continue;
    }
    names.push(candidate);
  }
  return names;
}

function isKnownHostsAccessFailure(message: string): boolean {
  return (
    message.includes("Operation not permitted") ||
    message.includes("hostkeys_foreach failed") ||
    message.includes("Failed to add the host") ||
    message.includes("Cannot stat ")
  );
}

async function loadEffectiveSshConfig(
  env: EnvironmentConfig,
  dependencies: RemotePreflightDependencies
): Promise<EffectiveSshConfig> {
  try {
    const output = await dependencies.runCommand(
      "ssh",
      ["-G", ...buildSshBaseArgs(env)],
      { streamOutput: false }
    );
    return parseEffectiveSshConfig(output);
  } catch (error) {
    throw new RemotePreflightError({
      code: "preflightFailed",
      host: env.host,
      message:
        `SSH host-key preflight failed for ${env.host}: ` +
        `unable to inspect effective SSH configuration.`,
      cause: error
    });
  }
}

async function verifyHostKeyAccess(
  env: EnvironmentConfig,
  dependencies: RemotePreflightDependencies
): Promise<void> {
  if (env.kind !== "remote") {
    return;
  }

  const runLogger = getRunLogger();
  const effectiveConfig = await loadEffectiveSshConfig(env, dependencies);
  const knownHostsPaths = effectiveConfig.userKnownHostsFiles;
  const lookupNames = buildLookupNames(env, effectiveConfig);

  if (lookupNames.length === 0) {
    throw new RemotePreflightError({
      code: "preflightFailed",
      host: env.host,
      knownHostsPaths,
      message:
        `SSH host-key preflight failed for ${env.host}: ` +
        `unable to determine a host name to check in known_hosts.`
    });
  }

  if (knownHostsPaths.length === 0) {
    throw new RemotePreflightError({
      code: "hostNotTrusted",
      host: env.host,
      lookupNames,
      message:
        `SSH host key for ${env.host} is not trusted yet. ` +
        `No UserKnownHostsFile entries were resolved for this target.`
    });
  }

  for (const knownHostsPath of knownHostsPaths) {
    if (!(await dependencies.pathExists(knownHostsPath))) {
      continue;
    }

    for (const lookupName of lookupNames) {
      try {
        await dependencies.runCommand(
          "ssh-keygen",
          ["-F", lookupName, "-f", knownHostsPath],
          { streamOutput: false }
        );
        runLogger.debug("remotePreflight", "Verified SSH host key trust", {
          host: env.host,
          lookupName,
          knownHostsPath
        });
        return;
      } catch (error) {
        const message =
          error instanceof Error && error.message.trim()
            ? error.message
            : String(error);
        if (message.includes("Command failed (1):")) {
          continue;
        }
        if (isKnownHostsAccessFailure(message)) {
          throw new RemotePreflightError({
            code: "knownHostsAccess",
            host: env.host,
            lookupNames,
            knownHostsPaths: [knownHostsPath],
            message:
              `SSH host-key preflight failed for ${env.host}: ` +
              `OpenSSH could not inspect ${knownHostsPath}. ` +
              `Fix access to that known_hosts file or configure UserKnownHostsFile to a readable local path.`,
            cause: error
          });
        }
        throw new RemotePreflightError({
          code: "preflightFailed",
          host: env.host,
          lookupNames,
          knownHostsPaths: [knownHostsPath],
          message:
            `SSH host-key preflight failed for ${env.host}: ` +
            `ssh-keygen could not verify trust in ${knownHostsPath}.`,
          cause: error
        });
      }
    }
  }

  throw new RemotePreflightError({
    code: "hostNotTrusted",
    host: env.host,
    lookupNames,
    knownHostsPaths,
    message:
      `SSH host key for ${env.host} is not trusted yet. ` +
      `No entry for ${lookupNames.join(", ")} was found in ${knownHostsPaths.join(", ")}. ` +
      `Trust the host first with ssh or update your SSH config, then rerun the command.`
  });
}

async function runCapability(
  env: EnvironmentConfig,
  capability: RemotePreflightCapability,
  dependencies: RemotePreflightDependencies
): Promise<void> {
  if (capability === "hostKeyAccess") {
    await verifyHostKeyAccess(env, dependencies);
    return;
  }
}

export async function ensureRemotePreflight(
  session: RemotePreflightSession,
  env: EnvironmentConfig,
  capabilities: RemotePreflightCapability[],
  dependencies: RemotePreflightDependencies = DEFAULT_REMOTE_PREFLIGHT_DEPENDENCIES
): Promise<void> {
  if (env.kind !== "remote") {
    return;
  }

  const runLogger = getRunLogger();
  for (const capability of capabilities) {
    const cacheKey = buildCapabilityCacheKey(env, capability);
    let pending = session.capabilityCache.get(cacheKey);
    if (!pending) {
      pending = runCapability(env, capability, dependencies).catch((error) => {
        runLogger.error("remotePreflight", "Remote preflight failed", {
          capability,
          host: env.host,
          code:
            error instanceof RemotePreflightError
              ? error.code
              : "preflightFailed",
          knownHostsPaths:
            error instanceof RemotePreflightError ? error.knownHostsPaths : [],
          error: error instanceof Error ? error.message : String(error)
        });
        throw error;
      });
      session.capabilityCache.set(cacheKey, pending);
    }
    await pending;
  }
}
