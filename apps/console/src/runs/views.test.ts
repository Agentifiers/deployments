import { describe, expect, test } from "bun:test";
import { approvalRequestSummary, formatByteSize, messageContent } from "./views.ts";

describe("approvalRequestSummary", () => {
  test("reads the worker's request shape", () => {
    expect(
      approvalRequestSummary({
        effect: "write",
        inputSummary: "Refund order 1042 for $40",
        requiredScopes: ["payments:write", "orders:read"],
        toolName: "issue_refund",
      }),
    ).toEqual({
      destinations: [],
      effect: "write",
      inputSummary: "Refund order 1042 for $40",
      requiredScopes: ["payments:write", "orders:read"],
      toolName: "issue_refund",
    });
  });

  test("leaves out missing, empty, and mistyped fields", () => {
    expect(
      approvalRequestSummary({
        effect: 3,
        inputSummary: "",
        requiredScopes: ["payments:write", 7, null],
        toolName: { name: "issue_refund" },
      }),
    ).toEqual({ destinations: [], requiredScopes: ["payments:write"] });
    expect(approvalRequestSummary({ requiredScopes: "payments:write" })).toEqual({
      destinations: [],
      requiredScopes: [],
    });
    expect(approvalRequestSummary({})).toEqual({ destinations: [], requiredScopes: [] });
  });

  test("keeps every data-boundary destination in full", () => {
    const url = `https://labs.example.org/results?patient=${"x".repeat(300)}`;
    expect(
      approvalRequestSummary({
        destinations: [url, "recipient +15551234567", 4],
        requiredScopes: [],
      }).destinations,
    ).toEqual([url, "recipient +15551234567"]);
  });
});

describe("messageContent", () => {
  test("an inline body is text", () => {
    expect(messageContent({ body: "Your refund is on its way." })).toEqual({
      kind: "text",
      text: "Your refund is on its way.",
    });
  });

  test("a body stored outside the message is a link with its size, type, and expiry", () => {
    expect(
      messageContent({
        bodyAccess: {
          byteSize: 400_000,
          contentType: "text/markdown",
          expiresAt: "2026-10-05T12:05:00.000Z",
          sha256: "ab12",
          url: "https://bodies.example/one?signature=x",
        },
      }),
    ).toEqual({
      byteSize: 400_000,
      contentType: "text/markdown",
      expiresAt: "2026-10-05T12:05:00.000Z",
      kind: "external",
      url: "https://bodies.example/one?signature=x",
    });
  });

  test("no body at all, or an empty one, is empty", () => {
    expect(messageContent({})).toEqual({ kind: "empty" });
    expect(messageContent({ body: "" })).toEqual({ kind: "empty" });
  });
});

describe("formatByteSize", () => {
  test("binary units with one decimal", () => {
    expect(formatByteSize(512)).toBe("512 B");
    expect(formatByteSize(262_144)).toBe("256.0 KiB");
    expect(formatByteSize(1_572_864)).toBe("1.5 MiB");
    expect(formatByteSize(3 * 1024 ** 3)).toBe("3.0 GiB");
  });
});
