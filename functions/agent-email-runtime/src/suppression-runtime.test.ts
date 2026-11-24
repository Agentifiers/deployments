import type { AgentEmailMessageRecord } from "@deployments-ai/agent-email";
import { describe, expect, it } from "bun:test";
import { agentEmailSesSuppressionTargets } from "./suppression-runtime.ts";

const message: AgentEmailMessageRecord = {
  attachments: [],
  bccAddresses: [],
  ccAddresses: [],
  createdAt: "2026-07-25T00:00:00.000Z",
  direction: "outbound",
  fromAddress: "agent@example.com",
  id: "01ARZ3NDEKTSV4RRFFQ69G5FAA",
  inboxId: "01ARZ3NDEKTSV4RRFFQ69G5FAB",
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAC",
  references: [],
  replyToAddresses: [],
  reprocessCount: 0,
  status: "bounced",
  subject: "Hello",
  threadKey: "thread",
  toAddresses: ["person@example.net"],
  updatedAt: "2026-07-25T00:00:00.000Z",
};

function repository(
  providerManaged: boolean,
  organizationSuppressions: readonly {
    readonly data: {
      readonly address: string;
      readonly id: string;
      readonly status: "active" | "removed";
    };
  }[] = [],
) {
  return {
    getInbox: async () => ({
      data: {
        domainId: "01ARZ3NDEKTSV4RRFFQ69G5FAD",
        id: message.inboxId,
        organizationId: message.organizationId,
        placementId: "01ARZ3NDEKTSV4RRFFQ69G5FAE",
      },
    }),
    listDomains: async () => [
      {
        data: {
          id: "01ARZ3NDEKTSV4RRFFQ69G5FAD",
          organizationId: message.organizationId,
          providerManaged,
        },
      },
    ],
    listPlacements: async () => [
      {
        data: {
          id: "01ARZ3NDEKTSV4RRFFQ69G5FAE",
          isDefault: false,
          organizationId: message.organizationId,
          provider: "ses",
          region: "us-east-1",
          secondaryRegion: "us-west-2",
        },
      },
    ],
    listProviderTenants: async () => [
      {
        data: {
          organizationId: message.organizationId,
          provider: "ses",
          providerName: "tenant-east",
          region: "us-east-1",
        },
      },
      {
        data: {
          organizationId: message.organizationId,
          provider: "ses",
          providerName: "tenant-west",
          region: "us-west-2",
        },
      },
    ],
    hasOtherActiveOrganizationSuppression: async (_address: string, suppressionId: string) =>
      organizationSuppressions.some(
        (suppression) =>
          suppression.data.id !== suppressionId && suppression.data.status === "active",
      ),
  } as never;
}

describe("agent email SES suppression routing", () => {
  it("targets every custom-domain tenant region", async () => {
    expect(agentEmailSesSuppressionTargets(repository(false), message)).resolves.toEqual([
      { region: "us-east-1", tenantName: "tenant-east" },
      { region: "us-west-2", tenantName: "tenant-west" },
    ]);
  });

  it("keeps provider-managed hosted-domain suppressions local", async () => {
    expect(agentEmailSesSuppressionTargets(repository(true), message)).resolves.toEqual([]);
  });

  it("removes custom-domain suppressions from every organization tenant region", async () => {
    expect(
      agentEmailSesSuppressionTargets(repository(false), message, {
        address: "person@example.net",
        suppressionId: "suppression-current",
      }),
    ).resolves.toEqual([
      { region: "us-east-1", tenantName: "tenant-east" },
      { region: "us-west-2", tenantName: "tenant-west" },
    ]);
  });

  it("retains custom-domain provider suppressions used by a sibling environment", async () => {
    expect(
      agentEmailSesSuppressionTargets(
        repository(false, [
          {
            data: {
              address: "person@example.net",
              id: "suppression-sibling",
              status: "active",
            },
          },
        ]),
        message,
        {
          address: "PERSON@example.net",
          suppressionId: "suppression-current",
        },
      ),
    ).resolves.toEqual([]);
  });

  it("does not grant hosted-domain callers account-level suppression control", async () => {
    expect(
      agentEmailSesSuppressionTargets(repository(true), message, {
        address: "person@example.net",
        suppressionId: "suppression-current",
      }),
    ).resolves.toEqual([]);
  });
});
