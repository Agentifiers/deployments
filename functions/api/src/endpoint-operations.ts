import { createAgentWorkflowEndpointOperations } from "./agent-workflow-endpoint-operations.ts";
import type { TenancyApiService } from "./index.ts";
import { createTenancyEndpointOperations as createTenancyResourceEndpointOperations } from "./tenancy-endpoint-operations.ts";

export * from "./endpoint-operation-definition.ts";

export function createTenancyEndpointOperations(service: TenancyApiService) {
  return {
    ...createAgentWorkflowEndpointOperations(service),
    ...createTenancyResourceEndpointOperations(service),
  };
}
