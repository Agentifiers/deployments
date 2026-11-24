import { Schema } from "effect";
import type { DynamoDatabaseService, TransactionOperation } from "../client-types.ts";
import { makeIdGenerator, type Ulid } from "../ids.ts";
import { key } from "../keys.ts";
import { PersistenceError } from "../persistence-types.ts";
import { UniqueClaimRecord } from "../records/identity.ts";
import { ModelPolicyRecord } from "../records/models.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import { makeSemanticEventRecord, transactWithSemanticEvents } from "../semantic-event-storage.ts";
import { isDatabaseWriteConflict } from "../transaction-conditions.ts";
import {
  acquireUniqueClaim,
  makeUniqueClaimRecord,
  MODEL_POLICY_ACTIVE_CLAIM_VALUE,
  modelPolicyClaimNamespace,
  releaseUniqueClaim,
  uniqueClaimRequirements,
} from "../unique-claims.ts";

export type ModelPolicyRecordValue = typeof ModelPolicyRecord.Type;
export type ModelPolicyData = ModelPolicyRecordValue["data"];

export interface ModelPolicyScope {
  readonly environmentId: string;
  readonly organizationId: string;
  readonly projectId: string;
}

export interface ModelPolicyMutationContext {
  readonly principalId: string;
  /** DynamoDB client request token so a retried idempotent request replays one transaction. */
  readonly transactionToken?: string;
}

export interface CreateModelPolicyInput {
  readonly description?: string;
  readonly includeCuratedModels: boolean;
  readonly models: readonly string[];
  readonly name: string;
}

export interface UpdateModelPolicyInput {
  readonly description?: string;
  readonly expectedVersion: number;
  readonly includeCuratedModels?: boolean;
  readonly models?: readonly string[];
  readonly name?: string;
}

export interface ModelPolicyPage {
  readonly items: readonly ModelPolicyData[];
  readonly nextCursor: string | null;
}

export interface ModelPolicyPersistence {
  readonly archive: (
    scope: ModelPolicyScope,
    id: string,
    expectedVersion: number,
    context: ModelPolicyMutationContext,
  ) => Promise<ModelPolicyData>;
  readonly create: (
    scope: ModelPolicyScope,
    input: CreateModelPolicyInput,
    context: ModelPolicyMutationContext,
  ) => Promise<ModelPolicyData>;
  /** The environment's active policy, or undefined when the curated defaults apply. */
  readonly getActive: (scope: ModelPolicyScope) => Promise<ModelPolicyData | undefined>;
  readonly get: (scope: ModelPolicyScope, id: string) => Promise<ModelPolicyData>;
  readonly list: (
    scope: ModelPolicyScope,
    page: { readonly cursor?: string; readonly limit?: number },
  ) => Promise<ModelPolicyPage>;
  readonly update: (
    scope: ModelPolicyScope,
    id: string,
    input: UpdateModelPolicyInput,
    context: ModelPolicyMutationContext,
  ) => Promise<ModelPolicyData>;
}

export interface ModelPolicyPersistenceOptions {
  readonly generateId?: () => Promise<string>;
  readonly now?: () => Date;
}

const ITEM_PREFIX = `${key("MODEL-POLICY")}#`;
const DEFAULT_PAGE_SIZE = 50;

function partition(scope: ModelPolicyScope) {
  return key("ORG", scope.organizationId, "ENV", scope.environmentId);
}

function invalidCursor() {
  return new PersistenceError(
    "invalid-input",
    "invalid_cursor",
    "The pagination cursor is invalid.",
  );
}

function decodeCursor(cursor: string | undefined, scope: ModelPolicyScope) {
  if (!cursor) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalidCursor();
  }
  const value = decoded as { readonly pk?: unknown; readonly sk?: unknown; readonly v?: unknown };
  if (
    !decoded ||
    typeof decoded !== "object" ||
    Object.keys(decoded).length !== 3 ||
    value.v !== 1 ||
    value.pk !== partition(scope) ||
    typeof value.sk !== "string" ||
    !value.sk.startsWith(ITEM_PREFIX) ||
    value.sk.length > 1_024
  ) {
    throw invalidCursor();
  }
  return { pk: value.pk, sk: value.sk };
}

async function run<A>(
  promise: Promise<A>,
  conflict?: { readonly code: string; readonly message: string },
): Promise<A> {
  try {
    return await promise;
  } catch (cause) {
    if (cause instanceof PersistenceError) throw cause;
    if (conflict && isDatabaseWriteConflict(cause)) {
      throw new PersistenceError("conflict", conflict.code, conflict.message);
    }
    throw new PersistenceError("internal", "persistence_error", "Model policy persistence failed.");
  }
}

function policyRecord(data: ModelPolicyData): ModelPolicyRecordValue {
  return Schema.decodeUnknownSync(ModelPolicyRecord, { onExcessProperty: "error" })(
    withCanonicalRecordKeys({ data, itemType: "model-policy" as const }),
  );
}

function activeClaim(record: ModelPolicyRecordValue) {
  const [requirement] = uniqueClaimRequirements(record);
  if (!requirement) throw new TypeError("Only active model policies hold the environment claim.");
  return Schema.decodeUnknownSync(UniqueClaimRecord)(
    makeUniqueClaimRecord(requirement, record.data.createdAt),
  );
}

