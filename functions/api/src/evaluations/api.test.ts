import { describe, expect, test } from "bun:test";
import { operatorAccessGrant } from "@deployments-ai/db/operator-access-testing";
import { ENV, evaluationHarness, ORG, OTHER_ENV, PROJECT, writerIdentity } from "./api.fixture.ts";

const containsDefinition = {
  evaluator: { kind: "contains", values: ["refund"] },
  name: "mentions-refund",
};

describe("Evaluations API authorization", () => {
  test("requires a bearer credential", async () => {
    const { call } = evaluationHarness();
    const response = await call("GET", "/v1/score-definitions", {
      headers: { authorization: "" },
    });
    expect(response.status).toBe(401);
    expect(response.body.code).toBe("unauthorized");
  });

  test("lets a read-only credential list but not create", async () => {
    const { call } = evaluationHarness({
      identity: { ...writerIdentity, scopes: ["observability:read"] },
    });
    expect((await call("GET", "/v1/score-definitions")).status).toBe(200);
    const created = await call("POST", "/v1/score-definitions", { body: containsDefinition });
    expect(created.status).toBe(403);
    expect(created.body.code).toBe("insufficient_scope");
  });

  test("rejects an environment the credential is not granted", async () => {
    const { call } = evaluationHarness();
    const response = await call("GET", "/v1/score-definitions", { environmentId: OTHER_ENV });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe("environment_scope_violation");
  });

  test("lets platform administrators reach any environment of an organization opened to them", async () => {
    const administrator = (organizationId: string) =>
      evaluationHarness({
        identity: {
          authentication: "tenant-jwt",
          operatorAccess: operatorAccessGrant(organizationId),
          platformRole: "administrator",
          principalId: writerIdentity.principalId,
          scopes: ["platform:admin"],
        },
      }).call("GET", "/v1/score-definitions", { environmentId: OTHER_ENV });
    expect((await administrator(ORG)).status).toBe(200);
    expect((await administrator(OTHER_ENV)).status).toBe(403);
  });

  test("requires organization, project, and environment headers", async () => {
    const { call } = evaluationHarness();
    const noProject = await call("GET", "/v1/score-definitions", {
      headers: { "x-deployments-project": "" },
    });
    expect(noProject.status).toBe(400);
    expect(noProject.body.code).toBe("missing_project_context");
    const noEnvironment = await call("GET", "/v1/score-definitions", {
      headers: { "x-deployments-environment": "" },
    });
    expect(noEnvironment.status).toBe(400);
    expect(noEnvironment.body.code).toBe("missing_environment_context");
    const noOrganization = await call("GET", "/v1/score-definitions", {
      headers: { "x-deployments-organization": "" },
    });
    expect(noOrganization.status).toBe(400);
    expect(noOrganization.body.code).toBe("missing_organization_context");
  });

  test("requires an Idempotency-Key on every mutation", async () => {
    const { call } = evaluationHarness();
    const response = await call("POST", "/v1/score-definitions", {
      body: containsDefinition,
      idempotencyKey: null,
    });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("missing_idempotency_key");
  });

  test("rejects environments that are missing, foreign, or archived", async () => {
    const foreign = evaluationHarness({
      environment: { id: ENV, organizationId: ENV, projectId: PROJECT, status: "active" },
    });
    const foreignResponse = await foreign.call("GET", "/v1/score-definitions");
    expect(foreignResponse.status).toBe(404);
    expect(foreignResponse.body.code).toBe("environment_not_found");

    const archived = evaluationHarness({
      environment: { id: ENV, organizationId: ORG, projectId: PROJECT, status: "archived" },
    });
    const archivedResponse = await archived.call("GET", "/v1/score-definitions");
    expect(archivedResponse.status).toBe(409);
    expect(archivedResponse.body.code).toBe("environment_archived");
  });

  test("replays a mutation for a reused Idempotency-Key without creating twice", async () => {
    const { call } = evaluationHarness();
    const first = await call("POST", "/v1/score-definitions", {
      body: containsDefinition,
      idempotencyKey: "definition-1",
    });
    const replay = await call("POST", "/v1/score-definitions", {
      body: containsDefinition,
      idempotencyKey: "definition-1",
    });
    expect(first.status).toBe(201);
    expect(replay.body.id).toBe(first.body.id);
    expect((await call("GET", "/v1/score-definitions")).body.items).toHaveLength(1);
  });
});
