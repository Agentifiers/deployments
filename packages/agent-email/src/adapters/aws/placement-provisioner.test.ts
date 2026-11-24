import { describe, expect, it } from "bun:test";
import {
  assertAgentEmailPlacementEndpointOwnership,
  assertAgentEmailPlacementResourceOwnership,
  assertAgentEmailRegionalTopicOwnership,
  agentEmailDedicatedPoolExists,
  agentEmailDedicatedPoolReadyForDeletion,
  agentEmailPlacementConfigurationSetArn,
  agentEmailPlacementMultiRegionEndpointArn,
  agentEmailPlacementPoolNamesForCleanup,
  agentEmailRegionalEventTopicKmsKeyArn,
  agentEmailPlacementSendingPoolName,
  agentEmailPlacementStatus,
  runAgentEmailPlacementProviderOperation,
} from "./placement-provisioner.ts";

const placement = {
  createdAt: "2026-07-20T00:00:00.000Z",
  dedicatedPool: true,
  id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  isDefault: false,
  name: "Resilient US",
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  provider: "ses" as const,
  providerMetadata: { endpointId: "owned-endpoint" },
  region: "us-east-2",
  secondaryRegion: "us-west-2",
  status: "active" as const,
  updatedAt: "2026-07-20T00:00:00.000Z",
};

const readyRegionalState = {
  max24HourSend: 50_000,
  maxSendRate: 25,
  productionAccessEnabled: true,
  region: "us-east-2",
  sendingEnabled: true,
};

