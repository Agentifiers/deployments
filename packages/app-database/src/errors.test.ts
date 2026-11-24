import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { DatabaseError } from "pg";
import { createAppApiGateway } from "./app-database.ts";
import { AppDatabaseError, fromPostgresError } from "./errors.ts";
import { AppId } from "./names.ts";

function closedPort(): number {
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data: () => undefined },
  });
  const { port } = listener;
  listener.stop(true);
  return port;
}

function outcome(error: AppDatabaseError) {
  return { code: error.code, message: error.message };
}

describe("fromPostgresError", () => {
  test("a server that cannot take connections now is database_unavailable", () => {
    const error = Object.assign(
      new DatabaseError("the database system is starting up", 0, "error"),
      {
        code: "57P03",
      },
    );
    expect(outcome(fromPostgresError(error))).toEqual({
      code: "database_unavailable",
      message: "the database system is starting up",
    });
  });

  test("a constraint violation is postgres_error and keeps its DETAIL", () => {
    const error = Object.assign(
      new DatabaseError('duplicate key value violates unique constraint "orders_pkey"', 0, "error"),
      { code: "23505", detail: "Key (id)=(1) already exists." },
    );
    expect(outcome(fromPostgresError(error))).toEqual({
      code: "postgres_error",
      message: [
        'duplicate key value violates unique constraint "orders_pkey"',
        "DETAIL: Key (id)=(1) already exists.",
      ].join("\n"),
    });
  });

  test("a refused connection to a closed port is database_unavailable", async () => {
    const port = closedPort();
    const gateway = createAppApiGateway({
      connections: {
        credentials: async () => "unused",
        host: "127.0.0.1",
        port,
        resumeWaitMs: 0,
        tls: { kind: "disabled" },
      },
    });
    const failure = await gateway
      .callApiFunction({
        appId: Schema.decodeUnknownSync(AppId)("01J9Z3NDEKTSV4RRFFQ69G5FAV"),
        appIsPublic: false,
        args: {},
        functionName: "list_orders",
        principal: { email: null, id: "principal-1" },
        role: "viewer",
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    await gateway.close();
    expect(failure instanceof AppDatabaseError ? outcome(failure) : failure).toEqual({
      code: "database_unavailable",
      message: `The app database did not answer: connect ECONNREFUSED 127.0.0.1:${port}`,
    });
  });
});
