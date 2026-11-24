import { describe, expect, test } from "bun:test";
import type { BrainDeploymentMount, BrainGrant } from "@deployments-ai/brains";
import { createBrainApi } from "./api.ts";
import {
  brainId,
  environmentId,
  humanIdentity,
  organizationId,
  ownerGrant,
  projectId,
  repository,
  service,
  timestamp,
} from "./service.fixture.ts";

const agentDefinitionId = "01ARZ3NDEKTSV4RRFFQ69G5FC0";
const agentDeploymentId = "01ARZ3NDEKTSV4RRFFQ69G5FC1";
const agentGrant: BrainGrant = {
  ...ownerGrant,
  id: "01ARZ3NDEKTSV4RRFFQ69G5FC2",
  permission: "read",
  target: { agentDefinitionId, environmentId, projectId, type: "agent-definition" },
};
const mount: BrainDeploymentMount = {
  agentDefinitionId,
  agentDeploymentId,
  brainId,
  brainKind: "company",
  createdAt: timestamp,
  environmentId,
  grantedByPrincipalId: humanIdentity.principalId,
  id: "01ARZ3NDEKTSV4RRFFQ69G5FC3",
  organizationId,
  permission: "read",
  projectId,
  status: "active",
  updatedAt: timestamp,
  version: 0,
};
const internalFields = [
  "brainKind",
  "createdByPrincipalId",
  "grantedByPrincipalId",
  "maintenancePolicy",
  "retrievalPolicy",
  "updatedByPrincipalId",
];

function api() {
  let nextId = 0;
  return createBrainApi({
    authenticate: async () => humanIdentity,
    idempotency: { execute: async (input) => input.operation() },
    requestId: () => "request_test",
    service: service(
      {
        repository: repository({
          findActiveGrant: async (_organizationId, _brainId, target) =>
            target.type === "agent-definition" ? agentGrant : ownerGrant,
          getGrant: async () => agentGrant,
          getMount: async () => mount,
          listMounts: async () => ({ items: [mount] }),
        }),
      },
      Array.from({ length: 8 }, () => `01ARZ3NDEKTSV4RRFFQ69G5FD${nextId++}`),
    ),
  });
}

async function call(method: string, path: string, body?: unknown) {
  const response = await api()(
    new Request(`https://api.example${path}`, {
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      headers: {
        "content-type": "application/json",
        "idempotency-key": `${method}:${path}`,
        "x-deployments-organization": organizationId,
      },
      method,
    }),
  );
  const payload = (await response?.json()) as Record<string, unknown>;
  return { payload, status: response?.status };
}

describe("Brain HTTP responses", () => {
  test.each([
    ["POST", "/v1/brains", { kind: "company", name: "Engineering", slug: "engineering" }, 201],
    ["GET", `/v1/brains/${brainId}`, undefined, 200],
    ["GET", "/v1/brains", undefined, 200],
    ["PATCH", `/v1/brains/${brainId}`, { expectedVersion: 0, name: "Platform knowledge" }, 200],
    ["DELETE", `/v1/brains/${brainId}`, { expectedVersion: 0 }, 200],
    ["GET", `/v1/brains/${brainId}/grants`, undefined, 200],
    [
      "POST",
      `/v1/brains/${brainId}/grants`,
      {
        permission: "reader",
        target: { principalId: humanIdentity.principalId, type: "principal" },
      },
      201,
    ],
    ["DELETE", `/v1/brains/${brainId}/grants/${agentGrant.id}`, { expectedVersion: 0 }, 200],
    ["GET", `/v1/brains/${brainId}/mounts`, undefined, 200],
    [
      "POST",
      `/v1/brains/${brainId}/mounts`,
      { agentDefinitionId, agentDeploymentId, environmentId, permission: "read", projectId },
      201,
    ],
    ["DELETE", `/v1/brains/${brainId}/mounts/${mount.id}`, { expectedVersion: 0 }, 200],
  ] as const)(
    "%s %s satisfies the strict public contract",
    async (method, path, body, expected) => {
      const { payload, status } = await call(method, path, body);
      expect({ payload, status }).toMatchObject({ status: expected });
      const items = Array.isArray(payload.items)
        ? (payload.items as Record<string, unknown>[])
        : [payload];
      for (const item of items) {
        for (const field of internalFields) expect(item).not.toHaveProperty(field);
      }
    },
  );
});
