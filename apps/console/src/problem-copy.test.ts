import { describe, expect, test } from "bun:test";
import { describeProblem } from "./components/section-boundary.tsx";
import { INSTALL_COPY } from "./edition.ts";
import { PlatformApiError, type PlatformProblem } from "./errors.ts";

/** Tenancy, agent, governance, and agent email APIs carry the message in `title` alone. */
function titleOnly(status: number, code: string, message: string): PlatformProblem {
  return { code, status, title: message };
}

/** Administration, budget, and evaluations APIs carry a generic title and the message in `detail`. */
function withDetail(status: number, code: string, message: string): PlatformProblem {
  return { code, detail: message, status, title: "Request failed" };
}

function described(problem: PlatformProblem, operation = "createThing") {
  const { description, title } = describeProblem(
    new PlatformApiError(operation, problem),
    "The request failed",
  );
  return { description, title };
}

describe("describeProblem keeps the server's specific message", () => {
  test.each([
    [
      titleOnly(
        422,
        "model_not_allowed_by_environment_policy",
        "/spec/model/id: Model openrouter/default is not one of the curated models; create an environment model policy that allows it.",
      ),
      "Model not allowed by the environment's model policy",
    ],
    [
      withDetail(
        422,
        "model_not_allowed_by_environment_policy",
        "Model openrouter/vendor/frontier-model is not one of the curated models; create an environment model policy that allows it.",
      ),
      "Model not allowed by the environment's model policy",
    ],
    [
      titleOnly(
        422,
        "model_not_in_catalog",
        "/spec/model/id: Model openai/gpt-retired is not an active entry in the platform model catalog.",
      ),
      "Model not in the platform catalog",
    ],
    [
      withDetail(422, "validation_failed", 'Expected string, got 7\n  at ["name"]'),
      "The platform rejected the request",
    ],
    [
      titleOnly(422, "validation_failed", 'Expected "ERASE", got "erase"\n  at ["confirmation"]'),
      "The platform rejected the request",
    ],
    [
      titleOnly(
        409,
        "email_sending_paused",
        "Outbound sending paused after the configured bounce-rate threshold was reached.",
      ),
      "Sending paused",
    ],
    [
      titleOnly(
        409,
        "daily_outbound_limit_exceeded",
        "The 200-message daily outbound limit has been reached.",
      ),
      "Daily sending limit reached",
    ],
    [
      titleOnly(
        422,
        "hosted_domain_region_unsupported",
        "Default placements must use hosted-domain region us-east-1 without a secondary region.",
      ),
      "Region not supported",
    ],
    [
      titleOnly(400, "invalid_time_range", "A summary holds at most 90 day buckets."),
      "Invalid time range",
    ],
    [
      titleOnly(
        400,
        "invalid_usage_range",
        "Usage filters require canonical UTC timestamps and a canonical inbox ID.",
      ),
      "Invalid usage range",
    ],
    [
      titleOnly(409, "invalid_draft_transition", "Only pending drafts can be approved."),
      "Draft status changed",
    ],
    [withDetail(422, "invalid_mcp_auth", "MCP auth is invalid."), "MCP authentication rejected"],
    [
      titleOnly(409, "release_archived", "Archived releases cannot be restarted."),
      "Release archived",
    ],
    [
      withDetail(
        422,
        "mcp_discovery_credential_echo",
        "Vendor MCP discovery returned credential material.",
      ),
      "MCP server returned credential material",
    ],
    [
      titleOnly(
        409,
        "tenant_erasure_in_progress",
        "Tenant governance is fenced by an erasure operation.",
      ),
      "Erasure in progress",
    ],
    [
      titleOnly(409, "binding_conflict", "The target already has an active inbox binding."),
      "Already bound",
    ],
    [
      titleOnly(
        403,
        "insufficient_role",
        "Tenant erasure require one of these organization roles: owner.",
      ),
      "Your organization role does not permit this",
    ],
    [
      titleOnly(
        403,
        "insufficient_role",
        "Mutating organization resources requires one of these organization roles: owner, admin.",
      ),
      "Your organization role does not permit this",
    ],
    [
      withDetail(502, "mcp_discovery_failed", "Vendor MCP tool discovery failed."),
      "The provider's MCP server did not answer",
    ],
    [
      withDetail(
        502,
        "mcp_discovery_failed",
        "Notion MCP authorization discovery failed: the metadata document has no issuer.",
      ),
      "The provider's MCP server did not answer",
    ],
    [
      withDetail(409, "version_conflict", "Expected model policy version 3, found 4."),
      "Changed since you opened it",
    ],
    [
      titleOnly(
        409,
        "deployment_not_editable",
        "The deployment is deploying; only a ready or paused deployment can change its tool bindings.",
      ),
      "This deployment cannot be edited now",
    ],
    [
      titleOnly(
        409,
        "idempotency_conflict",
        "The idempotency key was already used for a different request.",
      ),
      "Close this dialog and check whether the earlier attempt applied",
    ],
  ])("%o", (problem, title) => {
    expect(described(problem)).toEqual({
      description: problem.detail ?? problem.title,
      title,
    });
  });
});

