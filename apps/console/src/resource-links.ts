import { environmentPath, type EnvironmentScope } from "./scope.ts";

export type ResourceRef =
  | { readonly kind: "brain"; readonly brainId: string }
  | { readonly kind: "connection"; readonly connectionId: string }
  | { readonly kind: "extension"; readonly extensionId: string }
  | { readonly kind: "mcpServer"; readonly mcpServerId: string }
  | { readonly kind: "memorySpace"; readonly memorySpaceId: string }
  | { readonly kind: "newExtension"; readonly mcpServerId: string; readonly remoteToolName: string }
  | { readonly kind: "oauthApps" }
  | { readonly kind: "toolPolicy"; readonly toolPolicyId: string }
  | { readonly kind: "webhook"; readonly webhookId: string }
  | { readonly kind: "workflowDefinition"; readonly definitionId: string }
  | { readonly kind: "workflowExecution"; readonly executionId: string }
  | { readonly kind: "workflowRelease"; readonly releaseId: string };

export interface ResourcePath {
  readonly fullPath: string;
  readonly href: string;
}

const ENVIRONMENT = "/o/$orgId/p/$projectId/e/$envId";

function environmentResource(scope: EnvironmentScope, path: string, segment = path): ResourcePath {
  return { href: `${environmentPath(scope)}/${segment}`, fullPath: `${ENVIRONMENT}/${path}` };
}

export function resourcePath(scope: EnvironmentScope, ref: ResourceRef): ResourcePath {
  const id = encodeURIComponent;
  switch (ref.kind) {
    case "brain":
      return environmentResource(scope, "brains/$brainId", `brains/${id(ref.brainId)}`);
    case "connection":
      return environmentResource(
        scope,
        "connections/$connectionId",
        `connections/${id(ref.connectionId)}`,
      );
    case "extension":
      return environmentResource(
        scope,
        "extensions/$extensionId",
        `extensions/${id(ref.extensionId)}`,
      );
    case "mcpServer":
      return environmentResource(
        scope,
        "mcp-servers/$serverId",
        `mcp-servers/${id(ref.mcpServerId)}`,
      );
    case "memorySpace":
      return environmentResource(
        scope,
        "memory/spaces/$spaceId",
        `memory/spaces/${id(ref.memorySpaceId)}`,
      );
    case "newExtension": {
      const search = new URLSearchParams({
        remote: ref.remoteToolName,
        server: ref.mcpServerId,
        type: "mcp",
      });
      return environmentResource(scope, "extensions/new", `extensions/new?${search}`);
    }
    case "oauthApps":
      return environmentResource(scope, "connections/oauth-apps");
    case "toolPolicy":
      return environmentResource(
        scope,
        "tool-policies/$policyId",
        `tool-policies/${id(ref.toolPolicyId)}`,
      );
    case "webhook":
      return environmentResource(scope, "webhooks/$webhookId", `webhooks/${id(ref.webhookId)}`);
    case "workflowDefinition":
      return environmentResource(
        scope,
        "workflows/$definitionId",
        `workflows/${id(ref.definitionId)}`,
      );
    case "workflowExecution":
      return environmentResource(
        scope,
        "workflows/executions/$executionId",
        `workflows/executions/${id(ref.executionId)}`,
      );
    case "workflowRelease":
      return environmentResource(
        scope,
        "workflows/releases/$releaseId",
        `workflows/releases/${id(ref.releaseId)}`,
      );
    default: {
      const exhaustive: never = ref;
      return exhaustive;
    }
  }
}
