import { describe, expect, mock, test } from "bun:test";
import type { IdentityApplication } from "./application.ts";
import { makePublicEmailRequestQueue } from "./public-email-queue.ts";
import { makePublicEmailRequestProcessor } from "./public-email-requests.ts";

describe("public identity email queue", () => {
  test("durably hands off a normalized request with a stable deduplication ID", async () => {
    const sent: string[] = [];
    const queue = makePublicEmailRequestQueue({
      generateId: () => "01ARZ3NDEKTSV4RRFFQ69G5FAV" as never,
      send: async (body) => {
        sent.push(body);
      },
    });

    await queue({
      email: " USER@Example.com ",
      operation: "sign-up",
      sourcePrefixHash: "a".repeat(64),
    });

    expect(sent.map((body) => JSON.parse(body))).toEqual([
      {
        email: "user@example.com",
        operation: "sign-up",
        requestId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        schemaVersion: 1,
        sourcePrefixHash: "a".repeat(64),
      },
    ]);
  });

  test("passes stable request IDs into signup and recovery processing", async () => {
    const signUp = mock(async () => undefined);
    const forgotPassword = mock(async () => undefined);
    const process = makePublicEmailRequestProcessor({
      forgotPassword,
      signUp,
    } as unknown as IdentityApplication);

    expect(
      process({
        Records: [
          {
            body: JSON.stringify({
              email: "new@example.com",
              operation: "sign-up",
              requestId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
              schemaVersion: 1,
            }),
            messageId: "signup",
          },
          {
            body: JSON.stringify({
              email: "known@example.com",
              operation: "password-recovery",
              requestId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
              schemaVersion: 1,
            }),
            messageId: "recovery",
          },
        ],
      }),
    ).resolves.toEqual({ batchItemFailures: [] });
    expect(signUp).toHaveBeenCalledWith("new@example.com", undefined, "01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(forgotPassword).toHaveBeenCalledWith(
      "known@example.com",
      undefined,
      "01ARZ3NDEKTSV4RRFFQ69G5FAW",
    );
  });
});
