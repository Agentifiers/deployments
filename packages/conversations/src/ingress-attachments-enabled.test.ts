import { describe, expect, test } from "bun:test";
import {
  AgentDeploymentRecord,
  AgentReleaseRecord,
  withCanonicalRecordKeys,
  type Ulid,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { controlFixtures, ids, now } from "./conversation-control.fixture.ts";
import { ingressAttachmentsEnabled } from "./index.ts";
import type { AgentDeployment, AgentRelease } from "./submission.ts";

const candidateId = ids[39]!;

function withCandidate(deployment: AgentDeployment): AgentDeployment {
  return Schema.decodeUnknownSync(AgentDeploymentRecord)(
    withCanonicalRecordKeys({
      data: {
        ...deployment.data,
        candidateAgentReleaseId: candidateId,
        candidateStartedAt: now.toISOString(),
        candidateWeight: 10,
      },
      itemType: "agent-deployment" as const,
    }),
  );
}

function releaseWith(
  release: AgentRelease,
  data: Pick<AgentRelease["data"], "id" | "status">,
): AgentRelease {
  return Schema.decodeUnknownSync(AgentReleaseRecord)(
    withCanonicalRecordKeys({
      data: { ...release.data, ...data },
      itemType: "agent-release" as const,
    }),
  );
}

function stored(...releases: readonly AgentRelease[]) {
  return async (releaseId: Ulid) => releases.find((release) => release.data.id === releaseId);
}

describe("ingress attachment opt-in", () => {
  const plain = controlFixtures();
  const attaching = controlFixtures({ runtime: { ingressAttachments: "attach" } });
  const attachingCandidate = releaseWith(attaching.release, { id: candidateId, status: "active" });

  test("follows the opt-in of the primary release", async () => {
    expect(await ingressAttachmentsEnabled(plain.deployment, stored(plain.release))).toBe(false);
    expect(await ingressAttachmentsEnabled(attaching.deployment, stored(attaching.release))).toBe(
      true,
    );
  });

  test("turns on for a canary candidate that opts in, and only while it is selectable", async () => {
    expect(
      await ingressAttachmentsEnabled(
        withCandidate(plain.deployment),
        stored(plain.release, attachingCandidate),
      ),
    ).toBe(true);
    expect(
      await ingressAttachmentsEnabled(plain.deployment, stored(plain.release, attachingCandidate)),
    ).toBe(false);
  });

  test("ignores an opted-in release that can no longer run", async () => {
    const archived = releaseWith(attaching.release, {
      id: attaching.release.data.id,
      status: "archived",
    });
    expect(await ingressAttachmentsEnabled(attaching.deployment, stored(archived))).toBe(false);
    expect(await ingressAttachmentsEnabled(attaching.deployment, stored())).toBe(false);
  });
});
