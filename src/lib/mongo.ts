import { tmpdir } from "node:os";
import path from "node:path";
import {
  AppConfig,
  BackupManifest,
  EnvironmentConfig
} from "../config/types.js";
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
  await runRemote(env, `rm -f ${JSON.stringify(remotePath)}`).catch(
    () => undefined
  );
}

async function runRemote(
  env: EnvironmentConfig,
  remoteCommand: string
): Promise<string> {
  if (!env.sshUser || !env.sshKeyPath) {
    throw new Error(`Remote environment ${env.id} is missing SSH config`);
  }

  return runCommand("ssh", [
    "-i",
    env.sshKeyPath,
    `${env.sshUser}@${env.host}`,
    remoteCommand
  ]);
}

async function copyFromRemote(
  env: EnvironmentConfig,
  remotePath: string,
  localPath: string
): Promise<void> {
  await runCommand("scp", [
    "-i",
    env.sshKeyPath!,
    `${env.sshUser}@${env.host}:${remotePath}`,
    localPath
  ]);
}

async function copyToRemote(
  env: EnvironmentConfig,
  localPath: string,
  remotePath: string
): Promise<void> {
  await runCommand("scp", [
    "-i",
    env.sshKeyPath!,
    localPath,
    `${env.sshUser}@${env.host}:${remotePath}`
  ]);
}

export async function listCollections(
  env: EnvironmentConfig
): Promise<string[]> {
  const script = `const dbx = connect(${JSON.stringify(mongoUri(env))}).getDB(${JSON.stringify(env.databaseName)}); print(JSON.stringify(dbx.getCollectionNames().sort()));`;
  const output =
    env.kind === "local"
      ? await runCommand("mongosh", [
          mongoUri(env),
          "--quiet",
          "--eval",
          script
        ])
      : await runRemote(
          env,
          `mongosh ${JSON.stringify(mongoUri(env))} --quiet --eval ${JSON.stringify(script)}`
        );

  return JSON.parse(output || "[]") as string[];
}

export async function getCollectionCounts(
  env: EnvironmentConfig,
  collections: string[]
): Promise<Record<string, number>> {
  if (collections.length === 0) {
    return {};
  }

  const script = `
const dbx = connect(${JSON.stringify(mongoUri(env))}).getDB(${JSON.stringify(env.databaseName)});
const names = ${JSON.stringify(collections)};
const counts = {};
for (const name of names) counts[name] = dbx.getCollection(name).countDocuments({});
print(JSON.stringify(counts));
`;

  const output =
    env.kind === "local"
      ? await runCommand("mongosh", [
          mongoUri(env),
          "--quiet",
          "--eval",
          script
        ])
      : await runRemote(
          env,
          `mongosh ${JSON.stringify(mongoUri(env))} --quiet --eval ${JSON.stringify(script)}`
        );

  return JSON.parse(output || "{}") as Record<string, number>;
}

export async function createArchiveBackup(
  env: EnvironmentConfig,
  appConfig: AppConfig,
  destinationFile: string
): Promise<void> {
  if (env.kind === "local") {
    await runCommand("mongodump", [
      "--uri",
      mongoUri(env),
      "--gzip",
      `--archive=${destinationFile}`
    ]);
    return;
  }

  const remotePath = remoteArchivePath(appConfig, env);
  try {
    await runRemote(
      env,
      `mkdir -p ${JSON.stringify(appConfig.tempRoot)} && mongodump --uri ${JSON.stringify(mongoUri(env))} --gzip --archive=${JSON.stringify(remotePath)}`
    );
    await copyFromRemote(env, remotePath, destinationFile);
  } finally {
    await cleanupRemoteArchive(env, remotePath);
  }
}

export async function restoreArchiveToEnvironment(
  env: EnvironmentConfig,
  appConfig: AppConfig,
  archiveFile: string,
  options: { collection?: string; drop: boolean }
): Promise<void> {
  const baseArgs = ["--uri", mongoUri(env), "--gzip"];
  if (options.drop) {
    baseArgs.push("--drop");
  }
  if (options.collection) {
    const namespace = `${env.databaseName}.${options.collection}`;
    baseArgs.push("--nsInclude", namespace);
  }

  if (env.kind === "local") {
    await runCommand("mongorestore", [...baseArgs, `--archive=${archiveFile}`]);
    return;
  }

  const remotePath = remoteArchivePath(appConfig, env);
  try {
    await runRemote(env, `mkdir -p ${JSON.stringify(appConfig.tempRoot)}`);
    await copyToRemote(env, archiveFile, remotePath);
    const remoteArgs = [...baseArgs, `--archive=${remotePath}`];
    await runRemote(
      env,
      `mongorestore ${remoteArgs.map((arg) => JSON.stringify(arg)).join(" ")}`
    );
  } finally {
    await cleanupRemoteArchive(env, remotePath);
  }
}

export async function verifyConnectivity(
  env: EnvironmentConfig
): Promise<void> {
  if (env.kind === "remote") {
    await runRemote(env, "true");
  }

  const script = "db.runCommand({ ping: 1 })";
  if (env.kind === "local") {
    await runCommand("mongosh", [mongoUri(env), "--quiet", "--eval", script]);
  } else {
    await runRemote(
      env,
      `mongosh ${JSON.stringify(mongoUri(env))} --quiet --eval ${JSON.stringify(script)}`
    );
  }
}

export async function inspectArchiveCollections(
  manifest: BackupManifest
): Promise<string[]> {
  return manifest.collectionList;
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
