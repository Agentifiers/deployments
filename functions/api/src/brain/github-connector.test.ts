import { describe, expect, test } from "bun:test";
import type { BrainSource } from "@deployments-ai/brains";
import { createHash } from "node:crypto";
import { makeGitHubBrainConnector } from "./github-connector.ts";

const bytes = new TextEncoder().encode("# Decision\nUse the native Brain.\n");
const blobSha = createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
const source: BrainSource = {
  brainId: "brain",
  configuration: { owner: "deployments-ai", repository: "platform" },
  connectionId: "connection",
  createdAt: "2026-07-31T12:00:00.000Z",
  createdByPrincipalId: "principal",
  environmentId: "environment",
  id: "source",
  kind: "github",
  name: "Platform",
  organizationId: "organization",
  projectId: "project",
  status: "active",
  updatedAt: "2026-07-31T12:00:00.000Z",
  updatedByPrincipalId: "principal",
  version: 0,
};

describe("GitHub Brain connector", () => {
  test("pins a commit and verifies every selected blob against its immutable Git SHA", async () => {
    const urls: string[] = [];
    const connector = makeGitHubBrainConnector(async (request) => {
      const url = request instanceof Request ? request.url : String(request);
      urls.push(url);
      const body = url.includes("/commits/")
        ? {
            commit: {
              committer: { date: "2026-07-31T11:00:00.000Z" },
              tree: { sha: "tree-sha" },
            },
            sha: "commit-sha",
          }
        : url.includes("/git/trees/")
          ? {
              tree: [
                { path: "docs/decision.md", sha: blobSha, size: bytes.byteLength, type: "blob" },
                { path: "logo.png", sha: "binary", size: 10, type: "blob" },
              ],
              truncated: false,
            }
          : { content: Buffer.from(bytes).toString("base64"), encoding: "base64" };
      return Response.json(body);
    });

    const snapshot = await connector({ accessToken: "secret-token", source });
    expect(snapshot).toMatchObject({ cursor: "commit-sha" });
    expect(snapshot.files.map((file) => file.path)).toEqual(["docs/decision.md"]);
    expect(await snapshot.files[0]!.read()).toEqual(bytes);
    expect(urls).toHaveLength(3);
    expect(urls.join("\n")).not.toContain("secret-token");
  });

  test("fails closed when GitHub cannot return a complete repository tree", async () => {
    const connector = makeGitHubBrainConnector(async (request) =>
      Response.json(
        (request instanceof Request ? request.url : String(request)).includes("/commits/")
          ? {
              commit: {
                committer: { date: "2026-07-31T11:00:00.000Z" },
                tree: { sha: "tree-sha" },
              },
              sha: "commit-sha",
            }
          : { tree: [], truncated: true },
      ),
    );
    expect(connector({ accessToken: "secret-token", source })).rejects.toThrow("truncated");
  });
});
