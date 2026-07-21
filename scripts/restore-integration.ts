import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
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
      "const source=db.getSiblingDB('sync_source'); source.dropDatabase(); source.orders.insertMany([{_id:1,n:1},{_id:2,n:2}]); source.orders.createIndex({n:1},{name:'orders_n'}); source.createCollection('unrelated',{validator:{keep:{$eq:true}}}); source.unrelated.insertOne({_id:'source',keep:true}); source.unrelated.createIndex({keep:1},{name:'unrelated_n'}); source.createCollection('empty',{collation:{locale:'en',strength:2}}); source.empty.createIndex({n:1},{name:'empty_n'}); const full=db.getSiblingDB('sync_full_target'); full.dropDatabase(); full.target_only.insertOne({_id:'remove'}); full.getCollection('system.js').insertOne({_id:'keep',value:'function(){return true;}'}); const scoped=db.getSiblingDB('sync_collection_target'); scoped.dropDatabase(); scoped.orders.insertOne({_id:'old',n:-1}); scoped.orders.createIndex({n:1},{name:'old_orders_n'}); scoped.unrelated.insertOne({_id:'keep',keep:true}); scoped.unrelated.createIndex({keep:1},{name:'keep_index'}); const same=db.getSiblingDB('sync_same_db'); same.dropDatabase(); same.orders.insertMany([{_id:1,n:1},{_id:2,n:2}]); same.orders.createIndex({n:1},{name:'orders_n'}); same.unrelated.insertOne({_id:'keep',keep:true}); same.unrelated.createIndex({keep:1},{name:'keep_index'});"
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
    const leftoverSyncArchives = (await readdir(root)).filter(
      (entry) => entry.startsWith("db-helper-") && entry.endsWith(".archive.gz")
    );
    if (leftoverSyncArchives.length > 0) {
      throw new Error(
        `Sync temporary archives were not cleaned up: ${leftoverSyncArchives.join(", ")}`
      );
    }
    process.stdout.write(
      `Restore integration tools:\n${Object.entries(versions)
        .map(([name, version]) => `  ${name}: ${version.split("\n")[0]}`)
        .join("\n")}\nDisposable mongod: 127.0.0.1:${port}\n` +
        "Authenticated archive-backed collection/full restore and sync regressions passed.\n"
    );
  } finally {
    mongod.kill("SIGTERM");
    await rm(root, { recursive: true, force: true });
  }
}

await main();
