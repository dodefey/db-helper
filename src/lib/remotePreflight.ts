import { EnvironmentConfig } from "../config/types.js";
import { runCommand } from "./exec.js";
import { getRunLogger } from "./runLog.js";

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
}

const DEFAULT_REMOTE_PREFLIGHT_DEPENDENCIES: RemotePreflightDependencies = {
  runCommand
};

const SSH_PREFLIGHT_ARGS = [
  "-o",
  "BatchMode=yes",
  "-o",
  "StrictHostKeyChecking=yes",
  "-o",
  "ConnectTimeout=5"
] as const;

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

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  return String(error);
}

function extractFailureBody(message: string): string {
  const newlineIndex = message.indexOf("\n");
  if (newlineIndex === -1) {
    return message;
  }
  const body = message.slice(newlineIndex + 1).trim();
  return body || message;
}

function isKnownHostsAccessFailure(message: string): boolean {
  return (
    message.includes("Operation not permitted") ||
    message.includes("hostkeys_foreach failed") ||
    message.includes("Failed to add the host") ||
    message.includes("Cannot stat ")
  );
}

function isHostTrustFailure(message: string): boolean {
  return (
    message.includes("Host key verification failed") ||
    message.includes("REMOTE HOST IDENTIFICATION HAS CHANGED") ||
    message.includes("No ED25519 host key is known for") ||
    message.includes("No RSA host key is known for") ||
    message.includes("No ECDSA host key is known for") ||
    message.includes("The authenticity of host") ||
    message.includes("host key is not trusted") ||
    message.includes("Host key verification")
  );
}

function buildSshPreflightArgs(env: EnvironmentConfig): string[] {
  return [...SSH_PREFLIGHT_ARGS, ...buildSshBaseArgs(env), "true"];
}

async function verifyHostKeyAccess(
  env: EnvironmentConfig,
  dependencies: RemotePreflightDependencies
): Promise<void> {
  if (env.kind !== "remote") {
    return;
  }

  const runLogger = getRunLogger();
  const sshArgs = buildSshPreflightArgs(env);
  try {
    await dependencies.runCommand("ssh", sshArgs, { streamOutput: false });
    runLogger.debug("remotePreflight", "Verified SSH preflight", {
      host: env.host
    });
  } catch (error) {
    const details = extractFailureBody(extractErrorMessage(error));
    const code = isKnownHostsAccessFailure(details)
      ? "knownHostsAccess"
      : isHostTrustFailure(details)
        ? "hostNotTrusted"
        : "preflightFailed";

    throw new RemotePreflightError({
      code,
      host: env.host,
      message:
        code === "knownHostsAccess"
          ? `SSH preflight failed for ${env.host}: OpenSSH could not access known_hosts state.\n${details}`
          : code === "hostNotTrusted"
            ? `SSH preflight failed for ${env.host}: the host is not trusted.\n${details}`
            : `SSH preflight failed for ${env.host}.\n${details}`,
      cause: error
    });
  }
}

async function runCapability(
  env: EnvironmentConfig,
  capability: RemotePreflightCapability,
  dependencies: RemotePreflightDependencies
): Promise<void> {
  if (capability === "hostKeyAccess") {
    await verifyHostKeyAccess(env, dependencies);
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
