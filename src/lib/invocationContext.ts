import {
  createRemotePreflightSession,
  RemotePreflightSession
} from "./remotePreflight.js";

export interface CommandInvocationContext {
  remotePreflightSession: RemotePreflightSession;
}

export function createCommandInvocationContext(): CommandInvocationContext {
  return {
    remotePreflightSession: createRemotePreflightSession()
  };
}
