import "@tanstack/react-start/server-only";
import type { AgentEmailBinding, AgentEmailInbox, InboxStatus } from "../email/inbox-state.ts";
import type { EnvironmentScope } from "../scope.ts";
import { API_PAGE_LIMIT, fillPage, PAGE_SIZE, type Page } from "./list-pages.ts";
import { callRoute, collectPages } from "./platform-api.ts";

export interface DeploymentTarget {
  readonly agentName: string;
  readonly definitionId: string;
  readonly id: string;
}

/** The runtime filters inboxes by status after paging, so short pages are filled. */
export function loadInboxPage(
  accessToken: string,
  scope: EnvironmentScope,
  status: InboxStatus | undefined,
  cursor: string | undefined,
): Promise<Page<AgentEmailInbox>> {
  return fillPage(
    (pageCursor, limit) =>
      callRoute(
        "listAgentEmailInboxes",
        { query: { cursor: pageCursor, limit, status }, scope },
        accessToken,
      ),
    cursor,
    PAGE_SIZE,
  );
}

export function loadInbox(
  accessToken: string,
  scope: EnvironmentScope,
  inboxId: string,
): Promise<AgentEmailInbox> {
  return callRoute("getAgentEmailInbox", { path: { inboxId }, scope }, accessToken);
}

/** The runtime pages every binding in the environment and keeps the inbox's, so short pages are filled. */
export function loadBindingPage(
  accessToken: string,
  scope: EnvironmentScope,
  inboxId: string,
  cursor: string | undefined,
): Promise<Page<AgentEmailBinding>> {
  return fillPage(
    (pageCursor, limit) =>
      callRoute(
        "listAgentEmailBindings",
        { path: { inboxId }, query: { cursor: pageCursor, limit }, scope },
        accessToken,
      ),
    cursor,
    PAGE_SIZE,
  );
}

export function loadBinding(
  accessToken: string,
  scope: EnvironmentScope,
  bindingId: string,
): Promise<AgentEmailBinding> {
  return callRoute("getAgentEmailBinding", { path: { bindingId }, scope }, accessToken);
}

export async function loadDeploymentTargets(
  accessToken: string,
  scope: EnvironmentScope,
): Promise<readonly DeploymentTarget[]> {
  const [definitions, deployments] = await Promise.all([
    collectPages((cursor) =>
      callRoute(
        "listAgentDefinitions",
        { query: { cursor, limit: API_PAGE_LIMIT }, scope },
        accessToken,
      ),
    ),
    collectPages((cursor) =>
      callRoute(
        "listAgentDeployments",
        { query: { cursor, limit: API_PAGE_LIMIT }, scope },
        accessToken,
      ),
    ),
  ]);
  const names = new Map(definitions.map((definition) => [definition.id, definition.name]));
  return deployments
    .filter(
      (deployment) => deployment.currentState === "ready" && deployment.desiredState === "running",
    )
    .map((deployment) => ({
      agentName: names.get(deployment.agentDefinitionId) ?? deployment.agentDefinitionId,
      definitionId: deployment.agentDefinitionId,
      id: deployment.id,
    }))
    .toSorted((left, right) => left.agentName.localeCompare(right.agentName));
}
