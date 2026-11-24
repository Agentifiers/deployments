import {
  appendNativeQueryFields,
  encodedPath,
  jsonProviderNativeBody,
  optionalToolString,
  requireToolString,
  type ProviderNativeHttpToolDefinition,
} from "../core.ts";

const BITBUCKET_READ_SCOPES = ["repository", "pullrequest", "issue", "pipeline"] as const;
const BITBUCKET_WRITE_SCOPES = ["repository", "pullrequest:write", "issue:write"] as const;

function bitbucketRepository(input: Record<string, unknown>): string {
  return `${encodeURIComponent(requireToolString(input, "workspace"))}/${encodeURIComponent(
    requireToolString(input, "repoSlug"),
  )}`;
}

export const bitbucketNativeHttpToolDefinitions: readonly ProviderNativeHttpToolDefinition[] = [
  {
    toolName: "bitbucket.repository.read",
    description: "Read Bitbucket repository metadata, source, commits, or branches.",
    effect: "read",
    provider: "bitbucket",
    requiredScopes: BITBUCKET_READ_SCOPES,
    defaultPolicyAction: "allow",
    method: "GET",
    filePrefix: "bitbucket-repository-read",
    buildUrl(input) {
      const resource = optionalToolString(input, "resource") ?? "repository";
      const path = optionalToolString(input, "path");
      const suffix = path
        ? `/src/${encodeURIComponent(optionalToolString(input, "ref") ?? "HEAD")}/${encodedPath(path)}`
        : resource === "commits" || resource === "refs/branches"
          ? `/${resource}`
          : "";
      const url = new URL(
        `https://api.bitbucket.org/2.0/repositories/${bitbucketRepository(input)}${suffix}`,
      );
      appendNativeQueryFields(url, input, ["q", "sort", "page", "pagelen"]);
      return url.toString();
    },
  },
  {
    toolName: "bitbucket.pull_requests.list",
    description: "List Bitbucket pull requests and review state.",
    effect: "read",
    provider: "bitbucket",
    requiredScopes: BITBUCKET_READ_SCOPES,
    defaultPolicyAction: "allow",
    method: "GET",
    filePrefix: "bitbucket-pull-requests-list",
    buildUrl(input) {
      const url = new URL(
        `https://api.bitbucket.org/2.0/repositories/${bitbucketRepository(input)}/pullrequests`,
      );
      appendNativeQueryFields(url, input, ["state", "q", "sort", "page", "pagelen"]);
      return url.toString();
    },
  },
  {
    toolName: "bitbucket.pull_requests.create",
    description: "Create a Bitbucket pull request after approval.",
    effect: "write",
    provider: "bitbucket",
    requiredScopes: BITBUCKET_WRITE_SCOPES,
    defaultPolicyAction: "require_approval",
    method: "POST",
    filePrefix: "bitbucket-pull-request-create",
    buildUrl: (input) =>
      `https://api.bitbucket.org/2.0/repositories/${bitbucketRepository(input)}/pullrequests`,
    buildBody: (input) =>
      jsonProviderNativeBody({
        title: requireToolString(input, "title"),
        source: { branch: { name: requireToolString(input, "sourceBranch") } },
        destination: { branch: { name: requireToolString(input, "destinationBranch") } },
        ...(optionalToolString(input, "description")
          ? { description: optionalToolString(input, "description") }
          : {}),
        close_source_branch: input.closeSourceBranch === true,
      }),
  },
  {
    toolName: "bitbucket.issues.list",
    description: "List and search Bitbucket repository issues.",
    effect: "read",
    provider: "bitbucket",
    requiredScopes: BITBUCKET_READ_SCOPES,
    defaultPolicyAction: "allow",
    method: "GET",
    filePrefix: "bitbucket-issues-list",
    buildUrl(input) {
      const url = new URL(
        `https://api.bitbucket.org/2.0/repositories/${bitbucketRepository(input)}/issues`,
      );
      appendNativeQueryFields(url, input, ["q", "sort", "page", "pagelen"]);
      return url.toString();
    },
  },
  {
    toolName: "bitbucket.issues.create",
    description: "Create a Bitbucket issue after approval.",
    effect: "write",
    provider: "bitbucket",
    requiredScopes: BITBUCKET_WRITE_SCOPES,
    defaultPolicyAction: "require_approval",
    method: "POST",
    filePrefix: "bitbucket-issue-create",
    buildUrl: (input) =>
      `https://api.bitbucket.org/2.0/repositories/${bitbucketRepository(input)}/issues`,
    buildBody: (input) =>
      jsonProviderNativeBody({
        title: requireToolString(input, "title"),
        ...(optionalToolString(input, "content")
          ? { content: { raw: optionalToolString(input, "content") } }
          : {}),
        ...(optionalToolString(input, "kind") ? { kind: optionalToolString(input, "kind") } : {}),
        ...(optionalToolString(input, "priority")
          ? { priority: optionalToolString(input, "priority") }
          : {}),
      }),
  },
  {
    toolName: "bitbucket.pipelines.list",
    description: "List Bitbucket Pipelines runs for release coordination.",
    effect: "read",
    provider: "bitbucket",
    requiredScopes: BITBUCKET_READ_SCOPES,
    defaultPolicyAction: "allow",
    method: "GET",
    filePrefix: "bitbucket-pipelines-list",
    buildUrl(input) {
      const url = new URL(
        `https://api.bitbucket.org/2.0/repositories/${bitbucketRepository(input)}/pipelines`,
      );
      appendNativeQueryFields(url, input, ["sort", "page", "pagelen"]);
      return url.toString();
    },
  },
];
