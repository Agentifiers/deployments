import { makeOrganizationHoldReader, Ulid } from "@deployments-ai/db";
import {
  awsNativeTargetLocation,
  makeMemorySearchPlacementResolver,
  makeMemorySearchErasurePurger,
  purgeOwnedMemories,
} from "@deployments-ai/memory";
import { Schema } from "effect";
import {
  runtimeCurrentMemoryMembershipDigest,
  runtimeMemoryMembershipDigests,
} from "./membership-keyring-secret.ts";
import { openSearchTransport } from "./opensearch.ts";
import { retireErasedOrganizationSearchIndex } from "./erased-search-index-retirement.ts";
import { runtimeDatabase, runtimeMemorySearchRegistry } from "./runtime.ts";
import { dropDisabledOrganizationSearchIndex } from "./search-index-drop.ts";

const DropDisabledOrganizationSearchIndex = Schema.Struct({
  action: Schema.Literal("drop-disabled-organization-search-index"),
  organizationId: Ulid,
});

const RetireErasedOrganizationSearchIndex = Schema.Struct({
  action: Schema.Literal("retire-erased-organization-search-index"),
  index: Schema.String,
  organizationId: Ulid,
});

const OperatorAction = Schema.Union([
  DropDisabledOrganizationSearchIndex,
  RetireErasedOrganizationSearchIndex,
]);

let purger: ReturnType<typeof makeMemorySearchErasurePurger> | undefined;

async function runtimePurger() {
  if (purger) return purger;
  const approvedOpenSearchEndpoint = process.env.DEPLOYMENTS_AI_MEMORY_OPENSEARCH_ENDPOINT?.trim();
  purger = makeMemorySearchErasurePurger({
    ...(approvedOpenSearchEndpoint ? { approvedOpenSearchEndpoint } : {}),
    database: runtimeDatabase(),
    membershipDigest: runtimeCurrentMemoryMembershipDigest,
    membershipDigests: runtimeMemoryMembershipDigests,
    registry: runtimeMemorySearchRegistry(),
  });
  return purger;
}

export async function handler(
  event:
    | typeof OperatorAction.Encoded
    | {
        readonly brainId?: string;
        readonly memories?: readonly { readonly pk: string; readonly sk: string }[];
        readonly operationId: string;
        readonly organizationId: string;
        readonly threadId?: string;
      },
) {
  if ("action" in event) {
    const action = Schema.decodeUnknownSync(OperatorAction)(event);
    const approvedEndpoint = process.env.DEPLOYMENTS_AI_MEMORY_OPENSEARCH_ENDPOINT?.trim();
    if (!approvedEndpoint) {
      throw new TypeError("The OpenTofu-managed OpenSearch endpoint is not configured.");
    }
    const database = runtimeDatabase();
    if (action.action === "retire-erased-organization-search-index") {
      const region = process.env.AWS_REGION?.trim();
      if (!region) throw new TypeError("AWS_REGION is not configured.");
      return retireErasedOrganizationSearchIndex({
        approvedEndpoint,
        database,
        index: action.index,
        openSearch: openSearchTransport({ openSearchEndpoint: approvedEndpoint, region }),
        organizationId: action.organizationId,
        region,
      });
    }
    return dropDisabledOrganizationSearchIndex({
      approvedEndpoint,
      database,
      now: () => new Date(),
      openSearch: (target) => openSearchTransport(awsNativeTargetLocation(target)),
      organizationId: action.organizationId,
      standing: makeOrganizationHoldReader(database),
    });
  }
  const operationId = Schema.decodeUnknownSync(Ulid)(event.operationId);
  const organizationId = Schema.decodeUnknownSync(Ulid)(event.organizationId);
  if (event.brainId !== undefined || event.threadId !== undefined || event.memories !== undefined) {
    if ((event.brainId === undefined) === (event.threadId === undefined)) {
      throw new Error("A scoped memory purge names exactly one of brainId or threadId.");
    }
    const memories = Schema.decodeUnknownSync(
      Schema.Array(
        Schema.Struct({
          pk: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(2_048))),
          sk: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(1_024))),
        }),
      ).pipe(Schema.check(Schema.isMaxLength(100))),
    )(event.memories);
    const database = runtimeDatabase();
    const registry = runtimeMemorySearchRegistry(database);
    return purgeOwnedMemories({
      database,
      memories,
      operationId,
      organizationId,
      owner:
        event.brainId !== undefined
          ? { brainId: Schema.decodeUnknownSync(Ulid)(event.brainId), kind: "brain" }
          : { kind: "thread", threadId: Schema.decodeUnknownSync(Ulid)(event.threadId) },
      resolvePlacement: makeMemorySearchPlacementResolver(database, registry),
    });
  }
  return (await runtimePurger())(organizationId, operationId);
}
