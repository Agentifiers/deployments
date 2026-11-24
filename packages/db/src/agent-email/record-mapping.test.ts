import type { AgentEmailDomainRecord } from "@deployments-ai/agent-email";
import type { Ulid } from "@deployments-ai/db";
import { describe, expect, it } from "bun:test";
import { inboxDomainRecord } from "./record-mapping.ts";

describe("agent email DynamoDB records", () => {
  it("persists domain verification history independently of the latest check", () => {
    const domain: AgentEmailDomainRecord = {
      createdAt: "2026-07-20T09:00:00.000Z",
      dnsRecords: [],
      domain: "customer.example",
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      lastCheckedAt: "2026-07-20T12:00:00.000Z",
      mailFromDomain: "bounce.customer.example",
      organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      providerManaged: false,
      providerMetadata: {},
      status: "verified",
      updatedAt: "2026-07-20T12:00:00.000Z",
      verifiedAt: "2026-07-20T10:00:00.000Z",
    };

    const record = inboxDomainRecord(
      {
        environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAX" as Ulid,
        organizationId: domain.organizationId as Ulid,
        projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAY" as Ulid,
      },
      domain,
    );

    expect(record.data.lastCheckedAt).toBe("2026-07-20T12:00:00.000Z");
    expect(record.data.verifiedAt).toBe("2026-07-20T10:00:00.000Z");
  });
});
