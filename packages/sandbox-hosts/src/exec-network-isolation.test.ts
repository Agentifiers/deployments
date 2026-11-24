import {
  type DynamoDatabaseService,
  type PlatformRecord,
  type Ulid,
  makeIdGenerator,
} from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  createLambdaMicrovmProvider,
  type ExecInput,
  SandboxDataPlaneUnknownError,
  SandboxNetworkIsolationUnavailableError,
  type SandboxLease,
  type SandboxProvider,
} from "./index.ts";
import { makeSandboxManager } from "./sandbox-manager.fixture.ts";
import { jsonBody } from "./providers-allocation.fixture.ts";

const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FC0" as Ulid;
const PROJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FC1" as Ulid;
const ENVIRONMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FC2" as Ulid;
const AGENT_DEPLOYMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FC3" as Ulid;
const RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FC4" as Ulid;
const OBSERVABILITY = {
  captureMode: "metadata-only" as const,
  runSpanId: "0123456789abcdef" as const,
  sessionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" as Ulid,
  traceId: "0123456789abcdef0123456789abcdef" as const,
};
const WORKSPACE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FC5" as Ulid;

const baseLease = {
  environmentId: ENVIRONMENT_ID,
  executionTargetId: AGENT_DEPLOYMENT_ID,
  executionTargetKind: "agent-deployment" as const,
  isolationMode: "run-ephemeral" as const,
  organizationId: ORGANIZATION_ID,
  projectId: PROJECT_ID,
  runId: RUN_ID,
  status: "ready" as const,
  workspaceId: WORKSPACE_ID,
};

const execResult = { durationMs: 1, exitCode: 0, stderr: "", stdout: "ok\n" };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function lambdaProvider(
  response: () => Response,
  requests: { readonly body: unknown; readonly url: string }[] = [],
) {
  return createLambdaMicrovmProvider({
    client: {
      async send(command) {
        const name = command.constructor.name;
        if (name === "GetMicrovmCommand") return { endpoint: "microvm-net.lambda-microvms.aws" };
        if (name === "CreateMicrovmAuthTokenCommand") {
          return { authToken: { "X-aws-proxy-auth": "proxy-token" } };
        }
        throw new Error(`Unexpected command ${name}`);
      },
    },
    fetch: async (input, init) => {
      requests.push({
        body: jsonBody(init),
        url: input instanceof Request ? input.url : String(input),
      });
      return response();
    },
    imageIdentifier: "lambda-image",
  });
}

function recordStoreDatabase(): DynamoDatabaseService {
  const key = (record: Pick<PlatformRecord, "pk" | "sk">) => `${record.pk}\u0000${record.sk}`;
  const stored = new Map<string, PlatformRecord>();
  return {
    deleteRecord: async (record) => {
      stored.delete(key(record));
    },
    getRecord: async (_table, recordKey) => {
      const record = stored.get(key(recordKey));
      return record;
    },
    putRecord: async (record) => {
      stored.set(key(record), record);
    },
    queryRecords: async () => ({ items: [] }),
    transactWrite: async (operations) => {
      for (const operation of operations) {
        if (operation.kind === "put") stored.set(key(operation.record), operation.record);
        if (operation.kind === "delete") stored.delete(key(operation.record));
      }
    },
  };
}

describe("per-command network isolation", () => {
  test("sends network none to the dedicated isolated exec route only when requested", async () => {
    const requests: { readonly body: unknown; readonly url: string }[] = [];
    const provider = lambdaProvider(() => jsonResponse(execResult), requests);
    const lease = {
      ...baseLease,
      externalSandboxId: "microvm_net",
      provider: "aws_lambda_microvm" as const,
    };

    await provider.exec({ command: ["python3", "tool.py"], lease, network: "none" });
    await provider.exec({ command: ["pwd"], lease });

    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/__sandbox/exec-isolated",
      "/__sandbox/exec",
    ]);
    expect(requests[0]?.body).toMatchObject({ command: ["python3", "tool.py"] });
    expect(requests[0]?.body).not.toHaveProperty("network");
    expect(requests[1]?.body).not.toHaveProperty("network");
  });

  test.each([
    [404, "a guest control server that predates isolated exec"],
    [422, "a guest that cannot create a network namespace"],
  ])("fails closed and deterministically on %i from %s", async (status) => {
    const requests: { readonly body: unknown; readonly url: string }[] = [];
    const provider = lambdaProvider(
      () => jsonResponse({ error: status === 404 ? "Not found" : "unavailable" }, status),
      requests,
    );
    const error = await provider
      .exec({
        command: ["python3", "tool.py"],
        lease: {
          ...baseLease,
          externalSandboxId: `microvm_net_${status}`,
          provider: "aws_lambda_microvm",
        },
        network: "none",
      })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(SandboxNetworkIsolationUnavailableError);
    expect((error as Error).cause).toMatchObject({ status });
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/__sandbox/exec-isolated",
    ]);
  });

  test("keeps an isolated exec with an unknown outcome (5xx) unknown", async () => {
    const provider = lambdaProvider(() => jsonResponse({ error: "boom" }, 503));
    const error = await provider
      .exec({
        command: ["python3", "tool.py"],
        lease: {
          ...baseLease,
          externalSandboxId: "microvm_net_unknown",
          provider: "aws_lambda_microvm",
        },
        network: "none",
      })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(SandboxDataPlaneUnknownError);
  });

  test("managed exec forwards the network mode to the provider", async () => {
    const execInputs: ExecInput[] = [];
    const lease: SandboxLease = {
      ...baseLease,
      externalSandboxId: "microvm_managed_net",
      provider: "aws_lambda_microvm",
    };
    const provider: SandboxProvider = {
      name: "aws_lambda_microvm",
      checkpoint: async () => {
        throw new Error("not reached");
      },
      create: async () => lease,
      destroy: async () => undefined,
      download: async () => {
        throw new Error("not reached");
      },
      exec: async (input) => {
        execInputs.push(input);
        return execResult;
      },
      resume: async () => lease,
      upload: async () => undefined,
    };
    const manager = makeSandboxManager(provider, recordStoreDatabase(), makeIdGenerator());
    const sandbox = await Effect.runPromise(
      manager.create({
        environmentId: ENVIRONMENT_ID,
        executionTargetId: AGENT_DEPLOYMENT_ID,
        executionTargetKind: "agent-deployment",
        isolationMode: "run-ephemeral",
        observability: OBSERVABILITY,
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        workspaceId: WORKSPACE_ID,
      }),
    );

    await Effect.runPromise(
      manager.exec({ command: ["node", "tool.js"], network: "none", sandbox }),
    );
    await Effect.runPromise(manager.exec({ command: ["pwd"], sandbox }));

    expect(execInputs[0]?.network).toBe("none");
    expect(execInputs[1]).not.toHaveProperty("network");
  });
});
