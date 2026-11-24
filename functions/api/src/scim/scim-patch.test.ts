import { Ulid } from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { ScimError, type ScimType } from "./scim-error.ts";
import { parseScimRequest } from "./scim-request.ts";

const USER_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FC0");
const PATCH_OP = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

function patch(...operations: unknown[]) {
  return parseScimRequest({
    body: { Operations: operations, schemas: [PATCH_OP] },
    method: "PATCH",
    query: new URLSearchParams(),
    segments: ["Users", USER_ID],
  });
}

describe("parseScimRequest PATCH", () => {
  test.each([
    ["Okta deactivation", [{ op: "replace", value: { active: false } }], { active: false }],
    ["Okta reactivation", [{ op: "replace", value: { active: true } }], { active: true }],
    [
      "Okta value object with name and emails",
      [
        {
          op: "replace",
          value: {
            emails: [{ primary: true, value: "Ada@Acme.Example" }],
            id: USER_ID,
            name: { familyName: "King", givenName: "Ada" },
          },
        },
      ],
      { displayName: "Ada King" },
    ],
    ["Entra deactivation", [{ op: "Replace", path: "active", value: "False" }], { active: false }],
    ["Entra reactivation", [{ op: "Replace", path: "active", value: "True" }], { active: true }],
    [
      "Entra attribute updates",
      [
        { op: "Add", path: "displayName", value: "Grace Hopper" },
        { op: "Replace", path: 'emails[type eq "work"].value', value: "Grace@Acme.Example" },
        { op: "Replace", path: "name.familyName", value: "Hopper" },
        { op: "Replace", path: "externalId", value: "0a21f0f2" },
        { op: "Replace", path: "userName", value: "ghopper" },
        {
          op: "Replace",
          path: "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department",
          value: "Navy",
        },
        { op: "Add", path: 'phoneNumbers[type eq "mobile"].value', value: "+15555550100" },
        { op: "Replace", path: "title", value: "Rear Admiral" },
      ],
      {
        displayName: "Grace Hopper",
        externalId: "0a21f0f2",
        userName: "ghopper",
      },
    ],
    [
      "Entra value object keyed by paths",
      [
        {
          op: "Add",
          value: {
            "name.formatted": "Grace Hopper",
            "name.givenName": "Grace",
            "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:manager": { value: "x" },
          },
        },
      ],
      { displayName: "Grace Hopper" },
    ],
    [
      "the core schema URN on a path",
      [
        {
          op: "replace",
          path: "urn:ietf:params:scim:schemas:core:2.0:User:userName",
          value: "ada",
        },
      ],
      { userName: "ada" },
    ],
    [
      "the email paths are ignored",
      [
        { op: "replace", path: "emails[primary eq true].value", value: "ada@acme.example" },
        { op: "replace", path: 'emails[type eq "work"].value', value: "not-an-address" },
        { op: "remove", path: "emails" },
      ],
      {},
    ],
    ["remove externalId", [{ op: "Remove", path: "externalId" }], { externalId: null }],
    [
      "replace externalId with null",
      [{ op: "replace", path: "externalId", value: null }],
      { externalId: null },
    ],
    ["remove displayName keeps it", [{ op: "remove", path: "displayName" }], {}],
    [
      "later operations override earlier ones",
      [
        { op: "replace", path: "active", value: false },
        { op: "Remove", path: "externalId" },
        { op: "add", path: "externalId", value: "00u2" },
        { op: "replace", path: "active", value: "true" },
      ],
      { active: true, externalId: "00u2" },
    ],
    ["no operations", [], {}],
    [
      "a path named after an object prototype key",
      [{ op: "replace", path: "constructor", value: 1 }],
      {},
    ],
  ])("%s", (_case, operations, change) => {
    expect(patch(...operations)).toEqual({ change, id: USER_ID, kind: "change" });
  });

  test.each([
    'emails[type eq "work"',
    "name..formatted",
    "",
    "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:",
  ])("refuses the path %p as invalidPath", (path) => {
    expect(patch({ op: "replace", path, value: "x" })).toEqual(
      new ScimError({
        detail: `The path "${path}" is not a valid attribute path.`,
        scimType: "invalidPath",
        status: 400,
      }),
    );
  });

  const refusals: readonly [unknown, ScimType, string][] = [
    [
      { op: "replace", path: "active", value: "maybe" },
      "invalidValue",
      "active must be true or false.",
    ],
    [
      { op: "replace", path: "userName", value: "" },
      "invalidValue",
      "userName must be a non-empty string of at most 256 characters.",
    ],
    [
      { op: "replace", value: false },
      "invalidValue",
      "An operation without a path needs an object value.",
    ],
    [{ op: "remove", path: "active" }, "mutability", 'The path "active" cannot be removed.'],
    [{ op: "remove", path: "userName" }, "mutability", 'The path "userName" cannot be removed.'],
    [{ op: "remove" }, "noTarget", "A remove operation needs a path."],
    [
      { op: "move", path: "active", value: true },
      "invalidSyntax",
      'Each operation needs an op of "add", "replace" or "remove".',
    ],
    [
      { op: "constructor", path: "active", value: false },
      "invalidSyntax",
      'Each operation needs an op of "add", "replace" or "remove".',
    ],
  ];
  test.each(refusals)("refuses %j", (operation, scimType, detail) => {
    expect(patch(operation)).toEqual(new ScimError({ detail, scimType, status: 400 }));
  });

  test("refuses a body without Operations", () => {
    expect(
      parseScimRequest({
        body: { schemas: [PATCH_OP] },
        method: "PATCH",
        query: new URLSearchParams(),
        segments: ["Users", USER_ID],
      }),
    ).toEqual(
      new ScimError({
        detail: "A PatchOp body needs an Operations array.",
        scimType: "invalidSyntax",
        status: 400,
      }),
    );
  });
});
