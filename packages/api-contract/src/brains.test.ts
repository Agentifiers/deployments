import { describe, expect, it } from "bun:test";
import { Exit, Schema } from "effect";
import {
  BRAIN_API_ROUTES,
  BRAIN_API_SCHEMAS,
  BrainSearchRequest,
  CaptureBrainDocumentRequest,
  CreateBrainGrantRequest,
  CreateBrainRequest,
} from "./brains.ts";

const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

describe("Brain public API contract", () => {
  it("publishes unique native Brain lifecycle, grant, mount, source, and document routes", () => {
    expect(BRAIN_API_ROUTES).toHaveLength(28);
    expect(new Set(BRAIN_API_ROUTES.map((route) => route.name)).size).toBe(28);
    expect(new Set(BRAIN_API_ROUTES.map((route) => `${route.method} ${route.path}`)).size).toBe(28);
    expect(BRAIN_API_ROUTES.find((route) => route.name === "createBrain")).toMatchObject({
      path: "/v1/brains",
      requiredAuthorization: "brains:create",
    });
    expect(BRAIN_API_ROUTES.find((route) => route.name === "captureBrainDocument")).toMatchObject({
      path: "/v1/brains/:brainId/sources/:sourceId/documents",
      requiredAuthorization: "brains:write",
    });
  });

  it("requires an explicit bounded, unique authorized Brain set for search", () => {
    expect(
      Exit.isSuccess(
        Schema.decodeUnknownExit(BrainSearchRequest)({
          brainIds: [id],
          query: "Why did we make this decision?",
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isFailure(
        Schema.decodeUnknownExit(BrainSearchRequest)({
          brainIds: [id, id],
          query: "question",
        }),
      ),
    ).toBe(true);
  });

  it("registers every request and response schema referenced by a route", () => {
    for (const route of BRAIN_API_ROUTES) {
      expect(BRAIN_API_SCHEMAS).toHaveProperty(route.responseBody);
      if (route.requestBody) expect(BRAIN_API_SCHEMAS).toHaveProperty(route.requestBody);
    }
  });

  it("requires billable tenant scope for queries and organization scope elsewhere", () => {
    for (const route of BRAIN_API_ROUTES) {
      expect(route.authentication).toBe("tenant-jwt");
      expect(route.scopeHeaders).toBe(
        route.name === "askBrains" || route.name === "searchBrains" ? "tenant" : "organization",
      );
      expect(route.idempotency).toBe(route.method === "GET" ? "none" : "required");
    }
  });

  it("accepts normalized Brain creation and rejects invalid slugs", () => {
    const decode = Schema.decodeUnknownSync(CreateBrainRequest);
    expect(
      decode({
        kind: "company",
        name: "Engineering",
        sensitivity: "internal",
        slug: "eng-decisions",
      }),
    ).toMatchObject({ kind: "company", slug: "eng-decisions" });
    expect(
      Exit.isFailure(
        Schema.decodeUnknownExit(CreateBrainRequest)({
          kind: "company",
          name: "Engineering",
          slug: "Engineering Decisions",
        }),
      ),
    ).toBe(true);
  });

  it("keeps human and machine grant permissions structurally distinct", () => {
    expect(
      Exit.isSuccess(
        Schema.decodeUnknownExit(CreateBrainGrantRequest)({
          permission: "reader",
          target: { principalId: id, type: "principal" },
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isFailure(
        Schema.decodeUnknownExit(CreateBrainGrantRequest)({
          permission: "owner",
          target: {
            environmentId: id,
            projectId: id,
            serviceAccountId: id,
            type: "service-account",
          },
        }),
      ),
    ).toBe(true);
  });

  it("requires controlled uploads for content and forbids them on lifecycle markers", () => {
    expect(
      Exit.isFailure(
        Schema.decodeUnknownExit(CaptureBrainDocumentRequest)({
          externalItemIdentity: "github:repo:doc",
          kind: "content",
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isFailure(
        Schema.decodeUnknownExit(CaptureBrainDocumentRequest)({
          completedUploadTicketId: id,
          externalItemIdentity: "github:repo:doc",
          kind: "tombstone",
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isSuccess(
        Schema.decodeUnknownExit(CaptureBrainDocumentRequest)({
          completedUploadTicketId: id,
          externalItemIdentity: "github:repo:doc",
          kind: "content",
          mediaType: "text/markdown",
        }),
      ),
    ).toBe(true);
  });
});
