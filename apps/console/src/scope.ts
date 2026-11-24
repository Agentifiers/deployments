/** Tenant context of an environment page; server functions send it as the scope headers. */
export interface EnvironmentScope {
  readonly environmentId: string;
  readonly organizationId: string;
  readonly projectId: string;
}

/** The scope's fields, for `requireIds` in server function validators. */
export const SCOPE_FIELDS = ["environmentId", "organizationId", "projectId"] as const;

/** Query-key prefix of one environment's data. */
export const scopeKey = (scope: EnvironmentScope) =>
  [scope.organizationId, scope.projectId, scope.environmentId] as const;

/** The environment's console path, `/o/:org/p/:project/e/:env`. */
export const environmentPath = (scope: EnvironmentScope) =>
  `/o/${scope.organizationId}/p/${scope.projectId}/e/${scope.environmentId}`;
