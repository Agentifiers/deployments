import { expect, test } from "bun:test";
import { Schema } from "effect";
import { createServer } from "node:net";
import type { ApiFunction } from "./api-catalog.ts";
import { apiSessionFor, type ApiCallInput } from "./api-call.ts";
import { createAppApiGateway } from "./app-database.ts";
import { AppDatabaseError } from "./errors.ts";
import { AppId } from "./names.ts";

const appId = Schema.decodeUnknownSync(AppId)("01J9Z3NDEKTSV4RRFFQ69G5FAV");
const principal = { email: "member@example.com", id: "principal-1" };

function fn(schema: ApiFunction["schema"], volatility: ApiFunction["volatility"]): ApiFunction {
  return {
    arguments: [],
    name: "submit",
    result: { kind: "void" },
    returnsSet: false,
    schema,
    volatility,
  };
}

test("schema, volatility, caller, and publication pick the session role", () => {
  const outcomes: string[] = [];
  for (const appIsPublic of [false, true]) {
    for (const role of ["editor", "viewer", "visitor"] as const) {
      for (const schema of ["api", "visitor"] as const) {
        for (const volatility of ["stable", "volatile"] as const) {
          const base = { appId, appIsPublic, args: {}, functionName: "submit" };
          const input: ApiCallInput =
            role === "visitor" ? { ...base, role } : { ...base, principal, role };
          const session = apiSessionFor(input, fn(schema, volatility));
          const outcome =
            session instanceof AppDatabaseError
              ? session.code
              : `${session.role} ${session.access}`;
          outcomes.push(
            `${appIsPublic ? "public" : "members"} ${role} ${schema}.${volatility}: ${outcome}`,
          );
        }
      }
    }
  }
  expect(outcomes).toEqual([
    "members editor api.stable: viewer read only",
    "members editor api.volatile: editor read write",
    "members editor visitor.stable: viewer read only",
    "members editor visitor.volatile: editor read write",
    "members viewer api.stable: viewer read only",
    "members viewer api.volatile: function_not_allowed",
    "members viewer visitor.stable: viewer read only",
    "members viewer visitor.volatile: function_not_allowed",
    "members visitor api.stable: visitor_not_allowed",
    "members visitor api.volatile: visitor_not_allowed",
    "members visitor visitor.stable: visitor_not_allowed",
    "members visitor visitor.volatile: visitor_not_allowed",
    "public editor api.stable: viewer read only",
    "public editor api.volatile: editor read write",
    "public editor visitor.stable: visitor read only",
    "public editor visitor.volatile: visitor read write",
    "public viewer api.stable: viewer read only",
    "public viewer api.volatile: function_not_allowed",
    "public viewer visitor.stable: visitor read only",
    "public viewer visitor.volatile: visitor read write",
    "public visitor api.stable: visitor_not_allowed",
    "public visitor api.volatile: visitor_not_allowed",
    "public visitor visitor.stable: visitor read only",
    "public visitor visitor.volatile: visitor read write",
  ]);
});

test("a visitor on an app that is not public is refused before any database work", async () => {
  const contacts: string[] = [];
  const server = createServer((socket) => {
    contacts.push("connection");
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected a TCP address.");
  const gateway = createAppApiGateway({
    connections: {
      credentials: async (user) => {
        contacts.push(`credentials ${user}`);
        return "unused";
      },
      host: "127.0.0.1",
      port: address.port,
      resumeWaitMs: 0,
      tls: { kind: "disabled" },
    },
  });
  const outcome = await gateway
    .callApiFunction({
      appId,
      appIsPublic: false,
      args: {},
      functionName: "sign_up",
      role: "visitor",
    })
    .then(
      () => "called",
      (error: unknown) => (error instanceof AppDatabaseError ? error.code : String(error)),
    );
  await gateway.close();
  server.close();
  expect({ contacts, outcome }).toEqual({ contacts: [], outcome: "visitor_not_allowed" });
});
