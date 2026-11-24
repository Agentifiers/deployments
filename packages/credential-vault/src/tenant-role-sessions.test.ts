import { describe, expect, test } from "bun:test";
import type { AssumeRoleCommand } from "@aws-sdk/client-sts";
import { makeTenantRoleSessions, type TenantRoleSts } from "./tenant-role-sessions.ts";

const ROLE_ARN = "arn:aws:iam::123456789012:role/credential-vault-reader";
const scope = {
  environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
};

function fakeSts(lifetimesMs: readonly number[]) {
  const requests: AssumeRoleCommand["input"][] = [];
  const sts: TenantRoleSts = {
    send: async (command: AssumeRoleCommand) => {
      requests.push(command.input);
      return {
        $metadata: {},
        Credentials: {
          AccessKeyId: `session-${requests.length}`,
          Expiration: new Date(Date.now() + (lifetimesMs[requests.length - 1] ?? 900_000)),
          SecretAccessKey: "secret",
          SessionToken: "token",
        },
      };
    },
  };
  return { requests, sts };
}

function readerSessions(sts: TenantRoleSts) {
  return makeTenantRoleSessions({
    open: (credentials) => credentials.accessKeyId,
    roleArn: ROLE_ARN,
    sessionName: "credential-vault-reader",
    sts,
    tags: [{ Key: "accessMode", Value: "reader" }],
  });
}

describe("tenant role sessions", () => {
  test("assume the role with the fixed tags and the trimmed tenant scope as session tags", async () => {
    const { requests, sts } = fakeSts([]);

    expect(await readerSessions(sts)({ ...scope, projectId: ` ${scope.projectId} ` })).toBe(
      "session-1",
    );
    expect(requests).toEqual([
      {
        DurationSeconds: 900,
        RoleArn: ROLE_ARN,
        RoleSessionName: "credential-vault-reader",
        Tags: [
          { Key: "accessMode", Value: "reader" },
          { Key: "environmentId", Value: "01ARZ3NDEKTSV4RRFFQ69G5FAX" },
          { Key: "organizationId", Value: "01ARZ3NDEKTSV4RRFFQ69G5FAV" },
          { Key: "projectId", Value: "01ARZ3NDEKTSV4RRFFQ69G5FAW" },
        ],
      },
    ]);
  });

  test("reuse a session only for its own tenant scope and only until a minute before it expires", async () => {
    const { requests, sts } = fakeSts([900_000, 30_000]);
    const sessions = readerSessions(sts);
    const otherOrganization = { ...scope, organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAY" };

    expect([
      await sessions(scope),
      await sessions(scope),
      await sessions(otherOrganization),
      await sessions(otherOrganization),
    ]).toEqual(["session-1", "session-1", "session-2", "session-3"]);
    expect(requests.map(({ Tags }) => Tags?.find(({ Key }) => Key === "organizationId"))).toEqual([
      { Key: "organizationId", Value: "01ARZ3NDEKTSV4RRFFQ69G5FAV" },
      { Key: "organizationId", Value: "01ARZ3NDEKTSV4RRFFQ69G5FAY" },
      { Key: "organizationId", Value: "01ARZ3NDEKTSV4RRFFQ69G5FAY" },
    ]);
  });

  test("refuse a blank or oversized tenant scope before calling STS", async () => {
    const { requests, sts } = fakeSts([]);
    const sessions = readerSessions(sts);

    const failures = await Promise.all(
      [
        { ...scope, projectId: " " },
        { ...scope, environmentId: "e".repeat(257) },
      ].map((invalid) => sessions(invalid).catch((cause: unknown) => cause)),
    );

    expect(failures).toMatchObject([
      { message: "Tenant session projectId is required." },
      { message: "Tenant session environmentId is too long." },
    ]);
    expect(requests).toEqual([]);
    expect(await sessions(scope)).toBe("session-1");
  });
});
