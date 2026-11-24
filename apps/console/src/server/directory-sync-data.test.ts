import { expect, test } from "bun:test";
import { createDirectoryToken } from "./directory-sync-actions.ts";
import { loadDirectory } from "./directory-sync-data.ts";
import { createPlatformApiClient } from "./platform-api.ts";

const scope = { organizationId: "01K000000000000000000000G1" };

function platform(respond: (request: Request) => Response) {
  const sent: { readonly method: string; readonly path: string }[] = [];
  const client = createPlatformApiClient({
    baseUrl: "https://api.example.test",
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      sent.push({ method: request.method, path: new URL(request.url).pathname });
      return respond(request);
    }) as typeof globalThis.fetch,
  });
  return { client, sent };
}

test("an organization without directory sync loads as null", async () => {
  const { client, sent } = platform(() =>
    Response.json(
      {
        code: "directory_not_configured",
        detail: "Directory sync is not configured for this organization.",
        status: 404,
        title: "Not Found",
      },
      { status: 404 },
    ),
  );
  expect(await loadDirectory("token", scope, client)).toBeNull();
  expect(sent).toEqual([{ method: "GET", path: "/v1/directory" }]);
});

test("a created token keeps its secret apart from the token it describes", async () => {
  const token = {
    createdAt: "2026-10-09T12:00:00.000Z",
    createdBy: "01K000000000000000000000M1",
    id: "01K000000000000000000000T1",
    tokenPrefix: "dpl_scim_AAAAAAA",
  };
  const { client, sent } = platform(() =>
    Response.json(
      {
        directory: {
          createdAt: "2026-10-09T12:00:00.000Z",
          defaultRole: "member",
          scimBaseUrl: "https://api.example.test/scim/v2",
          tokens: [token],
          updatedAt: "2026-10-09T12:00:00.000Z",
        },
        token: { ...token, secret: "dpl_scim_AAAAAAAsecret" },
      },
      { status: 201 },
    ),
  );
  expect<unknown>(
    await createDirectoryToken({ accessToken: "token", idempotencyKey: "key-1", scope }, client),
  ).toEqual({ secret: "dpl_scim_AAAAAAAsecret", view: token });
  expect(sent).toEqual([{ method: "POST", path: "/v1/directory/tokens" }]);
});
