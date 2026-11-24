import type { AppActor, AppErasureOwner, AppPersistence, AppRecord } from "@deployments-ai/db";
import type { AppsDatabase } from "./apps-database-client.ts";

/**
 * The slug reservation stays: an erased app's origin keeps its browser storage forever.
 */
export async function eraseAgentBuiltApp(
  dependencies: {
    readonly apps: AppPersistence;
    readonly appsDatabase: Pick<AppsDatabase, "erase">;
  },
  input: {
    readonly actor: AppActor;
    readonly app: AppRecord;
    readonly erasureOwner?: AppErasureOwner;
  },
): Promise<AppRecord> {
  const { actor, app } = input;
  const owner = input.erasureOwner ? { erasureOwner: input.erasureOwner } : {};
  const erasing =
    app.data.lifecycle.state === "erasing"
      ? app
      : await dependencies.apps.transitionApp({
          actor,
          app,
          ...owner,
          transition: { to: "erasing" },
        });
  for (const domain of await dependencies.apps.listDomains(erasing)) {
    await dependencies.apps.detachDomain({ actor, app: erasing, domain, ...owner });
  }
  await dependencies.appsDatabase.erase(erasing);
  await dependencies.apps.eraseApp({ actor, app: erasing, ...owner });
  return erasing;
}
