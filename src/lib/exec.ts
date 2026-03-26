import { spawn } from "node:child_process";

export interface RunCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  streamOutput?: boolean;
  signal?: AbortSignal;
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
  const rendered = formatCommand(command, args);

  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    const abortListener = (): void => {
      child.kill("SIGINT");
      rejectOnce(new Error(`Command interrupted: ${rendered}`));
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
      rejectOnce(
        new Error(`Failed to run command: ${rendered}\n${error.message}`)
      );
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolveOnce(stdout.trim());
        return;
      }

      rejectOnce(
        new Error(`Command failed (${code}): ${rendered}\n${stderr.trim()}`)
      );
    });

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
