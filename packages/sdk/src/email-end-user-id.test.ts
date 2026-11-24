import { describe, expect, it } from "bun:test";
import { emailEndUserId } from "./index.ts";

describe("emailEndUserId", () => {
  it("names an email correspondent by the canonical subject the erasure API expects", () => {
    expect(emailEndUserId(" Alice@Example.com ")).toBe("channel:email:-:alice%40example.com");
    expect(emailEndUserId("bob+billing@example.com")).toBe(
      "channel:email:-:bob%2Bbilling%40example.com",
    );
  });
});
