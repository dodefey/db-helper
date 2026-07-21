import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { runBackupCreate } from "../src/lib/backup.js";
import { removeBackupArtifacts, readBackup } from "../src/lib/backups.js";

const execFileAsync = promisify(execFile);
const requiredBinaries = ["mongod", "mongosh", "mongodump", "mongorestore"];

async function waitForFile(file: string, timeoutMs = 10_000): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    try {
      await access(file);
      return;
    } catch {
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out waiting for integration marker ${file}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

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

async function mongoEval(uri: string, script: string): Promise<string> {
  const { stdout } = await execFileAsync("mongosh", [
    uri,
    "--quiet",
    "--eval",
    script
  ]);
  return stdout.trim();
}

async function mongoJson<T>(uri: string, script: string): Promise<T> {
  const marker = `__DBH_INTEGRATION_RESULT__${randomUUID()}__`;
  const output = await mongoEval(
    uri,
    `print(${JSON.stringify(marker)} + JSON.stringify(${script}))`
  );
  const matches = output
    .split(/\r?\n/)
    .filter((line) => line.startsWith(marker));
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one integration result envelope; received ${matches.length}.`
    );
  }
  return JSON.parse(matches[0].slice(marker.length)) as T;
}

async function captureStdout(run: () => Promise<void>): Promise<string> {
  const originalWrite = process.stdout.write;
  let output = "";
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    output += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    await run();
    return output;
  } finally {
    process.stdout.write = originalWrite;
  }
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
  let mongod = spawn(
    "mongod",
    [
      "--dbpath",
      dbPath,
      "--port",
      String(port),
      "--bind_ip",
      "127.0.0.1",
      "--auth"
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

    const username = `dbh_${randomUUID().replaceAll("-", "")}`;
    const password = randomUUID();
    await execFileAsync("mongosh", [
      `mongodb://127.0.0.1:${port}/admin`,
      "--quiet",
      "--eval",
      `db.createUser(${JSON.stringify({
        user: username,
        pwd: password,
        roles: ["root"]
      })})`
    ]);
    mongod.kill("SIGTERM");
    await once(mongod, "close");
    mongod = spawn(
      "mongod",
      [
        "--dbpath",
        dbPath,
        "--port",
        String(port),
        "--bind_ip",
        "127.0.0.1",
        "--auth"
      ],
      { stdio: "ignore" }
    );
    const uri = `mongodb://${encodeURIComponent(username)}:${encodeURIComponent(password)}@127.0.0.1:${port}/?authSource=admin`;
    for (let attempt = 0; ; attempt += 1) {
      try {
        await mongoEval(uri, "db.runCommand({ ping: 1 })");
        break;
      } catch (error) {
        if (attempt >= 100 || mongod.exitCode !== null) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    await mongoEval(
      uri,
      "const dbx=db.getSiblingDB('archive_db'); dbx.orders.insertMany([{_id:1,n:1},{_id:2,n:2}]); dbx.orders.createIndex({n:1},{name:'orders_n'}); dbx.createCollection('unrelated',{validator:{n:{$gte:0}}}); dbx.unrelated.insertOne({_id:'keep',n:1}); dbx.unrelated.createIndex({n:1},{name:'unrelated_n'}); dbx.createCollection('empty',{collation:{locale:'en',strength:2}}); dbx.empty.createIndex({n:1},{name:'empty_n'});"
    );
    const archive = path.join(root, "archive.gz");
    await execFileAsync("mongodump", [
      "--uri",
      `${uri.replace("/?authSource=admin", "/archive_db?authSource=admin")}`,
      "--gzip",
      `--archive=${archive}`
    ]);
    const { runRestoreCollection, runRestoreFull } =
      await import("../src/lib/restore.js");
    const { runSync } = await import("../src/lib/sync.js");
    const { listCollections } = await import("../src/lib/mongo.js");
    const { createRunLogger, setRunLogger } =
      await import("../src/lib/runLog.js");
    const env = {
      id: "integration",
      name: "integration",
      label: "Integration",
      kind: "local" as const,
      host: "127.0.0.1",
      mongoHost: "127.0.0.1",
      mongoPort: port,
      databaseName: "archive_db",
      mongoUser: username,
      mongoPassword: password,
      authSource: "admin",
      isProduction: false
    };
    const appConfig = {
      backupRoot: root,
      tempRoot: root,
      authSource: "admin",
      defaultDropOnRestore: true,
      environments: { integration: env }
    };
    const backupName = "integration-backup";
    const backupDir = path.join(root, backupName);
    await mkdir(backupDir);
    await copyFile(archive, path.join(backupDir, "dump.archive.gz"));
    await writeFile(
      path.join(backupDir, "manifest.json"),
      JSON.stringify({
        backupName,
        sourceEnvironment: "archive_db",
        databaseName: "archive_db",
        createdAt: new Date().toISOString(),
        tags: [],
        collectionList: ["empty", "orders", "unrelated"],
        collectionCounts: { empty: 0, orders: 2, unrelated: 1 },
        toolVersion: "integration",
        archiveFile: "dump.archive.gz"
      })
    );

    // Exercise the production backup lifecycle against the same disposable
    // authenticated server used by the restore and sync scenarios.
    const generatedBackupName = `integration-generated-${randomUUID()}`;
    const backupLogger = await createRunLogger({
      commandName: "restore-integration-backup",
      logRoot: root
    });
    setRunLogger(backupLogger);
    let generatedBackupSummary = "";
    let generatedBackupRecord;
    try {
      generatedBackupSummary = await captureStdout(async () => {
        generatedBackupRecord = await runBackupCreate(appConfig, {
          from: env.id,
          backupName: generatedBackupName,
          tags: ["integration"],
          outputMode: "default"
        });
      });
      await backupLogger.finalizeFailure();
    } finally {
      setRunLogger();
    }
    if (!generatedBackupRecord) {
      throw new Error("Production backup integration did not return a record.");
    }
    const generatedManifest = await readBackup(root, generatedBackupName);
    await access(
      path.join(generatedManifest.path, generatedManifest.manifest.archiveFile)
    );
    if (
      !generatedBackupSummary.includes(
        `Backup complete: ${generatedBackupName}`
      ) ||
      JSON.stringify(generatedManifest.manifest.collectionList) !==
        JSON.stringify(["empty", "orders", "unrelated"]) ||
      generatedManifest.manifest.collectionCounts.orders !== 2 ||
      generatedManifest.manifest.tags[0] !== "integration"
    ) {
      throw new Error(
        `Production backup lifecycle regression: ${JSON.stringify({
          summary: generatedBackupSummary,
          manifest: generatedManifest.manifest
        })}`
      );
    }
    const generatedBackupLog = await readFile(backupLogger.logPath, "utf8");
    if (generatedBackupLog.includes(password)) {
      throw new Error(
        "Production backup run log exposed the generated password."
      );
    }
    await removeBackupArtifacts(root, generatedBackupName);
    const runCollectionScenario = async (
      targetEnv: typeof env,
      collection: string,
      label: string
    ): Promise<{ summary: string; log: string }> => {
      const logger = await createRunLogger({
        commandName: `restore-integration-${label}`,
        logRoot: root
      });
      setRunLogger(logger);
      let summary: string;
      try {
        summary = await captureStdout(() =>
          runRestoreCollection(
            {
              ...appConfig,
              environments: { [targetEnv.id]: targetEnv }
            },
            {
              backup: backupName,
              collection,
              to: targetEnv.id,
              outputMode: "default"
            }
          )
        );
        await logger.finalizeFailure();
      } finally {
        setRunLogger();
      }
      return {
        summary,
        log: await readFile(logger.logPath, "utf8")
      };
    };
    const originalUnrelated = await mongoJson<unknown>(
      uri,
      "(()=>{const dbx=db.getSiblingDB('archive_db');return {docs:dbx.unrelated.find({}).sort({_id:1}).toArray(),indexes:dbx.unrelated.getIndexes(),options:dbx.getCollectionInfos({name:'unrelated'})[0].options};})()"
    );
    await mongoEval(
      uri,
      "const dbx=db.getSiblingDB('archive_db'); dbx.orders.insertOne({_id:99,n:99});"
    );
    const sameScoped = await runCollectionScenario(
      env,
      "orders",
      "same-orders"
    );
    if (
      !sameScoped.log.includes("--nsInclude") ||
      !sameScoped.log.includes("archive_db.orders") ||
      sameScoped.log.includes(password) ||
      !sameScoped.summary.includes(
        `Starting restore ${backupName}:orders -> integration`
      ) ||
      sameScoped.summary.includes("unrelated")
    ) {
      throw new Error(
        "Scoped restore logging or command summary was missing, broadened, or unredacted."
      );
    }
    const sameCollectionState = await mongoJson<{
      orders: unknown[];
      unrelated: unknown;
      orderIndexes: Array<{ name: string }>;
    }>(
      uri,
      "(()=>{const dbx=db.getSiblingDB('archive_db');return {orders:dbx.orders.find({}).sort({_id:1}).toArray(),unrelated:{docs:dbx.unrelated.find({}).sort({_id:1}).toArray(),indexes:dbx.unrelated.getIndexes(),options:dbx.getCollectionInfos({name:'unrelated'})[0].options},orderIndexes:dbx.orders.getIndexes()};})()"
    );
    if (
      JSON.stringify(sameCollectionState.orders) !==
        JSON.stringify([
          { _id: 1, n: 1 },
          { _id: 2, n: 2 }
        ]) ||
      JSON.stringify(sameCollectionState.unrelated) !==
        JSON.stringify(originalUnrelated) ||
      !sameCollectionState.orderIndexes.some(
        (index) => index.name === "orders_n"
      )
    ) {
      throw new Error(
        `Same-database collection restore regression: ${JSON.stringify(sameCollectionState)}`
      );
    }
    await mongoEval(
      uri,
      "const cross=db.getSiblingDB('cross_target'); cross.createCollection('unrelated',{validator:{keep:{$eq:true}}}); cross.unrelated.insertOne({_id:'keep',keep:true}); cross.unrelated.createIndex({keep:1},{name:'keep_index'}); const empty=db.getSiblingDB('empty_target'); empty.createCollection('unrelated',{validator:{keep:{$eq:true}}}); empty.unrelated.insertOne({_id:'keep',keep:true}); empty.unrelated.createIndex({keep:1},{name:'keep_index'});"
    );
    const unrelatedBefore = await mongoJson<{
      cross: unknown;
      empty: unknown;
    }>(
      uri,
      "(()=>{const snapshot=(dbx)=>({docs:dbx.unrelated.find({}).sort({_id:1}).toArray(),indexes:dbx.unrelated.getIndexes(),options:dbx.getCollectionInfos({name:'unrelated'})[0].options});return {cross:snapshot(db.getSiblingDB('cross_target')),empty:snapshot(db.getSiblingDB('empty_target'))};})()"
    );
    const crossEnv = {
      ...env,
      id: "cross",
      name: "cross",
      databaseName: "cross_target"
    };
    const emptyEnv = {
      ...env,
      id: "empty",
      name: "empty",
      databaseName: "empty_target"
    };
    const crossScoped = await runCollectionScenario(
      crossEnv,
      "orders",
      "cross-orders"
    );
    const emptyScoped = await runCollectionScenario(
      emptyEnv,
      "empty",
      "cross-empty"
    );
    for (const [scenario, scoped, collection, target] of [
      ["cross", crossScoped, "orders", "cross"],
      ["empty", emptyScoped, "empty", "empty"]
    ] as const) {
      if (
        !scoped.summary.includes(
          `Starting restore ${backupName}:${collection} -> ${target}`
        ) ||
        scoped.summary.includes("unrelated") ||
        !scoped.log.includes("--nsInclude") ||
        !scoped.log.includes(`archive_db.${collection}`) ||
        !scoped.log.includes("--nsTo") ||
        !scoped.log.includes(`${target}_target.${collection}`) ||
        scoped.log.includes("found collection `archive_db.unrelated`") ||
        scoped.log.includes(password)
      ) {
        throw new Error(
          `${scenario} collection restore logging or summary was missing, broadened, or unredacted: ${JSON.stringify(
            {
              summary: scoped.summary,
              hasNamespaceInclude: scoped.log.includes("--nsInclude"),
              hasSourceNamespace: scoped.log.includes(
                `archive_db.${collection}`
              ),
              hasNamespaceTargetFlag: scoped.log.includes("--nsTo"),
              hasTargetNamespace: scoped.log.includes(
                `${target}_target.${collection}`
              ),
              mapsUnrelated: scoped.log.includes(
                "found collection `archive_db.unrelated`"
              ),
              containsPassword: scoped.log.includes(password)
            }
          )}`
        );
      }
    }
    const scopedOutput = await mongoJson<{
      crossOrders: unknown[];
      crossUnrelated: unknown;
      emptyCount: number;
      emptyUnrelated: unknown;
      emptyOptions: Record<string, unknown>;
      emptyIndexes: Array<{ name: string }>;
    }>(
      uri,
      "(()=>{const cross=db.getSiblingDB('cross_target');const empty=db.getSiblingDB('empty_target');const snapshot=(dbx)=>({docs:dbx.unrelated.find({}).sort({_id:1}).toArray(),indexes:dbx.unrelated.getIndexes(),options:dbx.getCollectionInfos({name:'unrelated'})[0].options});return {crossOrders:cross.orders.find({}).sort({_id:1}).toArray(),crossUnrelated:snapshot(cross),emptyCount:empty.empty.countDocuments({}),emptyUnrelated:snapshot(empty),emptyOptions:empty.getCollectionInfos({name:'empty'})[0].options,emptyIndexes:empty.empty.getIndexes()};})()"
    );
    if (
      JSON.stringify(scopedOutput.crossOrders) !==
        JSON.stringify([
          { _id: 1, n: 1 },
          { _id: 2, n: 2 }
        ]) ||
      JSON.stringify(scopedOutput.crossUnrelated) !==
        JSON.stringify(unrelatedBefore.cross) ||
      scopedOutput.emptyCount !== 0 ||
      JSON.stringify(scopedOutput.emptyUnrelated) !==
        JSON.stringify(unrelatedBefore.empty) ||
      !JSON.stringify(scopedOutput.emptyOptions).includes('"locale":"en"') ||
      !scopedOutput.emptyIndexes.some((index) => index.name === "empty_n")
    ) {
      throw new Error(
        `Scoped restore regression detected: ${JSON.stringify(scopedOutput)}`
      );
    }
    await mongoEval(
      uri,
      "const same=db.getSiblingDB('archive_db'); same.target_only.insertOne({_id:'remove'}); same.getCollection('system.js').insertOne({_id:'keep',value:'function(){return true;}'});"
    );
    await runRestoreFull(
      { ...appConfig, environments: { integration: env } },
      {
        backup: backupName,
        to: "integration",
        skipPreBackup: true,
        outputMode: "quiet"
      }
    );
    const sameFullOutput = await mongoJson<{
      userCollections: string[];
      counts: Record<string, number>;
      systemPreserved: number;
    }>(
      uri,
      "(()=>{const dbx=db.getSiblingDB('archive_db');const users=dbx.getCollectionNames().filter(name=>!name.startsWith('system.')).sort();return {userCollections:users,counts:Object.fromEntries(users.map(name=>[name,dbx.getCollection(name).countDocuments({})])),systemPreserved:dbx.getCollection('system.js').countDocuments({_id:'keep'})};})()"
    );
    if (
      JSON.stringify(sameFullOutput.userCollections) !==
        JSON.stringify(["empty", "orders", "unrelated"]) ||
      JSON.stringify(sameFullOutput.counts) !==
        JSON.stringify({ empty: 0, orders: 2, unrelated: 1 }) ||
      sameFullOutput.systemPreserved !== 1
    ) {
      throw new Error(
        `Same-database full restore regression: ${JSON.stringify(sameFullOutput)}`
      );
    }

    const fullEnv = {
      ...env,
      id: "full_target",
      name: "full_target",
      databaseName: "full_target"
    };
    await mongoEval(
      uri,
      "const target=db.getSiblingDB('full_target'); target.target_only.insertOne({_id:'remove'}); target.getCollection('system.js').insertOne({_id:'keep',value:'function(){return true;}'});"
    );
    await runRestoreFull(
      { ...appConfig, environments: { full_target: fullEnv } },
      {
        backup: backupName,
        to: "full_target",
        skipPreBackup: true,
        outputMode: "quiet"
      }
    );
    const fullOutput = await mongoJson<{
      userCollections: string[];
      counts: Record<string, number>;
      systemPreserved: number;
    }>(
      uri,
      "(()=>{const dbx=db.getSiblingDB('full_target');const users=dbx.getCollectionNames().filter(name=>!name.startsWith('system.')).sort();return {userCollections:users,counts:Object.fromEntries(users.map(name=>[name,dbx.getCollection(name).countDocuments({})])),systemPreserved:dbx.getCollection('system.js').countDocuments({_id:'keep'})};})()"
    );
    if (
      JSON.stringify(fullOutput.userCollections) !==
        JSON.stringify(["empty", "orders", "unrelated"]) ||
      JSON.stringify(fullOutput.counts) !==
        JSON.stringify({ empty: 0, orders: 2, unrelated: 1 }) ||
      fullOutput.systemPreserved !== 1
    ) {
      throw new Error(
        `Cross-database full restore regression: ${JSON.stringify(fullOutput)}`
      );
    }

    const syncSource = {
      ...env,
      id: "sync_source",
      name: "sync_source",
      databaseName: "sync_source"
    };
    const syncFullTarget = {
      ...env,
      id: "sync_full_target",
      name: "sync_full_target",
      databaseName: "sync_full_target"
    };
    const syncCollectionTarget = {
      ...env,
      id: "sync_collection_target",
      name: "sync_collection_target",
      databaseName: "sync_collection_target"
    };
    const syncInterruptTarget = {
      ...env,
      id: "sync_interrupt_target",
      name: "sync_interrupt_target",
      databaseName: "sync_interrupt_target"
    };
    const syncSameSource = {
      ...env,
      id: "sync_same_source",
      name: "sync_same_source",
      databaseName: "sync_same_db"
    };
    const syncSameTarget = {
      ...env,
      id: "sync_same_target",
      name: "sync_same_target",
      databaseName: "sync_same_db"
    };
    await mongoEval(
      uri,
      "const source=db.getSiblingDB('sync_source'); source.dropDatabase(); source.orders.insertMany([{_id:1,n:1},{_id:2,n:2}]); source.orders.createIndex({n:1},{name:'orders_n'}); source.createCollection('unrelated',{validator:{keep:{$eq:true}}}); source.unrelated.insertOne({_id:'source',keep:true}); source.unrelated.createIndex({keep:1},{name:'unrelated_n'}); source.createCollection('empty',{collation:{locale:'en',strength:2}}); source.empty.createIndex({n:1},{name:'empty_n'}); const full=db.getSiblingDB('sync_full_target'); full.dropDatabase(); full.target_only.insertOne({_id:'remove'}); full.getCollection('system.js').insertOne({_id:'keep',value:'function(){return true;}'}); const scoped=db.getSiblingDB('sync_collection_target'); scoped.dropDatabase(); scoped.orders.insertOne({_id:'old',n:-1}); scoped.orders.createIndex({n:1},{name:'old_orders_n'}); scoped.unrelated.insertOne({_id:'keep',keep:true}); scoped.unrelated.createIndex({keep:1},{name:'keep_index'}); const interrupt=db.getSiblingDB('sync_interrupt_target'); interrupt.dropDatabase(); interrupt.target_only.insertOne({_id:'keep'}); const same=db.getSiblingDB('sync_same_db'); same.dropDatabase(); same.orders.insertMany([{_id:1,n:1},{_id:2,n:2}]); same.orders.createIndex({n:1},{name:'orders_n'}); same.unrelated.insertOne({_id:'keep',keep:true}); same.unrelated.createIndex({keep:1},{name:'keep_index'});"
    );
    const runSyncScenario = async (
      targetEnv: typeof syncFullTarget,
      input: { collection?: string },
      label: string,
      sourceEnv = syncSource
    ): Promise<{ summary: string; log: string }> => {
      const logger = await createRunLogger({
        commandName: `sync-integration-${label}`,
        logRoot: root
      });
      setRunLogger(logger);
      let summary: string | undefined;
      try {
        summary = await captureStdout(() =>
          runSync(
            {
              ...appConfig,
              environments: {
                [sourceEnv.id]: sourceEnv,
                [targetEnv.id]: targetEnv
              }
            },
            {
              from: sourceEnv.id,
              to: targetEnv.id,
              ...input,
              outputMode: "default"
            }
          )
        );
        await logger.finalizeFailure();
      } finally {
        setRunLogger();
      }
      return {
        summary: summary ?? "",
        log: await readFile(logger.logPath, "utf8")
      };
    };
    const fullSync = await runSyncScenario(syncFullTarget, {}, "full");
    if (
      !fullSync.summary.includes(
        "Starting sync sync_source -> sync_full_target"
      ) ||
      !fullSync.summary.includes(
        "Sync sync_source -> sync_full_target complete"
      ) ||
      !fullSync.log.includes("mongodump") ||
      !fullSync.log.includes("mongorestore") ||
      fullSync.log.includes(password)
    ) {
      throw new Error(
        "Full sync logging or summary was missing, incomplete, or unredacted."
      );
    }
    const fullSyncOutput = await mongoJson<{
      userCollections: string[];
      counts: Record<string, number>;
      orderIndexes: Array<{ name: string }>;
      unrelatedOptions: Record<string, unknown>;
      systemPreserved: number;
    }>(
      uri,
      "(()=>{const dbx=db.getSiblingDB('sync_full_target');const users=dbx.getCollectionNames().filter(name=>!name.startsWith('system.')).sort();return {userCollections:users,counts:Object.fromEntries(users.map(name=>[name,dbx.getCollection(name).countDocuments({})])),orderIndexes:dbx.orders.getIndexes(),unrelatedOptions:dbx.getCollectionInfos({name:'unrelated'})[0].options,systemPreserved:dbx.getCollection('system.js').countDocuments({_id:'keep'})};})()"
    );
    if (
      JSON.stringify(fullSyncOutput.userCollections) !==
        JSON.stringify(["empty", "orders", "unrelated"]) ||
      JSON.stringify(fullSyncOutput.counts) !==
        JSON.stringify({ empty: 0, orders: 2, unrelated: 1 }) ||
      !fullSyncOutput.orderIndexes.some((index) => index.name === "orders_n") ||
      !JSON.stringify(fullSyncOutput.unrelatedOptions).includes(
        '"validator"'
      ) ||
      fullSyncOutput.systemPreserved !== 1
    ) {
      throw new Error(
        `Full sync regression: ${JSON.stringify(fullSyncOutput)}`
      );
    }
    const originalSyncUnrelated = await mongoJson<unknown>(
      uri,
      "(()=>{const dbx=db.getSiblingDB('sync_collection_target');return {docs:dbx.unrelated.find({}).sort({_id:1}).toArray(),indexes:dbx.unrelated.getIndexes(),options:dbx.getCollectionInfos({name:'unrelated'})[0].options};})()"
    );
    const collectionSync = await runSyncScenario(
      syncCollectionTarget,
      { collection: "orders" },
      "collection"
    );
    if (
      !collectionSync.summary.includes(
        "Starting sync sync_source.orders -> sync_collection_target.orders"
      ) ||
      collectionSync.summary.includes("Removing target-only collections") ||
      !collectionSync.log.includes("--nsInclude") ||
      !collectionSync.log.includes("sync_source.orders") ||
      !collectionSync.log.includes("--nsTo") ||
      !collectionSync.log.includes("sync_collection_target.orders") ||
      collectionSync.log.includes(password)
    ) {
      throw new Error(
        "Collection sync logging or namespace scope was missing, broadened, or unredacted."
      );
    }
    const collectionSyncOutput = await mongoJson<{
      orders: unknown[];
      orderIndexes: Array<{ name: string }>;
      unrelated: unknown;
    }>(
      uri,
      "(()=>{const dbx=db.getSiblingDB('sync_collection_target');return {orders:dbx.orders.find({}).sort({_id:1}).toArray(),orderIndexes:dbx.orders.getIndexes(),unrelated:{docs:dbx.unrelated.find({}).sort({_id:1}).toArray(),indexes:dbx.unrelated.getIndexes(),options:dbx.getCollectionInfos({name:'unrelated'})[0].options}};})()"
    );
    if (
      JSON.stringify(collectionSyncOutput.orders) !==
        JSON.stringify([
          { _id: 1, n: 1 },
          { _id: 2, n: 2 }
        ]) ||
      !collectionSyncOutput.orderIndexes.some(
        (index) => index.name === "orders_n"
      ) ||
      JSON.stringify(collectionSyncOutput.unrelated) !==
        JSON.stringify(originalSyncUnrelated)
    ) {
      throw new Error(
        `Collection sync regression: ${JSON.stringify(collectionSyncOutput)}`
      );
    }
    const sameCollectionSync = await runSyncScenario(
      syncSameTarget,
      { collection: "orders" },
      "same-collection",
      syncSameSource
    );
    if (
      !sameCollectionSync.summary.includes(
        "Starting sync sync_same_source.orders -> sync_same_target.orders"
      ) ||
      !sameCollectionSync.log.includes("--nsInclude") ||
      !sameCollectionSync.log.includes("sync_same_db.orders") ||
      sameCollectionSync.log.includes("--nsTo") ||
      sameCollectionSync.log.includes(password)
    ) {
      throw new Error(
        "Same-database collection sync namespace scope was missing or broadened."
      );
    }
    const sameCollectionSyncOutput = await mongoJson<{
      orders: unknown[];
      unrelated: unknown[];
    }>(
      uri,
      "(()=>{const dbx=db.getSiblingDB('sync_same_db');return {orders:dbx.orders.find({}).sort({_id:1}).toArray(),unrelated:dbx.unrelated.find({}).sort({_id:1}).toArray()};})()"
    );
    if (
      JSON.stringify(sameCollectionSyncOutput.orders) !==
        JSON.stringify([
          { _id: 1, n: 1 },
          { _id: 2, n: 2 }
        ]) ||
      JSON.stringify(sameCollectionSyncOutput.unrelated) !==
        JSON.stringify([{ _id: "keep", keep: true }])
    ) {
      throw new Error(
        `Same-database collection sync regression: ${JSON.stringify(
          sameCollectionSyncOutput
        )}`
      );
    }
    const interruptRoot = path.join(root, "interrupt-shim");
    await mkdir(interruptRoot);
    const interruptReady = path.join(interruptRoot, "mongodump.ready");
    const interruptRelease = path.join(interruptRoot, "mongodump.release");
    const realMongodump = (
      await execFileAsync("sh", ["-lc", "command -v mongodump"])
    ).stdout.trim();
    const mongodumpShim = path.join(interruptRoot, "mongodump");
    await writeFile(
      mongodumpShim,
      `#!/bin/sh
trap 'exit 130' INT TERM
printf ready > "$DBH_INTERRUPT_READY"
while [ ! -f "$DBH_INTERRUPT_RELEASE" ]; do sleep 0.02; done
exec "$DBH_REAL_MONGODUMP" "$@"
`,
      "utf8"
    );
    await chmod(mongodumpShim, 0o755);
    const originalPath = process.env.PATH;
    const originalReady = process.env.DBH_INTERRUPT_READY;
    const originalRelease = process.env.DBH_INTERRUPT_RELEASE;
    const originalRealMongodump = process.env.DBH_REAL_MONGODUMP;
    process.env.PATH = `${interruptRoot}:${originalPath ?? ""}`;
    process.env.DBH_INTERRUPT_READY = interruptReady;
    process.env.DBH_INTERRUPT_RELEASE = interruptRelease;
    process.env.DBH_REAL_MONGODUMP = realMongodump;
    const interruptLogger = await createRunLogger({
      commandName: "sync-integration-interrupted-dump",
      logRoot: root
    });
    setRunLogger(interruptLogger);
    let interruptedError: unknown;
    let interruptedSummary = "";
    const interruptedRun = captureStdout(async () => {
      try {
        await runSync(
          {
            ...appConfig,
            environments: {
              sync_source: syncSource,
              [syncInterruptTarget.id]: syncInterruptTarget
            }
          },
          {
            from: "sync_source",
            to: syncInterruptTarget.id,
            outputMode: "default"
          }
        );
      } catch (error) {
        interruptedError = error;
      }
    });
    try {
      await waitForFile(interruptReady);
      process.emit("SIGINT");
      interruptedSummary = await interruptedRun;
      await interruptLogger.finalizeFailure();
    } finally {
      await writeFile(interruptRelease, "release", "utf8");
      setRunLogger();
      process.env.PATH = originalPath;
      if (originalReady === undefined) delete process.env.DBH_INTERRUPT_READY;
      else process.env.DBH_INTERRUPT_READY = originalReady;
      if (originalRelease === undefined)
        delete process.env.DBH_INTERRUPT_RELEASE;
      else process.env.DBH_INTERRUPT_RELEASE = originalRelease;
      if (originalRealMongodump === undefined)
        delete process.env.DBH_REAL_MONGODUMP;
      else process.env.DBH_REAL_MONGODUMP = originalRealMongodump;
    }
    if (!(interruptedError instanceof Error)) {
      throw new Error(
        "Interrupted sync integration run unexpectedly succeeded."
      );
    }
    if (
      !interruptedError.message.includes("Sync interrupted during dump") ||
      !interruptedError.message.includes("Target database was not modified") ||
      !interruptedSummary.includes("Cleaning up sync temp artifacts")
    ) {
      throw new Error(
        `Interrupted sync output was not truthful: ${interruptedError.message}\n${interruptedSummary}`
      );
    }
    const interruptedTargetState = await mongoJson<{
      targetOnlyCount: number;
      userCollections: string[];
    }>(
      uri,
      "(()=>{const dbx=db.getSiblingDB('sync_interrupt_target');const users=dbx.getCollectionNames().filter(name=>!name.startsWith('system.')).sort();return {targetOnlyCount:dbx.target_only.countDocuments({}),userCollections:users};})()"
    );
    if (
      interruptedTargetState.targetOnlyCount !== 1 ||
      JSON.stringify(interruptedTargetState.userCollections) !==
        JSON.stringify(["target_only"])
    ) {
      throw new Error(
        `Interrupted sync modified the target unexpectedly: ${JSON.stringify(
          interruptedTargetState
        )}`
      );
    }
    const interruptedLog = await readFile(interruptLogger.logPath, "utf8");
    if (
      !interruptedLog.includes('"phase":"dump"') ||
      interruptedLog.includes(password)
    ) {
      throw new Error(
        "Interrupted sync log did not retain the dump phase or was not redacted."
      );
    }
    const leftoverSyncArchives = (await readdir(root)).filter(
      (entry) => entry.startsWith("db-helper-") && entry.endsWith(".archive.gz")
    );
    if (leftoverSyncArchives.length > 0) {
      throw new Error(
        `Sync temporary archives were not cleaned up: ${leftoverSyncArchives.join(", ")}`
      );
    }

    // Interrupt a real restore subprocess, verify the conservative trust
    // message, then rerun the same archive and prove exact recovery.
    const restoreInterruptRoot = path.join(root, "restore-interrupt-shim");
    await mkdir(restoreInterruptRoot);
    const restoreReady = path.join(restoreInterruptRoot, "mongorestore.ready");
    const restoreRelease = path.join(
      restoreInterruptRoot,
      "mongorestore.release"
    );
    const realMongorestore = (
      await execFileAsync("sh", ["-lc", "command -v mongorestore"])
    ).stdout.trim();
    const mongorestoreShim = path.join(restoreInterruptRoot, "mongorestore");
    await writeFile(
      mongorestoreShim,
      `#!/bin/sh
case " $* " in
  *" --dryRun "*) exec "$DBH_REAL_MONGORESTORE" "$@" ;;
esac
trap 'exit 130' INT TERM
printf ready > "$DBH_RESTORE_READY"
while [ ! -f "$DBH_RESTORE_RELEASE" ]; do sleep 0.02; done
exec "$DBH_REAL_MONGORESTORE" "$@"
`,
      "utf8"
    );
    await chmod(mongorestoreShim, 0o755);
    const restoreInterruptTarget = {
      ...env,
      id: "restore_interrupt",
      name: "restore_interrupt",
      databaseName: "restore_interrupt"
    };
    await mongoEval(
      uri,
      "const target=db.getSiblingDB('restore_interrupt'); target.dropDatabase(); target.target_only.insertOne({_id:'keep'}); target.getCollection('system.js').insertOne({_id:'keep',value:'function(){return true;}'});"
    );
    const restoreOriginalPath = process.env.PATH;
    const restoreOriginalReady = process.env.DBH_RESTORE_READY;
    const restoreOriginalRelease = process.env.DBH_RESTORE_RELEASE;
    const restoreOriginalBinary = process.env.DBH_REAL_MONGORESTORE;
    process.env.PATH = `${restoreInterruptRoot}:${restoreOriginalPath ?? ""}`;
    process.env.DBH_RESTORE_READY = restoreReady;
    process.env.DBH_RESTORE_RELEASE = restoreRelease;
    process.env.DBH_REAL_MONGORESTORE = realMongorestore;
    const restoreInterruptLogger = await createRunLogger({
      commandName: "restore-integration-interrupted-restore",
      logRoot: root
    });
    setRunLogger(restoreInterruptLogger);
    let restoreInterruptedError: unknown;
    let restoreInterruptedSummary = "";
    const interruptedRestoreRun = captureStdout(async () => {
      try {
        await runRestoreFull(
          {
            ...appConfig,
            environments: { restore_interrupt: restoreInterruptTarget }
          },
          {
            backup: backupName,
            to: restoreInterruptTarget.id,
            skipPreBackup: true,
            outputMode: "default"
          }
        );
      } catch (error) {
        restoreInterruptedError = error;
      }
    });
    try {
      await waitForFile(restoreReady);
      process.emit("SIGINT");
      restoreInterruptedSummary = await interruptedRestoreRun;
      await restoreInterruptLogger.finalizeFailure();
    } finally {
      await writeFile(restoreRelease, "release", "utf8");
      setRunLogger();
      process.env.PATH = restoreOriginalPath;
      if (restoreOriginalReady === undefined)
        delete process.env.DBH_RESTORE_READY;
      else process.env.DBH_RESTORE_READY = restoreOriginalReady;
      if (restoreOriginalRelease === undefined)
        delete process.env.DBH_RESTORE_RELEASE;
      else process.env.DBH_RESTORE_RELEASE = restoreOriginalRelease;
      if (restoreOriginalBinary === undefined)
        delete process.env.DBH_REAL_MONGORESTORE;
      else process.env.DBH_REAL_MONGORESTORE = restoreOriginalBinary;
    }
    if (!(restoreInterruptedError instanceof Error)) {
      throw new Error(
        "Interrupted restore integration run unexpectedly succeeded."
      );
    }
    if (
      !restoreInterruptedError.message.includes(
        "Restore interrupted during restore"
      ) ||
      !restoreInterruptedError.message.includes("may be dirty") ||
      !restoreInterruptedSummary.includes("Starting restore")
    ) {
      throw new Error(
        `Interrupted restore output was not truthful: ${restoreInterruptedError.message}\n${restoreInterruptedSummary}`
      );
    }
    const interruptedRestoreState = await mongoJson<{
      targetOnlyCount: number;
      userCollections: string[];
      systemPreserved: number;
    }>(
      uri,
      "(()=>{const dbx=db.getSiblingDB('restore_interrupt');const users=dbx.getCollectionNames().filter(name=>!name.startsWith('system.')).sort();return {targetOnlyCount:dbx.target_only.countDocuments({}),userCollections:users,systemPreserved:dbx.getCollection('system.js').countDocuments({_id:'keep'})};})()"
    );
    if (
      interruptedRestoreState.targetOnlyCount !== 1 ||
      JSON.stringify(interruptedRestoreState.userCollections) !==
        JSON.stringify(["target_only"]) ||
      interruptedRestoreState.systemPreserved !== 1
    ) {
      throw new Error(
        `Interrupted restore modified the target unexpectedly: ${JSON.stringify(interruptedRestoreState)}`
      );
    }
    const interruptedRestoreLog = await readFile(
      restoreInterruptLogger.logPath,
      "utf8"
    );
    if (
      !interruptedRestoreLog.includes('"phase":"restore"') ||
      !interruptedRestoreLog.includes(
        '"targetTrustState":"may be partially modified"'
      ) ||
      interruptedRestoreLog.includes(password)
    ) {
      throw new Error(
        "Interrupted restore log did not retain truthful redacted state."
      );
    }
    await runRestoreFull(
      {
        ...appConfig,
        environments: { restore_interrupt: restoreInterruptTarget }
      },
      {
        backup: backupName,
        to: restoreInterruptTarget.id,
        skipPreBackup: true,
        outputMode: "quiet"
      }
    );
    const recoveredRestoreState = await mongoJson<{
      userCollections: string[];
      counts: Record<string, number>;
      systemPreserved: number;
    }>(
      uri,
      "(()=>{const dbx=db.getSiblingDB('restore_interrupt');const users=dbx.getCollectionNames().filter(name=>!name.startsWith('system.')).sort();return {userCollections:users,counts:Object.fromEntries(users.map(name=>[name,dbx.getCollection(name).countDocuments({})])),systemPreserved:dbx.getCollection('system.js').countDocuments({_id:'keep'})};})()"
    );
    if (
      JSON.stringify(recoveredRestoreState.userCollections) !==
        JSON.stringify(["empty", "orders", "unrelated"]) ||
      JSON.stringify(recoveredRestoreState.counts) !==
        JSON.stringify({ empty: 0, orders: 2, unrelated: 1 }) ||
      recoveredRestoreState.systemPreserved !== 1
    ) {
      throw new Error(
        `Interrupted restore recovery regression: ${JSON.stringify(recoveredRestoreState)}`
      );
    }

    // Prove the tagged-result parser survives diagnostic stdout from mongosh.
    const diagnosticRoot = path.join(root, "mongosh-diagnostic-shim");
    await mkdir(diagnosticRoot);
    const realMongosh = (
      await execFileAsync("sh", ["-lc", "command -v mongosh"])
    ).stdout.trim();
    const mongoshShim = path.join(diagnosticRoot, "mongosh");
    await writeFile(
      mongoshShim,
      `#!/bin/sh
printf 'Warning: integration diagnostic before tagged result\\n' >&1
exec "$DBH_REAL_MONGOSH" "$@"
`,
      "utf8"
    );
    await chmod(mongoshShim, 0o755);
    const diagnosticOriginalPath = process.env.PATH;
    const diagnosticOriginalBinary = process.env.DBH_REAL_MONGOSH;
    process.env.PATH = `${diagnosticRoot}:${diagnosticOriginalPath ?? ""}`;
    process.env.DBH_REAL_MONGOSH = realMongosh;
    try {
      const diagnosticOutput: string[] = [];
      await listCollections(env, {
        outputMode: "verbose",
        writeStdout: (message) => diagnosticOutput.push(message)
      });
      if (
        !diagnosticOutput.some((line) =>
          line.includes("integration diagnostic")
        ) ||
        diagnosticOutput.join("").includes(password)
      ) {
        throw new Error("Diagnostic mongosh output was not surfaced safely.");
      }
    } finally {
      process.env.PATH = diagnosticOriginalPath;
      if (diagnosticOriginalBinary === undefined)
        delete process.env.DBH_REAL_MONGOSH;
      else process.env.DBH_REAL_MONGOSH = diagnosticOriginalBinary;
    }
    process.stdout.write(
      `Restore integration tools:\n${Object.entries(versions)
        .map(([name, version]) => `  ${name}: ${version.split("\n")[0]}`)
        .join("\n")}\nDisposable mongod: 127.0.0.1:${port}\n` +
        "Authenticated archive-backed backup, restore, sync, interruption, and diagnostic regressions passed.\n"
    );
  } finally {
    mongod.kill("SIGTERM");
    await rm(root, { recursive: true, force: true });
  }
}

await main();
