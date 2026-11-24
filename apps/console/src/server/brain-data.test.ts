import { describe, expect, test } from "bun:test";
import { PlatformApiError } from "../errors.ts";
import { getBrainView, listBrainSources } from "./brain-data.ts";
import type { callRoute } from "./platform-api.ts";

const ORGANIZATION = "01K0000000000000000000000A";
const BRAIN = { id: "01K0000000000000000000000E", name: "QA" };

function platform(responses: Readonly<Record<string, () => unknown>>) {
  const fake = async (name: string) => {
    const respond = responses[name];
    if (!respond) throw new Error(`unexpected ${name}`);
    return respond();
  };
  return fake as unknown as typeof callRoute;
}

const refused = (status: number, code: string) => () => {
  throw new PlatformApiError("listBrainGrants", { code, status, title: code });
};

describe("getBrainView", () => {
  test("reads an owner when the grants list answers and a grantee when it answers 403", async () => {
    const standings = await Promise.all(
      [() => ({ items: [] }), refused(403, "brain_permission_denied")].map(async (grants) => {
        const view = await getBrainView(
          "token",
          ORGANIZATION,
          BRAIN.id,
          platform({ getBrain: () => BRAIN, listBrainGrants: grants }),
        );
        return [view.brain.name, view.standing.kind];
      }),
    );
    expect(standings).toEqual([
      ["QA", "owner"],
      ["QA", "grantee"],
    ]);
  });

  test("fails on any other grants error instead of guessing a standing", async () => {
    const failure = await getBrainView(
      "token",
      ORGANIZATION,
      BRAIN.id,
      platform({ getBrain: () => BRAIN, listBrainGrants: refused(500, "internal_error") }),
    ).then(
      () => undefined,
      (error: unknown) => (error instanceof PlatformApiError ? error.problem.code : error),
    );
    expect(failure).toBe("internal_error");
  });
});

describe("listBrainSources", () => {
  test("drops each source's configuration and keeps the cursor", async () => {
    const page = await listBrainSources(
      "token",
      ORGANIZATION,
      BRAIN.id,
      undefined,
      platform({
        listBrainSources: () => ({
          items: [{ configuration: { repository: "acme/docs" }, id: "s1", kind: "github" }],
          nextCursor: "next",
        }),
      }),
    );
    expect<unknown>(page).toEqual({ items: [{ id: "s1", kind: "github" }], nextCursor: "next" });
  });
});
