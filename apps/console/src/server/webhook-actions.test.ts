import { WebhookResponse } from "@deployments-ai/api-contract/runtime";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { shownOnce } from "./webhook-actions.ts";

const ENDPOINT = Schema.decodeUnknownSync(WebhookResponse)({
  consecutiveFailures: 0,
  createdAt: "2026-10-05T00:00:00.000Z",
  environmentId: "01K0000000000000000000000E",
  eventTypes: ["run.completed"],
  id: "01K0000000000000000000000W",
  name: "Billing",
  object: "webhook-endpoint",
  organizationId: "01K0000000000000000000000A",
  projectId: "01K0000000000000000000000B",
  status: "active",
  updatedAt: "2026-10-05T00:00:00.000Z",
  url: "https://hooks.example.com/billing",
  version: 1,
});

describe("shownOnce", () => {
  test("moves the signing secret out of the endpoint the console caches", () => {
    const issued = shownOnce({ ...ENDPOINT, signingSecret: "whsec_example" });
    expect(issued).toEqual({ secret: "whsec_example", view: ENDPOINT });
    expect(Object.keys(issued.view)).not.toContain("signingSecret");
  });
});
