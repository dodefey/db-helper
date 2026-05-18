import { appendFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export type RunLogLevel = "info" | "warn" | "error" | "debug";

export interface RunLogger {
  readonly logPath: string;
  info(component: string, message: string, details?: unknown): void;
  warn(component: string, message: string, details?: unknown): void;
  error(component: string, message: string, details?: unknown): void;
  debug(component: string, message: string, details?: unknown): void;
  relocate(logRoot: string): Promise<void>;
  finalizeSuccess(options: { keep: boolean }): Promise<void>;
  finalizeFailure(): Promise<void>;
}

const REDACTED = "<redacted>";

function defaultLogRoot(): string {
  return path.join(tmpdir(), "db-helper", "logs");
}

function timestampForFile(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function buildLogFilename(commandName: string): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return `db-helper-${timestampForFile(new Date())}-${commandName}-${suffix}.log`;
}

function normalizeDetails(details: unknown): string {
  if (details === undefined) {
    return "";
  }

  try {
    return JSON.stringify(redactValue(details));
  } catch (error) {
    return JSON.stringify({
      serializationError: error instanceof Error ? error.message : String(error)
    });
  }
}

function formatLine(
  level: RunLogLevel,
  component: string,
  message: string,
  details?: unknown
): string {
  const serializedDetails = normalizeDetails(details);
  const suffix = serializedDetails ? ` ${serializedDetails}` : "";
  return `${new Date().toISOString()} [${level.toUpperCase()}] [${component}] ${redactText(message)}${suffix}\n`;
}

function redactObjectEntry(key: string, value: unknown): unknown {
  if (/(password|secret|token)/i.test(key)) {
    return REDACTED;
  }

  if (typeof value === "string") {
    return redactText(value);
  }

  return redactValue(value);
}

export function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactText(value);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        redactObjectEntry(key, entry)
      ])
    );
  }

  return value;
}

export function redactText(value: string): string {
  return value
    .replace(
      /(mongodb(?:\+srv)?:\/\/[^:\s/]+:)([^@/\s]+)(@)/gi,
      `$1${REDACTED}$3`
    )
    .replace(/("mongoPassword"\s*:\s*")([^"]*)(")/gi, `$1${REDACTED}$3`)
    .replace(/(mongoPassword=)([^\s&]+)/gi, `$1${REDACTED}`);
}

class FileRunLogger implements RunLogger {
  logPath: string;

  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(logPath: string) {
    this.logPath = logPath;
  }

  info(component: string, message: string, details?: unknown): void {
    this.enqueueWrite(formatLine("info", component, message, details));
  }

  warn(component: string, message: string, details?: unknown): void {
    this.enqueueWrite(formatLine("warn", component, message, details));
  }

  error(component: string, message: string, details?: unknown): void {
    this.enqueueWrite(formatLine("error", component, message, details));
  }

  debug(component: string, message: string, details?: unknown): void {
    this.enqueueWrite(formatLine("debug", component, message, details));
  }

  async relocate(logRoot: string): Promise<void> {
    await this.pendingWrite;
    await mkdir(logRoot, { recursive: true });
    const nextPath = path.join(logRoot, path.basename(this.logPath));
    if (nextPath === this.logPath) {
      return;
    }
    await rename(this.logPath, nextPath);
    this.logPath = nextPath;
  }

  async finalizeSuccess(options: { keep: boolean }): Promise<void> {
    await this.pendingWrite;
    if (!options.keep) {
      await rm(this.logPath, { force: true });
    }
  }

  async finalizeFailure(): Promise<void> {
    await this.pendingWrite;
  }

  private enqueueWrite(content: string): void {
    this.pendingWrite = this.pendingWrite.then(() =>
      appendFile(this.logPath, content, "utf8")
    );
  }
}

const NOOP_RUN_LOGGER: RunLogger = {
  logPath: "",
  info(): void {},
  warn(): void {},
  error(): void {},
  debug(): void {},
  async relocate(): Promise<void> {},
  async finalizeSuccess(): Promise<void> {},
  async finalizeFailure(): Promise<void> {}
};

let currentRunLogger: RunLogger = NOOP_RUN_LOGGER;

export function getRunLogger(): RunLogger {
  return currentRunLogger;
}

export function setRunLogger(logger?: RunLogger): void {
  currentRunLogger = logger ?? NOOP_RUN_LOGGER;
}

export async function createRunLogger(options: {
  commandName: string;
  logRoot?: string;
}): Promise<RunLogger> {
  const logRoot = options.logRoot ?? defaultLogRoot();
  await mkdir(logRoot, { recursive: true });
  const logPath = path.join(logRoot, buildLogFilename(options.commandName));
  await writeFile(logPath, "", "utf8");
  return new FileRunLogger(logPath);
}
