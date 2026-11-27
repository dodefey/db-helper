import { spawn } from "node:child_process";
import { getRunLogger, redactText } from "./runLog.js";

export interface RunCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  streamOutput?: boolean;
  captureOutput?: "combined" | "combined-on-failure";
  signal?: AbortSignal;
  // A tracked subprocess must close before the caller can remove its files.
  trackProcess?: (pid: number) => void;
}

export class CommandExitError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null
  ) {
    super(message);
    this.name = "CommandExitError";
  }
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function formatCommand(command: string, args: string[]): string {
  return [command, ...args.map(shellEscape)].join(" ");
}

export async function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions = {}
): Promise<string> {
  const rendered = redactText(formatCommand(command, args));
  const runLogger = getRunLogger();
  const startedAt = Date.now();
  runLogger.debug("exec", "Starting subprocess", {
    command,
    args,
    rendered,
    cwd: options.cwd
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    let failureBeforeClose: Error | undefined;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    const combinedOutput = () =>
      [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");

    const abortListener = (): void => {
      runLogger.warn("exec", "Interrupting subprocess", {
        rendered,
        durationMs: Date.now() - startedAt
      });
      const error = new Error(`Command interrupted: ${rendered}`);
      if (options.trackProcess && child.pid !== undefined)
        failureBeforeClose ??= error;
      child.kill("SIGINT");
      if (!failureBeforeClose) rejectOnce(error);
    };

    const cleanupAbortListener = (): void => {
      if (options.signal && abortListener) {
        options.signal.removeEventListener("abort", abortListener);
      }
    };

    const rejectOnce = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanupAbortListener();
      reject(error);
    };

    const resolveOnce = (value: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanupAbortListener();
      resolve(value);
    };

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (options.streamOutput !== false) {
        process.stdout.write(text);
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (options.streamOutput !== false) {
        process.stderr.write(text);
      }
    });

    child.on("error", (error) => {
      runLogger.error("exec", "Subprocess spawn failed", {
        rendered,
        durationMs: Date.now() - startedAt,
        error: error.message
      });
      const failure = new Error(
        `Failed to run command: ${rendered}\n${redactText(error.message)}`
      );
      if (options.trackProcess && child.pid !== undefined)
        failureBeforeClose ??= failure;
      else rejectOnce(failure);
    });

    child.on("close", (code) => {
      if (failureBeforeClose) {
        rejectOnce(failureBeforeClose);
        return;
      }
      if (code === 0) {
        runLogger.debug("exec", "Subprocess completed", {
          rendered,
          durationMs: Date.now() - startedAt,
          exitCode: code,
          stdout: redactText(stdout),
          stderr: redactText(stderr)
        });
        resolveOnce(
          options.captureOutput === "combined"
            ? combinedOutput()
            : stdout.trim()
        );
        return;
      }

      runLogger.error("exec", "Subprocess failed", {
        rendered,
        durationMs: Date.now() - startedAt,
        exitCode: code,
        stdout: redactText(stdout),
        stderr: redactText(stderr)
      });
      const diagnostic = options.captureOutput
        ? combinedOutput()
        : stderr.trim();
      rejectOnce(
        new CommandExitError(
          `Command failed (${code}): ${rendered}\n${redactText(diagnostic)}`,
          code
        )
      );
    });

    if (options.trackProcess && child.pid !== undefined) {
      try {
        options.trackProcess(child.pid);
      } catch (error) {
        failureBeforeClose = new Error("Could not record the subprocess PID.", {
          cause: error
        });
        child.kill("SIGINT");
        child.stdin.end();
        return;
      }
    }

    if (options.signal) {
      if (options.signal.aborted) {
        abortListener();
        return;
      }
      options.signal.addEventListener("abort", abortListener, { once: true });
    }

    if (options.stdin) {
      child.stdin.write(options.stdin);
    }

    child.stdin.end();
  });
}
