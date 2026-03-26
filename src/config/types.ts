export const ENVIRONMENT_IDS = ["development", "test", "production"] as const;

export type EnvironmentId = (typeof ENVIRONMENT_IDS)[number];
export type EnvironmentKind = "local" | "remote";

export interface EnvironmentConfig {
  id: EnvironmentId;
  name: EnvironmentId;
  label: string;
  kind: EnvironmentKind;
  host: string;
  mongoHost: string;
  mongoPort: number;
  databaseName: string;
  sshUser?: string;
  sshKeyPath?: string;
  mongoUser: string;
  mongoPassword: string;
  authSource: string;
  isProduction: boolean;
}

export interface AppConfig {
  backupRoot: string;
  tempRoot: string;
  authSource: string;
  defaultDropOnRestore: boolean;
  environments: Record<EnvironmentId, EnvironmentConfig>;
}

export interface BackupManifest {
  backupName: string;
  sourceEnvironment: EnvironmentId;
  databaseName: string;
  createdAt: string;
  note?: string;
  tags: string[];
  collectionList: string[];
  toolVersion: string;
  archiveFile: string;
  collectionSizes?: Record<string, number>;
  collectionCounts?: Record<string, number>;
}

export interface BackupRecord {
  name: string;
  path: string;
  manifest: BackupManifest;
}

export interface TaskDefinition {
  id: string;
  description: string;
  allowedEnvironments: EnvironmentId[];
  destructive: boolean;
  requiresBackup: boolean;
  legacySource?: string;
  run: (input: TaskRunInput) => Promise<void>;
}

export interface TaskRunInput {
  env: EnvironmentConfig;
  appConfig: AppConfig;
  yes: boolean;
}

export interface VerifyRestoreResult {
  collectionsPresent: string[];
  missingCollections: string[];
  countMismatches: Array<{ collection: string; expected: number; actual: number }>;
}
