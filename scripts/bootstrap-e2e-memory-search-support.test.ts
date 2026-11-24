import { Ulid } from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  deterministicE2eMemoryId,
  e2eMemorySearchCatalog,
  e2eMemorySearchEnvelope,
  e2eMemoryTargetLocationMatches,
} from "./bootstrap-e2e-memory-search-support.ts";

const organizationId = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAV");

describe("credentialed E2E memory search bootstrap", () => {
  test("builds the canonical missing organization envelope", () => {
    const envelope = e2eMemorySearchEnvelope(organizationId, "2026-08-01T00:00:00.000Z");
    expect(envelope.placement).toMatchObject({
      data: { generation: 0, organizationId, phase: "unconfigured", version: 0 },
      itemType: "memory-search-placement",
      pk: `ORG#${organizationId}`,
      sk: `MEMORY-SEARCH-PLACEMENT#${organizationId}`,
    });
    expect(envelope.fence).toMatchObject({
      data: { epoch: 0, organizationId, status: "open", version: 0 },
      itemType: "memory-search-mutation-fence",
      pk: `ORG#${organizationId}`,
      sk: `MEMORY-SEARCH-MUTATION-FENCE#${organizationId}`,
    });
  });

  test("builds a deterministic AWS-native target", () => {
    const first = e2eMemorySearchCatalog(
      organizationId,
      "https://memory.example.us-east-2.es.amazonaws.com",
      "us-east-2",
    );
    const second = e2eMemorySearchCatalog(
      organizationId,
      "https://memory.example.us-east-2.es.amazonaws.com",
      "us-east-2",
    );
    expect(first).toEqual(second);
    expect(first.target).toMatchObject({
      componentIds: [
        deterministicE2eMemoryId(
          organizationId,
          "component:memory.example.us-east-2.es.amazonaws.com",
        ),
      ],
      location: {
        openSearchEndpoint: "https://memory.example.us-east-2.es.amazonaws.com",
        openSearchIndex: `memory-${organizationId.toLowerCase()}-v1`,
        region: "us-east-2",
      },
      providerId: "aws-native",
      schemaGeneration: 3,
    });
    expect(first.catalog.profile.gatewayRoute).toContain(`organization:${organizationId}`);
  });

  test("gives a replaced search domain a new catalog and target", () => {
    const before = e2eMemorySearchCatalog(
      organizationId,
      "https://vpc-memory.example",
      "us-east-2",
    );
    const after = e2eMemorySearchCatalog(organizationId, "https://vpc-search.example", "us-east-2");
    expect(after.target.targetId).not.toBe(before.target.targetId);
    expect(after.profileId).not.toBe(before.profileId);
    expect(e2eMemoryTargetLocationMatches(before.target, after.target)).toBe(false);
    expect(
      e2eMemoryTargetLocationMatches(
        before.target,
        e2eMemorySearchCatalog(organizationId, "https://vpc-memory.example/", "us-east-2").target,
      ),
    ).toBe(true);
  });
});
