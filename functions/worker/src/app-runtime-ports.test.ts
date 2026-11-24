import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { RuntimeToolPreparationRetryableError } from "@deployments-ai/agent-runtime";
import { appToolHarness } from "./app-runtime-tools.fixture.ts";
import { createLambdaAppsDatabase } from "./app-runtime-ports.ts";

const REQUEST_ID = "6f1d2c1e-9a0b-4c3d-8e7f-0a1b2c3d4e5f";
const UNAVAILABLE = {
  code: "apps_database_unavailable",
  message:
    "The app database did not answer. Call this tool again with the same input in a minute; if it keeps failing, tell the user the app database is unavailable.",
};

function lambdaAnswering(answer: { readonly FunctionError?: string; readonly payload: string }) {
  return createLambdaAppsDatabase({
    client: {
      send: (async () => ({
        $metadata: { httpStatusCode: 200, requestId: REQUEST_ID },
        FunctionError: answer.FunctionError,
        Payload: new TextEncoder().encode(answer.payload),
        StatusCode: 200,
      })) as never,
    },
    functionName: "apps-database",
  });
}

let harness = appToolHarness();
const errors = spyOn(console, "error").mockImplementation(() => undefined);
afterEach(() => {
  harness.guest.remove();
  harness = appToolHarness();
  errors.mockClear();
});
afterAll(() => {
  errors.mockRestore();
});

describe("Lambda apps database", () => {
  test("a crashed function completes app.create with a refusal the agent can resume from", async () => {
    harness.answers.provision = lambdaAnswering({
      FunctionError: "Unhandled",
      payload: JSON.stringify({
        errorMessage: "RuntimeError: Aborted(Error: ENOENT: no such file or directory)",
        errorType: "Runtime.UnhandledPromiseRejection",
      }),
    });
    const refused = await harness.call("app.create", { name: "Orders", slug: "orders" });
    const pending = await harness.apps.findAppBySlug("orders" as never);
    delete harness.answers.provision;
    const resumed = await harness.call("app.create", { name: "Orders", slug: "orders" });

    expect({
      logged: errors.mock.calls,
      pending: pending?.data.lifecycle.state,
      refused: refused.result,
      resumed: resumed.result?.output?.state,
    }).toEqual({
      logged: [
        [
          "The apps-database function did not answer.",
          {
            errorType: "Runtime.UnhandledPromiseRejection",
            functionName: "apps-database",
            requestId: REQUEST_ID,
          },
        ],
      ],
      pending: "provisioning",
      refused: {
        output: { error: UNAVAILABLE },
        outputSummary: `app.create failed: ${UNAVAILABLE.message}`,
        status: "completed",
      },
      resumed: "active",
    });
  });

  test.each([
    ["a payload outside the envelope", { rows: [["1"]] }],
    ["an envelope whose value has the wrong shape", { ok: true, value: { rows: "1" } }],
    [
      "an error code outside the protocol",
      { error: { code: "disk_full", message: "Full." }, ok: false },
    ],
  ])("%s completes app.query without logging the SQL", async (_case, answer) => {
    const created = await harness.call("app.create", { name: "Orders", slug: "orders" });
    harness.answers.query = lambdaAnswering({ payload: JSON.stringify(answer) });
    const queried = await harness.call("app.query", {
      appId: created.result?.output?.appId,
      sql: "SELECT email FROM customers",
    });

    expect({ logged: errors.mock.calls, queried: queried.result?.output }).toEqual({
      logged: [
        [
          "The apps-database function did not answer.",
          { errorType: "InvalidResponse", functionName: "apps-database", requestId: REQUEST_ID },
        ],
      ],
      queried: { error: UNAVAILABLE },
    });
  });

  test("an invoke that never reached the function leaves app.query to be retried", async () => {
    const created = await harness.call("app.create", { name: "Orders", slug: "orders" });
    harness.answers.query = createLambdaAppsDatabase({
      client: {
        send: (async () => {
          throw new Error("Rate exceeded");
        }) as never,
      },
      functionName: "apps-database",
    });
    const request = harness.runRequest("app.query", {
      appId: created.result?.output?.appId,
      sql: "SELECT email FROM customers",
    });
    const decision = await harness.service.authorizeToolCall(request);
    if (decision.action !== "allow") throw new Error("Expected allow.");

    const interrupted = await harness.execute(request, decision).catch((cause: unknown) => cause);

    expect({
      interrupted:
        interrupted instanceof RuntimeToolPreparationRetryableError
          ? [interrupted.toolName, String(interrupted.preparationCause)]
          : interrupted,
      logged: errors.mock.calls,
    }).toEqual({ interrupted: ["app.query", "Error: Rate exceeded"], logged: [] });
  });
});
