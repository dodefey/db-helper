import { AppConfig } from "../config/types.js";
import {
  deleteBackup,
  inspectBackupDeleteTarget,
  resolveBackupDeleteTarget
} from "../lib/backupDelete.js";
import { OutputMode } from "../lib/output.js";
import { promptConfirm } from "../lib/prompts.js";
import { getRunLogger } from "../lib/runLog.js";

export async function backupDelete(
  config: AppConfig,
  input: { backup: string; yes: boolean; outputMode: OutputMode },
  dependencies = {
    confirm: promptConfirm,
    interactive: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
    write: (text: string) => {
      process.stdout.write(text);
    }
  }
): Promise<void> {
  if (!input.yes && !dependencies.interactive())
    throw new Error("Noninteractive backup deletion requires --yes.");
  const target = await resolveBackupDeleteTarget(
    config.backupRoot,
    input.backup
  );
  await inspectBackupDeleteTarget(target);
  if (
    !input.yes &&
    !(await dependencies.confirm(
      `Delete backup ${target.name}?\nPath: ${target.path}\nThis permanently removes this backup directory. Continue?`
    ))
  ) {
    throw new Error("Backup deletion cancelled.");
  }
  if (input.outputMode === "verbose")
    dependencies.write(`Backup path: ${target.path}\n`);
  const logger = getRunLogger();
  logger.info("backup.delete", "Deleting named backup", target);
  const result = await deleteBackup(target.root, target.name);
  logger.info("backup.delete", "Backup deletion completed", {
    ...target,
    result
  });
  dependencies.write(
    result === "deleted"
      ? `Backup deleted: ${target.name}\n`
      : `Backup already absent: ${target.name}\n`
  );
}
