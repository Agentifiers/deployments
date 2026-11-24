import { Schema } from "effect";
import { activeMemberCondition } from "../brains/authorization-conditions.ts";
import type { DynamoDatabaseService, QueryRecordsResult } from "../client-types.ts";
import { MAX_THREADLESS_STABLE_TENANT_MUTATIONS_PER_TRANSACTION } from "../governance-tenant-directory.ts";
import { deterministicUlid, type Ulid } from "../ids.ts";
import { key, Keys } from "../keys.ts";
import {
  AppGrantRecord,
  AppReleaseRecord,
  AppSlugReservationRecord,
  DEFAULT_APP_PUBLICATION,
  type AppAccessLevel,
  type AppGrantRole,
  type AppRecord,
  type AppSlug,
} from "../records/apps.ts";
import { UniqueClaimRecord } from "../records/identity.ts";
import { withCanonicalRecordKeys, type PlatformRecord } from "../records/index.ts";
import { transactWithSemanticEvents } from "../semantic-event-storage.ts";
import { acquireUniqueClaim, makeUniqueClaimRecord, releaseUniqueClaim } from "../unique-claims.ts";
import { APP_ID_CLAIM_NAMESPACE } from "./claims.ts";
import {
  makeAppDomainPersistence,
  type AppDomainPersistence,
  type AppDomainReconciliation,
} from "./domains.ts";
import { AppPersistenceError, commit, refuse } from "./errors.ts";
import {
  APP_TRANSITION_EVENT_TYPES,
  liveReleaseIdOf,
  nextAppLifecycle,
  requireAppTransition,
  type AppTransition,
} from "./lifecycle.ts";
import { makeAppPublicationPersistence, type AppPublicationPersistence } from "./publication.ts";
import { appChildPartition as childPartition, makeAppReads, type AppReads } from "./reads.ts";
import {
  appRecord,
  makeAppRevisions,
  requireChange,
  type AppActor,
  type AppData,
  type AppErasureOwner,
} from "./revision.ts";
import { makeAppSessionPersistence, type AppSessionPersistence } from "./sessions.ts";

export type { AppActor, AppErasureOwner } from "./revision.ts";

export interface AppAgentScope {
  readonly agentDefinitionId: Ulid;
  readonly environmentId: Ulid;
  readonly organizationId: Ulid;
  readonly workspaceId: Ulid;
}

export interface CreateAppInput extends AppAgentScope {
  readonly actor: AppActor;
  readonly clusterKey: string;
  readonly createdBy: AppData["createdBy"];
  readonly databaseLayout: number;
  readonly name: string;
  readonly projectId: Ulid;
  readonly slug: AppSlug;
}

export interface CreateAppReleaseInput {
  readonly actor: AppActor;
  readonly app: AppRecord;
  readonly bundleSha256: string;
  readonly bytes: number;
  readonly documents: readonly string[];
  readonly files: number;
  readonly releaseId: Ulid;
  readonly runId: Ulid;
}

interface HumanChange {
  readonly app: AppRecord;
  readonly changedBy: Ulid;
}

export interface AppPersistence
  extends
    AppReads,
    AppSessionPersistence,
    AppPublicationPersistence,
    AppDomainPersistence,
    AppDomainReconciliation {
  readonly createApp: (input: CreateAppInput) => Promise<AppRecord>;
  readonly getApp: (appId: Ulid) => Promise<AppRecord | undefined>;
  readonly findAppBySlug: (slug: AppSlug) => Promise<AppRecord | undefined>;
  readonly listAppsForAgent: (scope: AppAgentScope) => Promise<readonly AppRecord[]>;
  readonly transitionApp: (input: {
    readonly actor: AppActor;
    readonly app: AppRecord;
    readonly erasureOwner?: AppErasureOwner;
    readonly transition: AppTransition;
  }) => Promise<AppRecord>;
  readonly eraseApp: (input: {
    readonly actor: AppActor;
    readonly app: AppRecord;
    readonly erasureOwner?: AppErasureOwner;
  }) => Promise<void>;
  readonly createRelease: (
    input: CreateAppReleaseInput,
  ) => Promise<{ readonly app: AppRecord; readonly release: AppReleaseRecord }>;
  readonly getRelease: (input: {
    readonly app: AppRecord;
    readonly releaseId: Ulid;
  }) => Promise<AppReleaseRecord | undefined>;
  readonly listReleases: (app: AppRecord) => Promise<readonly AppReleaseRecord[]>;
  readonly promoteRelease: (input: {
    readonly actor: AppActor;
    readonly app: AppRecord;
    readonly releaseId: Ulid;
  }) => Promise<AppRecord>;
  readonly getGrant: (input: {
    readonly app: AppRecord;
    readonly principalId: Ulid;
  }) => Promise<AppGrantRecord | undefined>;
  readonly listGrants: (app: AppRecord) => Promise<readonly AppGrantRecord[]>;
  readonly putGrant: (
    input: HumanChange & { readonly principalId: Ulid; readonly role: AppGrantRole },
  ) => Promise<{ readonly app: AppRecord; readonly grant: AppGrantRecord }>;
  readonly removeGrant: (input: HumanChange & { readonly principalId: Ulid }) => Promise<AppRecord>;
  readonly renameApp: (input: HumanChange & { readonly name: string }) => Promise<AppRecord>;
  readonly setAccess: (
    input: HumanChange & { readonly organizationMembers: AppAccessLevel },
  ) => Promise<AppRecord>;
  readonly setAgentDefinition: (
    input: HumanChange & { readonly agentDefinitionId: Ulid },
  ) => Promise<AppRecord>;
}

