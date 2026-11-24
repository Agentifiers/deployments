import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { DEFAULT_TABLE_NAMES } from "../client-types.ts";
import { makeDynamoDatabase } from "../dynamo-database.ts";
import { Ulid } from "../ids.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import { fakeDynamoDocumentClient } from "../testing/dynamo-document-client.fixture.ts";
import {
  makeInstallationRepository,
  type InstallationDeploymentInput,
} from "./installation-repository.ts";
import { makePlatformOrganizationDirectory } from "./organization-directory.ts";

const ulid = Schema.decodeUnknownSync(Ulid);
const DEPLOYMENT_IDS = [
  "01J00000000000000000000001",
  "01J00000000000000000000002",
  "01J00000000000000000000003",
].map((id) => ulid(id));

function snapshot(sourceCommit: string): InstallationDeploymentInput {
  return {
    awsAccountId: "123456789012",
    awsRegion: "us-east-2",
    deployedBy: "arn:aws:sts::123456789012:assumed-role/deployer/session",
    endpoints: [{ name: "platform-api", url: "https://api.example.com" }],
    images: [
      {
        imageId: `sha256:${"b".repeat(64)}`,
        name: "durable-streams",
        uri: `123456789012.dkr.ecr.us-east-2.amazonaws.com/streams@sha256:${"c".repeat(64)}`,
      },
    ],
    lambdaArtifacts: [
      {
        functions: [{ codeSha256: "e".repeat(64), name: "api" }],
        name: "platform-api",
        sha256: "a".repeat(64),
      },
    ],
    profile: "platform-prod",
    releaseManifestSha256: "d".repeat(64),
    sourceCommit,
    targetName: "acme-prod",
  };
}

function setup() {
  const fake = fakeDynamoDocumentClient();
  const database = makeDynamoDatabase(fake.client, DEFAULT_TABLE_NAMES);
  const ids = [...DEPLOYMENT_IDS];
  let tick = 0;
  const repository = makeInstallationRepository(database, {
    generateId: async () => ids.shift()!,
    now: () => new Date(Date.UTC(2026, 9, 1, 0, 0, tick++)),
  });
  return { database, fake, repository };
}

describe("installation repository", () => {
  test("keeps one installation singleton and appends history newest first", async () => {
    const { fake, repository } = setup();
    expect(await repository.current()).toBeUndefined();

    await repository.recordDeployment(snapshot("1".repeat(40)));
    await repository.recordDeployment(snapshot("2".repeat(40)));
    const latest = await repository.recordDeployment(snapshot("3".repeat(40)));

    const current = await repository.current();
    expect(current).toEqual(latest.installation);
    expect(current).toMatchObject({
      createdAt: "2026-10-01T00:00:00.000Z",
      deploymentId: DEPLOYMENT_IDS[2],
      sourceCommit: "3".repeat(40),
      version: 3,
    });
    const installations = fake.items("control").filter((item) => item.itemType === "installation");
    expect(installations).toHaveLength(1);
    expect(installations[0]).toMatchObject({
      pk: "GLOBAL#installation",
      sk: "INSTALLATION#current",
    });

    const first = await repository.listDeployments({ limit: 2 });
    expect(first.items.map((item) => item.sourceCommit)).toEqual(["3".repeat(40), "2".repeat(40)]);
    const second = await repository.listDeployments({ cursor: first.nextCursor, limit: 2 });
    expect(second.items.map((item) => item.id)).toEqual([DEPLOYMENT_IDS[0]!]);
    expect(second.nextCursor).toBeUndefined();
  });

  test("rejects a cursor from another partition and a malformed snapshot", async () => {
    const { repository } = setup();
    const foreign = Buffer.from(
      JSON.stringify({ pk: "GLOBAL#ORGANIZATIONS", sk: "ORGANIZATION#x" }),
    ).toString("base64url");
    expect(repository.listDeployments({ cursor: foreign })).rejects.toMatchObject({
      code: "invalid_cursor",
    });
    expect(
      repository.recordDeployment({ ...snapshot("1".repeat(40)), sourceCommit: "HEAD" }),
    ).rejects.toMatchObject({ code: "invalid_installation" });
    expect(await repository.current()).toBeUndefined();
  });

  test("never replaces or deletes a history entry", async () => {
    const { database, repository } = setup();
    const { deployment } = await repository.recordDeployment(snapshot("1".repeat(40)));
    const record = withCanonicalRecordKeys({
      data: { ...deployment, deployedBy: "someone-else" },
      itemType: "installation-deployment" as const,
    });
    const stored = withCanonicalRecordKeys({
      data: deployment,
      itemType: "installation-deployment" as const,
    });
    expect(
      database.transactWrite([{ kind: "put", record, previousRecord: stored }]),
    ).rejects.toMatchObject({ cause: expect.stringContaining("create-only") });
    expect(database.transactWrite([{ kind: "put", record }])).rejects.toMatchObject({
      _tag: "DatabaseError",
    });
    expect(database.deleteRecord(stored)).rejects.toMatchObject({
      _tag: "DatabaseError",
    });
  });
});

describe("platform organization directory", () => {
  test("pages every organization through GSI1 with active member counts", async () => {
    const { database, fake } = setup();
    const organizations = ["01J0000000000000000000000A", "01J0000000000000000000000B"].map(
      (id, index) =>
        withCanonicalRecordKeys({
          data: {
            createdAt: `2026-01-0${index + 1}T00:00:00.000Z`,
            id,
            name: `Org ${index}`,
            slug: `org-${index}`,
            status: "active",
            updatedAt: `2026-01-0${index + 1}T00:00:00.000Z`,
            version: 1,
          },
          itemType: "organization" as const,
        }),
    );
    for (const organization of organizations) fake.put("control", organization);
    const members = [
      ["01J0000000000000000000000A", "01J000000000000000000000P1", "active"],
      ["01J0000000000000000000000A", "01J000000000000000000000P2", "removed"],
      ["01J0000000000000000000000A", "01J000000000000000000000P3", "active"],
      ["01J0000000000000000000000B", "01J000000000000000000000P1", "invited"],
    ] as const;
    for (const [organizationId, principalId, status] of members) {
      fake.put(
        "control",
        withCanonicalRecordKeys({
          data: {
            createdAt: "2026-01-01T00:00:00.000Z",
            organizationId,
            principalId,
            role: "member",
            status,
            updatedAt: "2026-01-01T00:00:00.000Z",
            version: 1,
          },
          itemType: "organization-member" as const,
        }),
      );
    }
    const directory = makePlatformOrganizationDirectory(database);

    const first = await directory.list({ limit: 1 });
    const second = await directory.list({ cursor: first.nextCursor, limit: 1 });

    expect([...first.items, ...second.items]).toEqual([
      expect.objectContaining({ activeMemberCount: 2, id: "01J0000000000000000000000A" }),
      expect.objectContaining({ activeMemberCount: 0, id: "01J0000000000000000000000B" }),
    ]);
    const third = second.nextCursor
      ? await directory.list({ cursor: second.nextCursor, limit: 1 })
      : { items: [] };
    expect(third.items).toEqual([]);
  });
});
