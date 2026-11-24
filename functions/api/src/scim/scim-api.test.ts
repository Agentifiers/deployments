import { DirectoryContentionError } from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import { SCIM_BASE, scimHarness, type ScimReply } from "./scim-test-support.ts";

const ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";
const SCIM_JSON = "application/scim+json";
const ADA = {
  emails: [{ primary: true, value: "ada@acme.example" }],
  externalId: "00u1ada",
  userName: "ada@acme.example",
};

function scimError(status: number, detail: string, headers: Readonly<Record<string, string>> = {}) {
  return {
    body: { schemas: [ERROR_SCHEMA], status: String(status), detail },
    headers: { ...headers, "content-type": SCIM_JSON },
    status,
  };
}

function idOf(reply: ScimReply) {
  const { body } = reply;
  if (typeof body !== "object" || body === null || !("id" in body) || typeof body.id !== "string") {
    throw new Error(`Expected a SCIM resource, got ${JSON.stringify(body)}.`);
  }
  return body.id;
}

const unauthorized = scimError(401, "A valid directory bearer token is required.", {
  "www-authenticate": 'Bearer realm="scim"',
});

describe("SCIM route family", () => {
  test("leaves paths outside /scim/v2/ to the next family", async () => {
    const { api } = await scimHarness();

    expect(await api(new Request("https://api.example.test/v1/whoami"))).toBeUndefined();
    expect((await api(new Request("https://api.example.test/scim/v2/Users")))?.status).toBe(401);
  });

  test("answers 401 before reading the body", async () => {
    const { acmeToken, scim } = await scimHarness();
    const malformed = { body: "{not json", headers: { "content-type": "text/plain" } };

    expect(await scim(undefined, "POST", "/Users", malformed)).toEqual(unauthorized);
    expect(await scim("dpl_scim_not-a-real-token", "POST", "/Users", malformed)).toEqual(
      unauthorized,
    );
    expect(await scim(`${acmeToken}x`, "GET", "/Users")).toEqual(unauthorized);
    expect(await scim(acmeToken, "POST", "/Users", malformed)).toEqual(
      scimError(415, "Send the body as application/scim+json or application/json."),
    );
  });

  test("answers 429 with Retry-After once the organization exceeds its rate", async () => {
    const { acmeToken, rivalToken, scim } = await scimHarness({
      limits: {
        activeSandboxes: 8,
        apiRequestBurst: 2,
        apiRequestsPerSecond: 1,
        concurrentRuns: 8,
      },
    });

    const statuses = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      statuses.push((await scim(acmeToken, "GET", "/Users")).status);
    }
    expect(statuses).toEqual([200, 200, 429]);
    expect(await scim(acmeToken, "GET", "/Users")).toEqual(
      scimError(429, "This organization is limited to 1 requests per second with a burst of 2.", {
        "retry-after": "1",
      }),
    );
    expect((await scim(rivalToken, "GET", "/Users")).status).toBe(200);
  });

  test("accepts application/json and refuses other media types, oversized and malformed bodies", async () => {
    const { acmeToken, scim } = await scimHarness();
    const body = JSON.stringify(ADA);

    expect(
      (
        await scim(acmeToken, "POST", "/Users", {
          body,
          headers: { "content-type": "application/json" },
        })
      ).status,
    ).toBe(201);
    for (const contentType of ["text/xml", "constructor", undefined]) {
      expect(
        await scim(acmeToken, "POST", "/Users", {
          body,
          ...(contentType === undefined ? {} : { headers: { "content-type": contentType } }),
        }),
      ).toEqual(scimError(415, "Send the body as application/scim+json or application/json."));
    }
    expect(
      await scim(acmeToken, "POST", "/Users", {
        body: JSON.stringify({ ...ADA, padding: "x".repeat(64 * 1024) }),
        headers: { "content-type": "application/scim+json" },
      }),
    ).toEqual(scimError(413, "The request body exceeds 65536 bytes."));
    expect(
      await scim(acmeToken, "POST", "/Users", {
        body: "{not json",
        headers: { "content-type": "application/scim+json" },
      }),
    ).toEqual({
      body: {
        schemas: [ERROR_SCHEMA],
        status: "400",
        scimType: "invalidSyntax",
        detail: "The request body is not valid JSON.",
      },
      headers: { "content-type": SCIM_JSON },
      status: 400,
    });
  });

  test("tolerates a base URL configured with a trailing slash", async () => {
    const { acmeToken, scim } = await scimHarness();

    for (const path of ["//Users", "/Users/"]) {
      expect((await scim(acmeToken, "GET", path)).body).toMatchObject({ totalResults: 0 });
    }
  });

  test("scopes every user to the token's organization", async () => {
    const { acmeToken, rivalToken, scim, send } = await scimHarness();
    const id = idOf(await send(acmeToken, "POST", "/Users", ADA));
    const notFound = scimError(404, "User not found.");

    expect(await scim(rivalToken, "GET", `/Users/${id}`)).toEqual(notFound);
    expect(
      await send(rivalToken, "PATCH", `/Users/${id}`, {
        Operations: [{ op: "replace", value: { active: false } }],
      }),
    ).toEqual(notFound);
    expect(await scim(rivalToken, "DELETE", `/Users/${id}`)).toEqual(notFound);
    expect(
      (
        await scim(
          rivalToken,
          "GET",
          `/Users?filter=${encodeURIComponent('externalId eq "00u1ada"')}`,
        )
      ).body,
    ).toMatchObject({ totalResults: 0 });
    expect(await send(rivalToken, "POST", "/Users", ADA)).toEqual({
      body: {
        schemas: [ERROR_SCHEMA],
        status: "400",
        scimType: "invalidValue",
        detail: "The email domain is not a verified login domain of this organization.",
      },
      headers: { "content-type": SCIM_JSON },
      status: 400,
    });
    expect((await scim(acmeToken, "GET", `/Users/${id}`)).body).toMatchObject({ active: true, id });
  });

  test("answers contention with 503 and Retry-After", async () => {
    const contended = await scimHarness({
      users: (users) => ({
        ...users,
        create: async () => {
          throw new DirectoryContentionError();
        },
      }),
    });
    expect(await contended.send(contended.acmeToken, "POST", "/Users", ADA)).toEqual(
      scimError(503, "The user kept changing concurrently; retry the request.", {
        "retry-after": "1",
      }),
    );
  });

  test("protects an owner from deactivation and deletion", async () => {
    const { acmeToken, scim, send } = await scimHarness();
    const owner = idOf(await send(acmeToken, "POST", "/Users", { userName: "owner@acme.example" }));
    const protectedRole = scimError(
      403,
      "Owners and admins are managed in the console, not through SCIM.",
    );

    expect(
      await send(acmeToken, "PATCH", `/Users/${owner}`, {
        Operations: [{ op: "replace", path: "active", value: false }],
      }),
    ).toEqual(protectedRole);
    expect(await scim(acmeToken, "DELETE", `/Users/${owner}`)).toEqual(protectedRole);
  });

  test("describes itself at the request's origin", async () => {
    const { acmeToken, scim } = await scimHarness();

    expect((await scim(acmeToken, "GET", "/ServiceProviderConfig")).body).toMatchObject({
      meta: { location: `${SCIM_BASE}/ServiceProviderConfig` },
    });
    expect((await scim(acmeToken, "GET", "/ResourceTypes")).body).toMatchObject({
      totalResults: 1,
      Resources: [{ id: "User", meta: { location: `${SCIM_BASE}/ResourceTypes/User` } }],
    });
    expect(
      (await scim(acmeToken, "GET", "/Schemas/urn:ietf:params:scim:schemas:core:2.0:User")).body,
    ).toMatchObject({
      id: "urn:ietf:params:scim:schemas:core:2.0:User",
      meta: { location: `${SCIM_BASE}/Schemas/urn:ietf:params:scim:schemas:core:2.0:User` },
    });
    expect(
      await scim(acmeToken, "POST", "/ServiceProviderConfig", {
        body: "{}",
        headers: { "content-type": "application/json" },
      }),
    ).toEqual(scimError(405, "This resource accepts GET.", { allow: "GET" }));
  });

  test("lets a suspended organization's directory read and deprovision users but nothing else", async () => {
    const { acmeToken, advance, placeHold, releaseHold, rivalToken, scim, send } =
      await scimHarness();
    const ada = idOf(await send(acmeToken, "POST", "/Users", ADA));
    const grace = { userName: "grace@acme.example" };
    const suspended = scimError(
      403,
      "The organization is suspended: until every hold is released, the directory can read and deprovision users but not create or change them. Update your payment method.",
    );

    await placeHold("payment");
    advance(5_000);

    expect((await scim(acmeToken, "GET", `/Users/${ada}`)).body).toMatchObject({ active: true });
    expect(await send(acmeToken, "POST", "/Users", grace)).toEqual(suspended);
    expect(
      await send(acmeToken, "PATCH", `/Users/${ada}`, {
        Operations: [{ op: "replace", path: "displayName", value: "Ada L." }],
      }),
    ).toEqual(suspended);
    expect(
      (
        await send(acmeToken, "PATCH", `/Users/${ada}`, {
          Operations: [{ op: "replace", path: "active", value: false }],
        })
      ).body,
    ).toMatchObject({ active: false, id: ada });
    expect((await scim(acmeToken, "DELETE", `/Users/${ada}`)).status).toBe(204);
    expect(
      (await send(rivalToken, "POST", "/Users", { userName: "lin@rival.example" })).status,
    ).toBe(201);

    await releaseHold("payment");
    advance(5_000);

    expect((await send(acmeToken, "POST", "/Users", grace)).status).toBe(201);
  });
});
