import { describe, expect, test } from "bun:test";
import { NOW, SCIM_BASE, scimHarness, type ScimReply } from "./scim-test-support.ts";

const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";
const PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const SCIM_JSON = "application/scim+json";

function idOf(reply: ScimReply) {
  const { body } = reply;
  if (typeof body !== "object" || body === null || !("id" in body) || typeof body.id !== "string") {
    throw new Error(`Expected a SCIM resource, got ${JSON.stringify(body)}.`);
  }
  return body.id;
}

function list(...resources: unknown[]) {
  return {
    schemas: [LIST_SCHEMA],
    totalResults: resources.length,
    startIndex: 1,
    itemsPerPage: resources.length,
    Resources: resources,
  };
}

const notFound = {
  body: { schemas: [ERROR_SCHEMA], status: "404", detail: "User not found." },
  headers: { "content-type": SCIM_JSON },
  status: 404,
};

describe("SCIM provisioning replayed from Okta", () => {
  test("creates, finds, deactivates, updates, reactivates and deletes a user", async () => {
    const { acmeToken, scim, send } = await scimHarness();
    const lookup = `/Users?filter=${encodeURIComponent('userName eq "ada@acme.example"')}&startIndex=1&count=100`;
    const created = {
      schemas: [USER_SCHEMA],
      userName: "ada@acme.example",
      name: { givenName: "Ada", familyName: "Lovelace" },
      emails: [{ primary: true, value: "ada@acme.example", type: "work" }],
      displayName: "Ada Lovelace",
      locale: "en-US",
      externalId: "00u1ada",
      groups: [],
      password: "t1meMa$heen",
      active: true,
    };

    expect(await scim(acmeToken, "GET", lookup)).toEqual({
      body: list(),
      headers: { "content-type": SCIM_JSON },
      status: 200,
    });

    const posted = await send(acmeToken, "POST", "/Users", created);
    const id = idOf(posted);
    const ada = (changes: { readonly active: boolean; readonly displayName: string }) => ({
      schemas: [USER_SCHEMA],
      id,
      externalId: "00u1ada",
      userName: "ada@acme.example",
      displayName: changes.displayName,
      name: { formatted: changes.displayName },
      emails: [{ value: "ada@acme.example", primary: true, type: "work" }],
      active: changes.active,
      meta: {
        resourceType: "User",
        created: NOW,
        lastModified: NOW,
        location: `${SCIM_BASE}/Users/${id}`,
      },
    });
    expect(posted).toEqual({
      body: ada({ active: true, displayName: "Ada Lovelace" }),
      headers: { "content-type": SCIM_JSON, location: `${SCIM_BASE}/Users/${id}` },
      status: 201,
    });

    expect(await send(acmeToken, "POST", "/Users", created)).toEqual({
      body: {
        schemas: [ERROR_SCHEMA],
        status: "409",
        scimType: "uniqueness",
        detail: "A user with this userName or email address already exists in this organization.",
      },
      headers: { "content-type": SCIM_JSON },
      status: 409,
    });

    expect((await scim(acmeToken, "GET", lookup)).body).toEqual(
      list(ada({ active: true, displayName: "Ada Lovelace" })),
    );

    const deactivated = await send(acmeToken, "PATCH", `/Users/${id}`, {
      schemas: [PATCH_SCHEMA],
      Operations: [{ op: "replace", value: { active: false } }],
    });
    expect([deactivated.status, deactivated.body]).toEqual([
      200,
      ada({ active: false, displayName: "Ada Lovelace" }),
    ]);

    const replaced = await send(acmeToken, "PUT", `/Users/${id}`, {
      ...created,
      id,
      name: { givenName: "Ada", familyName: "King" },
      displayName: "Ada King",
      active: false,
    });
    expect([replaced.status, replaced.body]).toEqual([
      200,
      ada({ active: false, displayName: "Ada King" }),
    ]);

    const reactivated = await send(acmeToken, "PATCH", `/Users/${id}`, {
      schemas: [PATCH_SCHEMA],
      Operations: [{ op: "replace", value: { active: true } }],
    });
    expect([reactivated.status, reactivated.body]).toEqual([
      200,
      ada({ active: true, displayName: "Ada King" }),
    ]);

    expect(await scim(acmeToken, "DELETE", `/Users/${id}`)).toEqual({
      body: undefined,
      headers: {},
      status: 204,
    });
    expect(await scim(acmeToken, "GET", `/Users/${id}`)).toEqual(notFound);
    expect((await scim(acmeToken, "GET", lookup)).body).toEqual(list());
  });
});

