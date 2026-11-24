import { describe, expect, test } from "bun:test";

import {
  ENVIRONMENT,
  ENVIRONMENT_ID,
  GENERATED_IDS,
  ORGANIZATION_ID,
  OTHER_ENVIRONMENT_ID,
  PROJECT_ID,
  admitAllManifests,
  conditionalFailure,
  invocation,
  makeDatabase,
  makeService,
  manifest,
  storageKey,
} from "./agent-lifecycle-test-support.ts";
import {
  DatabaseError,
  PersistenceError,
  makeAgentLifecyclePersistence,
  tableForItemType,
  type DynamoDatabaseService,
  type PlatformRecord,
} from "./index.ts";

describe("agent lifecycle persistence", () => {
  test("persists definitions, immutable releases, and deployment state transitions", async () => {
    const { queries, records, service, transactionTokens } = makeService();
    const created = await service.agentDefinitions.create(invocation({ manifest: manifest() }));
    expect(created).toMatchObject({ slug: "example.assistant", status: "active", version: 0 });

    const updated = await service.agentDefinitions.update(
      invocation(
        { expectedVersion: 0, manifest: manifest("example.revised", "Revised Assistant") },
        { id: created.id },
      ),
    );
    expect(updated).toMatchObject({ slug: "example.revised", version: 1 });

    const firstRelease = await service.agentReleases.publish(
      invocation({ expectedDefinitionVersion: 1 }, { id: created.id }),
    );
    const secondRelease = await service.agentReleases.publish(
      invocation({ expectedDefinitionVersion: 2 }, { id: created.id }),
    );
    expect([firstRelease.releaseNumber, secondRelease.releaseNumber]).toEqual([1, 2]);
    expect(firstRelease.manifest.metadata.key).toBe("example.revised");

    for (const [keyValue, record] of records) {
      if (
        record.itemType === "agent-definition-release-index" ||
        record.itemType === "agent-release-control"
      ) {
        records.delete(keyValue);
      }
    }

    const firstPage = await service.agentReleases.list(
      invocation(undefined, { id: created.id, limit: 1 }),
    );
    expect(firstPage.items.map((item) => item.releaseNumber)).toEqual([1]);
    expect(firstPage.nextCursor).toBeString();
    expect(queries.at(-1)).toMatchObject({ ConsistentRead: true, Limit: 1 });
    expect(
      [...records.values()].filter((record) => record.itemType === "agent-release-control"),
    ).toHaveLength(2);
    const nextCursor = firstPage.nextCursor;
    if (!nextCursor) throw new Error("Expected a second release page.");
    const secondPage = await service.agentReleases.list(
      invocation(undefined, {
        cursor: nextCursor,
        id: created.id,
        limit: 1,
      }),
    );
    expect(secondPage.items.map((item) => item.releaseNumber)).toEqual([2]);

    expect(
      service.agentDeployments.create(
        invocation({
          agentReleaseId: secondRelease.id,
          runtimeConfig: {
            apiVersion: "agents.deployments.ai/v1",
            kind: "AgentDeploymentConfig",
            toolAuthorizations: {
              "undeclared.write": { authorizationId: GENERATED_IDS[5] },
            },
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_agent_deployment_config", kind: "unprocessable" });

    const deployment = await service.agentDeployments.create(
      invocation({
        agentReleaseId: secondRelease.id,
        runtimeConfig: {
          apiVersion: "agents.deployments.ai/v1",
          kind: "AgentDeploymentConfig",
          toolAuthorizations: {
            "records.read": { authorizationId: GENERATED_IDS[5] },
          },
        },
      }),
    );
    const paused = await service.agentDeployments.update(
      invocation({ desiredState: "paused", expectedVersion: 0 }, { id: deployment.id }),
    );
    expect(paused).toMatchObject({ currentState: "paused", desiredState: "paused", version: 1 });
    expect(
      service.agentReleases.archive(invocation({ expectedVersion: 0 }, { id: secondRelease.id })),
    ).rejects.toMatchObject({ code: "release_in_use", kind: "conflict" });

    const stopped = await service.agentDeployments.stop(
      invocation({ expectedVersion: 1 }, { id: deployment.id }),
    );
    expect(stopped).toMatchObject({ currentState: "stopped", desiredState: "stopped", version: 2 });
    const archived = await service.agentReleases.archive(
      invocation({ expectedVersion: 0 }, { id: secondRelease.id }),
    );
    expect(archived).toMatchObject({ status: "archived", version: 1 });
    const archivedAgain = await service.agentReleases.archive(
      invocation({ expectedVersion: 1 }, { id: secondRelease.id }),
    );
    expect(archivedAgain).toEqual(archived);
    expect(
      service.agentDeployments.update(
        invocation({ desiredState: "running", expectedVersion: 2 }, { id: deployment.id }),
      ),
    ).rejects.toMatchObject({ code: "deployment_stopped", kind: "conflict" });

    const storedReleases = [...records.values()].filter(
      (record) => record.itemType === "agent-release",
    );
    expect(storedReleases).toHaveLength(2);
    const storedFirstRelease = storedReleases.find(
      (record) => String(record.data.id) === String(firstRelease.id),
    );
    expect(
      (storedFirstRelease?.data as Readonly<Record<string, unknown>> | undefined)?.status,
    ).toBe("active");
    expect(transactionTokens.filter(Boolean).every((token) => token?.length === 36)).toBe(true);
    const eventTypes = [...records.values()]
      .filter((record) => record.itemType === "semantic-event")
      .map((record) => record.data.eventType);
    expect(eventTypes).toEqual(
      expect.arrayContaining([
        "agent-definition.created",
        "agent-definition.updated",
        "agent-definition.release-published",
        "agent-release.published",
        "agent-deployment.created",
        "agent-deployment.updated",
        "agent-deployment.stopped",
        "agent-release.archived",
      ]),
    );
    expect(eventTypes.filter((eventType) => eventType === "agent-release.archived")).toHaveLength(
      1,
    );
  });

  test("enforces slug uniqueness, optimistic versions, cursors, and environment isolation", async () => {
    const { service } = makeService();
    const first = await service.agentDefinitions.create(invocation({ manifest: manifest() }));
    expect(
      service.agentDefinitions.create(invocation({ manifest: manifest() })),
    ).rejects.toMatchObject({ code: "resource_conflict", kind: "conflict" });
    expect(
      service.agentDefinitions.update(
        invocation({ expectedVersion: 9, manifest: manifest("other.agent") }, { id: first.id }),
      ),
    ).rejects.toMatchObject({ code: "version_conflict", kind: "conflict" });
    expect(
      service.agentDefinitions.list(invocation(undefined, { cursor: "not-a-cursor" })),
    ).rejects.toMatchObject({ code: "invalid_cursor", kind: "invalid-input" });
    expect(
      service.agentDefinitions.get(
        invocation(undefined, { environmentId: OTHER_ENVIRONMENT_ID, id: first.id }),
      ),
    ).rejects.toMatchObject({ code: "resource_not_found", kind: "not-found" });
  });

  test("refuses to publish or run releases whose models the environment does not admit", async () => {
    const denied = new Set<string>();
    const scopes: unknown[] = [];
    const { records, service } = makeService([ENVIRONMENT], async (scope, candidate) => {
      scopes.push(scope);
      return denied.has(candidate.spec.model.id)
        ? [
            {
              code: "model_not_allowed_by_environment_policy",
              message: `Model ${candidate.spec.model.id} is not allowed.`,
              path: "/spec/model/id",
            },
          ]
        : [];
    });
    const runtimeConfig = {
      apiVersion: "agents.deployments.ai/v1",
      kind: "AgentDeploymentConfig",
      toolAuthorizations: { "records.read": { authorizationId: GENERATED_IDS[5] } },
    } as const;
    const definition = await service.agentDefinitions.create(invocation({ manifest: manifest() }));

    denied.add("openrouter/default");
    expect(
      service.agentReleases.publish(
        invocation({ expectedDefinitionVersion: 0 }, { id: definition.id }),
      ),
    ).rejects.toMatchObject({
      code: "model_not_allowed_by_environment_policy",
      kind: "unprocessable",
      message: "/spec/model/id: Model openrouter/default is not allowed.",
    });
    expect([...records.values()].some((record) => record.itemType === "agent-release")).toBe(false);
    expect(scopes[0]).toMatchObject({
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
    });

    denied.clear();
    const release = await service.agentReleases.publish(
      invocation({ expectedDefinitionVersion: 0 }, { id: definition.id }),
    );
    denied.add("openrouter/default");
    expect(
      service.agentDeployments.create(invocation({ agentReleaseId: release.id, runtimeConfig })),
    ).rejects.toMatchObject({ code: "model_not_allowed_by_environment_policy" });
    expect([...records.values()].some((record) => record.itemType === "agent-deployment")).toBe(
      false,
    );

    denied.clear();
    const deployment = await service.agentDeployments.create(
      invocation({ agentReleaseId: release.id, runtimeConfig }),
    );
    denied.add("openrouter/default");
    const paused = await service.agentDeployments.update(
      invocation({ desiredState: "paused", expectedVersion: 0 }, { id: deployment.id }),
    );
    expect(paused.desiredState).toBe("paused");
    expect(
      service.agentDeployments.update(
        invocation({ desiredState: "running", expectedVersion: 1 }, { id: deployment.id }),
      ),
    ).rejects.toMatchObject({ code: "model_not_allowed_by_environment_policy" });
  });

  test("translates conditional transaction failures without exposing database details", async () => {
    const store = makeDatabase();
    const failing: DynamoDatabaseService = {
      ...store.database,
      transactWrite: () => Promise.reject(conditionalFailure("transact-write")),
    };
    const service = makeAgentLifecyclePersistence({
      admitManifest: admitAllManifests,
      database: failing,
      generateId: async () => GENERATED_IDS[0],
      now: () => new Date("2026-07-25T12:00:00.000Z"),
      resolveEnvironment: async () => ENVIRONMENT,
    });

    const failure = await service.agentDefinitions
      .create(invocation({ manifest: manifest() }))
      .catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(PersistenceError);
    expect(failure).toMatchObject({
      code: "resource_conflict",
      message: "Agent definition key is already in use.",
      kind: "conflict",
    });
  });

  test("retries deployment creation when the release counter changes concurrently", async () => {
    const store = makeDatabase();
    let failedDeploymentWrite = false;
    const database: DynamoDatabaseService = {
      ...store.database,
      transactWrite: (operations, clientRequestToken) => {
        if (
          !failedDeploymentWrite &&
          operations.some(
            (operation) =>
              operation.kind === "put" && operation.record.itemType === "agent-deployment",
          )
        ) {
          failedDeploymentWrite = true;
          return Promise.reject(conditionalFailure("replace"));
        }
        return store.database.transactWrite(operations, clientRequestToken);
      },
    };
    let nextId = 0;
    const service = makeAgentLifecyclePersistence({
      admitManifest: admitAllManifests,
      database,
      generateId: async () => GENERATED_IDS[nextId++]!,
      now: () => new Date("2026-07-25T12:00:00.000Z"),
      resolveEnvironment: async () => ENVIRONMENT,
    });
    const definition = await service.agentDefinitions.create(invocation({ manifest: manifest() }));
    const release = await service.agentReleases.publish(
      invocation({ expectedDefinitionVersion: 0 }, { id: definition.id }),
    );

    const deployment = await service.agentDeployments.create(
      invocation({
        agentReleaseId: release.id,
        runtimeConfig: {
          apiVersion: "agents.deployments.ai/v1",
          kind: "AgentDeploymentConfig",
          toolAuthorizations: {
            "records.read": { authorizationId: GENERATED_IDS[5] },
          },
        },
      }),
    );

    expect(failedDeploymentWrite).toBe(true);
    expect(deployment.agentReleaseId).toBe(release.id);
  });

  test("does not overwrite a concurrent release counter during index backfill", async () => {
    const store = makeDatabase();
    let racedControlBackfill = false;
    const database: DynamoDatabaseService = {
      ...store.database,
      putRecord: (record, conditionExpression) => {
        if (!racedControlBackfill && record.itemType === "agent-release-control") {
          racedControlBackfill = true;
          const concurrentControl = {
            ...record,
            data: {
              ...record.data,
              activeDeploymentCount: 1,
            },
          } as PlatformRecord;
          store.records.set(
            storageKey(tableForItemType(concurrentControl.itemType), concurrentControl),
            concurrentControl,
          );
          return Promise.reject(conditionalFailure("put"));
        }
        return store.database.putRecord(record, conditionExpression);
      },
    };
    let nextId = 0;
    const service = makeAgentLifecyclePersistence({
      admitManifest: admitAllManifests,
      database,
      generateId: async () => GENERATED_IDS[nextId++]!,
      now: () => new Date("2026-07-25T12:00:00.000Z"),
      resolveEnvironment: async () => ENVIRONMENT,
    });
    const definition = await service.agentDefinitions.create(invocation({ manifest: manifest() }));
    const release = await service.agentReleases.publish(
      invocation({ expectedDefinitionVersion: 0 }, { id: definition.id }),
    );
    for (const [keyValue, record] of store.records) {
      if (
        record.itemType === "agent-definition-release-index" ||
        record.itemType === "agent-release-control"
      ) {
        store.records.delete(keyValue);
      }
    }

    await service.agentReleases.list(invocation(undefined, { id: definition.id }));

    expect(racedControlBackfill).toBe(true);
    expect(
      service.agentReleases.archive(invocation({ expectedVersion: 0 }, { id: release.id })),
    ).rejects.toMatchObject({ code: "release_in_use", kind: "conflict" });
  });

  test("keeps non-conflict database failures as persistence errors", async () => {
    const store = makeDatabase();
    const database: DynamoDatabaseService = {
      ...store.database,
      transactWrite: () =>
        Promise.reject(
          new DatabaseError({
            cause: new Error("simulated database failure"),
            message: "Transaction failed.",
            operation: "transact-write",
            reason: "unknown",
            table: "control",
          }),
        ),
    };
    const service = makeAgentLifecyclePersistence({
      admitManifest: admitAllManifests,
      database,
      generateId: async () => GENERATED_IDS[0],
      now: () => new Date("2026-07-25T12:00:00.000Z"),
      resolveEnvironment: async () => ENVIRONMENT,
    });

    expect(
      service.agentDefinitions.create(invocation({ manifest: manifest() })),
    ).rejects.toMatchObject({ code: "persistence_error", kind: "internal" });
  });
});
