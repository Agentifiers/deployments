import { Schema } from "effect";
import {
  endpointOperation,
  noRequestBody,
  promoteAgentReleaseOperation,
  requestDecoder,
  responseDecoder,
  schemas,
  serviceOperation,
} from "./endpoint-operation-definition.ts";
import type { TenancyApiService } from "./index.ts";

export function createAgentWorkflowEndpointOperations(service: TenancyApiService) {
  return {
    listAgentDefinitions: endpointOperation(
      "listAgentDefinitions",
      noRequestBody,
      service.agentDefinitions.list,
      responseDecoder(
        "listAgentDefinitions",
        Schema.decodeUnknownSync(schemas.ListAgentDefinitionsResponse),
      ),
    ),
    createAgentDefinition: endpointOperation(
      "createAgentDefinition",
      requestDecoder(
        "createAgentDefinition",
        Schema.decodeUnknownSync(schemas.CreateAgentDefinitionRequest),
      ),
      service.agentDefinitions.create,
      responseDecoder(
        "createAgentDefinition",
        Schema.decodeUnknownSync(schemas.AgentDefinitionResponse),
      ),
    ),
    getAgentDefinition: endpointOperation(
      "getAgentDefinition",
      noRequestBody,
      service.agentDefinitions.get,
      responseDecoder(
        "getAgentDefinition",
        Schema.decodeUnknownSync(schemas.AgentDefinitionResponse),
      ),
    ),
    updateAgentDefinition: endpointOperation(
      "updateAgentDefinition",
      requestDecoder(
        "updateAgentDefinition",
        Schema.decodeUnknownSync(schemas.UpdateAgentDefinitionRequest),
      ),
      service.agentDefinitions.update,
      responseDecoder(
        "updateAgentDefinition",
        Schema.decodeUnknownSync(schemas.AgentDefinitionResponse),
      ),
    ),
    archiveAgentDefinition: endpointOperation(
      "archiveAgentDefinition",
      requestDecoder(
        "archiveAgentDefinition",
        Schema.decodeUnknownSync(schemas.ArchiveAgentResourceRequest),
      ),
      service.agentDefinitions.archive,
      responseDecoder(
        "archiveAgentDefinition",
        Schema.decodeUnknownSync(schemas.AgentDefinitionResponse),
      ),
    ),
    listAgentReleases: endpointOperation(
      "listAgentReleases",
      noRequestBody,
      service.agentReleases.list,
      responseDecoder(
        "listAgentReleases",
        Schema.decodeUnknownSync(schemas.ListAgentReleasesResponse),
      ),
    ),
    publishAgentRelease: endpointOperation(
      "publishAgentRelease",
      requestDecoder(
        "publishAgentRelease",
        Schema.decodeUnknownSync(schemas.PublishAgentReleaseRequest),
      ),
      service.agentReleases.publish,
      responseDecoder(
        "publishAgentRelease",
        Schema.decodeUnknownSync(schemas.AgentReleaseResponse),
      ),
    ),
    getAgentRelease: endpointOperation(
      "getAgentRelease",
      noRequestBody,
      service.agentReleases.get,
      responseDecoder("getAgentRelease", Schema.decodeUnknownSync(schemas.AgentReleaseResponse)),
    ),
    promoteAgentRelease: promoteAgentReleaseOperation(service.agentReleases.promote),
    archiveAgentRelease: endpointOperation(
      "archiveAgentRelease",
      requestDecoder(
        "archiveAgentRelease",
        Schema.decodeUnknownSync(schemas.ArchiveAgentResourceRequest),
      ),
      service.agentReleases.archive,
      responseDecoder(
        "archiveAgentRelease",
        Schema.decodeUnknownSync(schemas.AgentReleaseResponse),
      ),
    ),
    listAgentDeployments: endpointOperation(
      "listAgentDeployments",
      noRequestBody,
      service.agentDeployments.list,
      responseDecoder(
        "listAgentDeployments",
        Schema.decodeUnknownSync(schemas.ListAgentDeploymentsResponse),
      ),
    ),
    createAgentDeployment: endpointOperation(
      "createAgentDeployment",
      requestDecoder(
        "createAgentDeployment",
        Schema.decodeUnknownSync(schemas.CreateAgentDeploymentRequest),
      ),
      service.agentDeployments.create,
      responseDecoder(
        "createAgentDeployment",
        Schema.decodeUnknownSync(schemas.AgentDeploymentResponse),
      ),
    ),
    getAgentDeployment: endpointOperation(
      "getAgentDeployment",
      noRequestBody,
      service.agentDeployments.get,
      responseDecoder(
        "getAgentDeployment",
        Schema.decodeUnknownSync(schemas.AgentDeploymentResponse),
      ),
    ),
    updateAgentDeployment: endpointOperation(
      "updateAgentDeployment",
      requestDecoder(
        "updateAgentDeployment",
        Schema.decodeUnknownSync(schemas.UpdateAgentDeploymentRequest),
      ),
      service.agentDeployments.update,
      responseDecoder(
        "updateAgentDeployment",
        Schema.decodeUnknownSync(schemas.AgentDeploymentResponse),
      ),
    ),
    stopAgentDeployment: endpointOperation(
      "stopAgentDeployment",
      requestDecoder(
        "stopAgentDeployment",
        Schema.decodeUnknownSync(schemas.ArchiveAgentResourceRequest),
      ),
      service.agentDeployments.stop,
      responseDecoder(
        "stopAgentDeployment",
        Schema.decodeUnknownSync(schemas.AgentDeploymentResponse),
      ),
    ),
    startAgentDeploymentCanary: endpointOperation(
      "startAgentDeploymentCanary",
      requestDecoder(
        "startAgentDeploymentCanary",
        Schema.decodeUnknownSync(schemas.StartAgentDeploymentCanaryRequest),
      ),
      service.agentDeployments.startCanary,
      responseDecoder(
        "startAgentDeploymentCanary",
        Schema.decodeUnknownSync(schemas.AgentDeploymentResponse),
      ),
    ),
    promoteAgentDeploymentCanary: endpointOperation(
      "promoteAgentDeploymentCanary",
      requestDecoder(
        "promoteAgentDeploymentCanary",
        Schema.decodeUnknownSync(schemas.ResolveAgentDeploymentCanaryRequest),
      ),
      service.agentDeployments.promoteCanary,
      responseDecoder(
        "promoteAgentDeploymentCanary",
        Schema.decodeUnknownSync(schemas.AgentDeploymentResponse),
      ),
    ),
    abortAgentDeploymentCanary: endpointOperation(
      "abortAgentDeploymentCanary",
      requestDecoder(
        "abortAgentDeploymentCanary",
        Schema.decodeUnknownSync(schemas.ResolveAgentDeploymentCanaryRequest),
      ),
      service.agentDeployments.abortCanary,
      responseDecoder(
        "abortAgentDeploymentCanary",
        Schema.decodeUnknownSync(schemas.AgentDeploymentResponse),
      ),
    ),
    listWorkflowDefinitions: endpointOperation(
      "listWorkflowDefinitions",
      noRequestBody,
      serviceOperation(service.workflowDefinitions?.list, "Workflow definition"),
      responseDecoder(
        "listWorkflowDefinitions",
        Schema.decodeUnknownSync(schemas.ListWorkflowDefinitionsResponse),
      ),
    ),
    createWorkflowDefinition: endpointOperation(
      "createWorkflowDefinition",
      requestDecoder(
        "createWorkflowDefinition",
        Schema.decodeUnknownSync(schemas.CreateWorkflowDefinitionRequest),
      ),
      serviceOperation(service.workflowDefinitions?.create, "Workflow definition"),
      responseDecoder(
        "createWorkflowDefinition",
        Schema.decodeUnknownSync(schemas.WorkflowDefinitionResponse),
      ),
    ),
    getWorkflowDefinition: endpointOperation(
      "getWorkflowDefinition",
      noRequestBody,
      serviceOperation(service.workflowDefinitions?.get, "Workflow definition"),
      responseDecoder(
        "getWorkflowDefinition",
        Schema.decodeUnknownSync(schemas.WorkflowDefinitionResponse),
      ),
    ),
    updateWorkflowDefinition: endpointOperation(
      "updateWorkflowDefinition",
      requestDecoder(
        "updateWorkflowDefinition",
        Schema.decodeUnknownSync(schemas.UpdateWorkflowDefinitionRequest),
      ),
      serviceOperation(service.workflowDefinitions?.update, "Workflow definition"),
      responseDecoder(
        "updateWorkflowDefinition",
        Schema.decodeUnknownSync(schemas.WorkflowDefinitionResponse),
      ),
    ),
    archiveWorkflowDefinition: endpointOperation(
      "archiveWorkflowDefinition",
      requestDecoder(
        "archiveWorkflowDefinition",
        Schema.decodeUnknownSync(schemas.ArchiveWorkflowResourceRequest),
      ),
      serviceOperation(service.workflowDefinitions?.archive, "Workflow definition"),
      responseDecoder(
        "archiveWorkflowDefinition",
        Schema.decodeUnknownSync(schemas.WorkflowDefinitionResponse),
      ),
    ),
    listWorkflowReleases: endpointOperation(
      "listWorkflowReleases",
      noRequestBody,
      serviceOperation(service.workflowReleases?.list, "Workflow release"),
      responseDecoder(
        "listWorkflowReleases",
        Schema.decodeUnknownSync(schemas.ListWorkflowReleasesResponse),
      ),
    ),
    publishWorkflowRelease: endpointOperation(
      "publishWorkflowRelease",
      requestDecoder(
        "publishWorkflowRelease",
        Schema.decodeUnknownSync(schemas.PublishWorkflowReleaseRequest),
      ),
      serviceOperation(service.workflowReleases?.publish, "Workflow release"),
      responseDecoder(
        "publishWorkflowRelease",
        Schema.decodeUnknownSync(schemas.WorkflowReleaseResponse),
      ),
    ),
    getWorkflowRelease: endpointOperation(
      "getWorkflowRelease",
      noRequestBody,
      serviceOperation(service.workflowReleases?.get, "Workflow release"),
      responseDecoder(
        "getWorkflowRelease",
        Schema.decodeUnknownSync(schemas.WorkflowReleaseResponse),
      ),
    ),
    archiveWorkflowRelease: endpointOperation(
      "archiveWorkflowRelease",
      requestDecoder(
        "archiveWorkflowRelease",
        Schema.decodeUnknownSync(schemas.ArchiveWorkflowResourceRequest),
      ),
      serviceOperation(service.workflowReleases?.archive, "Workflow release"),
      responseDecoder(
        "archiveWorkflowRelease",
        Schema.decodeUnknownSync(schemas.WorkflowReleaseResponse),
      ),
    ),
    listManagedSkillSources: endpointOperation(
      "listManagedSkillSources",
      noRequestBody,
      serviceOperation(service.managedSkillSources?.list, "Managed skill source"),
      responseDecoder(
        "listManagedSkillSources",
        Schema.decodeUnknownSync(schemas.ListManagedSkillSourcesResponse),
      ),
    ),
    createManagedSkillSource: endpointOperation(
      "createManagedSkillSource",
      requestDecoder(
        "createManagedSkillSource",
        Schema.decodeUnknownSync(schemas.CreateManagedSkillSourceRequest),
      ),
      serviceOperation(service.managedSkillSources?.create, "Managed skill source"),
      responseDecoder(
        "createManagedSkillSource",
        Schema.decodeUnknownSync(schemas.ManagedSkillSourceResponse),
      ),
    ),
    getManagedSkillSource: endpointOperation(
      "getManagedSkillSource",
      noRequestBody,
      serviceOperation(service.managedSkillSources?.get, "Managed skill source"),
      responseDecoder(
        "getManagedSkillSource",
        Schema.decodeUnknownSync(schemas.ManagedSkillSourceResponse),
      ),
    ),
    updateManagedSkillSource: endpointOperation(
      "updateManagedSkillSource",
      requestDecoder(
        "updateManagedSkillSource",
        Schema.decodeUnknownSync(schemas.UpdateManagedSkillSourceRequest),
      ),
      serviceOperation(service.managedSkillSources?.update, "Managed skill source"),
      responseDecoder(
        "updateManagedSkillSource",
        Schema.decodeUnknownSync(schemas.ManagedSkillSourceResponse),
      ),
    ),
    archiveManagedSkillSource: endpointOperation(
      "archiveManagedSkillSource",
      requestDecoder(
        "archiveManagedSkillSource",
        Schema.decodeUnknownSync(schemas.ArchiveManagedSkillResourceRequest),
      ),
      serviceOperation(service.managedSkillSources?.archive, "Managed skill source"),
      responseDecoder(
        "archiveManagedSkillSource",
        Schema.decodeUnknownSync(schemas.ManagedSkillSourceResponse),
      ),
    ),
    listManagedSkillReleases: endpointOperation(
      "listManagedSkillReleases",
      noRequestBody,
      serviceOperation(service.managedSkillReleases?.list, "Managed skill release"),
      responseDecoder(
        "listManagedSkillReleases",
        Schema.decodeUnknownSync(schemas.ListManagedSkillReleasesResponse),
      ),
    ),
    publishManagedSkillRelease: endpointOperation(
      "publishManagedSkillRelease",
      requestDecoder(
        "publishManagedSkillRelease",
        Schema.decodeUnknownSync(schemas.PublishManagedSkillReleaseRequest),
      ),
      serviceOperation(service.managedSkillReleases?.publish, "Managed skill release"),
      responseDecoder(
        "publishManagedSkillRelease",
        Schema.decodeUnknownSync(schemas.ManagedSkillReleaseResponse),
      ),
    ),
    getManagedSkillRelease: endpointOperation(
      "getManagedSkillRelease",
      noRequestBody,
      serviceOperation(service.managedSkillReleases?.get, "Managed skill release"),
      responseDecoder(
        "getManagedSkillRelease",
        Schema.decodeUnknownSync(schemas.ManagedSkillReleaseResponse),
      ),
    ),
    archiveManagedSkillRelease: endpointOperation(
      "archiveManagedSkillRelease",
      requestDecoder(
        "archiveManagedSkillRelease",
        Schema.decodeUnknownSync(schemas.ArchiveManagedSkillResourceRequest),
      ),
      serviceOperation(service.managedSkillReleases?.archive, "Managed skill release"),
      responseDecoder(
        "archiveManagedSkillRelease",
        Schema.decodeUnknownSync(schemas.ManagedSkillReleaseResponse),
      ),
    ),
  };
}
