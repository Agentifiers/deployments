import { describe, expect, test } from "bun:test";
import {
  reconcileSlackUserGroup,
  slackUserGroupClient,
  type SlackUserGroup,
} from "./user-groups.ts";

function group(overrides: Partial<SlackUserGroup> = {}): SlackUserGroup {
  return {
    description: "Routes mentions to the release agent.",
    handle: "release-agent",
    id: "S123ABC",
    name: "Release Agent",
    status: "active",
    ...overrides,
  };
}

function apiGroup(overrides: Partial<SlackUserGroup> = {}) {
  const { userIds = [], ...value } = group(overrides);
  return { ...value, users: userIds };
}

function requestUrl(input: string | URL | Request): string {
  return input instanceof Request ? input.url : String(input);
}

function jsonBody(body: RequestInit["body"]): unknown {
  if (typeof body !== "string") throw new Error("Expected a JSON string request body.");
  return JSON.parse(body) as unknown;
}

describe("Slack user-group lifecycle", () => {
  test("creates a user group and reconciles it only after its Slack ID is pinned", async () => {
    const calls: { body?: unknown; method: string; url: string }[] = [];
    const client = slackUserGroupClient({
      fetch: async (input, init) => {
        const url = requestUrl(input);
        calls.push({
          ...(init?.body ? { body: jsonBody(init.body) } : {}),
          method: init?.method ?? "GET",
          url,
        });
        if (url.endsWith("usergroups.create")) {
          return Response.json({ ok: true, usergroup: group() });
        }
        if (url.endsWith("usergroups.disable")) {
          return Response.json({
            ok: true,
            usergroup: group({ status: "disabled" }),
          });
        }
        throw new Error(`Unexpected Slack request ${url}`);
      },
      token: "xoxb-secret",
    });

    const desired = {
      description: "Routes mentions to the release agent.",
      handle: "release-agent",
      name: "Release Agent",
      status: "active" as const,
    };
    const created = await client.create(desired);
    expect(created.id).toBe("S123ABC");
    const result = await reconcileSlackUserGroup({
      client: {
        ...client,
        list: async () => [created],
      },
      desired: { ...desired, status: "disabled" },
      userGroupId: created.id,
    });

    expect(result).toEqual({
      actions: ["disabled"],
      userGroup: group({ status: "disabled" }),
    });
    expect(calls).toEqual([
      {
        body: {
          description: "Routes mentions to the release agent.",
          handle: "release-agent",
          name: "Release Agent",
        },
        method: "POST",
        url: "https://slack.com/api/usergroups.create",
      },
      {
        body: { usergroup: "S123ABC" },
        method: "POST",
        url: "https://slack.com/api/usergroups.disable",
      },
    ]);
  });

  test("updates and enables a known disabled user group", async () => {
    const methods: string[] = [];
    const client = slackUserGroupClient({
      fetch: async (input, init) => {
        const method = new URL(requestUrl(input)).pathname.split("/").at(-1)!;
        methods.push(method);
        if (method === "usergroups.list") {
          return Response.json({
            ok: true,
            usergroups: [
              apiGroup({
                description: "Old description",
                name: "Old Release Agent",
                status: "disabled",
              }),
            ],
          });
        }
        if (method === "usergroups.enable") {
          return Response.json({ ok: true, usergroup: group({ description: "New description" }) });
        }
        if (method === "usergroups.update") {
          expect(jsonBody(init?.body)).toEqual({
            description: "New description",
            handle: "release-agent",
            name: "Release Agent",
            usergroup: "S123ABC",
          });
          return Response.json({
            ok: true,
            usergroup: group({ description: "New description", status: "disabled" }),
          });
        }
        throw new Error(`Unexpected Slack request ${requestUrl(input)}`);
      },
      token: "xoxb-secret",
    });

    const result = await reconcileSlackUserGroup({
      client,
      desired: {
        description: "New description",
        handle: "release-agent",
        name: "Release Agent",
        status: "active",
      },
      userGroupId: "S123ABC",
    });

    expect(methods).toEqual(["usergroups.list", "usergroups.update", "usergroups.enable"]);
    expect(result.actions).toEqual(["updated", "enabled"]);
    expect(result.userGroup).toEqual(group({ description: "New description" }));
  });

  test("does not enable a disabled group when its update fails", async () => {
    const methods: string[] = [];
    const client = slackUserGroupClient({
      fetch: async (input) => {
        const method = new URL(requestUrl(input)).pathname.split("/").at(-1)!;
        methods.push(method);
        if (method === "usergroups.list") {
          return Response.json({
            ok: true,
            usergroups: [apiGroup({ name: "Old Release Agent", status: "disabled" })],
          });
        }
        if (method === "usergroups.update") {
          return Response.json({ error: "invalid_name", ok: false });
        }
        throw new Error(`Unexpected Slack request ${requestUrl(input)}`);
      },
      token: "xoxb-secret",
    });

    expect(
      reconcileSlackUserGroup({
        client,
        desired: {
          description: "Routes mentions to the release agent.",
          handle: "release-agent",
          name: "Release Agent",
          status: "active",
        },
        userGroupId: "S123ABC",
      }),
    ).rejects.toThrow("invalid_name");
    expect(methods).toEqual(["usergroups.list", "usergroups.update"]);
  });

  test("does not mutate an already reconciled user group", async () => {
    let requests = 0;
    const client = slackUserGroupClient({
      fetch: async () => {
        requests += 1;
        return Response.json({ ok: true, usergroups: [apiGroup()] });
      },
      token: "xoxb-secret",
    });

    const result = await reconcileSlackUserGroup({
      client,
      desired: {
        description: "Routes mentions to the release agent.",
        handle: "release-agent",
        name: "Release Agent",
        status: "active",
      },
      userGroupId: "S123ABC",
    });

    expect(requests).toBe(1);
    expect(result.actions).toEqual([]);
  });

  test("requests and validates user-group membership when listing", async () => {
    let requestedUrl = "";
    const client = slackUserGroupClient({
      fetch: async (input) => {
        requestedUrl = requestUrl(input);
        return Response.json({ ok: true, usergroups: [group()] });
      },
      token: "xoxb-secret",
    });
    expect(client.list("T123ABC")).rejects.toThrow("must include users");
    expect(new URL(requestedUrl).searchParams.get("include_users")).toBe("true");

    const listed = await slackUserGroupClient({
      fetch: async () =>
        Response.json({
          ok: true,
          usergroups: [apiGroup({ userIds: ["U123ABC", "W456DEF"] })],
        }),
      token: "xoxb-secret",
    }).list("T123ABC");
    expect(listed[0]?.userIds).toEqual(["U123ABC", "W456DEF"]);
  });

  test("clears an obsolete description while reconciling a pinned group", async () => {
    const bodies: unknown[] = [];
    const client = slackUserGroupClient({
      fetch: async (input, init) => {
        const method = new URL(requestUrl(input)).pathname.split("/").at(-1)!;
        if (init?.body) bodies.push(jsonBody(init.body));
        const { description: _description, ...withoutDescription } = group();
        return method === "usergroups.list"
          ? Response.json({ ok: true, usergroups: [apiGroup()] })
          : Response.json({ ok: true, usergroup: withoutDescription });
      },
      token: "xoxb-secret",
    });

    const result = await reconcileSlackUserGroup({
      client,
      desired: { handle: "release-agent", name: "Release Agent", status: "active" },
      userGroupId: "S123ABC",
    });

    expect(result.actions).toEqual(["updated"]);
    expect(bodies).toEqual([
      {
        description: "",
        handle: "release-agent",
        name: "Release Agent",
        usergroup: "S123ABC",
      },
    ]);
  });

  test("fails closed for a missing pinned group and invalid desired state", async () => {
    const client = slackUserGroupClient({
      fetch: async () => Response.json({ ok: true, usergroups: [] }),
      token: "xoxb-secret",
    });
    expect(
      reconcileSlackUserGroup({
        client,
        desired: { handle: "release-agent", name: "Release Agent", status: "active" },
        userGroupId: "S123ABC",
      }),
    ).rejects.toThrow("S123ABC");
    expect(
      reconcileSlackUserGroup({
        client,
        desired: { handle: "Release Agent", name: "Release Agent", status: "active" },
        userGroupId: "S123ABC",
      }),
    ).rejects.toThrow("handle");
  });

  test("rejects an invalid desired status before calling Slack", async () => {
    let requests = 0;
    const client = slackUserGroupClient({
      fetch: async () => {
        requests += 1;
        return Response.json({ ok: true, usergroups: [apiGroup()] });
      },
      token: "xoxb-secret",
    });

    expect(
      reconcileSlackUserGroup({
        client,
        desired: {
          handle: "release-agent",
          name: "Release Agent",
          status: "paused",
        } as unknown as Parameters<typeof reconcileSlackUserGroup>[0]["desired"],
        userGroupId: "S123ABC",
      }),
    ).rejects.toThrow("status");
    expect(requests).toBe(0);
  });

  test("fails when Slack acknowledges an update without converging", async () => {
    const client = slackUserGroupClient({
      fetch: async (input) =>
        requestUrl(input).includes("usergroups.list")
          ? Response.json({ ok: true, usergroups: [apiGroup({ name: "Old name" })] })
          : Response.json({ ok: true, usergroup: group({ name: "Old name" }) }),
      token: "xoxb-secret",
    });

    expect(
      reconcileSlackUserGroup({
        client,
        desired: {
          description: "Routes mentions to the release agent.",
          handle: "release-agent",
          name: "Release Agent",
          status: "active",
        },
        userGroupId: "S123ABC",
      }),
    ).rejects.toThrow("did not converge");
  });
});
