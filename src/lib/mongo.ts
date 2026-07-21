import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { AppConfig, EnvironmentConfig } from "../config/types.js";
import { CommandInvocationContext } from "./invocationContext.js";
import { OutputMode, shouldStreamSubprocessOutput } from "./output.js";
import { runCommand } from "./exec.js";
import { ensureRemotePreflight } from "./remotePreflight.js";

type RemoteInvocationOptions = {
  remotePreflightSession?: CommandInvocationContext["remotePreflightSession"];
};

type MongoShellOptions = {
  outputMode?: OutputMode;
  signal?: AbortSignal;
  remotePreflightSession?: CommandInvocationContext["remotePreflightSession"];
  env?: NodeJS.ProcessEnv;
  streamOutput?: boolean;
  writeStdout?: (message: string) => void;
};

export type RemoteOperationErrorCode =
  | "sshTransport"
  | "scpTransport"
  | "remoteCleanupFailed";

export type RemoteOperation =
  | "ssh"
  | "scp-download"
  | "scp-upload"
  | "remote-cleanup";

export class RemoteOperationError extends Error {
  readonly code: RemoteOperationErrorCode;
  readonly host: string;
  readonly operation: RemoteOperation;
  readonly remoteTempPath?: string;
  readonly details: string;
  readonly interrupted: boolean;

  constructor(input: {
    code: RemoteOperationErrorCode;
    host: string;
    operation: RemoteOperation;
    details: string;
    remoteTempPath?: string;
    interrupted?: boolean;
    cause?: unknown;
  }) {
    super(input.details, {
      cause: input.cause instanceof Error ? input.cause : undefined
    });
    this.name = "RemoteOperationError";
    this.code = input.code;
    this.host = input.host;
    this.operation = input.operation;
    this.remoteTempPath = input.remoteTempPath;
    this.details = input.details;
    this.interrupted = input.interrupted ?? false;
  }
}

function mongoUri(env: EnvironmentConfig): string {
  const host = env.mongoHost || env.host;
  const params = new URLSearchParams({ authSource: env.authSource });
  return `mongodb://${encodeURIComponent(env.mongoUser)}:${encodeURIComponent(env.mongoPassword)}@${host}:${env.mongoPort}/${env.databaseName}?${params.toString()}`;
}

function remoteArchivePath(
  appConfig: AppConfig,
  env: EnvironmentConfig
): string {
  return path.posix.join(
    appConfig.tempRoot,
    `db-helper-${Date.now()}-${env.id}.archive.gz`
  );
}

async function cleanupRemoteArchive(
  env: EnvironmentConfig,
  remotePath: string,
  invocation?: RemoteInvocationOptions
): Promise<void> {
  try {
    await runRemote(
      env,
      `rm -f ${JSON.stringify(remotePath)}`,
      true,
      undefined,
      invocation
    );
  } catch (error) {
    throw wrapCleanupError(env, remotePath, error);
  }
}

function getErrorDetails(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }

  return String(error);
}

function extractTransportDetails(error: unknown): string {
  if (error instanceof RemoteOperationError) {
    return error.details;
  }
  return getErrorDetails(error);
}

function hasKnownHostsTrustFailure(message: string): boolean {
  return (
    message.includes("hostkeys_foreach failed") ||
    message.includes("Failed to add the host") ||
    message.includes("Operation not permitted") ||
    message.includes("known_hosts")
  );
}

function extractCommandFailureBody(message: string): string {
  const newlineIndex = message.indexOf("\n");
  if (newlineIndex === -1) {
    return message.trim();
  }

  const body = message.slice(newlineIndex + 1).trim();
  return body || message.trim();
}

function isInterruptedTransportFailure(error: unknown): boolean {
  return (
    (error instanceof Error &&
      error.message.startsWith("Command interrupted:")) ||
    (error instanceof RemoteOperationError && error.interrupted)
  );
}

