import { redactText } from "./runLog.js";

export type QueryStatus = "ok" | "partial" | "error";

export interface QueryIssue {
  code: string;
  path: string | null;
  message: string;
  systemCode: string | null;
}

export interface QueryReport<T> {
  schemaVersion: 1;
  command: string;
  observedAt: string;
  status: QueryStatus;
  data: T;
  issues: QueryIssue[];
  debugLogPath: string | null;
}

export class QueryError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export function queryIssue(
  code: string,
  location: string | null,
  message: string,
  error?: unknown
): QueryIssue {
  return {
    code,
    path: location,
    message: redactText(message),
    systemCode: errorCode(error) ?? null
  };
}

export function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}

export function queryReport<T>(
  command: string,
  data: T,
  issues: QueryIssue[],
  status: QueryStatus
): QueryReport<T> {
  return {
    schemaVersion: 1,
    command,
    observedAt: new Date().toISOString(),
    status,
    data,
    issues,
    debugLogPath: null
  };
}

export function queryExitCode(status: QueryStatus): number {
  return status === "ok" ? 0 : status === "partial" ? 2 : 1;
}
