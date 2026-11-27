import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AppConfig, EnvironmentConfig } from "../config/types.js";
import { CommandInvocationContext } from "./invocationContext.js";
import { OutputMode, shouldStreamSubprocessOutput } from "./output.js";
import {
  CommandExitError,
  formatCommand,
  runCommand,
  RunCommandOptions
} from "./exec.js";
import { ensureRemotePreflight } from "./remotePreflight.js";
import {
  requireCollections,
  validateCollectionSelection
} from "./collections.js";

type RemoteInvocationOptions = {
  remotePreflightSession?: CommandInvocationContext["remotePreflightSession"];
  captureOutput?: RunCommandOptions["captureOutput"];
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

function mongoUriForScope(
  env: EnvironmentConfig,
  scope: "database" | "server"
): string {
  const host = env.mongoHost || env.host;
  const databasePath = scope === "database" ? `/${env.databaseName}` : "/";
  const credentials =
    env.mongoUser || env.mongoPassword
      ? `${encodeURIComponent(env.mongoUser)}:${encodeURIComponent(env.mongoPassword)}@`
      : "";
  const query = credentials
    ? `?${new URLSearchParams({ authSource: env.authSource }).toString()}`
    : "";
  return `mongodb://${credentials}${host}:${env.mongoPort}${databasePath}${query}`;
}

export function mongoDatabaseUri(env: EnvironmentConfig): string {
  return mongoUriForScope(env, "database");
}

export function mongoServerUri(env: EnvironmentConfig): string {
  return mongoUriForScope(env, "server");
}

type RestoreNamespaceOptions = {
  sourceDatabaseName: string;
  collections?: readonly string[];
};

export function buildRestoreNamespaceContract(
  env: EnvironmentConfig,
  options: RestoreNamespaceOptions
): { sourceNamespace: string; targetNamespace: string; args: string[] } {
  const { collections, sourceDatabaseName } = options;
  if (collections) validateCollectionSelection(collections);
  const sameDatabase = sourceDatabaseName === env.databaseName;
  const sourceNamespace = `${sourceDatabaseName}.*`;
  const targetNamespace = `${env.databaseName}.*`;
  const args = collections
    ? collections.flatMap((name) => [
        "--nsInclude",
        `${sourceDatabaseName}.${name}`
      ])
    : [];
  if (!sameDatabase) {
    if (!collections) args.push("--nsInclude", sourceNamespace);
    args.push("--nsFrom", sourceNamespace, "--nsTo", targetNamespace);
  }
  return { sourceNamespace, targetNamespace, args };
}

function remoteArchivePath(
  appConfig: AppConfig,
  env: EnvironmentConfig
): string {
  return path.posix.join(
    appConfig.tempRoot,
    `db-helper-${randomUUID()}-${env.id}.archive.gz`
  );
}

export async function cleanupRemoteArchive(
  env: EnvironmentConfig,
  remotePath: string,
  invocation?: RemoteInvocationOptions
): Promise<void> {
  try {
    await runRemote(
      env,
      formatCommand("rm", ["-f", "--", remotePath]),
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
  // OpenSSH uses 255 when the transport fails. Other exit codes come from the remote command.
  const remoteCommandFailed =
    input.operation === "ssh" &&
    input.error instanceof CommandExitError &&
    input.error.exitCode !== null &&
    input.error.exitCode !== 255;
  const trustFailure =
    !remoteCommandFailed && hasKnownHostsTrustFailure(rawDetails);

  if (input.operation === "ssh") {
    return new RemoteOperationError({
      code: "sshTransport",
      host: input.host,
      operation: input.operation,
      remoteTempPath: input.remoteTempPath,
      interrupted,
      details: trustFailure
        ? `SSH could not verify or access host-key trust for ${input.host}. Check known_hosts access and trust the host before retrying.`
        : remoteCommandFailed
          ? `Remote command on ${input.host} failed.\n${rawDetails}`
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
    return await runCommand("ssh", sshArgs, {
      streamOutput,
      signal,
      captureOutput: invocation?.captureOutput
    });
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
  invocation?: RemoteInvocationOptions & {
    runArchiveWriter?: typeof runCommand;
  }
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
    await (invocation?.runArchiveWriter ?? runCommand)("scp", scpArgs, {
      signal
    });
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
    return runCommand(
      "mongosh",
      [mongoDatabaseUri(env), "--quiet", "--eval", script],
      {
        streamOutput,
        signal: options.signal,
        env: options.env
      }
    );
  }

  return runRemote(
    env,
    formatCommand("mongosh", [
      mongoDatabaseUri(env),
      "--quiet",
      "--eval",
      script
    ]),
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

function parseScopedCollectionList(output: string, marker: string): string[] {
  const result = parseMongoShellResult<unknown>(output, marker);
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("mongosh returned invalid scoped collection metadata.");
  }
  const { collections, selectedViews, viewDefinitions } = result as Record<
    string,
    unknown
  >;
  const names = assertCollectionList(collections);
  const views = assertCollectionList(selectedViews);
  if (views.length === 0) return names;

  if (viewDefinitions === null) {
    const quotedViews = views.map((name) => JSON.stringify(name)).join(", ");
    throw new Error(
      `Scoped backup and sync cannot include selected views ${quotedViews}. MongoDB denied access to their backing collection metadata.`
    );
  }
  if (!Array.isArray(viewDefinitions)) {
    throw new Error("mongosh returned invalid view metadata.");
  }
  const definitions = new Map<string, string>();
  for (const view of viewDefinitions) {
    if (
      !Array.isArray(view) ||
      view.length !== 2 ||
      view.some((value) => typeof value !== "string" || value.length === 0)
    ) {
      throw new Error("mongosh returned invalid view metadata.");
    }
    const [name, backing] = view;
    definitions.set(name, backing);
  }
  const descriptions = views.map((name) => {
    const seen = new Set([name]);
    let backing = definitions.get(name);
    while (backing && definitions.has(backing)) {
      if (seen.has(backing))
        throw new Error("mongosh returned cyclic view metadata.");
      seen.add(backing);
      backing = definitions.get(backing);
    }
    return backing
      ? `Selected view ${JSON.stringify(name)} is backed by collection ${JSON.stringify(backing)}.`
      : `The backing collection for selected view ${JSON.stringify(name)} could not be determined.`;
  });
  throw new Error(
    `${descriptions.join(" ")} Scoped backup and sync require data collections. Select the backing collections or use a full backup.`
  );
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

export function parseMongoShellPingResult(
  output: string,
  marker: string
): void {
  const result = parseMongoShellResult<unknown>(output, marker);
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    (result as { ok?: unknown }).ok !== 1
  ) {
    throw new Error("mongosh returned an invalid ping result");
  }
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

export type ArchiveMutationState =
  | "not_started"
  | "in_progress"
  | "subprocess_succeeded";

export class ArchivePreflightError extends Error {
  constructor(cause: unknown) {
    super(
      cause instanceof Error && cause.message
        ? cause.message
        : "Archive preflight failed.",
      { cause: cause instanceof Error ? cause : undefined }
    );
    this.name = "ArchivePreflightError";
  }
}

export function isArchivePreflightError(error: unknown): boolean {
  let current = error;
  const visited = new Set<unknown>();
  while (current instanceof Error && !visited.has(current)) {
    if (current instanceof ArchivePreflightError) return true;
    visited.add(current);
    current = current.cause;
  }
  return false;
}

export interface ArchiveInspectionResult {
  mappings: Array<{ sourceNamespace: string; targetNamespace: string }>;
  collections: string[];
  completed: boolean;
}

export interface PreparedArchiveRestoreSession {
  readonly inspection: ArchiveInspectionResult;
  restore(options: {
    drop: boolean;
    outputMode?: OutputMode;
    signal?: AbortSignal;
    onMutationState?: (state: ArchiveMutationState) => void;
  }): Promise<void>;
  cleanup(): Promise<void>;
}

export interface PrepareArchiveRestoreDependencies {
  runRemote: typeof runRemote;
  copyToRemote: typeof copyToRemote;
  cleanupRemoteArchive: typeof cleanupRemoteArchive;
  runCommand: typeof runCommand;
}

const DEFAULT_PREPARE_ARCHIVE_RESTORE_DEPENDENCIES: PrepareArchiveRestoreDependencies =
  {
    runRemote,
    copyToRemote,
    cleanupRemoteArchive,
    runCommand
  };

async function runArchiveInspection(
  env: EnvironmentConfig,
  args: string[],
  options: RemoteInvocationOptions & { signal?: AbortSignal },
  dependencies: Pick<
    PrepareArchiveRestoreDependencies,
    "runCommand" | "runRemote"
  > = DEFAULT_PREPARE_ARCHIVE_RESTORE_DEPENDENCIES
): Promise<string> {
  if (env.kind === "remote") {
    return dependencies.runRemote(
      env,
      `${formatCommand("mongorestore", args)} 2>&1`,
      false,
      options.signal,
      { ...options, captureOutput: "combined-on-failure" }
    );
  }
  return dependencies.runCommand("mongorestore", args, {
    streamOutput: false,
    signal: options.signal,
    captureOutput: "combined"
  });
}

function validateArchiveInspectionScope(
  inspection: ArchiveInspectionResult,
  env: EnvironmentConfig,
  options: RestoreNamespaceOptions
): void {
  if (!options.collections) return;
  const reported = new Map(
    inspection.mappings.map(({ sourceNamespace, targetNamespace }) => [
      sourceNamespace,
      targetNamespace
    ])
  );
  const expected = new Map(
    options.collections.map((name) => [
      `${options.sourceDatabaseName}.${name}`,
      `${env.databaseName}.${name}`
    ])
  );
  // MongoDB reports a separate physical bucket mapping for time-series data.
  // The matching logical collection must still appear in the inspected archive.
  const buckets = new Map(
    options.collections.map((name) => [
      `${options.sourceDatabaseName}.system.buckets.${name}`,
      `${env.databaseName}.system.buckets.${name}`
    ])
  );
  if (
    [...expected].some(([source, target]) => reported.get(source) !== target) ||
    inspection.mappings.some(
      ({ sourceNamespace, targetNamespace }) =>
        targetNamespace !==
        (expected.get(sourceNamespace) ?? buckets.get(sourceNamespace))
    )
  ) {
    const expectedPairs = [...expected].map(
      ([source, target]) => `${source} -> ${target}`
    );
    throw new Error(
      `Archive inspection did not select exactly ${expectedPairs.join(", ")}.`
    );
  }
}

export function parseArchiveInspection(
  output: string,
  sourceDatabaseName: string,
  targetDatabaseName: string
): ArchiveInspectionResult {
  const completed =
    /\d+ document\(s\) restored successfully\.\s*\d+ document\(s\) failed to restore\./i.test(
      output
    ) || /dry run completed successfully/i.test(output);
  if (!completed) {
    throw new Error(
      "Archive inspection did not report a recognized completion signal."
    );
  }

  const mappings = new Map<
    string,
    { sourceNamespace: string; targetNamespace: string }
  >();
  // A namespace or diagnostic can contain "found collection" in the message body.
  const mappingLine =
    /^(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})[ \t]+)?found collection(?:[ \t]+(.*))?$/gm;
  const mappingPattern =
    /^(?:metadata from )?(?:\x60([^\x60]+)\x60|(\S+))(?: bson)? to restore to (?:\x60([^\x60]+)\x60|(\S+))[ \t]*$/;

  for (const [, description] of output.matchAll(mappingLine)) {
    const match = mappingPattern.exec(description ?? "");
    if (!match) {
      throw new Error(
        "Archive inspection reported an unreadable namespace mapping."
      );
    }
    const sourceNamespace = match[1] ?? match[2];
    const targetNamespace = match[3] ?? match[4];
    const key = JSON.stringify([sourceNamespace, targetNamespace]);
    mappings.set(key, { sourceNamespace, targetNamespace });
  }

  return {
    mappings: [...mappings.values()].sort((a, b) =>
      a.sourceNamespace.localeCompare(b.sourceNamespace)
    ),
    collections: [...mappings.values()]
      .filter(
        ({ sourceNamespace, targetNamespace }) =>
          sourceNamespace.startsWith(sourceDatabaseName + ".") &&
          targetNamespace.startsWith(targetDatabaseName + ".")
      )
      .map(({ targetNamespace }) =>
        targetNamespace.slice(targetDatabaseName.length + 1)
      )
      .sort(),
    completed
  };
}

export async function listCollections(
  env: EnvironmentConfig,
  options: MongoShellOptions & { rejectViewsIn?: readonly string[] } = {}
): Promise<string[]> {
  const database = `const dbx = db.getSiblingDB(${JSON.stringify(env.databaseName)});`;
  if (options.rejectViewsIn) {
    const script = `
      ${database}
      const selected = new Set(${JSON.stringify(options.rejectViewsIn)});
      const infos = dbx.getCollectionInfos({}, { nameOnly: true, authorizedCollections: true });
      const collections = infos.map(({ name }) => name).sort();
      const selectedViews = infos.filter(({ name, type }) =>
        type === "view" && selected.has(name)
      ).map(({ name }) => name);
      let viewDefinitions = [];
      if (selectedViews.length > 0) {
        try {
          viewDefinitions = dbx.getCollectionInfos({ type: "view" })
            .map(({ name, options }) => [name, options.viewOn]);
        } catch (error) {
          if (error.code !== 13) throw error;
          viewDefinitions = null;
        }
      }
      const __dbhResult = { collections, selectedViews, viewDefinitions };
    `;
    return runMongoShellResult(env, script, parseScopedCollectionList, options);
  }

  return runMongoShellResult(
    env,
    `${database} const __dbhResult = dbx.getCollectionNames().sort();`,
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

  const script = `const dbx = db.getSiblingDB(${JSON.stringify(env.databaseName)}); const names = ${JSON.stringify(collections)}; const __dbhResult = Object.create(null); for (const name of names) __dbhResult[name] = dbx.getCollection(name).countDocuments({});`;
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

type DumpSelection = {
  collections: readonly string[];
  sourceCollections: readonly string[];
};

export async function createArchiveBackup(
  env: EnvironmentConfig,
  appConfig: AppConfig,
  destinationFile: string,
  options: {
    selection?: DumpSelection;
    outputMode?: OutputMode;
    signal?: AbortSignal;
    runArchiveWriter?: typeof runCommand;
    remotePreflightSession?: CommandInvocationContext["remotePreflightSession"];
  } = {}
): Promise<void> {
  const streamOutput = shouldStreamSubprocessOutput(
    options.outputMode ?? "verbose"
  );
  const dumpArgs = ["--uri", mongoDatabaseUri(env), "--gzip"];
  const selection = options.selection;
  if (selection) {
    const { collections, sourceCollections } = selection;
    validateCollectionSelection(collections);
    requireCollections(
      collections,
      sourceCollections,
      `not found in source ${env.id}.`
    );
    if (collections.length === 1) {
      dumpArgs.push(`--collection=${collections[0]}`);
    } else {
      // mongodump supports either one explicit collection or a database-wide exclusion list.
      const selected = new Set(collections);
      dumpArgs.push(
        ...sourceCollections
          .filter((name) => !selected.has(name))
          .map((name) => `--excludeCollection=${name}`)
      );
    }
    await (await open(destinationFile, "wx", 0o600)).close();
  }

  const verifyDumpScope = async (archivePath: string): Promise<void> => {
    if (!selection) return;
    const args = [
      "--uri",
      mongoServerUri(env),
      "--gzip",
      "--dryRun",
      "--verbose",
      `--archive=${archivePath}`
    ];
    const output = await runArchiveInspection(env, args, options);
    const inspection = parseArchiveInspection(
      output,
      env.databaseName,
      env.databaseName
    );
    // Check the unfiltered archive because a collection can appear after we list the source.
    validateArchiveInspectionScope(inspection, env, {
      sourceDatabaseName: env.databaseName,
      collections: selection.collections
    });
  };

  if (env.kind === "local") {
    await (options.runArchiveWriter ?? runCommand)(
      "mongodump",
      [...dumpArgs, `--archive=${destinationFile}`],
      { streamOutput, signal: options.signal }
    );
    await verifyDumpScope(destinationFile);
    return;
  }

  const remotePath = remoteArchivePath(appConfig, env);
  let primaryError: unknown;
  let cleanupError: unknown;
  try {
    await runRemote(
      env,
      `umask 077 && ${formatCommand("mkdir", ["-p", "--", appConfig.tempRoot])} && ${formatCommand("mongodump", [...dumpArgs, `--archive=${remotePath}`])}`,
      streamOutput,
      options.signal,
      options
    );
    await verifyDumpScope(remotePath);
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
  options: RestoreNamespaceOptions & {
    drop: boolean;
    outputMode?: OutputMode;
    signal?: AbortSignal;
    onMutationState?: (state: ArchiveMutationState) => void;
    remotePreflightSession?: CommandInvocationContext["remotePreflightSession"];
  }
): Promise<void> {
  let session: PreparedArchiveRestoreSession | undefined;
  let primaryError: unknown;
  let cleanupError: unknown;
  try {
    session = await prepareArchiveRestoreSession(env, appConfig, archiveFile, {
      sourceDatabaseName: options.sourceDatabaseName,
      collections: options.collections,
      outputMode: options.outputMode,
      signal: options.signal,
      remotePreflightSession: options.remotePreflightSession
    });
    await session.restore(options);
  } catch (error) {
    primaryError = error;
  }
  if (session) {
    try {
      await session.cleanup();
    } catch (error) {
      cleanupError = error;
    }
  }

  if (primaryError && cleanupError) {
    throw combineRemoteTransportErrors(
      primaryError,
      cleanupError,
      cleanupError instanceof RemoteOperationError
        ? (cleanupError.remoteTempPath ?? "unknown")
        : "unknown"
    );
  }
  if (primaryError) {
    throw primaryError;
  }
  if (cleanupError) {
    throw cleanupError;
  }
}

export async function prepareArchiveRestoreSession(
  env: EnvironmentConfig,
  appConfig: AppConfig,
  archiveFile: string,
  options: RestoreNamespaceOptions & {
    outputMode?: OutputMode;
    signal?: AbortSignal;
    remotePreflightSession?: CommandInvocationContext["remotePreflightSession"];
  },
  dependencies: PrepareArchiveRestoreDependencies = DEFAULT_PREPARE_ARCHIVE_RESTORE_DEPENDENCIES
): Promise<PreparedArchiveRestoreSession> {
  const namespaceArgs = buildRestoreNamespaceContract(env, options).args;
  const archivePath =
    env.kind === "remote" ? remoteArchivePath(appConfig, env) : archiveFile;
  const inspectionArgs = [
    "--uri",
    mongoServerUri(env),
    "--gzip",
    ...namespaceArgs,
    "--dryRun",
    "--verbose",
    `--archive=${archivePath}`
  ];
  let staged = false;
  let cleaned = false;
  let restored = false;

  try {
    if (env.kind === "remote") {
      await dependencies.runRemote(
        env,
        formatCommand("mkdir", ["-p", "--", appConfig.tempRoot]),
        false,
        options.signal,
        options
      );
      staged = true;
      await dependencies.copyToRemote(
        env,
        archiveFile,
        archivePath,
        options.signal,
        options
      );
    }
    const inspectionOutput = await runArchiveInspection(
      env,
      inspectionArgs,
      options,
      dependencies
    );
    const inspection = parseArchiveInspection(
      inspectionOutput,
      options.sourceDatabaseName,
      env.databaseName
    );
    validateArchiveInspectionScope(inspection, env, options);

    return {
      inspection,
      async restore(restoreOptions): Promise<void> {
        if (cleaned) throw new Error("Prepared archive session is closed.");
        if (restored)
          throw new Error("Prepared archive session was already restored.");
        restored = true;
        const restoreArgs = ["--uri", mongoServerUri(env), "--gzip"];
        if (restoreOptions.drop) restoreArgs.push("--drop");
        restoreArgs.push(...namespaceArgs, `--archive=${archivePath}`);
        restoreOptions.onMutationState?.("in_progress");
        if (env.kind === "remote") {
          await dependencies.runRemote(
            env,
            formatCommand("mongorestore", restoreArgs),
            shouldStreamSubprocessOutput(
              restoreOptions.outputMode ?? options.outputMode ?? "verbose"
            ),
            restoreOptions.signal ?? options.signal,
            options
          );
        } else {
          await dependencies.runCommand("mongorestore", restoreArgs, {
            streamOutput: shouldStreamSubprocessOutput(
              restoreOptions.outputMode ?? options.outputMode ?? "verbose"
            ),
            signal: restoreOptions.signal ?? options.signal
          });
        }
        restoreOptions.onMutationState?.("subprocess_succeeded");
      },
      async cleanup(): Promise<void> {
        if (cleaned) return;
        cleaned = true;
        if (env.kind === "remote" && staged) {
          await dependencies.cleanupRemoteArchive(env, archivePath, options);
        }
      }
    };
  } catch (error) {
    let cleanupError: unknown;
    if (env.kind === "remote" && staged) {
      try {
        await dependencies.cleanupRemoteArchive(env, archivePath, options);
      } catch (cleanupFailure) {
        cleanupError = cleanupFailure;
      }
    }
    const preflightError = new ArchivePreflightError(error);
    if (cleanupError) {
      throw combineRemoteTransportErrors(
        preflightError,
        cleanupError,
        archivePath
      );
    }
    throw preflightError;
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
    "const result = db.runCommand({ ping: 1 }); if (result.ok !== 1) { throw new Error('Mongo ping failed'); } const __dbhResult = { ok: result.ok };";
  await runMongoShellResult(env, script, parseMongoShellPingResult, {
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
  let session: PreparedArchiveRestoreSession | undefined;
  try {
    session = await prepareArchiveRestoreSession(
      env,
      appConfig,
      archiveFile,
      options
    );
    return session.inspection.collections;
  } finally {
    await session?.cleanup();
  }
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