export function translateRemoteProcessError(input: {
  host: string;
  operation: RemoteOperation;
  remoteTempPath?: string;
  error: unknown;
}): RemoteOperationError {
  if (input.error instanceof RemoteOperationError) {
    return input.error;
  }

  const rawDetails = extractCommandFailureBody(getErrorDetails(input.error));
  const interrupted = isInterruptedTransportFailure(input.error);
  const trustFailure = hasKnownHostsTrustFailure(rawDetails);

  if (input.operation === "ssh") {
    return new RemoteOperationError({
      code: "sshTransport",
      host: input.host,
      operation: input.operation,
      remoteTempPath: input.remoteTempPath,
      interrupted,
      details: trustFailure
        ? `SSH could not verify or access host-key trust for ${input.host}. Check known_hosts access and trust the host before retrying.`
        : `SSH transport to ${input.host} failed.\n${rawDetails}`,
      cause: input.error
    });
  }

  return new RemoteOperationError({
    code: "scpTransport",
    host: input.host,
    operation: input.operation,
    remoteTempPath: input.remoteTempPath,
    interrupted,
    details: trustFailure
      ? `SSH could not verify or access host-key trust for ${input.host}. Check known_hosts access and trust the host before retrying.`
      : `SCP transport to ${input.host} failed during ${input.operation}.\n${rawDetails}`,
    cause: input.error
  });
}

function wrapCleanupError(
  env: EnvironmentConfig,
  remotePath: string,
  error: unknown
): RemoteOperationError {
  const translated = translateRemoteProcessError({
    host: env.host,
    operation: "ssh",
    remoteTempPath: remotePath,
    error
  });

  return new RemoteOperationError({
    code: "remoteCleanupFailed",
    host: env.host,
    operation: "remote-cleanup",
    remoteTempPath: remotePath,
    interrupted: translated.interrupted,
    details: `Remote cleanup failed on ${env.host}.\n${translated.details}`,
    cause: translated
  });
}

export function combineRemoteTransportErrors(
  primaryError: unknown,
  cleanupError: unknown,
  remoteTempPath: string
): RemoteOperationError {
  const primary =
    primaryError instanceof RemoteOperationError
      ? primaryError
      : new RemoteOperationError({
          code: "sshTransport",
          host: "unknown",
          operation: "ssh",
          details: extractTransportDetails(primaryError),
          remoteTempPath,
          interrupted: isInterruptedTransportFailure(primaryError),
          cause: primaryError
        });
  const cleanupDetails = extractTransportDetails(cleanupError);

  return new RemoteOperationError({
    code: primary.code,
    host: primary.host,
    operation: primary.operation,
    remoteTempPath: primary.remoteTempPath ?? remoteTempPath,
    interrupted: primary.interrupted,
    details: `${primary.details}\nRemote temporary archive cleanup failed: ${cleanupDetails}`,
    cause: primary
  });
}

async function runRemote(
  env: EnvironmentConfig,
  remoteCommand: string,
  streamOutput = true,
  signal?: AbortSignal,
  invocation?: RemoteInvocationOptions
): Promise<string> {
  if (env.kind === "remote" && invocation?.remotePreflightSession) {
    await ensureRemotePreflight(invocation.remotePreflightSession, env, [
      "hostKeyAccess"
    ]);
  }
  const target = env.sshUser ? `${env.sshUser}@${env.host}` : env.host;
  const sshArgs = env.sshKeyPath
    ? ["-i", env.sshKeyPath, target, remoteCommand]
    : [target, remoteCommand];

  try {
    return await runCommand("ssh", sshArgs, { streamOutput, signal });
  } catch (error) {
    throw translateRemoteProcessError({
      host: env.host,
      operation: "ssh",
      error
    });
  }
}

async function copyFromRemote(
  env: EnvironmentConfig,
  remotePath: string,
  localPath: string,
  signal?: AbortSignal,
  invocation?: RemoteInvocationOptions
): Promise<void> {
  if (env.kind === "remote" && invocation?.remotePreflightSession) {
    await ensureRemotePreflight(invocation.remotePreflightSession, env, [
      "hostKeyAccess"
    ]);
  }
  const sourceTarget = `${env.sshUser ? `${env.sshUser}@` : ""}${env.host}:${remotePath}`;
  const scpArgs = env.sshKeyPath
    ? ["-i", env.sshKeyPath, sourceTarget, localPath]
    : [sourceTarget, localPath];
  try {
    await runCommand("scp", scpArgs, { signal });
  } catch (error) {
    throw translateRemoteProcessError({
      host: env.host,
      operation: "scp-download",
      remoteTempPath: remotePath,
      error
    });
  }
}

