import { withClient, type ConnectionSettings } from "./connection.ts";
import { fromPostgresError } from "./errors.ts";
import {
  MAINTENANCE_DATABASE,
  PROVISIONER_ROLE,
  appDatabaseNames,
  appRoleList,
  type AppId,
  type AppSlug,
} from "./names.ts";
import type { AppObjectStore, SlugDirectory } from "./ports.ts";
import { appObjectPrefix, type EraseResult } from "./protocol.ts";

export interface EraseInput {
  readonly appId: AppId;
  readonly slug: AppSlug;
  readonly bucket: string;
}

async function deleteObjectsUnder(
  store: AppObjectStore,
  { bucket, prefix }: { readonly bucket: string; readonly prefix: string },
): Promise<number> {
  let deleted = 0;
  for (;;) {
    const keys = await store.listObjects({ bucket, prefix });
    if (keys.length === 0) return deleted;
    await store.deleteObjects({ bucket, keys });
    deleted += keys.length;
  }
}

/**
 * `WITH (FORCE)` ends open sessions through the provisioner's `pg_signal_backend`.
 */
export async function erase(
  dependencies: {
    readonly connections: ConnectionSettings;
    readonly slugDirectory: SlugDirectory;
    readonly objectStore: AppObjectStore;
  },
  input: EraseInput,
): Promise<EraseResult> {
  const names = appDatabaseNames(input.appId);
  await dependencies.slugDirectory.remove(input.slug);
  try {
    await withClient(
      dependencies.connections,
      { database: MAINTENANCE_DATABASE, user: PROVISIONER_ROLE },
      async (client) => {
        await client.query(`DROP DATABASE IF EXISTS ${names.database} WITH (FORCE)`);
        await client.query(`DROP ROLE IF EXISTS ${appRoleList(names).join(", ")}`);
      },
    );
  } catch (error) {
    throw fromPostgresError(error);
  }
  return {
    appId: input.appId,
    database: names.database,
    objectsDeleted: await deleteObjectsUnder(dependencies.objectStore, {
      bucket: input.bucket,
      prefix: appObjectPrefix(input.appId),
    }),
    roles: appRoleList(names),
  };
}
