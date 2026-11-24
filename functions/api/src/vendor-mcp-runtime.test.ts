import type { InvokeCommand } from "@aws-sdk/client-lambda";
import { OAUTH_REFRESH_REQUEST_KIND, type OAuthRefreshRequest } from "@deployments-ai/providers";
import { describe, expect, test } from "bun:test";
import {
  makeOAuthRefreshInvoker,
  makeVendorMcpAdministrationDependencies,
  vendorMcpPublicOrigin,
} from "./vendor-mcp-runtime.ts";

const REQUEST: OAuthRefreshRequest = {
  connectionId: "01ARZ3NDEKTSV4RRFFQ69G5FC0",
  environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
  expectedGeneration: 2,
  kind: OAUTH_REFRESH_REQUEST_KIND,
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  requestedBy: "api",
};

function lambda(
  respond: () => Promise<{ readonly FunctionError?: string; readonly Payload?: Uint8Array }>,
) {
  const commands: InvokeCommand[] = [];
  return {
    client: {
      send: async (command: InvokeCommand) => {
        commands.push(command);
        return respond();
      },
    },
    commands,
  };
}

const payload = (value: unknown) => ({ Payload: new TextEncoder().encode(JSON.stringify(value)) });

describe("vendor MCP runtime wiring", () => {
  test("invokes the refresh Lambda synchronously and parses its response", async () => {
    const reference = {
      credentialId: "01ARZ3NDEKTSV4RRFFQ69G5FC1",
      generation: 3,
      store: "dynamodb-kms",
    } as const;
    const fake = lambda(async () => payload({ reference, status: "refreshed" }));

    expect(makeOAuthRefreshInvoker("oauth-refresh", fake.client)(REQUEST)).resolves.toEqual({
      reference,
      status: "refreshed",
    });
    expect(fake.commands[0]?.input).toMatchObject({
      FunctionName: "oauth-refresh",
      InvocationType: "RequestResponse",
    });
    expect(
      JSON.parse(Buffer.from(fake.commands[0]!.input.Payload as Uint8Array).toString("utf8")),
    ).toEqual(REQUEST);
  });

  test("treats function errors, transport failures, and malformed payloads as retryable", async () => {
    const outcomes = [
      lambda(async () => ({ ...payload({ errorMessage: "boom" }), FunctionError: "Unhandled" })),
      lambda(async () => {
        throw new Error("socket hang up");
      }),
      lambda(async () => payload({ status: "refreshed" })),
    ];
    for (const fake of outcomes) {
      expect(makeOAuthRefreshInvoker("oauth-refresh", fake.client)(REQUEST)).resolves.toMatchObject(
        { status: "retryable" },
      );
    }
  });

  test("requires an exact HTTPS public origin and a refresh function", () => {
    expect(vendorMcpPublicOrigin("https://channels.example.test")).toBe(
      "https://channels.example.test",
    );
    for (const invalid of [
      "https://channels.example.test/",
      "http://channels.example.test",
      "https://channels.example.test/oauth",
      "channels.example.test",
    ]) {
      expect(() => vendorMcpPublicOrigin(invalid)).toThrow();
    }
    const base = {
      lambda: lambda(async () => payload({})).client,
      mcpClient: {} as never,
    };
    expect(
      makeVendorMcpAdministrationDependencies({
        ...base,
        publicOrigin: undefined,
        refreshFunctionName: "oauth-refresh",
      }),
    ).toBeUndefined();
    expect(() =>
      makeVendorMcpAdministrationDependencies({
        ...base,
        publicOrigin: "https://channels.example.test",
        refreshFunctionName: undefined,
      }),
    ).toThrow();
  });
});
