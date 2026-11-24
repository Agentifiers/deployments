import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { makeUnionRecordSchema, recordDataFields } from "./record-schema.ts";

const ConnectionRecord = makeUnionRecordSchema("test-connection", [
  Schema.Struct({
    clientId: Schema.String,
    id: Schema.String,
    protocol: Schema.optional(Schema.Literal("oidc")),
  }),
  Schema.Struct({ entityId: Schema.String, id: Schema.String, protocol: Schema.Literal("saml") }),
]);
const decode = Schema.decodeUnknownSync(ConnectionRecord, { onExcessProperty: "error" });
const envelope = { itemType: "test-connection", pk: "ORG#1", sk: "CONNECTION#1" } as const;

describe("makeUnionRecordSchema", () => {
  test("decodes a row of either arm", () => {
    const oidc = { ...envelope, data: { clientId: "client", id: "c1" } };
    const saml = {
      ...envelope,
      data: { entityId: "urn:idp", id: "c1", protocol: "saml" },
    } as const;

    expect(decode(oidc)).toEqual(oidc);
    expect(decode(saml)).toEqual(saml);
  });

  test("rejects a row that mixes the fields of both arms", () => {
    expect(() =>
      decode({
        ...envelope,
        data: { clientId: "client", entityId: "urn:idp", id: "c1", protocol: "saml" },
      }),
    ).toThrow();
  });

  test("rejects an empty partition key like every record envelope", () => {
    expect(() => decode({ ...envelope, data: { clientId: "client", id: "c1" }, pk: " " })).toThrow(
      "Record keys must be non-empty",
    );
  });

  test("reports a data field only when every arm declares it", () => {
    expect(recordDataFields(ConnectionRecord)).toEqual(["id", "protocol"]);
  });
});
