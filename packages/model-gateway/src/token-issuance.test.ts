import { describe, expect, it } from "bun:test";
import { InvokeCommand } from "@aws-sdk/client-lambda";

import {
  type IssuedModelGatewayToken,
  issuedModelGatewayToken,
  lambdaModelTokenIssuer,
  makeModelGatewayTokenCache,
  MODEL_GATEWAY_TOKEN_REFRESH_SECONDS,
  modelGatewayServiceCredentials,
  ModelTokenIssuanceError,
  type ModelTokenRequest,
} from "./token-issuance.ts";

const NOW_MS = 1_800_000_000_000;
const runRequest: ModelTokenRequest = {
  kind: "run",
  leaseOwner: "worker-1",
  organizationId: "org_1",
  runId: "run_1",
  threadId: "thread_1",
};

function caught(run: () => unknown) {
  try {
    run();
  } catch (cause) {
    return cause;
  }
  throw new Error("Expected a throw.");
}

describe("issuer responses", () => {
  it("decodes issued tokens", () => {
    expect(
      issuedModelGatewayToken({ expiresAt: 10, models: ["openai/gpt-5.2"], ok: true, token: "t" }),
    ).toEqual({ expiresAt: 10, models: ["openai/gpt-5.2"], token: "t" });
  });

  it("surfaces refusals with their code", () => {
    const error = caught(() =>
      issuedModelGatewayToken({ code: "lease_inactive", message: "Lease lost.", ok: false }),
    );
    expect(error).toBeInstanceOf(ModelTokenIssuanceError);
    expect(error).toMatchObject({ code: "lease_inactive", message: "Lease lost." });
    expect(caught(() => issuedModelGatewayToken({ ok: false }))).toMatchObject({
      code: "issuer_failed",
      message: "Token issuance was refused.",
    });
  });

  it("treats malformed responses as issuer failures", () => {
    for (const response of [
      undefined,
      "token",
      { ok: true, token: "t", models: [] },
      { expiresAt: 1.5, models: [], ok: true, token: "t" },
      { expiresAt: 1, models: [1], ok: true, token: "t" },
      { expiresAt: 1, models: [], ok: "yes", token: "t" },
      { expiresAt: 1, models: [], ok: true, token: 7 },
    ]) {
      expect(caught(() => issuedModelGatewayToken(response))).toMatchObject({
        code: "issuer_failed",
        name: "ModelTokenIssuanceError",
      });
    }
  });
});

describe("Lambda token issuer", () => {
  it("invokes the issuer synchronously with the request payload", async () => {
    const commands: InvokeCommand[] = [];
    const issue = lambdaModelTokenIssuer(
      {
        send: (async (command: InvokeCommand) => {
          commands.push(command);
          return {
            Payload: Buffer.from(
              JSON.stringify({ expiresAt: 99, models: ["openai/gpt-5.2"], ok: true, token: "jwt" }),
            ),
          };
        }) as never,
      },
      "prefix-model-token-run",
    );

    expect(issue(runRequest)).resolves.toEqual({
      expiresAt: 99,
      models: ["openai/gpt-5.2"],
      token: "jwt",
    });
    expect(commands[0]).toBeInstanceOf(InvokeCommand);
    expect(commands[0]?.input.FunctionName).toBe("prefix-model-token-run");
    expect(commands[0]?.input.InvocationType).toBe("RequestResponse");
    expect(
      JSON.parse(Buffer.from(commands[0]!.input.Payload as Uint8Array).toString("utf8")),
    ).toEqual(runRequest);
  });

  it("maps function errors, non-JSON payloads, and refusals", async () => {
    const issuer = (result: { FunctionError?: string; Payload?: Uint8Array }) =>
      lambdaModelTokenIssuer({ send: (async () => result) as never }, "issuer");

    expect(
      issuer({
        FunctionError: "Unhandled",
        Payload: Buffer.from(JSON.stringify({ errorMessage: "boom" })),
      })(runRequest),
    ).rejects.toMatchObject({ code: "issuer_failed", message: "Token issuer failed (Unhandled)." });
    expect(issuer({ Payload: Buffer.from("not json") })(runRequest)).rejects.toMatchObject({
      code: "issuer_failed",
    });
    expect(issuer({})(runRequest)).rejects.toMatchObject({ code: "issuer_failed" });
    expect(
      issuer({
        Payload: Buffer.from(
          JSON.stringify({ code: "model_not_admitted", message: "denied", ok: false }),
        ),
      })(runRequest),
    ).rejects.toMatchObject({ code: "model_not_admitted", message: "denied" });
  });
});

