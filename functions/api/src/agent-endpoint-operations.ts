import {
  TENANCY_API_SCHEMAS,
  decodeTenancyRequest,
  decodeTenancyResponse,
  type TenancyRouteName,
} from "@deployments-ai/api-contract";
import { Schema } from "effect";
import { promoteAgentReleaseOperation } from "./endpoint-operation-definition.ts";
import type { AgentLifecycleApiService, ApiInvocation } from "./index.ts";

const schemas = TENANCY_API_SCHEMAS;

export interface AgentEndpointOperation {
  readonly decodeBody: (input: unknown) => unknown;
  readonly decodeResponse: (input: unknown) => unknown;
  operation(invocation: ApiInvocation): Promise<unknown>;
  readonly routeName: TenancyRouteName;
  readonly successStatus?: (result: unknown) => number;
  targetEnvironmentId?(body: unknown): string;
}

function operation<Body, Success>(
  routeName: TenancyRouteName,
  decodeBody: (input: unknown) => Body,
  execute: (invocation: ApiInvocation<Body>) => Promise<Success>,
  decodeResponse: (input: unknown) => Success,
): AgentEndpointOperation {
  return {
    decodeBody,
    decodeResponse,
    operation: (invocation) => execute(invocation as ApiInvocation<Body>),
    routeName,
  };
}

function request<Body>(routeName: TenancyRouteName, decode: (input: unknown) => Body) {
  return (input: unknown) => decode(decodeTenancyRequest(routeName, input));
}

function response<Success>(routeName: TenancyRouteName, decode: (input: unknown) => Success) {
  return (input: unknown) => decode(decodeTenancyResponse(routeName, input));
}

const noBody = (): undefined => undefined;

export function createAgentEndpointOperations(service: AgentLifecycleApiService) {
  return {
    listAgentDefinitions: operation(
      "listAgentDefinitions",
      noBody,
      service.agentDefinitions.list,
      response(
        "listAgentDefinitions",
        Schema.decodeUnknownSync(schemas.ListAgentDefinitionsResponse),
      ),
    ),
    createAgentDefinition: operation(
      "createAgentDefinition",
      request(
        "createAgentDefinition",
        Schema.decodeUnknownSync(schemas.CreateAgentDefinitionRequest),
      ),
      service.agentDefinitions.create,
      response("createAgentDefinition", Schema.decodeUnknownSync(schemas.AgentDefinitionResponse)),
    ),
    getAgentDefinition: operation(
      "getAgentDefinition",
      noBody,
      service.agentDefinitions.get,
      response("getAgentDefinition", Schema.decodeUnknownSync(schemas.AgentDefinitionResponse)),
    ),
    updateAgentDefinition: operation(
      "updateAgentDefinition",
      request(
        "updateAgentDefinition",
        Schema.decodeUnknownSync(schemas.UpdateAgentDefinitionRequest),
      ),
      service.agentDefinitions.update,
      response("updateAgentDefinition", Schema.decodeUnknownSync(schemas.AgentDefinitionResponse)),
    ),
    archiveAgentDefinition: operation(
      "archiveAgentDefinition",
      request(
        "archiveAgentDefinition",
        Schema.decodeUnknownSync(schemas.ArchiveAgentResourceRequest),
      ),
      service.agentDefinitions.archive,
      response("archiveAgentDefinition", Schema.decodeUnknownSync(schemas.AgentDefinitionResponse)),
    ),
    listAgentReleases: operation(
      "listAgentReleases",
      noBody,
      service.agentReleases.list,
      response("listAgentReleases", Schema.decodeUnknownSync(schemas.ListAgentReleasesResponse)),
    ),
    publishAgentRelease: operation(
      "publishAgentRelease",
      request("publishAgentRelease", Schema.decodeUnknownSync(schemas.PublishAgentReleaseRequest)),
      service.agentReleases.publish,
      response("publishAgentRelease", Schema.decodeUnknownSync(schemas.AgentReleaseResponse)),
    ),
    getAgentRelease: operation(
      "getAgentRelease",
      noBody,
      service.agentReleases.get,
      response("getAgentRelease", Schema.decodeUnknownSync(schemas.AgentReleaseResponse)),
    ),
    promoteAgentRelease: promoteAgentReleaseOperation(service.agentReleases.promote),
    archiveAgentRelease: operation(
      "archiveAgentRelease",
      request("archiveAgentRelease", Schema.decodeUnknownSync(schemas.ArchiveAgentResourceRequest)),
      service.agentReleases.archive,
      response("archiveAgentRelease", Schema.decodeUnknownSync(schemas.AgentReleaseResponse)),
    ),
    listAgentDeployments: operation(
      "listAgentDeployments",
      noBody,
      service.agentDeployments.list,
      response(
        "listAgentDeployments",
        Schema.decodeUnknownSync(schemas.ListAgentDeploymentsResponse),
      ),
    ),
    createAgentDeployment: operation(
      "createAgentDeployment",
      request(
        "createAgentDeployment",
        Schema.decodeUnknownSync(schemas.CreateAgentDeploymentRequest),
      ),
      service.agentDeployments.create,
      response("createAgentDeployment", Schema.decodeUnknownSync(schemas.AgentDeploymentResponse)),
    ),
    getAgentDeployment: operation(
      "getAgentDeployment",
      noBody,
      service.agentDeployments.get,
      response("getAgentDeployment", Schema.decodeUnknownSync(schemas.AgentDeploymentResponse)),
    ),
    updateAgentDeployment: operation(
      "updateAgentDeployment",
      request(
        "updateAgentDeployment",
        Schema.decodeUnknownSync(schemas.UpdateAgentDeploymentRequest),
      ),
      service.agentDeployments.update,
      response("updateAgentDeployment", Schema.decodeUnknownSync(schemas.AgentDeploymentResponse)),
    ),
    stopAgentDeployment: operation(
      "stopAgentDeployment",
      request("stopAgentDeployment", Schema.decodeUnknownSync(schemas.ArchiveAgentResourceRequest)),
      service.agentDeployments.stop,
      response("stopAgentDeployment", Schema.decodeUnknownSync(schemas.AgentDeploymentResponse)),
    ),
    startAgentDeploymentCanary: operation(
      "startAgentDeploymentCanary",
      request(
        "startAgentDeploymentCanary",
        Schema.decodeUnknownSync(schemas.StartAgentDeploymentCanaryRequest),
      ),
      service.agentDeployments.startCanary,
      response(
        "startAgentDeploymentCanary",
        Schema.decodeUnknownSync(schemas.AgentDeploymentResponse),
      ),
    ),
    promoteAgentDeploymentCanary: operation(
      "promoteAgentDeploymentCanary",
      request(
        "promoteAgentDeploymentCanary",
        Schema.decodeUnknownSync(schemas.ResolveAgentDeploymentCanaryRequest),
      ),
      service.agentDeployments.promoteCanary,
      response(
        "promoteAgentDeploymentCanary",
        Schema.decodeUnknownSync(schemas.AgentDeploymentResponse),
      ),
    ),
    abortAgentDeploymentCanary: operation(
      "abortAgentDeploymentCanary",
      request(
        "abortAgentDeploymentCanary",
        Schema.decodeUnknownSync(schemas.ResolveAgentDeploymentCanaryRequest),
      ),
      service.agentDeployments.abortCanary,
      response(
        "abortAgentDeploymentCanary",
        Schema.decodeUnknownSync(schemas.AgentDeploymentResponse),
      ),
    ),
  } as const;
}

export type AgentEndpointOperations = ReturnType<typeof createAgentEndpointOperations>;
