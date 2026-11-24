import { describe, expect, test } from "bun:test";
import { controlResourceCommandCatalog } from "./catalog-control-resources.ts";
import { buildRequest } from "./command-runtime.ts";

const context = {
  apiUrl: "https://api.example.test",
  mock: false,
  profileName: "default",
} as const;

describe("control resource CLI catalog", () => {
  test("serializes managed-skill source clear flags and rejects conflicting values", async () => {
    const spec = controlResourceCommandCatalog["managed-skill-source"]!.actions.update!;
    const request = await buildRequest(
      spec,
      {
        "clear-license-hash": true,
        "clear-metadata": true,
        "clear-pinned-commit": true,
        "clear-repository-url": true,
        "expected-version": "1",
        id: "source_1",
      },
      context,
      {},
    );

    expect(request.body).toEqual({
      expectedVersion: 1,
      licenseHash: null,
      metadata: null,
      pinnedCommit: null,
      repositoryUrl: null,
    });
    expect(
      buildRequest(
        spec,
        {
          "clear-repository-url": true,
          "expected-version": "1",
          id: "source_1",
          "repository-url": "https://github.com/example/source",
        },
        context,
        {},
      ),
    ).rejects.toThrow("Conflicting values were provided for repositoryUrl");
  });
});
