import { type MemoryApiEvent } from "./api.ts";

export const ids = {
  environment: "01ARZ3NDEKTSV4RRFFQ69G5FA2",
  organization: "01ARZ3NDEKTSV4RRFFQ69G5FA5",
  project: "01ARZ3NDEKTSV4RRFFQ69G5FA6",
};

export function event(path: string, method: string, body?: unknown): MemoryApiEvent {
  return {
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    rawPath: path,
    requestContext: {
      authorizer: {
        jwt: {
          claims: {
            environment_id: ids.environment,
            organization_id: ids.organization,
            project_id: ids.project,
            scope: "memory:admin memory:read memory:write",
          },
        },
      },
      http: { method, path },
      requestId: "request-1",
    },
  };
}
