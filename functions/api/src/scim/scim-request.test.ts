import { Ulid, type DirectoryUserQuery } from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { ScimError } from "./scim-error.ts";
import { parseScimRequest, type ScimCommand } from "./scim-request.ts";

const USER_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FC0");

function list(query: string) {
  return parseScimRequest({
    body: undefined,
    method: "GET",
    query: new URLSearchParams(query),
    segments: ["Users"],
  });
}

function send(method: "POST" | "PUT", body: unknown) {
  return parseScimRequest({
    body,
    method,
    query: new URLSearchParams(),
    segments: method === "POST" ? ["Users"] : ["Users", USER_ID],
  });
}

const invalidFilter = new ScimError({
  detail: 'Only filters of the form userName eq "…" or externalId eq "…" are supported.',
  scimType: "invalidFilter",
  status: 400,
});

describe("parseScimRequest list queries", () => {
  const filters: readonly [string, NonNullable<DirectoryUserQuery["filter"]>][] = [
    ['filter=userName eq "ada@acme.example"', { attribute: "userName", value: "ada@acme.example" }],
    ['filter=USERNAME EQ "Ada@Acme.Example"', { attribute: "userName", value: "Ada@Acme.Example" }],
    ['filter=externalId eq "00u1ada"', { attribute: "externalId", value: "00u1ada" }],
    ['filter=externalid Eq "with \\"quote\\""', { attribute: "externalId", value: 'with "quote"' }],
  ];
  test.each(filters)("%s", (query, filter) => {
    expect(list(query)).toEqual({
      kind: "list",
      query: { count: 100, filter, startIndex: 1 },
    });
  });

  test.each([
    'filter=displayName eq "Ada"',
    'filter=userName ne "ada@acme.example"',
    'filter=userName eq "ada@acme.example" and active eq true',
    "filter=userName eq ada@acme.example",
    'filter=userName sw "ada"',
    'filter=externalId eq "bad \\x escape"',
    'filter=constructor eq "ext-1"',
  ])("refuses %s as invalidFilter", (query) => {
    expect(list(query)).toEqual(invalidFilter);
  });

  test.each([
    ["", { count: 100, startIndex: 1 }],
    ["startIndex=3&count=2", { count: 2, startIndex: 3 }],
    ["startIndex=0&count=-5", { count: 0, startIndex: 1 }],
    ["startIndex=-4&count=500", { count: 100, startIndex: 1 }],
    ["count=0", { count: 0, startIndex: 1 }],
  ])("pages %p", (query, expected) => {
    expect(list(query)).toEqual({ kind: "list", query: expected });
  });

  test("refuses a count that is not an integer", () => {
    expect(list("count=ten")).toEqual(
      new ScimError({ detail: "count must be an integer.", scimType: "invalidValue", status: 400 }),
    );
  });
});

