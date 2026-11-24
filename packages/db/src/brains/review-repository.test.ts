import { describe, expect, test } from "bun:test";
import type { Brain, BrainGrant } from "@deployments-ai/brains";
import { Schema } from "effect";
import type { TransactionOperation } from "../client-types.ts";
import { BrainReviewItemRecord } from "../records/brain-runtime.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import { makeBrainReviewRepository } from "./review-repository.ts";
import { brainEntityPlatformRecord } from "./record-mapping.ts";

const ids = [
  "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  "01ARZ3NDEKTSV4RRFFQ69G5FAX",
  "01ARZ3NDEKTSV4RRFFQ69G5FAY",
  "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
] as const;
const [organizationId, brainId, principalId, grantId, reviewId] = ids;
const entityOneId = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
const entityTwoId = "01ARZ3NDEKTSV4RRFFQ69G5FB1";
const now = "2026-07-30T12:00:00.000Z";

describe("Brain curator review repository", () => {
  test("resolves an open review with live canonical fences and a semantic event", async () => {
    const open = Schema.decodeUnknownSync(BrainReviewItemRecord)(
      withCanonicalRecordKeys({
        data: {
          brainId,
          createdAt: now,
          id: reviewId,
          kind: "entity-merge",
          organizationId,
          proposal: { candidateEntityIds: [entityOneId, entityTwoId] },
          reason: "Ambiguous deterministic alias.",
          status: "open",
          updatedAt: now,
          version: 0,
        },
        itemType: "brain-review-item" as const,
      }),
    );
    const entity = (id: string, alias: string) =>
      brainEntityPlatformRecord({
        brainId,
        canonicalName: alias,
        createdAt: now,
        externalIdentifiers: {},
        id,
        kind: "company",
        normalizedAliases: [alias.toLowerCase()],
        organizationId,
        reviewStatus: "unreviewed",
        status: "active",
        updatedAt: now,
        version: 0,
      });
    const entities = [entity(entityOneId, "Acme"), entity(entityTwoId, "Acme Labs")];
    const transactions: TransactionOperation[][] = [];
    const repository = makeBrainReviewRepository({
      deleteRecord: async () => {},
      getRecord: async (table, recordKey) =>
        table === "execution" ? open : entities.find((value) => value.sk === recordKey.sk),
      putRecord: async () => {},
      queryRecords: async () => ({ items: [] }),
      transactWrite: async (operations) => {
        transactions.push([...operations]);
        return;
      },
    });
    const brain: Brain = {
      createdAt: now,
      createdByPrincipalId: principalId,
      id: brainId,
      kind: "company",
      maintenancePolicy: {},
      name: "Engineering",
      organizationId,
      ownershipGeneration: 0,
      retrievalPolicy: {},
      schemaVersion: 1,
      sensitivity: "internal",
      slug: "engineering",
      status: "active",
      updatedAt: now,
      updatedByPrincipalId: principalId,
      version: 0,
    };
    const grant: BrainGrant = {
      brainId,
      brainKind: "company",
      createdAt: now,
      grantedByPrincipalId: principalId,
      id: grantId,
      organizationId,
      permission: "curator",
      status: "active",
      target: { principalId, type: "principal" },
      updatedAt: now,
      version: 0,
    };
    const resolved = await repository.resolveReviewItem({
      actorPrincipalId: principalId,
      authorizingGrant: grant,
      brain,
      eventId: grantId,
      reviewItem: {
        brainId: open.data.brainId,
        createdAt: open.data.createdAt,
        decision: "merge",
        id: open.data.id,
        kind: open.data.kind,
        organizationId: open.data.organizationId,
        proposal: { ...open.data.proposal, resolutionTargetEntityId: entityOneId },
        reason: open.data.reason,
        resolvedAt: now,
        resolvedByPrincipalId: principalId,
        status: "resolved",
        updatedAt: now,
        version: 1,
      },
    });

    expect(resolved).toMatchObject({ decision: "merge", status: "resolved", version: 1 });
    const entityWrites = transactions[0]!.flatMap((operation) =>
      operation.kind === "put" && operation.record.itemType === "brain-entity"
        ? [operation.record]
        : [],
    );
    expect(entityWrites.map((record) => record.data)).toEqual([
      expect.objectContaining({ id: entityOneId, reviewStatus: "approved", version: 1 }),
      expect.objectContaining({
        id: entityTwoId,
        mergedIntoEntityId: entityOneId,
        status: "merged",
        version: 1,
      }),
    ]);
    expect(
      transactions[0]!
        .filter((operation) => operation.kind === "put")
        .map((operation) => operation.record.itemType),
    ).toEqual(["brain-entity", "brain-entity", "brain-review-item", "semantic-event"]);
  });
});
