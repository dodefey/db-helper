import { tmpdir } from "node:os";
import path from "node:path";
import { AppConfig, EnvironmentConfig } from "../config/types.js";
import { OutputMode, shouldStreamSubprocessOutput } from "./output.js";
import { runCommand } from "./exec.js";

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
  remotePath: string
): Promise<void> {
  await runRemote(env, `rm -f ${JSON.stringify(remotePath)}`, true);
}

function getErrorDetails(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }

  return String(error);
}

function combineWithCleanupFailure(
  primaryError: unknown,
  cleanupError: unknown
): Error {
  const primaryDetails = getErrorDetails(primaryError);
  const cleanupDetails = getErrorDetails(cleanupError);

  return new Error(
    `${primaryDetails}\nRemote temporary archive cleanup failed: ${cleanupDetails}`,
    {
      cause: primaryError instanceof Error ? primaryError : undefined
    }
  );
}

async function runRemote(
  env: EnvironmentConfig,
  remoteCommand: string,
  streamOutput = true,
  signal?: AbortSignal
): Promise<string> {
  const target = env.sshUser ? `${env.sshUser}@${env.host}` : env.host;
  const sshArgs = env.sshKeyPath
    ? ["-i", env.sshKeyPath, target, remoteCommand]
    : [target, remoteCommand];

  return runCommand("ssh", sshArgs, { streamOutput, signal });
}

async function copyFromRemote(
  env: EnvironmentConfig,
  remotePath: string,
  localPath: string,
  signal?: AbortSignal
): Promise<void> {
  const sourceTarget = `${env.sshUser ? `${env.sshUser}@` : ""}${env.host}:${remotePath}`;
  const scpArgs = env.sshKeyPath
    ? ["-i", env.sshKeyPath, sourceTarget, localPath]
    : [sourceTarget, localPath];
  await runCommand("scp", scpArgs, { signal });
}

async function copyToRemote(
  env: EnvironmentConfig,
  localPath: string,
  remotePath: string,
  signal?: AbortSignal
): Promise<void> {
  const destinationTarget = `${env.sshUser ? `${env.sshUser}@` : ""}${env.host}:${remotePath}`;
  const scpArgs = env.sshKeyPath
    ? ["-i", env.sshKeyPath, localPath, destinationTarget]
    : [localPath, destinationTarget];
  await runCommand("scp", scpArgs, { signal });
}

