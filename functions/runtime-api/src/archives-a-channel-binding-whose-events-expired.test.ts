import { describe, expect, test } from "bun:test";
import {
  ChannelBindingRecord,
  DatabaseError,
  makeDynamoDatabase,
  OrganizationRecord,
  tableNamesFromEnvironment,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
} from "@deployments-ai/db";
import { fakeDynamoDocumentClient } from "@deployments-ai/db/dynamo-testing";
import { Schema } from "effect";
import { archiveChannelBinding, updateChannelBinding } from "./channel-bindings.ts";
import { ids, now, principal } from "./runtime-lifecycle.fixture.ts";
import type { RuntimeApiDependencies } from "./runtime-support.ts";

const bindingId = ids[9]!;

/** A channel binding last written at version 8 whose semantic events retention has deleted. */
function bindingWithExpiredEvents() {
  const fake = fakeDynamoDocumentClient();
  const tables = tableNamesFromEnvironment({});
  fake.put(
    tables.control,
    Schema.decodeUnknownSync(OrganizationRecord)(
      withCanonicalRecordKeys({
        data: {
          createdAt: now.toISOString(),
          id: principal().scope.organizationId,
          name: "Acme",
          slug: "acme",
          status: "active" as const,
          updatedAt: now.toISOString(),
          version: 1,
        },
        itemType: "organization" as const,
      }),
    ),
  );
  fake.put(
    tables.control,
    Schema.decodeUnknownSync(ChannelBindingRecord)(
      withCanonicalRecordKeys({
        data: {
          ...principal().scope,
          agentDefinitionId: ids[5]!,
          agentDeploymentId: ids[4]!,
          channel: "telegram",
          createdAt: now.toISOString(),
          externalChannelId: "bot-1",
          externalWorkspaceId: "bot-1",
          id: bindingId,
          provider: "telegram",
          status: "active" as const,
          updatedAt: now.toISOString(),
          version: 8,
        },
        itemType: "channel-binding" as const,
      }),
    ),
  );
  let generated = 20;
  const dependencies = (database: DynamoDatabaseService) =>
    ({
      database,
      generateId: async () => ids[generated++]!,
      now: () => now,
    }) as unknown as RuntimeApiDependencies;
  const database = makeDynamoDatabase(fake.client, tables);
  const stored = () => {
    const { data } = Schema.decodeUnknownSync(ChannelBindingRecord)(
      fake.get(tables.control, {
        pk: `ORG#${principal().scope.organizationId}#ENV#${principal().scope.environmentId}`,
        sk: `CHANNEL-BINDING#${bindingId}`,
      }),
    );
    return { status: data.status, version: data.version };
  };
  const eventKeys = () => fake.items(tables.events).map((item) => item.sk);
  return { database, dependencies, eventKeys, stored };
}

describe("archiving a channel binding whose semantic events retention deleted", () => {
  test("archives the binding and appends its event", async () => {
    const { database, dependencies, eventKeys, stored } = bindingWithExpiredEvents();

    const archived = await archiveChannelBinding(principal(), bindingId, dependencies(database));

    expect({ status: archived.data.status, version: archived.data.version }).toEqual({
      status: "archived",
      version: 9,
    });
    expect(stored()).toEqual({ status: "archived", version: 9 });
    expect(eventKeys()).toEqual(["SEMANTIC-EVENT#0000000000000010"]);
  });

  test("rejects an archive that loses a race with an update", async () => {
    const { database, dependencies, eventKeys, stored } = bindingWithExpiredEvents();
    let raced = false;
    const racing: DynamoDatabaseService = {
      ...database,
      transactWrite: async (...args) => {
        if (!raced) {
          raced = true;
          await updateChannelBinding(
            principal(),
            bindingId,
            { status: "disabled" },
            dependencies(database),
          );
        }
        return database.transactWrite(...args);
      },
    };

    const lost = await archiveChannelBinding(principal(), bindingId, dependencies(racing)).then(
      () => "archived",
      (cause: unknown) => (cause instanceof DatabaseError ? cause.reason : "unexpected"),
    );

    expect(lost).toBe("conflict");
    expect(stored()).toEqual({ status: "disabled", version: 9 });
    expect(eventKeys()).toEqual(["SEMANTIC-EVENT#0000000000000010"]);
  });
});