describe("describeProblem falls back when the server says nothing specific", () => {
  test("a generic server text gives way to the console's advice", () => {
    expect(
      described(
        withDetail(409, "connection_not_verified", "Connection has no active verified capability."),
      ),
    ).toEqual({
      description: "Verify the connection so it records a capability, then grant it.",
      title: "Connection not verified",
    });
  });

  test("a bare 403 explains the refusal without naming the API operation", () => {
    expect(described(titleOnly(403, "forbidden", "Forbidden"), "createWebhook")).toEqual({
      description: "Your role or API key scopes do not allow this action.",
      title: "Forbidden",
    });
  });

  test("a non-API error keeps its message under the fallback title", () => {
    expect(describeProblem(new Error("Network down"), "Export failed")).toMatchObject({
      description: "Network down",
      title: "Export failed",
    });
  });
});

describe("describeProblem prefers copy for the failed operation", () => {
  const operationCopy = {
    createThing: {
      "500": { title: "Thing creation failed" },
      ambiguous_write_outcome: { title: "Thing may exist" },
    },
  };
  const titleOf = (error: Error) => describeProblem(error, "Fallback", operationCopy).title;

  test("an entry by code beats the global copy, and an entry by status applies only without a code", () => {
    expect([
      titleOf(
        new PlatformApiError("createThing", withDetail(409, "ambiguous_write_outcome", "Unknown")),
      ),
      titleOf(new PlatformApiError("createThing", { status: 500, title: "Internal error" })),
      titleOf(new PlatformApiError("createThing", titleOnly(500, "internal_error", "Boom"))),
    ]).toEqual(["Thing may exist", "Thing creation failed", "Boom"]);
  });

  test("another operation and a non-API error keep the global behavior", () => {
    expect([
      titleOf(
        new PlatformApiError("createOther", withDetail(409, "ambiguous_write_outcome", "Unknown")),
      ),
      titleOf(new Error("Network down")),
    ]).toEqual(["The outcome is unknown", "Fallback"]);
  });
});

describe("describeProblem on Brain writes", () => {
  const denied = titleOnly(403, "brain_permission_denied", "Brain permission denied.");

  test.each([
    ["createBrainUploadTicket", "Not allowed to upload"],
    ["getBrainUploadTicket", "Not allowed to upload"],
    ["uploadBrainContent", "Not allowed to upload"],
    ["captureBrainDocument", "Not allowed to change documents"],
    ["resolveBrainReviewItem", "Not allowed to resolve review items"],
  ])("a 403 on %s names the writer, curator, or owner grant", (operation, title) => {
    expect(described(denied, operation)).toEqual({
      description: expect.stringContaining("needs a writer, curator, or owner grant"),
      title,
    });
  });

  test("an owner-only write keeps the owner-grant copy", () => {
    expect(described(denied, "updateBrain")).toEqual({
      description:
        "A private Brain is open only to its owner. On a company Brain, your grant does not allow this; access and settings need an owner grant.",
      title: "Not allowed on this Brain",
    });
  });

  test("an upload that cannot finish says so for every cause", () => {
    expect(
      described(
        titleOnly(409, "brain_upload_restart", "Upload did not finish"),
        "uploadBrainContent",
      ),
    ).toEqual({
      description:
        "The document was not captured, and this upload can no longer finish. Upload again to start a new one.",
      title: "Upload did not finish",
    });
  });
});

describe("describeProblem reads Memory's internal error by operation", () => {
  const internal = withDetail(500, "memory_internal_error", "Memory request failed.");

  test("a policy write explains the missing search placement", () => {
    expect(described(internal, "upsertMemoryPolicy")).toEqual({
      description:
        "Saving a memory policy needs memory search, which an operator enables for the organization. If search is already enabled, retry; the error is the platform's.",
      title: "Memory search may not be enabled for this organization",
    });
  });

  test("a memory import names what needed the placement", () => {
    expect(described(internal, "importMemories")).toEqual({
      description:
        "Importing memories needs memory search, which an operator enables for the organization. If search is already enabled, retry; the error is the platform's.",
      title: "Memory search may not be enabled for this organization",
    });
  });

  test("an operation that needs no placement keeps the server's message", () => {
    expect(described(internal, "createMemorySpace")).toEqual({
      description: "Memory request failed.",
      title: "Request failed",
    });
  });

  test("a member refused the review queue reads that it is a read, not a mutation", () => {
    const refused = withDetail(
      403,
      "insufficient_role",
      "Memory mutations require an organization owner or administrator.",
    );
    expect(described(refused, "listMemoryReviewItems")).toEqual({
      description: "Only organization owners and admins can read the memory review queue.",
      title: "Your organization role does not permit this",
    });
  });
});

describe("describeProblem words install-dependent problems for who runs the install", () => {
  const describedFor = (
    install: keyof typeof INSTALL_COPY,
    problem: PlatformProblem,
    operation = "createThing",
  ) =>
    describeProblem(
      new PlatformApiError(operation, problem),
      "Failed",
      undefined,
      INSTALL_COPY[install],
    ).description;

  test.each([
    [titleOnly(500, "brain_search_unavailable", "x"), "searchBrains"],
    [titleOnly(400, "invalid_return_to", "x"), "beginOAuth"],
    [titleOnly(409, "oauth_provider_unconfigured", "x"), "beginOAuth"],
    [withDetail(500, "memory_internal_error", "x"), "upsertMemoryPolicy"],
  ])(
    "%o on %s names no operator or deployment setting in the managed edition",
    (problem, operation) => {
      const managed = describedFor("managed", problem, operation) ?? "";
      expect(managed).toContain("support");
      expect(managed).not.toMatch(/operator|install|OpenTofu|PLATFORM_|_json/u);
      expect(describedFor("self-hosted", problem, operation)).toMatch(/operator|Operators/u);
    },
  );
});
