import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const requiredBinaries = ["mongod", "mongosh", "mongodump", "mongorestore"];

async function requireBinary(binary: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(binary, ["--version"]);
    return stdout.trim();
  } catch (error) {
    throw new Error(
      `Restore integration requires ${binary} on PATH. Install MongoDB Database Tools and mongod before running npm run test:restore-integration.`,
      { cause: error }
    );
  }
}

async function freePort(): Promise<number> {
  const net = await import("node:net");
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not allocate an integration-test port."));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function main(): Promise<void> {
  const versions = Object.fromEntries(
    await Promise.all(
      requiredBinaries.map(async (binary) => [
        binary,
        await requireBinary(binary)
      ])
    )
  );
  const root = await mkdtemp(path.join(tmpdir(), "dbh-restore-integration-"));
  const port = await freePort();
  const dbPath = path.join(root, "db");
  await mkdir(dbPath);
  const mongod = spawn(
    "mongod",
    [
      "--dbpath",
      dbPath,
      "--port",
      String(port),
      "--bind_ip",
      "127.0.0.1",
      "--noauth"
    ],
    { stdio: "ignore" }
  );

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setInterval(async () => {
        try {
          await execFileAsync("mongosh", [
            `mongodb://127.0.0.1:${port}/admin`,
            "--quiet",
            "--eval",
            "db.runCommand({ ping: 1 })"
          ]);
          clearInterval(timer);
          resolve();
        } catch {
          if (mongod.exitCode !== null) {
            clearInterval(timer);
            reject(
              new Error(
                `mongod exited before becoming ready (${mongod.exitCode}).`
              )
            );
          }
        }
      }, 100);
    });

    const uri = `mongodb://127.0.0.1:${port}`;
    await execFileAsync("mongosh", [
      uri,
      "--quiet",
      "--eval",
      "const dbx=db.getSiblingDB('archive_db'); dbx.orders.insertMany([{n:1},{n:2}]); dbx.unrelated.insertOne({n:1});"
    ]);
    const archive = path.join(root, "archive.gz");
    await execFileAsync("mongodump", [
      "--uri",
      `${uri}/archive_db`,
      "--gzip",
      `--archive=${archive}`
    ]);
    const { restoreArchiveToEnvironment } = await import("../src/lib/mongo.js");
    const env = {
      id: "integration",
      name: "integration",
      label: "Integration",
      kind: "local" as const,
      host: "127.0.0.1",
      mongoHost: "127.0.0.1",
      mongoPort: port,
      databaseName: "archive_db",
      mongoUser: "",
      mongoPassword: "",
      authSource: "admin",
      isProduction: false
    };
    await restoreArchiveToEnvironment(
      env,
      {
        backupRoot: root,
        tempRoot: root,
        authSource: "admin",
        defaultDropOnRestore: true,
        environments: { integration: env }
      },
      archive,
      {
        sourceDatabaseName: "archive_db",
        collection: "orders",
        drop: true,
        outputMode: "quiet"
      }
    );
    const { stdout } = await execFileAsync("mongosh", [
      uri,
      "--quiet",
      "--eval",
      "JSON.stringify(db.getSiblingDB('archive_db').getCollectionNames().sort())"
    ]);
    if (!stdout.includes("orders") || stdout.includes("unrelated")) {
      throw new Error(
        `Collection restore regression detected: ${stdout.trim()}`
      );
    }
    process.stdout.write(
      `Restore integration tools:\n${Object.entries(versions)
        .map(([name, version]) => `  ${name}: ${version.split("\n")[0]}`)
        .join("\n")}\nDisposable mongod: 127.0.0.1:${port}\n` +
        "Archive-backed collection restore regression passed.\n"
    );
  } finally {
    mongod.kill("SIGTERM");
    await rm(root, { recursive: true, force: true });
  }
}

await main();
