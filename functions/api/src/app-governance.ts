import {
  AppPersistenceError,
  deterministicUlid,
  type AppPersistence,
  type AppRecord,
} from "@deployments-ai/db";
import {
  GovernanceError,
  type AppTableObject,
  type GovernanceServiceOptions,
} from "@deployments-ai/governance";
import { eraseAgentBuiltApp } from "./app-erasure.ts";
import type { AppsDatabase } from "./apps-database-client.ts";

async function exportAppTables(
  dependencies: {
    readonly appsDatabase: Pick<AppsDatabase, "exportTables">;
    readonly bucket: string;
  },
  input: { readonly app: AppRecord; readonly operationId: string },
): Promise<readonly AppTableObject[]> {
  const { state } = input.app.data.lifecycle;
  if (state !== "active" && state !== "archived") return [];
  const { objects } = await dependencies.appsDatabase.exportTables({
    app: input.app,
    exportId: deterministicUlid(`app-export\u0000${input.operationId}\u0000${input.app.data.id}`),
  });
  return objects.map(({ key }) => ({
    bucket: dependencies.bucket,
    contentType: "text/csv; charset=utf-8",
    key,
  }));
}

export function governanceAppPorts(dependencies: {
  readonly apps: AppPersistence;
  readonly appsDatabase: Pick<AppsDatabase, "erase" | "exportTables">;
  readonly bucket: string;
}): Required<Pick<GovernanceServiceOptions, "eraseApp" | "exportAppTables">> {
  return {
    eraseApp: async ({ app, operationId }) => {
      try {
        await eraseAgentBuiltApp(dependencies, {
          actor: { type: "system" },
          app,
          erasureOwner: { operationId, organizationId: app.data.organizationId },
        });
      } catch (cause) {
        if (cause instanceof AppPersistenceError && cause.reason === "still-provisioning") {
          throw new GovernanceError("tenant_app_provisioning_pending", cause.message);
        }
        throw cause;
      }
    },
    exportAppTables: (input) => exportAppTables(dependencies, input),
  };
}
