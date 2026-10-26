export type OutputMode = "default" | "quiet" | "verbose";

export function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  const unit = Math.min(
    bytes > 0 ? Math.floor(Math.log(bytes) / Math.log(1024)) : 0,
    units.length - 1
  );
  return `${(bytes / 1024 ** unit).toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function parseOutputMode(input: {
  quiet: boolean;
  verbose: boolean;
}): OutputMode {
  if (input.quiet && input.verbose) {
    throw new Error("Flags --quiet and --verbose cannot be used together");
  }

  if (input.quiet) {
    return "quiet";
  }

  if (input.verbose) {
    return "verbose";
  }

  return "default";
}

export function shouldPrintCommandSummary(mode: OutputMode): boolean {
  return mode !== "quiet";
}

export function shouldStreamSubprocessOutput(mode: OutputMode): boolean {
  return mode === "verbose";
}