async function copyToRemote(
  env: EnvironmentConfig,
  localPath: string,
  remotePath: string,
  signal?: AbortSignal,
  invocation?: RemoteInvocationOptions
): Promise<void> {
  if (env.kind === "remote" && invocation?.remotePreflightSession) {
    await ensureRemotePreflight(invocation.remotePreflightSession, env, [
      "hostKeyAccess"
    ]);
  }
  const destinationTarget = `${env.sshUser ? `${env.sshUser}@` : ""}${env.host}:${remotePath}`;
  const scpArgs = env.sshKeyPath
    ? ["-i", env.sshKeyPath, localPath, destinationTarget]
    : [localPath, destinationTarget];
  try {
    await runCommand("scp", scpArgs, { signal });
  } catch (error) {
    throw translateRemoteProcessError({
      host: env.host,
      operation: "scp-upload",
      remoteTempPath: remotePath,
      error
    });
  }
}

async function runMongoShell(
  env: EnvironmentConfig,
  script: string,
  options: MongoShellOptions = {}
): Promise<string> {
  const streamOutput =
    options.streamOutput ??
    shouldStreamSubprocessOutput(options.outputMode ?? "verbose");

  if (env.kind === "local") {
    return runCommand("mongosh", [mongoUri(env), "--quiet", "--eval", script], {
      streamOutput,
      signal: options.signal,
      env: options.env
    });
  }

  return runRemote(
    env,
    `mongosh ${JSON.stringify(mongoUri(env))} --quiet --eval ${JSON.stringify(script)}`,
    streamOutput,
    options.signal,
    options
  );
}

const MONGOSH_RESULT_PREFIX = "__DBH_MONGOSH_RESULT__";

function buildMongoShellResultMarker(): string {
  return `${MONGOSH_RESULT_PREFIX}${randomUUID()}__`;
}

function buildMongoShellResultScript(script: string, marker: string): string {
  return `${script} print(${JSON.stringify(marker)} + JSON.stringify(__dbhResult));`;
}

export function parseMongoShellResult<T>(output: string, marker: string): T {
  const resultLines = output
    .split(/\r?\n/)
    .filter((line) => line.startsWith(marker));

  if (resultLines.length === 0) {
    throw new Error("mongosh returned no tagged machine-readable result");
  }
  if (resultLines.length > 1) {
    throw new Error(
      "mongosh returned multiple tagged machine-readable results"
    );
  }

  const payload = resultLines[0].slice(marker.length);
  if (!payload) {
    throw new Error("mongosh returned an empty tagged machine-readable result");
  }

  try {
    return JSON.parse(payload) as T;
  } catch (error) {
    throw new Error(
      "mongosh returned malformed tagged machine-readable result",
      {
        cause: error
      }
    );
  }
}

function assertCollectionList(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.some((collection) => typeof collection !== "string")
  ) {
    throw new Error("mongosh returned an invalid collection-list result");
  }

  return value;
}

function assertCollectionCounts(
  value: unknown,
  collections: string[]
): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("mongosh returned an invalid collection-count result");
  }

  const counts = value as Record<string, unknown>;
  const names = Object.keys(counts);
  if (
    names.length !== collections.length ||
    collections.some((collection) => !Object.hasOwn(counts, collection))
  ) {
    throw new Error(
      "mongosh returned incomplete or ambiguous collection counts"
    );
  }

  for (const collection of collections) {
    const count = counts[collection];
    if (
      typeof count !== "number" ||
      !Number.isFinite(count) ||
      count < 0 ||
      !Number.isInteger(count)
    ) {
      throw new Error(`mongosh returned an invalid count for ${collection}`);
    }
  }

  return Object.fromEntries(
    collections.map((collection) => [collection, counts[collection] as number])
  );
}

export function parseMongoShellCollectionList(
  output: string,
  marker: string
): string[] {
  return assertCollectionList(parseMongoShellResult(output, marker));
}

export function parseMongoShellCollectionCounts(
  output: string,
  marker: string,
  collections: string[]
): Record<string, number> {
  return assertCollectionCounts(
    parseMongoShellResult(output, marker),
    collections
  );
}