async function runMongoShell(
  env: EnvironmentConfig,
  script: string,
  options: { outputMode?: OutputMode; signal?: AbortSignal } = {}
): Promise<string> {
  const streamOutput = shouldStreamSubprocessOutput(
    options.outputMode ?? "verbose"
  );

  if (env.kind === "local") {
    return runCommand("mongosh", [mongoUri(env), "--quiet", "--eval", script], {
      streamOutput,
      signal: options.signal
    });
  }

  return runRemote(
    env,
    `mongosh ${JSON.stringify(mongoUri(env))} --quiet --eval ${JSON.stringify(script)}`,
    streamOutput,
    options.signal
  );
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

function parseArchiveCollections(
  output: string,
  databaseName: string
): string[] {
  const names = new Set<string>();
  const patterns = [
    /^.*archive prelude ([^.]+)\.(.+)$/gm,
    /^.*reading metadata for ([^.]+)\.(.+?) from archive\b.*$/gm,
    /^.*restoring (?:to existing collection |to collection |)([^.]+)\.(.+?)(?: from archive\b.*| without dropping\b.*|$)/gm
  ];

  for (const pattern of patterns) {
    for (const match of output.matchAll(pattern)) {
      if (match[1] !== databaseName) {
        continue;
      }
      names.add(match[2]);
    }
  }

  return [...names].sort();
}

export async function listCollections(
  env: EnvironmentConfig,
  options: { outputMode?: OutputMode; signal?: AbortSignal } = {}
): Promise<string[]> {
  const script = `const dbx = db.getSiblingDB(${JSON.stringify(env.databaseName)}); print(JSON.stringify(dbx.getCollectionNames().sort()));`;
  const output = await runMongoShell(env, script, options);

  return JSON.parse(output || "[]") as string[];
}

export async function getCollectionCounts(
  env: EnvironmentConfig,
  collections: string[],
  options: { outputMode?: OutputMode; signal?: AbortSignal } = {}
): Promise<Record<string, number>> {
  if (collections.length === 0) {
    return {};
  }

  const script = `const dbx = db.getSiblingDB(${JSON.stringify(env.databaseName)}); const names = ${JSON.stringify(collections)}; const counts = {}; for (const name of names) counts[name] = dbx.getCollection(name).countDocuments({}); print(JSON.stringify(counts));`;
  const output = await runMongoShell(env, script, options);

  return JSON.parse(output || "{}") as Record<string, number>;
}

export async function dropCollections(
  env: EnvironmentConfig,
  collections: string[],
  options: { outputMode?: OutputMode; signal?: AbortSignal } = {}
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
  options: { outputMode?: OutputMode; signal?: AbortSignal } = {}
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
      options.signal
    );
    await copyFromRemote(env, remotePath, destinationFile, options.signal);
  } catch (error) {
    primaryError = error;
  }
  try {
    await cleanupRemoteArchive(env, remotePath);
  } catch (error) {
    cleanupError = error;
  }

  if (primaryError && cleanupError) {
    throw combineWithCleanupFailure(primaryError, cleanupError);
  }
  if (primaryError) {
    throw primaryError;
  }
  if (cleanupError) {
    throw new Error(
      `Remote temporary archive cleanup failed: ${getErrorDetails(cleanupError)}`,
      { cause: cleanupError }
    );
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
      options.signal
    );
    await copyToRemote(env, archiveFile, remotePath, options.signal);
    const remoteArgs = [...baseArgs, `--archive=${remotePath}`];
    await runRemote(
      env,
      `mongorestore ${remoteArgs.map((arg) => JSON.stringify(arg)).join(" ")}`,
      streamOutput,
      options.signal
    );
  } catch (error) {
    primaryError = error;
  }
  try {
    await cleanupRemoteArchive(env, remotePath);
  } catch (error) {
    cleanupError = error;
  }

  if (primaryError && cleanupError) {
    throw combineWithCleanupFailure(primaryError, cleanupError);
  }
  if (primaryError) {
    throw primaryError;
  }
  if (cleanupError) {
    throw new Error(
      `Remote temporary archive cleanup failed: ${getErrorDetails(cleanupError)}`,
      { cause: cleanupError }
    );
  }
}

export async function verifyConnectivity(
  env: EnvironmentConfig
): Promise<void> {
  if (env.kind === "remote") {
    await runRemote(env, "true");
  }

  const script =
    "const result = db.runCommand({ ping: 1 }); if (result.ok !== 1) { throw new Error('Mongo ping failed'); }";
  await runMongoShell(env, script);
}

export async function inspectArchiveCollections(
  env: EnvironmentConfig,
  appConfig: AppConfig,
  archiveFile: string,
  options: {
    sourceDatabaseName: string;
    outputMode?: OutputMode;
    signal?: AbortSignal;
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
    return parseArchiveCollections(output, env.databaseName);
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
      options.signal
    );
    await copyToRemote(env, archiveFile, remotePath, options.signal);
    const remoteArgs = [...baseArgs, `--archive=${remotePath}`];
    output = await runRemote(
      env,
      `mongorestore ${remoteArgs
        .map((arg) => JSON.stringify(arg))
        .join(" ")} 2>&1`,
      false,
      options.signal
    );
  } catch (error) {
    primaryError = error;
  }
  try {
    await cleanupRemoteArchive(env, remotePath);
  } catch (error) {
    cleanupError = error;
  }

  if (primaryError && cleanupError) {
    throw combineWithCleanupFailure(primaryError, cleanupError);
  }
  if (primaryError) {
    throw primaryError;
  }
  if (cleanupError) {
    throw new Error(
      `Remote temporary archive cleanup failed: ${getErrorDetails(cleanupError)}`,
      { cause: cleanupError }
    );
  }

  return parseArchiveCollections(output, env.databaseName);
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