describe("SCIM never changes a primary email", () => {
  const ada = {
    schemas: [USER_SCHEMA],
    userName: "ada@acme.example",
    emails: [{ primary: true, value: "ada@acme.example", type: "work" }],
    displayName: "Ada Lovelace",
    externalId: "00u1ada",
    active: true,
  };
  const stored = (id: string, active: boolean) => ({
    schemas: [USER_SCHEMA],
    id,
    externalId: "00u1ada",
    userName: "ada@acme.example",
    displayName: "Ada Lovelace",
    name: { formatted: "Ada Lovelace" },
    emails: [{ value: "ada@acme.example", primary: true, type: "work" }],
    active,
    meta: {
      resourceType: "User",
      created: NOW,
      lastModified: NOW,
      location: `${SCIM_BASE}/Users/${id}`,
    },
  });

  test("an Okta PUT that deactivates with a renamed mailbox removes the membership", async () => {
    const { acmeToken, scim, send } = await scimHarness();
    const id = idOf(await send(acmeToken, "POST", "/Users", ada));

    const replaced = await send(acmeToken, "PUT", `/Users/${id}`, {
      ...ada,
      id,
      emails: [{ primary: true, value: "former-ada@acme.example", type: "work" }],
      active: false,
    });

    expect([replaced.status, replaced.body]).toEqual([200, stored(id, false)]);
    expect((await scim(acmeToken, "GET", `/Users/${id}`)).body).toEqual(stored(id, false));
  });

  test("a PATCH that changes only the email returns the user unchanged and writes nothing", async () => {
    const { acmeToken, fake, send } = await scimHarness();
    const id = idOf(await send(acmeToken, "POST", "/Users", ada));
    const writes = fake.transactions.length;

    const patched = await send(acmeToken, "PATCH", `/Users/${id}`, {
      schemas: [PATCH_SCHEMA],
      Operations: [
        { op: "Replace", path: 'emails[type eq "work"].value', value: "former-ada@acme.example" },
      ],
    });

    expect([patched.status, patched.body]).toEqual([200, stored(id, true)]);
    expect(fake.transactions.length).toBe(writes);
  });
});

describe("SCIM provisioning replayed from Microsoft Entra ID", () => {
  test("creates, matches by externalId, patches with paths and string booleans, then deletes", async () => {
    const { acmeToken, scim, send } = await scimHarness();
    const externalId = "0a21f0f2-8d2a-4f8e-bf98-7363c4aed4ef";

    expect(
      (await scim(acmeToken, "GET", `/Users?filter=${encodeURIComponent('userName eq "ghopper"')}`))
        .body,
    ).toEqual(list());

    const posted = await send(acmeToken, "POST", "/Users", {
      schemas: [USER_SCHEMA, "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User"],
      externalId,
      userName: "ghopper",
      active: true,
      emails: [{ primary: true, type: "work", value: "Grace@Acme.Example" }],
      meta: { resourceType: "User" },
      name: { formatted: "Grace Hopper", familyName: "Hopper", givenName: "Grace" },
      roles: [],
      "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User": { department: "Navy" },
    });
    const id = idOf(posted);
    const grace = (changes: {
      readonly active: boolean;
      readonly displayName: string;
      readonly externalId?: string;
    }) => ({
      schemas: [USER_SCHEMA],
      id,
      ...(changes.externalId === undefined ? {} : { externalId: changes.externalId }),
      userName: "ghopper",
      displayName: changes.displayName,
      name: { formatted: changes.displayName },
      emails: [{ value: "grace@acme.example", primary: true, type: "work" }],
      active: changes.active,
      meta: {
        resourceType: "User",
        created: NOW,
        lastModified: NOW,
        location: `${SCIM_BASE}/Users/${id}`,
      },
    });
    expect([posted.status, posted.body]).toEqual([
      201,
      grace({ active: true, displayName: "Grace Hopper", externalId }),
    ]);

    expect(
      (
        await scim(
          acmeToken,
          "GET",
          `/Users?filter=${encodeURIComponent(`externalId eq "${externalId}"`)}`,
        )
      ).body,
    ).toEqual(list(grace({ active: true, displayName: "Grace Hopper", externalId })));

    const disabled = await send(acmeToken, "PATCH", `/Users/${id}`, {
      schemas: [PATCH_SCHEMA],
      Operations: [{ op: "Replace", path: "active", value: "False" }],
    });
    expect([disabled.status, disabled.body]).toEqual([
      200,
      grace({ active: false, displayName: "Grace Hopper", externalId }),
    ]);

    const updated = await send(acmeToken, "PATCH", `/Users/${id}`, {
      schemas: [PATCH_SCHEMA],
      Operations: [
        { op: "Add", path: "displayName", value: "Rear Admiral Hopper" },
        { op: "Replace", path: 'emails[type eq "work"].value', value: "grace@acme.example" },
        { op: "Replace", path: "name.familyName", value: "Hopper" },
        {
          op: "Replace",
          path: "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department",
          value: "Fleet",
        },
        { op: "Remove", path: "externalId" },
      ],
    });
    expect([updated.status, updated.body]).toEqual([
      200,
      grace({ active: false, displayName: "Rear Admiral Hopper" }),
    ]);

    const renamedMailbox = await send(acmeToken, "PATCH", `/Users/${id}`, {
      schemas: [PATCH_SCHEMA],
      Operations: [
        {
          op: "Replace",
          path: 'emails[type eq "work"].value',
          value: "amazing.grace@acme.example",
        },
      ],
    });
    expect([renamedMailbox.status, renamedMailbox.body]).toEqual([
      200,
      grace({ active: false, displayName: "Rear Admiral Hopper" }),
    ]);

    const enabled = await send(acmeToken, "PATCH", `/Users/${id}`, {
      schemas: [PATCH_SCHEMA],
      Operations: [{ op: "Replace", path: "active", value: "True" }],
    });
    expect([enabled.status, enabled.body]).toEqual([
      200,
      grace({ active: true, displayName: "Rear Admiral Hopper" }),
    ]);

    expect((await scim(acmeToken, "DELETE", `/Users/${id}`)).status).toBe(204);
    expect(await scim(acmeToken, "GET", `/Users/${id}`)).toEqual(notFound);
  });
});