async function runMongoShellResult<T>(
  env: EnvironmentConfig,
  script: string,
  parse: (output: string, marker: string) => T,
  options: MongoShellOptions = {}
): Promise<T> {
  const marker = buildMongoShellResultMarker();
  const output = await runMongoShell(
    env,
    buildMongoShellResultScript(script, marker),
    { ...options, streamOutput: false }
  );
  const result = parse(output, marker);

  if (options.outputMode === "verbose") {
    const diagnostics = output
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith(marker));
    if (diagnostics.length > 0) {
      (options.writeStdout ?? ((message) => process.stdout.write(message)))(
        `${diagnostics.join("\n")}\n`
      );
    }
  }

  return result;
}

async function runCommandViaShell(
  command: string,
  options: { signal?: AbortSignal } = {}
): Promise<string> {
  return runCommand("sh", ["-lc", `${command} 2>&1`], {
    streamOutput: false,
    signal: options.signal
  });
}

export function parseArchiveCollections(
  output: string,
  sourceDatabaseName: string,
  targetDatabaseName: string
): string[] {
  const normalizedOutput = output.replace(/`/g, "");
  const names = new Set<string>();
  const sourceNamespacePatterns = [
    /^.*archive prelude ([^.]+)\.(.+)$/gm,
    /^.*reading metadata for ([^.]+)\.(.+?) from archive\b.*$/gm,
    /^.*restoring (?:to existing collection |to collection |)([^.]+)\.(.+?)(?: from archive\b.*| without dropping\b.*|$)/gm
  ];
  const targetNamespacePatterns = [
    /^.*found collection (?:metadata from )?([^.]+)\.(.+?)(?: bson)? to restore to ([^.]+)\.(.+)$/gm
  ];

  for (const pattern of sourceNamespacePatterns) {
    for (const match of normalizedOutput.matchAll(pattern)) {
      if (match[1] === sourceDatabaseName || match[1] === targetDatabaseName) {
        names.add(match[2]);
      }
    }
  }

  for (const pattern of targetNamespacePatterns) {
    for (const match of normalizedOutput.matchAll(pattern)) {
      if (match[3] === targetDatabaseName || match[3] === sourceDatabaseName) {
        names.add(match[4]);
      }
    }
  }

  return [...names].sort();
}

export async function listCollections(
  env: EnvironmentConfig,
  options: MongoShellOptions = {}
): Promise<string[]> {
  const script = `const dbx = db.getSiblingDB(${JSON.stringify(env.databaseName)}); const __dbhResult = dbx.getCollectionNames().sort();`;
  return runMongoShellResult(
    env,
    script,
    parseMongoShellCollectionList,
    options
  );
}

export async function getCollectionCounts(
  env: EnvironmentConfig,
  collections: string[],
  options: MongoShellOptions = {}
): Promise<Record<string, number>> {
  if (collections.length === 0) {
    return {};
  }

  const script = `const dbx = db.getSiblingDB(${JSON.stringify(env.databaseName)}); const names = ${JSON.stringify(collections)}; const __dbhResult = {}; for (const name of names) __dbhResult[name] = dbx.getCollection(name).countDocuments({});`;
  return runMongoShellResult(
    env,
    script,
    (output, marker) =>
      parseMongoShellCollectionCounts(output, marker, collections),
    options
  );
}

export async function dropCollections(
  env: EnvironmentConfig,
  collections: string[],
  options: {
    outputMode?: OutputMode;
    signal?: AbortSignal;
    remotePreflightSession?: CommandInvocationContext["remotePreflightSession"];
  } = {}
): Promise<void> {
  if (collections.length === 0) {
    return;
  }

  const script = `const dbx = db.getSiblingDB(${JSON.stringify(env.databaseName)}); const names = ${JSON.stringify(collections)}; for (const name of names) { const result = dbx.runCommand({ drop: name }); if (result.ok !== 1 && result.code !== 26 && result.codeName !== "NamespaceNotFound") { throw new Error(\`Failed to drop collection \${name}: \${result.errmsg || JSON.stringify(result)}\`); } }`;
  await runMongoShell(env, script, options);
}

export async function createArchiveBackup(
  env: EnvironmentConfig,
  appConfig: AppConfig,
  destinationFile: string,
  options: {
    outputMode?: OutputMode;
    signal?: AbortSignal;
    remotePreflightSession?: CommandInvocationContext["remotePreflightSession"];
  } = {}
): Promise<void> {
  const streamOutput = shouldStreamSubprocessOutput(
    options.outputMode ?? "verbose"
  );

  if (env.kind === "local") {
    await runCommand(
      "mongodump",
      ["--uri", mongoUri(env), "--gzip", `--archive=${destinationFile}`],
      { streamOutput, signal: options.signal }
    );
    return;
  }

  const remotePath = remoteArchivePath(appConfig, env);
  let primaryError: unknown;
  let cleanupError: unknown;
  try {
    await runRemote(
      env,
      `mkdir -p ${JSON.stringify(appConfig.tempRoot)} && mongodump --uri ${JSON.stringify(mongoUri(env))} --gzip --archive=${JSON.stringify(remotePath)}`,
      streamOutput,
      options.signal,
      options
    );
    await copyFromRemote(
      env,
      remotePath,
      destinationFile,
      options.signal,
      options
    );
  } catch (error) {
    primaryError = error;
  }
  try {
    await cleanupRemoteArchive(env, remotePath, options);
  } catch (error) {
    cleanupError = error;
  }

  if (primaryError && cleanupError) {
    throw combineRemoteTransportErrors(primaryError, cleanupError, remotePath);
  }
  if (primaryError) {
    if (primaryError instanceof RemoteOperationError) {
      throw new RemoteOperationError({
        code: primaryError.code,
        host: primaryError.host,
        operation: primaryError.operation,
        remoteTempPath: primaryError.remoteTempPath ?? remotePath,
        interrupted: primaryError.interrupted,
        details: primaryError.details,
        cause: primaryError
      });
    }
    throw primaryError;
  }
  if (cleanupError) {
    throw cleanupError;
  }
}

export async function restoreArchiveToEnvironment(
  env: EnvironmentConfig,
  appConfig: AppConfig,
  archiveFile: string,
  options: {
    sourceDatabaseName?: string;
    collection?: string;
    drop: boolean;
    outputMode?: OutputMode;
    signal?: AbortSignal;
    remotePreflightSession?: CommandInvocationContext["remotePreflightSession"];
  }
): Promise<void> {
  const streamOutput = shouldStreamSubprocessOutput(
    options.outputMode ?? "verbose"
  );
  const baseArgs = ["--uri", mongoUri(env), "--gzip"];
  if (options.drop) {
    baseArgs.push("--drop");
  }
  if (options.sourceDatabaseName) {
    if (options.collection) {
      const sourceNamespace = `${options.sourceDatabaseName}.${options.collection}`;
      const targetNamespace = `${env.databaseName}.${options.collection}`;
      baseArgs.push("--nsInclude", sourceNamespace);
      baseArgs.push("--nsFrom", sourceNamespace);
      baseArgs.push("--nsTo", targetNamespace);
    } else if (options.sourceDatabaseName !== env.databaseName) {
      baseArgs.push("--nsInclude", `${options.sourceDatabaseName}.*`);
      baseArgs.push("--nsFrom", `${options.sourceDatabaseName}.*`);
      baseArgs.push("--nsTo", `${env.databaseName}.*`);
    }
  }
  if (options.collection) {
    const namespace = `${env.databaseName}.${options.collection}`;
    if (!options.sourceDatabaseName) {
      baseArgs.push("--nsInclude", namespace);
    }
  }

  if (env.kind === "local") {
    await runCommand(
      "mongorestore",
      [...baseArgs, `--archive=${archiveFile}`],
      { streamOutput, signal: options.signal }
    );
    return;
  }

  const remotePath = remoteArchivePath(appConfig, env);
  let primaryError: unknown;
  let cleanupError: unknown;
  try {
    await runRemote(
      env,
      `mkdir -p ${JSON.stringify(appConfig.tempRoot)}`,
      streamOutput,
      options.signal,
      options
    );
    await copyToRemote(env, archiveFile, remotePath, options.signal, options);
    const remoteArgs = [...baseArgs, `--archive=${remotePath}`];
    await runRemote(
      env,
      `mongorestore ${remoteArgs.map((arg) => JSON.stringify(arg)).join(" ")}`,
      streamOutput,
      options.signal,
      options
    );
  } catch (error) {
    primaryError = error;
  }
  try {
    await cleanupRemoteArchive(env, remotePath, options);
  } catch (error) {
    cleanupError = error;
  }

  if (primaryError && cleanupError) {
    throw combineRemoteTransportErrors(primaryError, cleanupError, remotePath);
  }
  if (primaryError) {
    if (primaryError instanceof RemoteOperationError) {
      throw new RemoteOperationError({
        code: primaryError.code,
        host: primaryError.host,
        operation: primaryError.operation,
        remoteTempPath: primaryError.remoteTempPath ?? remotePath,
        interrupted: primaryError.interrupted,
        details: primaryError.details,
        cause: primaryError
      });
    }
    throw primaryError;
  }
  if (cleanupError) {
    throw cleanupError;
  }
}

export async function verifyConnectivity(
  env: EnvironmentConfig,
  options: RemoteInvocationOptions = {}
): Promise<void> {
  if (env.kind === "remote") {
    await runRemote(env, "true", true, undefined, options);
  }

  const script =
    "const result = db.runCommand({ ping: 1 }); if (result.ok !== 1) { throw new Error('Mongo ping failed'); }";
  await runMongoShell(env, script, {
    remotePreflightSession: options.remotePreflightSession
  });
}

export async function inspectArchiveCollections(
  env: EnvironmentConfig,
  appConfig: AppConfig,
  archiveFile: string,
  options: {
    sourceDatabaseName: string;
    outputMode?: OutputMode;
    signal?: AbortSignal;
    remotePreflightSession?: CommandInvocationContext["remotePreflightSession"];
  }
): Promise<string[]> {
  const baseArgs = ["--uri", mongoUri(env), "--gzip", "--dryRun", "--verbose"];
  if (options.sourceDatabaseName !== env.databaseName) {
    baseArgs.push("--nsInclude", `${options.sourceDatabaseName}.*`);
    baseArgs.push("--nsFrom", `${options.sourceDatabaseName}.*`);
    baseArgs.push("--nsTo", `${env.databaseName}.*`);
  }

  if (env.kind === "local") {
    const output = await runCommandViaShell(
      `mongorestore ${baseArgs
        .concat(`--archive=${archiveFile}`)
        .map((arg) => JSON.stringify(arg))
        .join(" ")}`,
      { signal: options.signal }
    );
    return parseArchiveCollections(
      output,
      options.sourceDatabaseName,
      env.databaseName
    );
  }

  const remotePath = remoteArchivePath(appConfig, env);
  let primaryError: unknown;
  let cleanupError: unknown;
  let output = "";
  try {
    await runRemote(
      env,
      `mkdir -p ${JSON.stringify(appConfig.tempRoot)}`,
      false,
      options.signal,
      options
    );
    await copyToRemote(env, archiveFile, remotePath, options.signal, options);
    const remoteArgs = [...baseArgs, `--archive=${remotePath}`];
    output = await runRemote(
      env,
      `mongorestore ${remoteArgs
        .map((arg) => JSON.stringify(arg))
        .join(" ")} 2>&1`,
      false,
      options.signal,
      options
    );
  } catch (error) {
    primaryError = error;
  }
  try {
    await cleanupRemoteArchive(env, remotePath, options);
  } catch (error) {
    cleanupError = error;
  }

  if (primaryError && cleanupError) {
    throw combineRemoteTransportErrors(primaryError, cleanupError, remotePath);
  }
  if (primaryError) {
    if (primaryError instanceof RemoteOperationError) {
      throw new RemoteOperationError({
        code: primaryError.code,
        host: primaryError.host,
        operation: primaryError.operation,
        remoteTempPath: primaryError.remoteTempPath ?? remotePath,
        interrupted: primaryError.interrupted,
        details: primaryError.details,
        cause: primaryError
      });
    }
    throw primaryError;
  }
  if (cleanupError) {
    throw cleanupError;
  }

  return parseArchiveCollections(
    output,
    options.sourceDatabaseName,
    env.databaseName
  );
}

export function createLocalTempFile(
  appConfig: AppConfig,
  suffix: string
): string {
  return path.join(
    appConfig.tempRoot || tmpdir(),
    `db-helper-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`
  );
}