describe("agent email SES placement status", () => {
  it("builds taggable multi-region endpoint ARNs", () => {
    expect(
      agentEmailPlacementMultiRegionEndpointArn(
        "aws",
        "us-east-1",
        "123456789012",
        "agent-inboxes-placement",
      ),
    ).toBe("arn:aws:ses:us-east-1:123456789012:multi-region-endpoint/agent-inboxes-placement");
  });
  it("keeps a placement non-active when any regional configuration set is disabled", () => {
    expect(
      agentEmailPlacementStatus({
        endpointStatus: "READY",
        hasSecondaryRegion: true,
        regionalStates: [readyRegionalState, { ...readyRegionalState, sendingEnabled: false }],
      }),
    ).toBe("reconciling");
    expect(
      agentEmailPlacementStatus({
        hasSecondaryRegion: false,
        regionalStates: [{ ...readyRegionalState, sendingEnabled: false }],
      }),
    ).toBe("reconciling");
  });

  it("activates only fully enabled routes and fails failed endpoints", () => {
    expect(
      agentEmailPlacementStatus({
        endpointStatus: "READY",
        hasSecondaryRegion: true,
        regionalStates: [readyRegionalState, { ...readyRegionalState, region: "us-west-2" }],
      }),
    ).toBe("active");
    expect(
      agentEmailPlacementStatus({
        endpointStatus: "FAILED",
        hasSecondaryRegion: true,
        regionalStates: [readyRegionalState, { ...readyRegionalState, region: "us-west-2" }],
      }),
    ).toBe("failed");
  });

  it("requires production access and matching regional quotas", () => {
    expect(
      agentEmailPlacementStatus({
        endpointStatus: "READY",
        hasSecondaryRegion: true,
        regionalStates: [
          {
            region: "us-east-2",
            max24HourSend: 50_000,
            maxSendRate: 25,
            productionAccessEnabled: true,
            sendingEnabled: true,
          },
          {
            region: "us-west-2",
            max24HourSend: 50_000,
            maxSendRate: 25,
            productionAccessEnabled: false,
            sendingEnabled: true,
          },
        ],
      }),
    ).toBe("reconciling");
    expect(
      agentEmailPlacementStatus({
        endpointStatus: "READY",
        hasSecondaryRegion: true,
        regionalStates: [
          {
            region: "us-east-2",
            max24HourSend: 50_000,
            maxSendRate: 25,
            productionAccessEnabled: true,
            sendingEnabled: true,
          },
          {
            region: "us-west-2",
            max24HourSend: 10_000,
            maxSendRate: 10,
            productionAccessEnabled: true,
            sendingEnabled: true,
          },
        ],
      }),
    ).toBe("reconciling");
  });

  it("builds regional configuration-set ARNs for tenant dissociation", () => {
    expect(
      agentEmailPlacementConfigurationSetArn(
        "aws",
        "us-west-2",
        "123456789012",
        "agent-inboxes-placement",
      ),
    ).toBe("arn:aws:ses:us-west-2:123456789012:configuration-set/agent-inboxes-placement");
  });

  it("omits the dedicated pool when a placement uses SES shared sending", () => {
    expect(agentEmailPlacementSendingPoolName(placement, "dedicated-pool")).toBe("dedicated-pool");
    expect(
      agentEmailPlacementSendingPoolName({ ...placement, dedicatedPool: false }, "dedicated-pool"),
    ).toBeUndefined();
  });

  it("records the failing provider operation without changing the provider cause", async () => {
    const cause = new Error("provider detail");
    expect(
      runAgentEmailPlacementProviderOperation("delivery-options", async () => {
        throw cause;
      }),
    ).rejects.toMatchObject({
      cause,
      name: "AgentEmailPlacementProviderError",
      operation: "delivery-options",
    });
  });

  it("treats a missing dedicated pool as an idempotent cleanup no-op", async () => {
    const missing = new Error("missing");
    missing.name = "NotFoundException";
    expect(
      agentEmailDedicatedPoolExists(async () => {
        throw missing;
      }),
    ).resolves.toBe(false);

    const invalid = new Error("invalid");
    invalid.name = "BadRequestException";
    expect(
      agentEmailDedicatedPoolExists(async () => {
        throw invalid;
      }),
    ).rejects.toBe(invalid);
  });

  it("rechecks a pool that disappears during ownership verification", async () => {
    const missing = new Error("missing");
    missing.name = "NotFoundException";
    const invalidTagLookup = new Error("invalid tag resource");
    invalidTagLookup.name = "BadRequestException";
    let loads = 0;

    expect(
      agentEmailDedicatedPoolReadyForDeletion(
        async () => {
          loads += 1;
          if (loads > 1) throw missing;
        },
        async () => {
          throw invalidTagLookup;
        },
      ),
    ).resolves.toBe(false);

    expect(
      agentEmailDedicatedPoolReadyForDeletion(
        async () => undefined,
        async () => {
          throw invalidTagLookup;
        },
      ),
    ).rejects.toBe(invalidTagLookup);
  });

  it("skips dedicated-pool APIs for a fresh shared placement", () => {
    expect(
      agentEmailPlacementPoolNamesForCleanup(
        { dedicatedPool: false, providerMetadata: {} },
        "deterministic-pool",
      ),
    ).toEqual([]);
    expect(
      agentEmailPlacementPoolNamesForCleanup(
        { dedicatedPool: true, providerMetadata: {} },
        "deterministic-pool",
      ),
    ).toEqual(["deterministic-pool"]);
    expect(
      agentEmailPlacementPoolNamesForCleanup(
        {
          dedicatedPool: false,
          providerMetadata: { poolName: "persisted-pool" },
        },
        "deterministic-pool",
      ),
    ).toEqual(["persisted-pool"]);
  });

  it("rejects SES placement resources owned by another record", () => {
    expect(() =>
      assertAgentEmailPlacementResourceOwnership(placement, [
        { Key: "agent-inboxes:organization-id", Value: placement.organizationId },
        { Key: "agent-inboxes:resource-id", Value: "another-placement" },
      ]),
    ).toThrow("is not owned by placement");
    expect(() =>
      assertAgentEmailPlacementResourceOwnership(placement, [
        { Key: "agent-inboxes:organization-id", Value: placement.organizationId },
        { Key: "agent-inboxes:resource-id", Value: placement.id },
      ]),
    ).not.toThrow();
  });

  it("requires persisted endpoint identity before adopting or deleting it", () => {
    expect(() =>
      assertAgentEmailPlacementEndpointOwnership(placement, {
        EndpointId: "foreign-endpoint",
        EndpointName: `agent-inboxes-${placement.id}`,
        Routes: [{ Region: placement.secondaryRegion! }],
      }),
    ).toThrow("is not owned by placement");
    expect(() =>
      assertAgentEmailPlacementEndpointOwnership(
        { ...placement, providerMetadata: {} },
        {
          EndpointId: "recovered-endpoint",
          EndpointName: `agent-inboxes-${placement.id}`,
          Routes: [{ Region: placement.secondaryRegion! }],
        },
      ),
    ).not.toThrow();
  });

  it("rejects a regional SNS topic that is not tied to the primary topic", () => {
    expect(() =>
      assertAgentEmailRegionalTopicOwnership("arn:aws:sns:us-east-1:123456789012:events", [
        { Key: "agent-inboxes:managed", Value: "true" },
        { Key: "agent-inboxes:primary-topic-arn", Value: "another-topic" },
      ]),
    ).toThrow("is not owned by the primary agent email topic");
  });

  it("requires regional KMS keys for secondary event topics", () => {
    expect(
      agentEmailRegionalEventTopicKmsKeyArn("us-west-2", {
        DEPLOYMENTS_AI_AGENT_EMAIL_REGIONAL_KMS_KEY_ARNS: JSON.stringify({
          "us-west-2": "arn:aws:kms:us-west-2:123456789012:key/example",
        }),
      }),
    ).toBe("arn:aws:kms:us-west-2:123456789012:key/example");
    expect(() => agentEmailRegionalEventTopicKmsKeyArn("eu-west-1", {})).toThrow(
      "DEPLOYMENTS_AI_AGENT_EMAIL_REGIONAL_KMS_KEY_ARNS is required.",
    );
  });
});
