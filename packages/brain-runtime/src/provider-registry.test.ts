import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { dropBrainIndex } from "@deployments-ai/brains";
import { brainOpenSearchTransport } from "./provider-registry.ts";

const endpoint = "https://search.example.com";

describe("brainOpenSearchTransport", () => {
  const credentials = {
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
  };
  beforeEach(() => {
    process.env.AWS_ACCESS_KEY_ID = "AKIDEXAMPLE";
    process.env.AWS_SECRET_ACCESS_KEY = "secret";
  });
  afterEach(() => {
    for (const [name, value] of Object.entries(credentials)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  test("reports the HTTP status and error type, so a drop of a missing index reads as already absent", async () => {
    const fetched: string[] = [];
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
      url: URL,
      init: RequestInit,
    ) => {
      fetched.push(`${init.method} ${url.href}`);
      return new Response(JSON.stringify({ error: { type: "index_not_found_exception" } }), {
        status: 404,
      });
    }) as unknown as typeof fetch);
    try {
      const openSearch = brainOpenSearchTransport({
        approvedEndpoint: endpoint,
        endpoint,
        region: "us-east-2",
      });

      expect([
        await dropBrainIndex(openSearch, "brain-01ja0000000000000000000002-v1"),
        await openSearch
          .request({ method: "GET", path: "/brain-01ja0000000000000000000002-v1" })
          .catch((error: Error & { status?: number; type?: string }) => [
            error.message,
            error.status,
            error.type,
          ]),
        fetched,
      ]).toEqual([
        "already-absent",
        ["Brain OpenSearch request failed with status 404.", 404, "index_not_found_exception"],
        [
          "DELETE https://search.example.com/brain-01ja0000000000000000000002-v1",
          "GET https://search.example.com/brain-01ja0000000000000000000002-v1",
        ],
      ]);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("refuses a domain other than the approved Brain domain", () => {
    expect(() =>
      brainOpenSearchTransport({
        approvedEndpoint: "https://brain.example.com",
        endpoint,
        region: "us-east-2",
      }),
    ).toThrow("Brain OpenSearch target is not the approved Brain domain.");
  });
});