export interface AppPersistenceDependencies {
  readonly database: DynamoDatabaseService;
  readonly generateId: () => Ulid;
  readonly now: () => Date;
}

const decodeRelease = Schema.decodeUnknownSync(AppReleaseRecord);
const decodeGrant = Schema.decodeUnknownSync(AppGrantRecord);
const decodeReservation = Schema.decodeUnknownSync(AppSlugReservationRecord);
const decodeClaim = Schema.decodeUnknownSync(UniqueClaimRecord);

function appIdClaim(app: AppRecord) {
  return decodeClaim(
    makeUniqueClaimRecord(
      {
        namespace: APP_ID_CLAIM_NAMESPACE,
        ownerId: app.data.id,
        ownerItemType: "app",
        ownerPk: app.pk,
        ownerSk: app.sk,
        ownerTable: "control",
        value: app.data.id,
      },
      app.data.createdAt,
    ),
  );
}

function slugReservationKey(slug: AppSlug) {
  return { pk: key("GLOBAL", "app-slug-reservation"), sk: key("APP-SLUG-RESERVATION", slug) };
}

export function makeAppPersistence(dependencies: AppPersistenceDependencies): AppPersistence {
  const { database, generateId, now } = dependencies;
  const { appEvent, reviseApp, transact } = makeAppRevisions(dependencies);
  const domains = makeAppDomainPersistence({ database, generateId, now, transact });

  async function queryAll(input: Parameters<DynamoDatabaseService["queryRecords"]>[1]) {
    const items: PlatformRecord[] = [];
    let start: QueryRecordsResult["lastEvaluatedKey"];
    do {
      const page = await database.queryRecords("control", {
        ...input,
        ...(start ? { ExclusiveStartKey: start } : {}),
      });
      items.push(...page.items);
      start = page.lastEvaluatedKey;
    } while (start);
    return items;
  }

  async function getApp(appId: Ulid) {
    const claim = await database.getRecord(
      "control",
      Keys.control.uniqueClaim(APP_ID_CLAIM_NAMESPACE, appId),
      true,
    );
    if (claim?.itemType !== "unique-claim") return undefined;
    const app = await database.getRecord(
      "control",
      { pk: claim.data.ownerPk, sk: claim.data.ownerSk },
      true,
    );
    return app?.itemType === "app" ? app : undefined;
  }

  async function getRelease(input: { readonly app: AppRecord; readonly releaseId: Ulid }) {
    const release = await database.getRecord(
      "control",
      { pk: childPartition(input.app), sk: key("APP-RELEASE", input.releaseId) },
      true,
    );
    return release?.itemType === "app-release" ? release : undefined;
  }

  function grantId(app: AppRecord, principalId: Ulid) {
    return deterministicUlid(`app-grant\u0000${app.data.id}\u0000${principalId}`);
  }

  async function getGrant(input: { readonly app: AppRecord; readonly principalId: Ulid }) {
    const grant = await database.getRecord(
      "control",
      {
        pk: childPartition(input.app),
        sk: key("APP-GRANT", grantId(input.app, input.principalId)),
      },
      true,
    );
    return grant?.itemType === "app-grant" ? grant : undefined;
  }

  return {
    ...makeAppReads({ database }),
    ...makeAppSessionPersistence({ database, now }),
    ...makeAppPublicationPersistence({ now, reviseApp }),
    ...domains,

    async createApp(input) {
      const at = now().toISOString();
      const app = appRecord({
        access: { organizationMembers: "none" },
        agentDefinitionId: input.agentDefinitionId,
        clusterKey: input.clusterKey,
        createdAt: at,
        createdBy: input.createdBy,
        databaseLayout: input.databaseLayout,
        environmentId: input.environmentId,
        id: generateId(),
        lifecycle: { requestedAt: at, state: "provisioning" },
        name: input.name,
        organizationId: input.organizationId,
        projectId: input.projectId,
        publication: DEFAULT_APP_PUBLICATION,
        slug: input.slug,
        updatedAt: at,
        version: 1,
        workspaceId: input.workspaceId,
      });
      const reservation = decodeReservation(
        withCanonicalRecordKeys({
          data: { appId: app.data.id, reservedAt: at, slug: input.slug },
          itemType: "app-slug-reservation" as const,
        }),
      );
      try {
        await commit(
          "create",
          transactWithSemanticEvents(
            database,
            [
              { kind: "put", record: app },
              acquireUniqueClaim(appIdClaim(app)),
              { kind: "put", record: reservation },
            ],
            [
              appEvent(app.data, "app.created", input.actor, {
                agentDefinitionId: app.data.agentDefinitionId,
                slug: app.data.slug,
                workspaceId: app.data.workspaceId,
              }),
            ],
          ),
        );
      } catch (error) {
        const existing =
          error instanceof AppPersistenceError && error.reason === "conflict"
            ? await database.getRecord("control", slugReservationKey(input.slug), true)
            : undefined;
        if (existing?.itemType !== "app-slug-reservation") throw error;
        throw new AppPersistenceError({
          cause: error,
          message: `The app slug ${input.slug} is already taken.`,
          operation: "create",
          reason: "slug-taken",
        });
      }
      return app;
    },

    getApp,

    async findAppBySlug(slug) {
      const reservation = await database.getRecord("control", slugReservationKey(slug), true);
      return reservation?.itemType === "app-slug-reservation"
        ? getApp(reservation.data.appId)
        : undefined;
    },

    async listAppsForAgent(scope) {
      const records = await queryAll({
        ConsistentRead: true,
        ExpressionAttributeValues: {
          ":pk": key("ORG", scope.organizationId, "ENV", scope.environmentId),
          ":sk": `${key("APP")}#`,
        },
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :sk)",
      });
      return records.filter(
        (record): record is AppRecord =>
          record.itemType === "app" &&
          record.data.workspaceId === scope.workspaceId &&
          record.data.agentDefinitionId === scope.agentDefinitionId,
      );
    },

    async transitionApp(input) {
      const at = now();
      const from = input.app.data.lifecycle.state;
      const lifecycle = nextAppLifecycle(input.app.data, input.transition, at);
      return reviseApp({
        actor: input.actor,
        app: input.app,
        changes: { lifecycle },
        ...(input.erasureOwner ? { erasureOwner: input.erasureOwner } : {}),
        eventType: APP_TRANSITION_EVENT_TYPES[input.transition.to],
        operation: "transition",
        payload: {
          from,
          to: input.transition.to,
          ...(input.transition.to === "failed" ? { reason: input.transition.reason } : {}),
        },
        updatedAt: at.toISOString(),
      });
    },

    async eraseApp({ actor, app, erasureOwner }) {
      const from = app.data.lifecycle.state;
      requireAppTransition("erase", app.data, "erased", now());
      if ((await domains.listDomains(app)).length > 0) {
        refuse(
          "erase",
          "illegal-state",
          `App ${app.data.id} still has domains; detach them first.`,
        );
      }
      for (;;) {
        const children = await database.queryRecords("control", {
          ConsistentRead: true,
          ExpressionAttributeValues: { ":pk": childPartition(app) },
          KeyConditionExpression: "pk = :pk",
          Limit: MAX_THREADLESS_STABLE_TENANT_MUTATIONS_PER_TRANSACTION,
        });
        if (children.items.length === 0) break;
        await commit(
          "erase",
          transact(
            children.items.map((record) => ({ kind: "delete" as const, record })),
            [],
            erasureOwner,
          ),
        );
      }
      const at = now().toISOString();
      await commit(
        "erase",
        transact(
          [{ kind: "delete", record: app }, releaseUniqueClaim(appIdClaim(app))],
          [
            appEvent(
              { ...app.data, updatedAt: at, version: app.data.version + 1 },
              APP_TRANSITION_EVENT_TYPES.erased,
              actor,
              { from, slug: app.data.slug, to: "erased" },
            ),
          ],
          erasureOwner,
        ),
      );
    },

    async createRelease(input) {
      requireChange("create-release", input.app, "release");
      const at = now().toISOString();
      const release = decodeRelease(
        withCanonicalRecordKeys({
          data: {
            appId: input.app.data.id,
            bundleSha256: input.bundleSha256,
            bytes: input.bytes,
            createdAt: at,
            documents: input.documents,
            environmentId: input.app.data.environmentId,
            files: input.files,
            id: input.releaseId,
            organizationId: input.app.data.organizationId,
            projectId: input.app.data.projectId,
            runId: input.runId,
          },
          itemType: "app-release" as const,
        }),
      );
      const app = await reviseApp({
        actor: input.actor,
        app: input.app,
        changes: {},
        companions: [{ kind: "put", record: release }],
        eventType: "app.release.created",
        operation: "create-release",
        payload: {
          bundleSha256: release.data.bundleSha256,
          bytes: release.data.bytes,
          files: release.data.files,
          releaseId: release.data.id,
        },
        updatedAt: at,
      });
      return { app, release };
    },

    getRelease,

    async listReleases(app) {
      const records = await queryAll({
        ConsistentRead: true,
        ExpressionAttributeValues: { ":pk": childPartition(app), ":sk": `${key("APP-RELEASE")}#` },
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :sk)",
        ScanIndexForward: false,
      });
      return records.filter((record) => record.itemType === "app-release");
    },

    async promoteRelease(input) {
      requireChange("promote", input.app, "release");
      const previousReleaseId = liveReleaseIdOf(input.app.data.lifecycle);
      if (previousReleaseId === input.releaseId) return input.app;
      const release = await getRelease(input);
      if (!release) {
        refuse(
          "promote",
          "not-found",
          `Release ${input.releaseId} is not a release of app ${input.app.data.id}.`,
        );
      }
      return reviseApp({
        actor: input.actor,
        app: input.app,
        changes: { lifecycle: { liveReleaseId: release.data.id, state: "active" } },
        eventType: "app.release.promoted",
        operation: "promote",
        payload: { previousReleaseId, releaseId: release.data.id },
      });
    },

    getGrant,

    async listGrants(app) {
      const records = await queryAll({
        ConsistentRead: true,
        ExpressionAttributeValues: { ":pk": childPartition(app), ":sk": `${key("APP-GRANT")}#` },
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :sk)",
      });
      return records.filter((record) => record.itemType === "app-grant");
    },

    async putGrant(input) {
      requireChange("put-grant", input.app, "configure");
      const previous = await getGrant(input);
      if (previous?.data.role === input.role) return { app: input.app, grant: previous };
      const at = now().toISOString();
      const grant = decodeGrant(
        withCanonicalRecordKeys({
          data: {
            appId: input.app.data.id,
            createdAt: previous?.data.createdAt ?? at,
            environmentId: input.app.data.environmentId,
            grantedBy: input.changedBy,
            id: grantId(input.app, input.principalId),
            organizationId: input.app.data.organizationId,
            principalId: input.principalId,
            projectId: input.app.data.projectId,
            role: input.role,
            updatedAt: at,
            version: previous ? previous.data.version + 1 : 1,
          },
          itemType: "app-grant" as const,
        }),
      );
      const app = await reviseApp({
        actor: { id: input.changedBy, type: "principal" },
        app: input.app,
        changes: {},
        companions: [
          { kind: "put", record: grant, ...(previous ? { previousRecord: previous } : {}) },
          activeMemberCondition(input.app.data.organizationId, input.principalId),
        ],
        eventType: "app.grant.changed",
        operation: "put-grant",
        payload: { principalId: input.principalId, role: input.role },
        updatedAt: at,
      });
      return { app, grant };
    },

    async removeGrant(input) {
      requireChange("remove-grant", input.app, "configure");
      const previous = await getGrant(input);
      if (!previous) return input.app;
      return reviseApp({
        actor: { id: input.changedBy, type: "principal" },
        app: input.app,
        changes: {},
        companions: [{ kind: "delete", record: previous }],
        eventType: "app.grant.changed",
        operation: "remove-grant",
        payload: { principalId: input.principalId, role: null },
      });
    },

    async setAccess(input) {
      requireChange("set-access", input.app, "configure");
      if (input.app.data.access.organizationMembers === input.organizationMembers) return input.app;
      return reviseApp({
        actor: { id: input.changedBy, type: "principal" },
        app: input.app,
        changes: { access: { organizationMembers: input.organizationMembers } },
        eventType: "app.access.changed",
        operation: "set-access",
        payload: { organizationMembers: input.organizationMembers },
      });
    },

    async renameApp(input) {
      requireChange("rename", input.app, "configure");
      if (input.app.data.name === input.name) return input.app;
      return reviseApp({
        actor: { id: input.changedBy, type: "principal" },
        app: input.app,
        changes: { name: input.name },
        eventType: "app.renamed",
        operation: "rename",
        payload: { name: input.name, previousName: input.app.data.name },
      });
    },

    async setAgentDefinition(input) {
      requireChange("set-agent-definition", input.app, "configure");
      if (input.app.data.agentDefinitionId === input.agentDefinitionId) return input.app;
      return reviseApp({
        actor: { id: input.changedBy, type: "principal" },
        app: input.app,
        changes: { agentDefinitionId: input.agentDefinitionId },
        eventType: "app.agent-definition.changed",
        operation: "set-agent-definition",
        payload: {
          agentDefinitionId: input.agentDefinitionId,
          previousAgentDefinitionId: input.app.data.agentDefinitionId,
        },
      });
    },
  };
}
