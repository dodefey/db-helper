import { AppConfig } from "../config/types.js";
import { executeBackupPrune, planBackupPrune } from "../lib/backupPrune.js";
import { OutputMode } from "../lib/output.js";
import { promptConfirm } from "../lib/prompts.js";
import { getRunLogger } from "../lib/runLog.js";

export async function backupPrune(
  config: AppConfig,
  input: {
    keepLast: number;
    dryRun: boolean;
    yes: boolean;
    outputMode: OutputMode;
  },
  dependencies = {
    confirm: promptConfirm,
    interactive: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
    write: (text: string) => {
      process.stdout.write(text);
    }
  }
): Promise<void> {
  const plan = await planBackupPrune(config.backupRoot, input.keepLast);
  const logger = getRunLogger();
  logger.info("backup.prune", "Backup prune plan", {
    ...plan,
    keep: plan.keep.map(({ name, environment, createdAt }) => ({
      name,
      environment,
      createdAt
    })),
    remove: plan.remove.map(({ name, environment, createdAt }) => ({
      name,
      environment,
      createdAt
    }))
  });
  // A destructive preview remains visible even in quiet mode.
  dependencies.write(
    `Backup root: ${plan.root}\nKeep newest ${plan.keepLast} per environment. Tags do not protect backups.\n`
  );
  const environments = [
    ...new Set(
      [...plan.keep, ...plan.remove, ...plan.skip].map(
        (item) => item.environment
      )
    )
  ].sort();
  for (const environment of environments) {
    dependencies.write(`${environment}:\n`);
    for (const [action, backups] of [
      ["KEEP", plan.keep],
      ["DELETE", plan.remove]
    ] as const)
      for (const backup of backups.filter(
        (item) => item.environment === environment
      ))
        dependencies.write(
          `  ${action} ${backup.name} (${backup.createdAt})\n`
        );
    for (const skipped of plan.skip.filter(
      (item) => item.environment === environment
    ))
      dependencies.write(`  SKIP ${skipped.name}: ${skipped.reason}\n`);
  }
  if (input.dryRun || !plan.remove.length) {
    dependencies.write(
      `${input.dryRun ? "Dry run" : "Prune complete"}: ${plan.remove.length} planned deletions; 0 deleted; ${plan.skip.length} skipped.\n`
    );
    return;
  }
  if (!input.yes) {
    if (!dependencies.interactive())
      throw new Error(
        "Noninteractive backup pruning requires --yes or --dry-run."
      );
    if (
      !(await dependencies.confirm(
        `Permanently delete these ${plan.remove.length} backups?`
      ))
    )
      throw new Error("Backup pruning cancelled.");
  }
  const deleted = await executeBackupPrune(plan);
  logger.info("backup.prune", "Backup pruning completed", { deleted });
  dependencies.write(
    `Prune complete: ${deleted.length} deleted; ${plan.keep.length} kept; ${plan.skip.length} skipped.\n`
  );
}
