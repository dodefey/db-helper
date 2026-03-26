export type OutputMode = "default" | "quiet" | "verbose";

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
