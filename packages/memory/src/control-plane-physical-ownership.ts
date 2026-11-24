import {
  MemorySearchPhysicalOwnerRecord,
  canonicalRecordKeys,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
  type TransactionOperation,
  type Ulid,
  memoryPersistence,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { createHash } from "node:crypto";

type Component = Extract<PlatformRecord, { readonly itemType: "memory-search-component" }>;
type PhysicalOwner = Extract<PlatformRecord, { readonly itemType: "memory-search-physical-owner" }>;

function componentIsTargetExclusive(component: Component) {
  return (
    component.data.componentKind === "dense" ||
    (component.data.componentKind === "lexical" &&
      component.data.providerId === "aws-native" &&
      component.data.schemaGeneration >= 2)
  );
}

export function physicalLocationHash(
  componentKind: "dense" | "lexical",
  location: Readonly<Record<string, unknown>>,
) {
  const physicalString = (name: string) => {
    const value = location[name];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error("Physical component ownership requires its complete provider address.");
    }
    return value.trim().toLowerCase();
  };
  const canonicalOpenSearchOrigin = () => {
    const endpoint = new URL(physicalString("openSearchEndpoint"));
    if (
      endpoint.protocol !== "https:" ||
      endpoint.username ||
      endpoint.password ||
      (endpoint.pathname !== "/" && endpoint.pathname !== "") ||
      endpoint.search ||
      endpoint.hash
    ) {
      throw new Error("OpenSearch ownership requires a canonical HTTPS origin.");
    }
    return endpoint.origin;
  };
  const identity = [
    physicalString("region"),
    canonicalOpenSearchOrigin(),
    physicalString("openSearchIndex"),
  ];
  return createHash("sha256")
    .update(JSON.stringify([componentKind, ...identity]))
    .digest("hex");
}

export function requiredPhysicalField(location: Readonly<Record<string, unknown>>, name: string) {
  return typeof location[name] === "string" && String(location[name]).trim().length > 0;
}

export async function physicalOwnerRegistrationOperation(args: {
  readonly component: Component;
  readonly database: DynamoDatabaseService;
  readonly organizationId: Ulid;
  readonly targetId: Ulid;
  readonly timestamp: string;
}): Promise<TransactionOperation> {
  if (args.component.data.componentKind === "namespace") {
    throw new Error("Namespace components do not have physical owner records.");
  }
  const locationHash = physicalLocationHash(
    args.component.data.componentKind,
    args.component.data.location,
  );
  const keys = canonicalRecordKeys(
    {
      data: { physicalLocationHash: locationHash },
      itemType: "memory-search-physical-owner",
    },
    "control",
  );
  const value = await memoryPersistence.read(args.database, "control", keys, true);
  if (value && value.itemType !== "memory-search-physical-owner") {
    throw new Error("Physical component ownership identity is occupied.");
  }
  const existing = value as
    | Extract<PlatformRecord, { readonly itemType: "memory-search-physical-owner" }>
    | undefined;
  if (existing) {
    if (
      existing.data.componentKind !== args.component.data.componentKind ||
      existing.data.componentId !== args.component.data.id ||
      existing.data.organizationId !== args.organizationId ||
      (componentIsTargetExclusive(args.component) &&
        (existing.data.targetId !== args.targetId || existing.data.referenceCount !== 1))
    ) {
      throw new Error("Physical component is owned by another memory target.");
    }
    if (!componentIsTargetExclusive(args.component)) {
      return {
        kind: "put",
        previousRecord: existing,
        record: Schema.decodeUnknownSync(MemorySearchPhysicalOwnerRecord)(
          withCanonicalRecordKeys({
            data: {
              ...existing.data,
              referenceCount: existing.data.referenceCount + 1,
              updatedAt: args.timestamp,
              version: existing.data.version + 1,
            },
            itemType: "memory-search-physical-owner" as const,
          }),
        ),
      };
    }
    return {
      conditionExpression:
        "#data.#version = :version AND #data.#componentId = :componentId AND #itemType = :itemType",
      expressionAttributeNames: {
        "#componentId": "componentId",
        "#data": "data",
        "#itemType": "itemType",
        "#version": "version",
      },
      expressionAttributeValues: {
        ":componentId": args.component.data.id,
        ":itemType": "memory-search-physical-owner",
        ":version": existing.data.version,
      },
      key: { pk: existing.pk, sk: existing.sk },
      kind: "condition-check",
      table: "control",
    };
  }
  const owner = Schema.decodeUnknownSync(MemorySearchPhysicalOwnerRecord)(
    withCanonicalRecordKeys({
      data: {
        componentKind: args.component.data.componentKind,
        componentId: args.component.data.id,
        createdAt: args.timestamp,
        organizationId: args.organizationId,
        physicalLocationHash: locationHash,
        referenceCount: 1,
        targetId: args.targetId,
        updatedAt: args.timestamp,
        version: 0,
      },
      itemType: "memory-search-physical-owner" as const,
    }),
  );
  return {
    conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
    kind: "put",
    record: owner,
  };
}

export function physicalOwnerRemovalOperation(args: {
  readonly component: Component;
  readonly owner: PhysicalOwner;
  readonly organizationId: Ulid;
  readonly targetId: Ulid;
  readonly timestamp: string;
}): TransactionOperation {
  if (
    args.owner.data.componentKind !== args.component.data.componentKind ||
    args.owner.data.componentId !== args.component.data.id ||
    args.owner.data.organizationId !== args.organizationId ||
    args.owner.data.referenceCount < 1 ||
    (componentIsTargetExclusive(args.component) &&
      (args.owner.data.targetId !== args.targetId || args.owner.data.referenceCount !== 1))
  ) {
    throw new Error("Physical target ownership is unavailable for safe cleanup.");
  }
  if (args.owner.data.referenceCount === 1) {
    return { kind: "delete", record: args.owner };
  }
  return {
    kind: "put",
    previousRecord: args.owner,
    record: Schema.decodeUnknownSync(MemorySearchPhysicalOwnerRecord)(
      withCanonicalRecordKeys({
        data: {
          ...args.owner.data,
          referenceCount: args.owner.data.referenceCount - 1,
          updatedAt: args.timestamp,
          version: args.owner.data.version + 1,
        },
        itemType: "memory-search-physical-owner" as const,
      }),
    ),
  };
}
