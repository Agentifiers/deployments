import { CREDENTIAL_REFERENCE_OWNER_TYPES } from "@deployments-ai/api-contract/credential-references";
import { PublicId } from "@deployments-ai/api-contract/primitives";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { ownerRef, parseSecretSearch } from "./secret-state.ts";

const OWNER = Schema.decodeUnknownSync(PublicId)("01M4CGZA4N2G1B23FA73Y8FSZ4");

describe("ownerRef", () => {
  test("links each owner type to the screen that rotates its credential", () => {
    expect(
      CREDENTIAL_REFERENCE_OWNER_TYPES.map((ownerType) => [
        ownerType,
        ownerRef({ ownerId: OWNER, ownerType }),
      ]),
    ).toEqual([
      ["channel-binding", undefined],
      ["mcp-server", { kind: "mcpServer", mcpServerId: OWNER }],
      ["provider-application", { kind: "oauthApps" }],
      ["provider-connection", { connectionId: OWNER, kind: "connection" }],
      ["tool-adapter", { extensionId: OWNER, kind: "extension" }],
      ["webhook-endpoint", { kind: "webhook", webhookId: OWNER }],
    ]);
  });
});

describe("parseSecretSearch", () => {
  test("keeps a known owner type and drops anything else", () => {
    expect(parseSecretSearch({ owner: "webhook-endpoint" })).toEqual({ owner: "webhook-endpoint" });
    expect(parseSecretSearch({ owner: "vault" })).toEqual({});
    expect(parseSecretSearch({})).toEqual({});
  });
});
