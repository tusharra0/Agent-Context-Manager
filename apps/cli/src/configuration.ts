import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export type StorageConfiguration = {
  dataDirectory: string;
  databasePath: string;
  artifactRoot: string;
};

export function resolveStorageConfiguration(
  explicitDataDirectory: string | undefined,
  environment: NodeJS.ProcessEnv,
): StorageConfiguration {
  const configuredDataDirectory =
    explicitDataDirectory ?? environment.ACM_DATA_DIR;
  const dataDirectory = resolve(
    configuredDataDirectory ?? join(homedir(), '.acm'),
  );
  const artifactRoot = resolve(
    environment.ACM_ARTIFACT_DIR ?? join(dataDirectory, 'artifacts'),
  );
  return {
    dataDirectory,
    databasePath: join(dataDirectory, 'acm.sqlite3'),
    artifactRoot,
  };
}