describe("token cache", () => {
  function issuer() {
    const requests: ModelTokenRequest[] = [];
    const issue = async (request: ModelTokenRequest): Promise<IssuedModelGatewayToken> => {
      requests.push(request);
      await Promise.resolve();
      return { expiresAt: NOW_MS / 1000 + 600, models: [], token: `token-${requests.length}` };
    };
    return { issue, requests };
  }

  it("shares one issuance between concurrent callers", async () => {
    const { issue, requests } = issuer();
    const tokens = makeModelGatewayTokenCache(issue, () => NOW_MS);
    expect(
      Promise.all([tokens(runRequest), tokens(runRequest), tokens(runRequest)]),
    ).resolves.toEqual(["token-1", "token-1", "token-1"]);
    expect(requests).toEqual([runRequest]);
  });

  it("reuses a token until the refresh window and re-issues after", async () => {
    const { issue, requests } = issuer();
    let now = NOW_MS;
    const tokens = makeModelGatewayTokenCache(issue, () => now);
    const expiresAt = NOW_MS / 1000 + 600;

    expect(tokens(runRequest)).resolves.toBe("token-1");
    now = (expiresAt - MODEL_GATEWAY_TOKEN_REFRESH_SECONDS - 1) * 1000;
    expect(tokens(runRequest)).resolves.toBe("token-1");
    now = (expiresAt - MODEL_GATEWAY_TOKEN_REFRESH_SECONDS) * 1000;
    expect(tokens(runRequest)).resolves.toBe("token-2");
    expect(requests).toHaveLength(2);
  });

  it("keys tokens by request", async () => {
    const { issue, requests } = issuer();
    const tokens = makeModelGatewayTokenCache(issue, () => NOW_MS);
    await tokens(runRequest);
    expect(tokens({ ...runRequest, runId: "run_2" })).resolves.toBe("token-2");
    expect(tokens(runRequest)).resolves.toBe("token-1");
    expect(requests).toHaveLength(2);
  });

  it("does not cache failed issuances", async () => {
    let calls = 0;
    const tokens = makeModelGatewayTokenCache(
      async () => {
        calls += 1;
        if (calls === 1) throw new ModelTokenIssuanceError("lease_inactive", "Lease lost.");
        return { expiresAt: NOW_MS / 1000 + 600, models: [], token: "recovered" };
      },
      () => NOW_MS,
    );
    expect(tokens(runRequest)).rejects.toMatchObject({ code: "lease_inactive" });
    expect(tokens(runRequest)).resolves.toBe("recovered");
    expect(tokens(runRequest)).resolves.toBe("recovered");
    expect(calls).toBe(2);
  });
});

describe("service credentials", () => {
  it("requests the route's primary first and its unique fallbacks sorted, with the tenant context", async () => {
    const requests: ModelTokenRequest[] = [];
    const credentials = modelGatewayServiceCredentials({
      context: (request) => ({
        environmentId: "env_1",
        organizationId: request.scope?.organizationId ?? "org_unknown",
        projectId: "project_1",
      }),
      issue: async (request) => {
        requests.push(request);
        return { expiresAt: NOW_MS / 1000 + 900, models: [], token: "service-token" };
      },
      now: () => NOW_MS,
    });
    const scope = { organizationId: "org_1" };

    expect(
      credentials({
        modelIds: [
          "openai/gpt-5.2",
          "openrouter/z-ai/glm-5.2",
          "openrouter/xiaomi/mimo-v2.5",
          "openrouter/z-ai/glm-5.2",
        ],
        scope,
      }),
    ).resolves.toBe("service-token");
    await credentials({
      modelIds: ["openai/gpt-5.2", "openrouter/xiaomi/mimo-v2.5", "openrouter/z-ai/glm-5.2"],
      scope,
    });
    await credentials({
      modelIds: ["openrouter/z-ai/glm-5.2", "openai/gpt-5.2", "openrouter/xiaomi/mimo-v2.5"],
      scope,
    });
    const context = { environmentId: "env_1", organizationId: "org_1", projectId: "project_1" };
    expect(requests).toEqual([
      {
        context,
        kind: "service",
        models: ["openai/gpt-5.2", "openrouter/xiaomi/mimo-v2.5", "openrouter/z-ai/glm-5.2"],
      },
      {
        context,
        kind: "service",
        models: ["openrouter/z-ai/glm-5.2", "openai/gpt-5.2", "openrouter/xiaomi/mimo-v2.5"],
      },
    ]);
  });

  it("omits an absent or empty context", async () => {
    const requests: ModelTokenRequest[] = [];
    const issue = async (request: ModelTokenRequest) => {
      requests.push(request);
      return { expiresAt: NOW_MS / 1000 + 900, models: [], token: "t" };
    };
    await modelGatewayServiceCredentials({ issue, now: () => NOW_MS })({
      modelIds: ["openai/gpt-5.2"],
    });
    await modelGatewayServiceCredentials({ context: () => ({}), issue, now: () => NOW_MS })({
      modelIds: ["openai/gpt-5.2"],
    });
    expect(requests).toEqual([
      { kind: "service", models: ["openai/gpt-5.2"] },
      { kind: "service", models: ["openai/gpt-5.2"] },
    ]);
  });
});
