import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { AppConfig } from "../config/types.js";
import { assertWritable } from "../lib/fs.js";
import { verifyConnectivity } from "../lib/mongo.js";
import { runCommand } from "../lib/exec.js";

async function ensureBinary(name: string): Promise<void> {
  await runCommand("which", [name]);
}

export async function runDoctor(appConfig: AppConfig): Promise<void> {
  process.stdout.write("Running doctor checks...\n");

  for (const binary of ["mongodump", "mongorestore", "mongosh", "ssh", "scp"]) {
    await ensureBinary(binary);
  }

  await assertWritable(appConfig.backupRoot);
  await assertWritable(appConfig.tempRoot);

  for (const env of Object.values(appConfig.environments)) {
    if (env.kind === "remote" && env.sshKeyPath) {
      await access(env.sshKeyPath, constants.R_OK);
    }

    if (!env.mongoUser || !env.mongoPassword) {
      throw new Error(`Mongo credentials missing for ${env.id}`);
    }

    await verifyConnectivity(env);
  }

  process.stdout.write("Doctor checks passed.\n");
}
