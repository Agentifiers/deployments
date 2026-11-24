import { expect, test } from "bun:test";
import type { Ulid } from "@deployments-ai/db";
import { commandHash, idempotencyKey } from "./submission.ts";

const organizationId = "01ARZ3NDEKTSV4RRFFQ69G5F00" as Ulid;
const projectId = "01ARZ3NDEKTSV4RRFFQ69G5F01" as Ulid;
const environmentId = "01ARZ3NDEKTSV4RRFFQ69G5F02" as Ulid;
const workspaceId = "01ARZ3NDEKTSV4RRFFQ69G5F03" as Ulid;
const deploymentId = "01ARZ3NDEKTSV4RRFFQ69G5F06" as Ulid;
const releaseId = "01ARZ3NDEKTSV4RRFFQ69G5F05" as Ulid;

test("scopes conversation idempotency by project, environment, and workspace", () => {
  const base = { environmentId, organizationId, projectId, workspaceId };
  const first = idempotencyKey(base, "request-123");
  expect(first).not.toEqual(
    idempotencyKey({ ...base, projectId: "01ARZ3NDEKTSV4RRFFQ69G5F20" as Ulid }, "request-123"),
  );
  expect(first).not.toEqual(
    idempotencyKey({ ...base, environmentId: "01ARZ3NDEKTSV4RRFFQ69G5F21" as Ulid }, "request-123"),
  );
  expect(first).not.toEqual(
    idempotencyKey({ ...base, workspaceId: "01ARZ3NDEKTSV4RRFFQ69G5F22" as Ulid }, "request-123"),
  );
});

test("hashes normalized conversation intent without binding retries to a release", () => {
  const base = {
    actor: { type: "system" as const },
    agentDeploymentId: deploymentId,
    agentReleaseId: releaseId,
    content: "Run it",
    environmentId,
    idempotencyKey: "hash-test",
    organizationId,
    projectId,
    title: "Explicit title",
  };
  const hash = commandHash(base, "Run it", "Explicit title");
  expect(hash).toBe("482882cc71fe79461488ff21cd40299588aba17c330480fd02cb230d36fee7ee");
  expect(
    commandHash(
      { ...base, agentReleaseId: "01ARZ3NDEKTSV4RRFFQ69G5F20" as Ulid },
      "Run it",
      "Explicit title",
    ),
  ).toBe(hash);
  expect(commandHash({ ...base, title: "Other" }, "Run it", "Other")).not.toBe(hash);
  expect(
    commandHash({ ...base, captureMode: "metadata-only" }, "Run it", "Explicit title"),
  ).not.toBe(hash);
  expect(
    commandHash(
      {
        ...base,
        initiatingCaller: {
          principalId: organizationId,
          scopes: ["brains:read"],
          type: "principal",
        },
      },
      "Run it",
      "Explicit title",
    ),
  ).not.toBe(hash);
  const responseFormat = {
    type: "json_schema" as const,
    name: "answer",
    schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  };
  const structuredHash = commandHash(
    { ...base, responseFormat, inputArtifacts: [organizationId] },
    "Run it",
    "Explicit title",
  );
  expect(structuredHash).not.toBe(hash);
  expect(
    commandHash(
      { ...base, responseFormat, inputArtifacts: [projectId] },
      "Run it",
      "Explicit title",
    ),
  ).not.toBe(structuredHash);
  expect(
    commandHash(
      {
        ...base,
        responseFormat: {
          ...responseFormat,
          schema: { required: ["text"], properties: { text: { type: "string" } }, type: "object" },
        },
        inputArtifacts: [organizationId],
      },
      "Run it",
      "Explicit title",
    ),
  ).toBe(structuredHash);
  expect(
    commandHash(
      {
        ...base,
        responseFormat: { ...responseFormat, schema: { type: "array" } },
        inputArtifacts: [organizationId],
      },
      "Run it",
      "Explicit title",
    ),
  ).not.toBe(structuredHash);
  expect(
    commandHash(
      {
        ...base,
        createThreadIfMissing: true,
        externalThreadKey: "external-thread-1",
        messageMetadata: { externalMessageId: "external-message-1" },
      },
      "Run it",
      "Explicit title",
    ),
  ).not.toBe(hash);
});
