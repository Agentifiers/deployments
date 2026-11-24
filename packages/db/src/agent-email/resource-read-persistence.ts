import { createHash } from "node:crypto";
import type { AgentEmailRepositoryContext } from "./persistence-context.ts";
import {
  MAX_ACTIVE_AGENT_EMAIL_PLATFORM_BINDINGS_PER_INBOX,
  type AgentEmailControlResourceType,
} from "./record-mapping.ts";
import { key } from "../keys.ts";
import { type PlatformRecord } from "../records/index.ts";

const ACTIVE_BINDING_INDEX_CONVERGENCE_ATTEMPTS = 4;
const ACTIVE_BINDING_INDEX_RETRY_DELAY_MILLISECONDS = 25;

export function makeAgentEmailResourceReadRepository(context: AgentEmailRepositoryContext) {
  const {
    allPages,
    database,
    failure,
    getDomain,
    getEnvironmentRecord,
    getInbox,
    inScope,
    only,
    queryByEnvironment,
    run,
    scope,
  } = context;

  async function getControlResource<ResourceType extends AgentEmailControlResourceType>(
    resourceType: ResourceType,
    id: string,
  ) {
    const value =
      resourceType === "inbox" ? await getInbox(id) : await getEnvironmentRecord(resourceType, id);
    return value?.itemType === resourceType
      ? (value as Extract<PlatformRecord, { readonly itemType: ResourceType }>)
      : undefined;
  }

  async function listControlResourcesPage<ResourceType extends AgentEmailControlResourceType>(
    resourceType: ResourceType,
    input: {
      readonly cursor?: { readonly createdAt: string; readonly id: string };
      readonly limit: number;
    },
  ) {
    const partitionKey = `ORG#${scope.organizationId}#ENV#${scope.environmentId}`;
    if (input.cursor) {
      const cursorResource = await getControlResource(resourceType, input.cursor.id);
      if (!cursorResource || cursorResource.data.createdAt !== input.cursor.createdAt) {
        throw failure(
          `list-${resourceType}-page`,
          new Error(`The ${resourceType} cursor is no longer valid.`),
        );
      }
    }
    const result = await run(
      `list-${resourceType}-page`,
      database.queryRecords("control", {
        ...(input.cursor
          ? {
              ExclusiveStartKey: {
                pk: partitionKey,
                sk: key(
                  "INBOX-CONTROL-CREATED-INDEX",
                  resourceType,
                  input.cursor.createdAt,
                  input.cursor.id,
                ),
              },
            }
          : {}),
        ConsistentRead: true,
        ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
        ExpressionAttributeValues: {
          ":pk": partitionKey,
          ":sk": `INBOX-CONTROL-CREATED-INDEX#${resourceType}#`,
        },
        KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :sk)",
        Limit: input.limit + 1,
        ScanIndexForward: false,
      }),
    );
    const candidates = only(result.items, "inbox-control-created-index").filter(
      (record) => inScope(record) && record.data.resourceType === resourceType,
    );
    const selected = candidates.slice(0, input.limit);
    const items = await Promise.all(
      selected.map(async (index) => {
        const resource = await getControlResource(resourceType, index.data.id);
        if (!resource || resource.data.createdAt !== index.data.createdAt) {
          throw failure(
            `list-${resourceType}-page`,
            new Error(`The ${resourceType} creation index is inconsistent.`),
          );
        }
        return resource;
      }),
    );
    return {
      hasMore: candidates.length > input.limit || result.lastEvaluatedKey !== undefined,
      items,
      scannedThrough: selected.at(-1),
    };
  }

  return {
    getDomain,
    getInbox,
    async listDomains() {
      const items = await allPages("list-domains", (exclusiveStartKey) =>
        queryByEnvironment(
          database,
          "control",
          scope.environmentId,
          "inbox-domain",
          exclusiveStartKey,
        ),
      );
      return only(items, "inbox-domain").filter(inScope);
    },

    listDomainsPage(input: {
      readonly cursor?: { readonly createdAt: string; readonly id: string };
      readonly limit: number;
    }) {
      return listControlResourcesPage("inbox-domain", input);
    },

    async listOrganizationDomains() {
      const items = await allPages("list-organization-domains", (exclusiveStartKey) =>
        database.queryRecords("control", {
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
          ExpressionAttributeNames: { "#pk": "gsi1pk", "#sk": "gsi1sk" },
          ExpressionAttributeValues: {
            ":pk": `ORG#${scope.organizationId}`,
            ":sk": "INBOX-DOMAIN#",
          },
          IndexName: "gsi1",
          KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :sk)",
        }),
      );
      return only(items, "inbox-domain").filter(
        (record) => record.data.organizationId === scope.organizationId,
      );
    },

    async listPlacements() {
      const items = await allPages("list-placements", (exclusiveStartKey) =>
        queryByEnvironment(
          database,
          "control",
          scope.environmentId,
          "inbox-placement",
          exclusiveStartKey,
        ),
      );
      return only(items, "inbox-placement").filter(inScope);
    },

    listPlacementsPage(input: {
      readonly cursor?: { readonly createdAt: string; readonly id: string };
      readonly limit: number;
    }) {
      return listControlResourcesPage("inbox-placement", input);
    },

    async listOrganizationPlacements() {
      const items = await allPages("list-organization-placements", (exclusiveStartKey) =>
        database.queryRecords("control", {
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
          ExpressionAttributeNames: { "#pk": "gsi1pk", "#sk": "gsi1sk" },
          ExpressionAttributeValues: {
            ":pk": `ORG#${scope.organizationId}`,
            ":sk": "INBOX-PLACEMENT#",
          },
          IndexName: "gsi1",
          KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :sk)",
        }),
      );
      return only(items, "inbox-placement").filter(
        (record) => record.data.organizationId === scope.organizationId,
      );
    },

    async listInboxBindings() {
      const items = await allPages("list-bindings", (exclusiveStartKey) =>
        queryByEnvironment(
          database,
          "control",
          scope.environmentId,
          "inbox-binding",
          exclusiveStartKey,
        ),
      );
      return only(items, "inbox-binding").filter(inScope);
    },

    async listActivePlatformBindingsForInbox(inboxId: string) {
      let expectedCount = 0;
      let observedCount = 0;
      for (let attempt = 0; attempt < ACTIVE_BINDING_INDEX_CONVERGENCE_ATTEMPTS; attempt += 1) {
        const inbox = await getInbox(inboxId, true);
        if (!inbox) {
          throw failure(
            "list-active-platform-bindings-for-inbox",
            new Error(`Inbox ${inboxId} is missing while resolving active bindings.`),
          );
        }
        // The public API, inbound worker, and counter are introduced in the same
        // first runtime rollout. Older compatibility-only inbox rows cannot have
        // runtime-created platform bindings, so an absent counter represents zero.
        expectedCount = inbox.data.activePlatformBindingCount ?? 0;
        if (expectedCount > MAX_ACTIVE_AGENT_EMAIL_PLATFORM_BINDINGS_PER_INBOX) {
          throw failure(
            "list-active-platform-bindings-for-inbox",
            new Error(
              `Inbox ${inboxId} exceeds the active platform-agent binding limit of ${MAX_ACTIVE_AGENT_EMAIL_PLATFORM_BINDINGS_PER_INBOX}.`,
            ),
          );
        }

        const activeById = new Map<
          string,
          Extract<PlatformRecord, { readonly itemType: "inbox-binding" }>
        >();
        const verifiedIds = new Set<string>();
        let exclusiveStartKey: Record<string, unknown> | undefined;
        do {
          const result = await run(
            "list-active-platform-bindings-for-inbox",
            database.queryRecords("control", {
              ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
              ExpressionAttributeNames: { "#pk": "gsi1pk", "#sk": "gsi1sk" },
              ExpressionAttributeValues: {
                ":pk": `ENV#${scope.environmentId}#INBOX#${inboxId}#BINDINGS`,
                ":sk": "INBOX-BINDING#active#platform_agent#",
              },
              IndexName: "gsi1",
              KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :sk)",
              Limit: MAX_ACTIVE_AGENT_EMAIL_PLATFORM_BINDINGS_PER_INBOX + 1,
            }),
          );
          const candidateIds = [
            ...new Set(
              only(result.items, "inbox-binding")
                .filter((binding) => inScope(binding) && binding.data.inboxId === inboxId)
                .map((binding) => binding.data.id)
                .filter((id) => !verifiedIds.has(id)),
            ),
          ];
          candidateIds.forEach((id) => verifiedIds.add(id));
          const verified = await Promise.all(
            candidateIds.map((id) => getEnvironmentRecord("inbox-binding", id, "control", true)),
          );
          for (const binding of verified) {
            if (!binding) continue;
            if (
              binding.data.inboxId === inboxId &&
              binding.data.status === "active" &&
              binding.data.bindingType === "platform_agent"
            ) {
              activeById.set(binding.data.id, binding);
            }
          }
          observedCount = activeById.size;
          if (observedCount > MAX_ACTIVE_AGENT_EMAIL_PLATFORM_BINDINGS_PER_INBOX) {
            throw failure(
              "list-active-platform-bindings-for-inbox",
              new Error(
                `Inbox ${inboxId} exceeds the active platform-agent binding limit of ${MAX_ACTIVE_AGENT_EMAIL_PLATFORM_BINDINGS_PER_INBOX}.`,
              ),
            );
          }
          if (observedCount === expectedCount) {
            return [...activeById.values()];
          }
          exclusiveStartKey = result.lastEvaluatedKey;
        } while (exclusiveStartKey);
        if (attempt + 1 < ACTIVE_BINDING_INDEX_CONVERGENCE_ATTEMPTS) {
          await new Promise((resolve) =>
            setTimeout(resolve, ACTIVE_BINDING_INDEX_RETRY_DELAY_MILLISECONDS * 2 ** attempt),
          );
        }
      }
      throw failure(
        "list-active-platform-bindings-for-inbox",
        new Error(
          `Active binding index did not converge for inbox ${inboxId}: expected ${expectedCount}, observed ${observedCount}.`,
        ),
      );
    },

    listInboxBindingsPage(input: {
      readonly cursor?: { readonly createdAt: string; readonly id: string };
      readonly limit: number;
    }) {
      return listControlResourcesPage("inbox-binding", input);
    },

    async listInboxes() {
      const items = await allPages("list-inboxes", (exclusiveStartKey) =>
        queryByEnvironment(database, "control", scope.environmentId, "inbox", exclusiveStartKey),
      );
      return only(items, "inbox").filter(inScope);
    },

    listInboxesPage(input: {
      readonly cursor?: { readonly createdAt: string; readonly id: string };
      readonly limit: number;
    }) {
      return listControlResourcesPage("inbox", input);
    },

    async listProviderTenants() {
      const items = await allPages("list-provider-tenants", (exclusiveStartKey) =>
        database.queryRecords("control", {
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
          ExpressionAttributeNames: { "#pk": "gsi1pk", "#sk": "gsi1sk" },
          ExpressionAttributeValues: {
            ":pk": `ORG#${scope.organizationId}`,
            ":sk": "INBOX-PROVIDER-TENANT#",
          },
          IndexName: "gsi1",
          KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :sk)",
        }),
      );
      return only(items, "inbox-provider-tenant").filter(
        (record) => record.data.organizationId === scope.organizationId,
      );
    },

    async listSuppressions() {
      const items = await allPages("list-suppressions", (exclusiveStartKey) =>
        queryByEnvironment(
          database,
          "control",
          scope.environmentId,
          "inbox-suppression",
          exclusiveStartKey,
        ),
      );
      return only(items, "inbox-suppression").filter(inScope);
    },

    async listOrganizationSuppressions() {
      const items = await allPages("list-organization-suppressions", (exclusiveStartKey) =>
        database.queryRecords("control", {
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
          ExpressionAttributeNames: { "#pk": "gsi1pk", "#sk": "gsi1sk" },
          ExpressionAttributeValues: {
            ":pk": `ORG#${scope.organizationId}`,
            ":sk": "INBOX-SUPPRESSION#",
          },
          IndexName: "gsi1",
          KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :sk)",
        }),
      );
      return only(items, "inbox-suppression").filter(
        (record) => record.data.organizationId === scope.organizationId,
      );
    },

    async hasOtherActiveOrganizationSuppression(address: string, suppressionId: string) {
      const emailHash = createHash("sha256").update(address.trim().toLowerCase()).digest("hex");
      const namespace = `organization:${scope.organizationId}:inbox-suppression-address:${emailHash}`;
      // Suppressions and their organization claims are created and removed atomically.
      // This greenfield store therefore has no claimless suppression records to scan for.
      const items = await allPages("list-organization-suppression-claims", (exclusiveStartKey) =>
        database.queryRecords("control", {
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
          ConsistentRead: true,
          ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
          ExpressionAttributeValues: {
            ":pk": key("UNIQUE", namespace),
            ":sk": "VALUE#",
          },
          KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :sk)",
        }),
      );
      const claimed = only(items, "unique-claim").some(
        (claim) =>
          claim.data.namespace === namespace &&
          claim.data.ownerItemType === "inbox-suppression" &&
          claim.data.ownerId !== suppressionId,
      );
      return claimed;
    },

    listSuppressionsPage(input: {
      readonly cursor?: { readonly createdAt: string; readonly id: string };
      readonly limit: number;
    }) {
      return listControlResourcesPage("inbox-suppression", input);
    },
  };
}