export function makeModelPolicyPersistence(
  database: DynamoDatabaseService,
  options: ModelPolicyPersistenceOptions = {},
): ModelPolicyPersistence {
  const idGenerator = makeIdGenerator();
  const now = options.now ?? (() => new Date());
  const generateId = options.generateId ?? (async () => idGenerator.generate());

  async function load(scope: ModelPolicyScope, id: string) {
    const record = await run(
      database.getRecord("control", { pk: partition(scope), sk: key("MODEL-POLICY", id) }, true),
    );
    if (!record || record.itemType !== "model-policy") {
      throw new PersistenceError("not-found", "resource_not_found", "Model policy was not found.");
    }
    return record;
  }

  async function event(
    record: ModelPolicyRecordValue,
    eventType: string,
    context: ModelPolicyMutationContext,
  ) {
    return makeSemanticEventRecord({
      actor: { id: context.principalId as Ulid, type: "principal" },
      aggregateId: record.data.id,
      aggregateType: "model-policy",
      aggregateVersion: record.data.version,
      environmentId: record.data.environmentId,
      eventId: (await generateId()) as Ulid,
      eventType,
      occurredAt: record.data.updatedAt,
      organizationId: record.data.organizationId,
      payload: {
        id: record.data.id,
        includeCuratedModels: record.data.includeCuratedModels,
        modelCount: record.data.models.length,
        status: record.data.status,
      },
      projectId: record.data.projectId,
    });
  }

  async function mutate(
    previous: ModelPolicyRecordValue,
    next: ModelPolicyRecordValue,
    eventType: string,
    context: ModelPolicyMutationContext,
    extra: readonly TransactionOperation[] = [],
  ) {
    await run(
      transactWithSemanticEvents(
        database,
        [{ kind: "put", previousRecord: previous, record: next }, ...extra],
        [await event(next, eventType, context)],
        context.transactionToken,
      ),
      { code: "version_conflict", message: "The model policy changed concurrently." },
    );
    return next.data;
  }

  function assertMutable(previous: ModelPolicyRecordValue, expectedVersion: number) {
    if (previous.data.version !== expectedVersion) {
      throw new PersistenceError(
        "conflict",
        "version_conflict",
        `Expected model policy version ${expectedVersion}, found ${previous.data.version}.`,
      );
    }
    if (previous.data.status !== "active") {
      throw new PersistenceError(
        "conflict",
        "resource_inactive",
        "Archived model policies cannot be changed.",
      );
    }
  }

  return {
    async create(scope, input, context) {
      const timestamp = now().toISOString();
      const record = policyRecord({
        createdAt: timestamp,
        createdByPrincipalId: context.principalId as Ulid,
        ...(input.description !== undefined ? { description: input.description } : {}),
        environmentId: scope.environmentId as Ulid,
        id: (await generateId()) as Ulid,
        includeCuratedModels: input.includeCuratedModels,
        models: [...input.models],
        name: input.name,
        organizationId: scope.organizationId as Ulid,
        projectId: scope.projectId as Ulid,
        status: "active",
        updatedAt: timestamp,
        version: 1,
      });
      await run(
        transactWithSemanticEvents(
          database,
          [{ kind: "put", record }, acquireUniqueClaim(activeClaim(record))],
          [await event(record, "model-policy.created", context)],
          context.transactionToken,
        ),
        {
          code: "model_policy_exists",
          message:
            "The environment already has an active model policy; update or archive it instead.",
        },
      );
      return record.data;
    },
    async get(scope, id) {
      return (await load(scope, id)).data;
    },
    async getActive(scope) {
      const claim = await run(
        database.getRecord(
          "control",
          {
            pk: key("UNIQUE", modelPolicyClaimNamespace(scope.environmentId)),
            sk: key("VALUE", MODEL_POLICY_ACTIVE_CLAIM_VALUE),
          },
          true,
        ),
      );
      if (!claim || claim.itemType !== "unique-claim") return undefined;
      const policy = await load(scope, claim.data.ownerId);
      return policy.data.status === "active" ? policy.data : undefined;
    },
    async list(scope, page) {
      const exclusiveStartKey = decodeCursor(page.cursor, scope);
      const result = await run(
        database.queryRecords("control", {
          ConsistentRead: true,
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
          ExpressionAttributeValues: { ":pk": partition(scope), ":prefix": ITEM_PREFIX },
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          Limit: page.limit ?? DEFAULT_PAGE_SIZE,
        }),
      );
      const last = result.lastEvaluatedKey;
      return {
        items: result.items.flatMap((record) =>
          record.itemType === "model-policy" ? [record.data] : [],
        ),
        nextCursor:
          last && typeof last.pk === "string" && typeof last.sk === "string"
            ? Buffer.from(JSON.stringify({ pk: last.pk, sk: last.sk, v: 1 })).toString("base64url")
            : null,
      };
    },
    async update(scope, id, input, context) {
      const previous = await load(scope, id);
      assertMutable(previous, input.expectedVersion);
      const { description: _description, ...unchanged } = previous.data;
      const next = policyRecord({
        ...unchanged,
        ...((input.description ?? previous.data.description) !== undefined
          ? { description: input.description ?? previous.data.description }
          : {}),
        includeCuratedModels: input.includeCuratedModels ?? previous.data.includeCuratedModels,
        models: [...(input.models ?? previous.data.models)],
        name: input.name ?? previous.data.name,
        updatedAt: now().toISOString(),
        version: previous.data.version + 1,
      });
      return mutate(previous, next, "model-policy.updated", context);
    },
    async archive(scope, id, expectedVersion, context) {
      const previous = await load(scope, id);
      assertMutable(previous, expectedVersion);
      const timestamp = now().toISOString();
      const next = policyRecord({
        ...previous.data,
        archivedAt: timestamp,
        status: "archived",
        updatedAt: timestamp,
        version: previous.data.version + 1,
      });
      return mutate(previous, next, "model-policy.archived", context, [
        releaseUniqueClaim(activeClaim(previous)),
      ]);
    },
  };
}
