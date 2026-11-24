import { describe, expect, it } from "bun:test";
import { dropMemoryOrganizationIndex } from "./aws-native-index-drop.ts";

const ORGANIZATION = "01ARZ3NDEKTSV4RRFFQ69G5FA5";
const INDEX = "memory-01arz3ndektsv4rrffq69g5fa5-v2";

function drop(index: string, deleted: () => unknown) {
  const requests: string[] = [];
  const result = dropMemoryOrganizationIndex({
    index,
    openSearch: {
      request: async ({ method, path }) => {
        requests.push(`${method} ${path}`);
        return path === "/_snapshot/_all" ? { "cs-automated-enc": { type: "s3" } } : deleted();
      },
    },
    organizationId: ORGANIZATION,
  });
  return { requests, result };
}

function notFound(type: string) {
  return Object.assign(new Error("OpenSearch request failed with status 404."), {
    details: { error: { type }, status: 404 },
    status: 404,
  });
}

describe("dropping an organization's own memory index", () => {
  it("deletes the index and answers dropped once OpenSearch acknowledges it", async () => {
    const { requests, result } = drop(INDEX, () => ({ acknowledged: true }));

    expect(await result).toBe("dropped");
    expect(requests).toEqual(["GET /_snapshot/_all", `DELETE /${INDEX}`]);
  });

  it("answers already-absent only for a 404 that names a missing index", async () => {
    expect(
      await drop(INDEX, () => {
        throw notFound("index_not_found_exception");
      }).result,
    ).toBe("already-absent");
    expect(
      await drop(INDEX, () => {
        throw notFound("resource_not_found_exception");
      }).result.catch((cause: Error) => cause.message),
    ).toBe("OpenSearch request failed with status 404.");
  });

  it("fails when OpenSearch does not acknowledge the deletion", async () => {
    expect(
      await drop(INDEX, () => ({ acknowledged: false })).result.catch(
        (cause: Error) => cause.message,
      ),
    ).toBe(`OpenSearch did not acknowledge the deletion of ${INDEX}.`);
  });

  it("sends nothing for a name that is not exactly the organization's own", async () => {
    const outcomes = [];
    for (const index of ["memory-*", `${INDEX},memory-shared-v1`, "memory-v3"]) {
      const { requests, result } = drop(index, () => ({ acknowledged: true }));
      outcomes.push([await result.catch((cause: Error) => cause.message), requests]);
    }

    expect(outcomes).toEqual([
      ["memory-* is not the organization's own memory index.", []],
      [`${INDEX},memory-shared-v1 is not the organization's own memory index.`, []],
      ["memory-v3 is not the organization's own memory index.", []],
    ]);
  });
});