describe("parseScimRequest User bodies", () => {
  test("reads Okta's create with the primary email and name parts", () => {
    expect(
      send("POST", {
        active: true,
        emails: [
          { primary: false, type: "home", value: "ada@home.example" },
          { primary: true, type: "work", value: "Ada@Acme.Example" },
        ],
        externalId: "00u1ada",
        groups: [],
        locale: "en-US",
        name: { familyName: "Lovelace", givenName: "Ada" },
        password: "ignored",
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
        userName: "ada@acme.example",
      }),
    ).toEqual({
      kind: "create",
      user: {
        active: true,
        displayName: "Ada Lovelace",
        email: "ada@acme.example",
        externalId: "00u1ada",
        userName: "ada@acme.example",
      },
    });
  });

  test("reads Entra's create with a non-email userName and name.formatted", () => {
    expect(
      send("POST", {
        active: true,
        emails: [{ primary: true, type: "work", value: "grace@acme.example" }],
        externalId: "0a21f0f2-8d2a-4f8e-bf98-7363c4aed4ef",
        meta: { resourceType: "User" },
        name: { familyName: "Hopper", formatted: "Grace B. Hopper", givenName: "Grace" },
        roles: [],
        schemas: [
          "urn:ietf:params:scim:schemas:core:2.0:User",
          "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User",
        ],
        "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User": { department: "Navy" },
        userName: "ghopper",
      }),
    ).toEqual({
      kind: "create",
      user: {
        active: true,
        displayName: "Grace B. Hopper",
        email: "grace@acme.example",
        externalId: "0a21f0f2-8d2a-4f8e-bf98-7363c4aed4ef",
        userName: "ghopper",
      },
    });
  });

  test.each([
    [
      "the work address without a primary",
      [
        { type: "home", value: "ada@home.example" },
        { type: "Work", value: "ada@acme.example" },
      ],
      "ada@acme.example",
    ],
    [
      "the first address without primary or work",
      [
        { type: "home", value: "ada@home.example" },
        { type: "other", value: "ada@other.example" },
      ],
      "ada@home.example",
    ],
    [
      "a string primary flag",
      [{ value: "x@b.example" }, { primary: "True", value: "Y@B.example" }],
      "y@b.example",
    ],
    ["the userName when emails is absent", undefined, "ada@acme.example"],
  ])("chooses %s", (_case, emails, email) => {
    expect(send("POST", { emails, userName: "Ada@Acme.Example" })).toEqual({
      kind: "create",
      user: { active: true, email, userName: "Ada@Acme.Example" },
    });
  });

  test.each([
    [
      { userName: "ghopper" },
      "A user needs an email address in emails, or a userName that is one.",
    ],
    [
      { emails: [{ value: "not-an-address" }], userName: "ada@acme.example" },
      "An email value must be an email address.",
    ],
    [{ emails: "ada@acme.example", userName: "ada@acme.example" }, "emails must be an array."],
    [{ userName: "" }, "userName must be a non-empty string of at most 256 characters."],
    [
      { externalId: "x".repeat(257), userName: "ada@acme.example" },
      "externalId must be a non-empty string of at most 256 characters.",
    ],
    [{ active: "yes", userName: "ada@acme.example" }, "active must be true or false."],
  ])("refuses %j as invalidValue", (body, detail) => {
    expect(send("POST", body)).toEqual(
      new ScimError({ detail, scimType: "invalidValue", status: 400 }),
    );
  });

  test("refuses a body that is not an object as invalidSyntax", () => {
    expect(send("POST", ["ada@acme.example"])).toEqual(
      new ScimError({
        detail: "The request body must be a User object.",
        scimType: "invalidSyntax",
        status: 400,
      }),
    );
  });

  test("reads a PUT as a replacement that ignores emails, clears an absent externalId and keeps an absent active", () => {
    expect(
      send("PUT", {
        emails: [{ primary: true, value: "ada@acme.example" }],
        name: { formatted: "Ada King" },
        userName: "ada.king@acme.example",
      }),
    ).toEqual({
      change: {
        displayName: "Ada King",
        externalId: null,
        userName: "ada.king@acme.example",
      },
      id: USER_ID,
      kind: "change",
    });
    expect(send("PUT", { active: false, externalId: "00u1ada", userName: "ghopper" })).toEqual({
      change: { active: false, externalId: "00u1ada", userName: "ghopper" },
      id: USER_ID,
      kind: "change",
    });
  });
});

describe("parseScimRequest routing", () => {
  const route = (method: string, ...segments: string[]) =>
    parseScimRequest({ body: undefined, method, query: new URLSearchParams(), segments });

  const routes: readonly [readonly string[], ScimCommand][] = [
    [["GET", "Users", USER_ID], { id: USER_ID, kind: "get" }],
    [["DELETE", "Users", USER_ID], { id: USER_ID, kind: "delete" }],
    [["GET", "ServiceProviderConfig"], { document: "service-provider-config", kind: "discovery" }],
    [["GET", "ResourceTypes"], { document: "resource-types", kind: "discovery" }],
    [["GET", "ResourceTypes", "User"], { document: "user-resource-type", kind: "discovery" }],
    [["GET", "Schemas"], { document: "schemas", kind: "discovery" }],
    [
      ["GET", "Schemas", "urn%3Aietf%3Aparams%3Ascim%3Aschemas%3Acore%3A2.0%3AUser"],
      { document: "user-schema", kind: "discovery" },
    ],
  ];
  test.each(routes)("%j", ([method = "", ...segments], expected) => {
    expect(route(method, ...segments)).toEqual(expected);
  });

  test.each([
    [["GET", "Groups"], 404, "No SCIM resource lives at this path."],
    [["GET", "Users", USER_ID, "extra"], 404, "No SCIM resource lives at this path."],
    [["GET", "Users", "not-a-ulid"], 404, "User not found."],
    [
      ["GET", "Schemas", "urn:ietf:params:scim:schemas:core:2.0:Group"],
      404,
      "No SCIM resource lives at this path.",
    ],
    [["GET", "Users", "%E0%A4%A"], 404, "No SCIM resource lives at this path."],
  ])("answers %j with %i", ([method = "", ...segments], status, detail) => {
    expect(route(method, ...segments)).toEqual(new ScimError({ detail, status }));
  });

  test("answers an unsupported method with 405 and the allowed methods", () => {
    expect(route("DELETE", "Users")).toEqual(
      new ScimError({
        detail: "This resource accepts GET, POST.",
        headers: { allow: "GET, POST" },
        status: 405,
      }),
    );
  });
});
