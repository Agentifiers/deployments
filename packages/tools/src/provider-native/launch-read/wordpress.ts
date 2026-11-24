import {
  appendNativeQueryFields,
  originResourceTargetAuditMetadata,
  requireHttpsOriginBaseUrl,
  requirePositiveLimit,
  type ProviderNativeHttpToolDefinition,
} from "../core.ts";

function wordpressRestCollectionUrl(
  input: Record<string, unknown>,
  collection: "posts" | "pages",
): string {
  const origin = requireHttpsOriginBaseUrl(input);
  const url = new URL(`${origin.toString().replace(/\/+$/u, "")}/wp-json/wp/v2/${collection}`);
  url.searchParams.set("per_page", String(requirePositiveLimit(input, "perPage", 10, 100)));
  url.searchParams.set("page", String(requirePositiveLimit(input, "page", 1, 10_000)));
  appendNativeQueryFields(url, input, [
    "search",
    "status",
    "author",
    "categories",
    "tags",
    "order",
    "orderby",
    "after",
    "before",
    "slug",
    "context",
  ]);
  // Read-only collection tools never default to write contexts.
  if (!url.searchParams.has("context")) {
    url.searchParams.set("context", "view");
  }
  const context = url.searchParams.get("context");
  if (context && context !== "view" && context !== "embed") {
    throw new Error("Tool input context must be view or embed for read-only WordPress tools");
  }
  return url.toString();
}

export const wordpressNativeHttpToolDefinitions: readonly ProviderNativeHttpToolDefinition[] = [
  {
    toolName: "wordpress.posts.list",
    description:
      "List WordPress posts from a verified HTTPS site origin (application-password Basic Auth; read only).",
    effect: "read",
    provider: "wordpress",
    requiredScopes: [],
    defaultPolicyAction: "allow",
    method: "GET",
    filePrefix: "wordpress-posts-list",
    auditMetadata: originResourceTargetAuditMetadata(),
    buildUrl: (input) => wordpressRestCollectionUrl(input, "posts"),
    successSummary: () => "Listed WordPress posts.",
  },
  {
    toolName: "wordpress.pages.list",
    description:
      "List WordPress pages from a verified HTTPS site origin (application-password Basic Auth; read only).",
    effect: "read",
    provider: "wordpress",
    requiredScopes: [],
    defaultPolicyAction: "allow",
    method: "GET",
    filePrefix: "wordpress-pages-list",
    auditMetadata: originResourceTargetAuditMetadata(),
    buildUrl: (input) => wordpressRestCollectionUrl(input, "pages"),
    successSummary: () => "Listed WordPress pages.",
  },
];
