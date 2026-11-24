import type { AppPublication, AppRecord } from "../records/apps.ts";
import { liveReleaseIdOf } from "./lifecycle.ts";
import { requireChange, type AppActor, type AppData, type AppRevisions } from "./revision.ts";

export interface AppDatabaseConvergence {
  readonly converge: (app: AppRecord) => Promise<void>;
  readonly layout: number;
}

export interface AppPublicationPersistence {
  readonly setPublication: (input: {
    readonly actor: AppActor;
    readonly app: AppRecord;
    readonly database: AppDatabaseConvergence;
    readonly publication: AppPublication;
  }) => Promise<AppRecord>;
  readonly convergeDatabase: (input: {
    readonly actor: AppActor;
    readonly app: AppRecord;
    readonly database: AppDatabaseConvergence;
  }) => Promise<AppRecord>;
}

export function appIsPublic(app: Pick<AppData, "lifecycle" | "publication">) {
  return (
    app.publication.audience === "public" &&
    app.lifecycle.state === "active" &&
    liveReleaseIdOf(app.lifecycle) !== null
  );
}

export function makeAppPublicationPersistence({
  now,
  reviseApp,
}: Pick<AppRevisions, "reviseApp"> & { readonly now: () => Date }): AppPublicationPersistence {
  async function stampThenConverge(input: {
    readonly actor: AppActor;
    readonly app: AppRecord;
    readonly database: AppDatabaseConvergence;
    readonly operation: string;
  }) {
    const startedAt = now().toISOString();
    const stamped = await reviseApp({
      actor: input.actor,
      app: input.app,
      changes: { databaseConvergenceStartedAt: startedAt },
      eventType: "app.database-convergence.started",
      operation: input.operation,
      payload: { next: input.database.layout, previous: input.app.data.databaseLayout },
      updatedAt: startedAt,
    });
    await input.database.converge(stamped);
    return stamped;
  }

  return {
    async setPublication({ actor, app, database, publication }) {
      requireChange("set-publication", app, "configure");
      const previous = app.data.publication;
      if (previous.audience === publication.audience && previous.serving === publication.serving) {
        return app;
      }
      const converges =
        publication.audience === "public" && app.data.databaseLayout < database.layout;
      return reviseApp({
        actor,
        app: converges
          ? await stampThenConverge({ actor, app, database, operation: "set-publication" })
          : app,
        changes: { publication, ...(converges ? { databaseLayout: database.layout } : {}) },
        eventType: "app.publication.changed",
        operation: "set-publication",
        payload: { next: publication, previous },
      });
    },

    async convergeDatabase({ actor, app, database }) {
      requireChange("converge-database", app, "configure");
      if (app.data.databaseLayout >= database.layout) return app;
      return reviseApp({
        actor,
        app: await stampThenConverge({ actor, app, database, operation: "converge-database" }),
        changes: { databaseLayout: database.layout },
        eventType: "app.database-layout.changed",
        operation: "converge-database",
        payload: { next: database.layout, previous: app.data.databaseLayout },
      });
    },
  };
}
