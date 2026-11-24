import { describe, expect, test } from "bun:test";
import { describeProblem } from "../components/section-boundary.tsx";
import { PlatformApiError } from "../errors.ts";
import { GRANT_A, GRANT_B, manifest, ULID } from "../agents/tool-bindings.fixture.ts";
import { deployRelease, saveToolBindings, type CallRoute } from "./tool-binding-actions.ts";

const SCOPE = {
  environmentId: ULID("E1"),
  organizationId: ULID("G1"),
  projectId: ULID("J1"),
};
const DEFINITION = ULID("AD1");
const DEPLOYMENT = ULID("D1");
const RELEASE = ULID("R1");
const RELEASE_MANIFEST = manifest([{ name: "crm.read", required: true }, { name: "echo" }]);

function deployment(fields: Record<string, unknown> = {}) {
  return {
    agentDefinitionId: DEFINITION,
    agentReleaseId: RELEASE,
    currentState: "paused",
    desiredState: "paused",
    id: DEPLOYMENT,
    runtimeConfig: {
      apiVersion: "agents.deployments.ai/v1",
      brainRetrievalMode: "hybrid",
      kind: "AgentDeploymentConfig",
      toolAuthorizations: { "crm.read": { authorizationId: GRANT_A } },
    },
    version: 4,
    ...fields,
  };
}

function fakeApi(current: Record<string, unknown>) {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const callRoute = (async (name: string, input: Record<string, unknown>) => {
    calls.push({ input, name });
    if (name === "getAgentDeployment") return current;
    if (name === "getAgentRelease") {
      return {
        agentDefinitionId: DEFINITION,
        id: RELEASE,
        manifest: RELEASE_MANIFEST,
      };
    }
    return { ...current, version: Number(current.version) + 1 };
  }) as unknown as CallRoute;
  return { callRoute, calls };
}

const save = (expectedVersion: number, changes: Record<string, unknown>) => ({
  accessToken: "token",
  changes: changes as never,
  definitionId: DEFINITION,
  deploymentId: DEPLOYMENT,
  expectedVersion,
  idempotencyKey: "key-1",
  scope: SCOPE,
});

async function problemOf(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  return error instanceof PlatformApiError ? error.problem : error;
}

describe("saveToolBindings", () => {
  test("sends the whole config with the other keys kept and only the expected version", async () => {
    const api = fakeApi(deployment());
    await saveToolBindings(save(4, { echo: { authorizationId: GRANT_B } }), api.callRoute);
    expect(api.calls.at(-1)).toEqual({
      input: {
        body: {
          expectedVersion: 4,
          runtimeConfig: {
            apiVersion: "agents.deployments.ai/v1",
            brainRetrievalMode: "hybrid",
            kind: "AgentDeploymentConfig",
            toolAuthorizations: {
              "crm.read": { authorizationId: GRANT_A },
              echo: { authorizationId: GRANT_B },
            },
          },
        },
        idempotencyKey: "key-1",
        path: { id: DEPLOYMENT },
        scope: SCOPE,
      },
      name: "updateAgentDeployment",
    });
  });

  test("a retried save whose change already applied succeeds without writing", async () => {
    const applied = deployment({
      runtimeConfig: {
        apiVersion: "agents.deployments.ai/v1",
        kind: "AgentDeploymentConfig",
        toolAuthorizations: {
          "crm.read": { authorizationId: GRANT_A },
          echo: { authorizationId: GRANT_B },
        },
      },
      version: 5,
    });
    const api = fakeApi(applied);
    expect(
      await saveToolBindings(save(4, { echo: { authorizationId: GRANT_B } }), api.callRoute),
    ).toBe(applied as never);
    expect(api.calls.map(({ name }) => name)).toEqual(["getAgentDeployment", "getAgentRelease"]);
  });

  test("a change made elsewhere since the page loaded is refused with 409", async () => {
    const api = fakeApi(deployment({ version: 5 }));
    expect(
      await problemOf(
        saveToolBindings(save(4, { echo: { authorizationId: GRANT_B } }), api.callRoute),
      ),
    ).toMatchObject({
      code: "tool_bindings_changed",
      status: 409,
    });
    expect(api.calls.some(({ name }) => name === "updateAgentDeployment")).toBe(false);
  });

  test("a deployment that is not ready or paused is refused before anything else is read", async () => {
    const api = fakeApi(deployment({ currentState: "failed" }));
    const error = await saveToolBindings(save(4, { echo: null }), api.callRoute).then(
      () => undefined,
      (thrown: Error) => thrown,
    );
    expect(error && describeProblem(error, "")).toEqual({
      description:
        "The deployment is failed; only a ready or paused deployment can change its tool bindings.",
      requestId: undefined,
      status: 409,
      title: "This deployment cannot be edited now",
    });
    expect(api.calls.map(({ name }) => name)).toEqual(["getAgentDeployment"]);
  });

  test("unbinding a required tool is refused with the platform's issue and no update call", async () => {
    const api = fakeApi(deployment());
    expect(await problemOf(saveToolBindings(save(4, { "crm.read": null }), api.callRoute))).toEqual(
      {
        code: "invalid_agent_deployment_config",
        detail:
          "/toolAuthorizations/crm.read: Deployment configuration must bind workspace authorization for crm.read.",
        status: 422,
        title: "The deployment configuration does not satisfy the release.",
      },
    );
    expect(api.calls.some(({ name }) => name === "updateAgentDeployment")).toBe(false);
  });
});

describe("deployRelease", () => {
  const deploy = (
    changes: Record<string, unknown>,
    seed?: { deploymentId: string; version: number },
  ) => ({
    accessToken: "token",
    changes: changes as never,
    definitionId: DEFINITION,
    desiredState: "paused" as const,
    idempotencyKey: "key-2",
    releaseId: RELEASE,
    scope: SCOPE,
    seed,
  });

  test("creates from the seed's config plus the changes", async () => {
    const api = fakeApi(deployment());
    await deployRelease(
      deploy({ echo: { authorizationId: GRANT_B } }, { deploymentId: DEPLOYMENT, version: 4 }),
      api.callRoute,
    );
    expect(api.calls.at(-1)).toEqual({
      input: {
        body: {
          agentReleaseId: RELEASE,
          desiredState: "paused",
          runtimeConfig: {
            apiVersion: "agents.deployments.ai/v1",
            brainRetrievalMode: "hybrid",
            kind: "AgentDeploymentConfig",
            toolAuthorizations: {
              "crm.read": { authorizationId: GRANT_A },
              echo: { authorizationId: GRANT_B },
            },
          },
        },
        idempotencyKey: "key-2",
        scope: SCOPE,
      },
      name: "createAgentDeployment",
    });
  });

  test("a missing required binding is refused before the API is asked", async () => {
    const api = fakeApi(deployment());
    expect(await problemOf(deployRelease(deploy({}), api.callRoute))).toMatchObject({
      code: "invalid_agent_deployment_config",
      status: 422,
    });
    expect(api.calls.map(({ name }) => name)).toEqual(["getAgentRelease"]);
  });

  test("a seed that changed since the page loaded is refused", async () => {
    const api = fakeApi(deployment({ version: 6 }));
    expect(
      await problemOf(
        deployRelease(deploy({}, { deploymentId: DEPLOYMENT, version: 4 }), api.callRoute),
      ),
    ).toMatchObject({ code: "tool_bindings_changed", status: 409 });
  });
});
