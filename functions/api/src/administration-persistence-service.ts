import { PersistenceError, type PlatformRecord } from "@deployments-ai/db";
import type { AdministrationApiService } from "./administration-api.ts";
import { makeExtensionAdministration } from "./extension-administration.ts";
import { makeCredentialReferenceAdministration } from "./credential-reference-administration.ts";
import { makeHostedCodeArtifactAdministration } from "./hosted-code-artifact-administration.ts";
import { makeProviderAuthorizationAdministration } from "./provider-authorization-administration.ts";
import { makeProviderCredentialAdministration } from "./provider-credential-administration.ts";
import { makeProviderGrantAdministration } from "./provider-grant-administration.ts";
import { makeProviderVerificationAdministration } from "./provider-verification-administration.ts";
import { makeVendorMcpToolSync } from "./vendor-mcp-tool-sync.ts";
import { isModelApiRouteName, makeModelAdministration } from "./model-administration.ts";
import { toolCatalogDetail, toolCatalogPage } from "./tool-catalog-listing.ts";
import { makeToolPolicyEvaluation } from "./tool-policy-evaluation-administration.ts";

import {
  makeAdministrationPersistenceContext,
  publicExtensionExecution,
} from "./administration-persistence-context.ts";
import {
  resourceId,
  text,
  type AdministrationPersistenceDependencies,
  type EnvironmentItemType,
} from "./administration-persistence-contracts.ts";
import { projection } from "./administration-record-mapping.ts";
export function makeAdministrationPersistence(
  dependencies: AdministrationPersistenceDependencies,
): AdministrationApiService {
  const context = makeAdministrationPersistenceContext(dependencies);
  const {
    getRecord,
    listRecords,
    listProviders,
    getProvider,
    staticProviderConnection,
    revokeProviderCredential,
    getAdapterByName,
    adapterInvocation,
    statusChange,
  } = context;
  const { createProviderApplication, createProviderCredential, rotateCredential } =
    makeProviderCredentialAdministration(context);
  const { beginProviderAuthorization } = makeProviderAuthorizationAdministration(context);
  const { requestVerification } = makeProviderVerificationAdministration(context);
  const { createGrant } = makeProviderGrantAdministration(context);
  const { syncConnectionTools } = makeVendorMcpToolSync(context);
  const { createSimple, createMcpServer, discoverMcpServer, updateMutable } =
    makeExtensionAdministration(context);
  const models = makeModelAdministration({
    database: dependencies.database,
    environment: context.environment,
    generateId: context.generateId,
    ...(dependencies.loadModelOperatorGrants
      ? { loadModelOperatorGrants: dependencies.loadModelOperatorGrants }
      : {}),
    now: context.now,
  });
  const { createHostedCodeArtifact, getHostedCodeArtifact } =
    makeHostedCodeArtifactAdministration(context);
  const listCredentialReferences = makeCredentialReferenceAdministration(context);
  const { evaluateToolPolicy } = makeToolPolicyEvaluation(context);
  return {
    async invoke(routeName, invocation) {
      if (isModelApiRouteName(routeName)) return models.invoke(routeName, invocation);
      if (routeName === "listProviders") return listProviders(invocation);
      if (routeName === "getProvider") return getProvider(invocation);
      if (routeName === "listCredentialReferences") return listCredentialReferences(invocation);
      if (routeName === "getExtensionTool") return projection(await getAdapterByName(invocation));
      if (routeName === "listTools") {
        return toolCatalogPage({
          ...(invocation.query.cursor ? { cursor: invocation.query.cursor } : {}),
          filters: invocation.query.toolFilters ?? { status: "active" },
          limit: invocation.query.limit ?? 50,
        });
      }
      if (routeName === "getTool") {
        return toolCatalogDetail(text(invocation.params.toolName, "toolName"));
      }
      if (routeName === "evaluateToolPolicy") return evaluateToolPolicy(invocation);
      const list: Readonly<Record<string, EnvironmentItemType>> = {
        listProviderApplications: "provider-application",
        listProviderConnections: "provider-connection",
        listConnectionGrants: "workspace-connection-authorization",
        listMcpConnections: "mcp-connection",
        listMcpServers: "mcp-server",
        listToolPolicies: "tool-policy",
      };
      const get: Readonly<Record<string, EnvironmentItemType>> = {
        getProviderApplication: "provider-application",
        getProviderConnection: "provider-connection",
        getConnectionGrant: "workspace-connection-authorization",
        getConnectionVerification: "connection-verification",
        getMcpConnection: "mcp-connection",
        getMcpServer: "mcp-server",
        getToolPolicy: "tool-policy",
      };
      if (list[routeName]) return listRecords(invocation, list[routeName]);
      if (routeName === "listProviderCredentials") {
        return listRecords(invocation, "provider-connection", staticProviderConnection);
      }
      if (routeName === "listExtensionTools") {
        return listRecords(
          invocation,
          "tool-adapter",
          (record) =>
            record.itemType === "tool-adapter" && publicExtensionExecution(record.data.execution),
        );
      }
      if (get[routeName]) return projection(await getRecord(invocation, get[routeName]));
      switch (routeName) {
        case "createProviderApplication":
          return createProviderApplication(invocation);
        case "rotateProviderApplicationSecret":
          return rotateCredential(invocation, "provider-application");
        case "archiveProviderApplication":
          return statusChange(invocation, "provider-application", "archived", "clientSecretRef");
        case "createProviderCredential":
          return createProviderCredential(invocation);
        case "beginProviderAuthorization":
          return beginProviderAuthorization(invocation);
        case "rotateProviderCredential":
          return rotateCredential(invocation, "provider-connection");
        case "revokeProviderCredential":
          return revokeProviderCredential(invocation);
        case "revokeProviderConnection":
          // This revokes the platform connection, its durable grants, and its vault credential.
          // Upstream provider grants can be shared across installations and are provider-owned;
          // this API does not claim to revoke that external grant.
          return statusChange(invocation, "provider-connection", "disconnected", "credentialRef");
        case "requestConnectionVerification":
          return requestVerification(invocation);
        case "syncConnectionTools":
          return syncConnectionTools(invocation);
        case "listConnectionCapabilities": {
          const connectionId = resourceId(invocation);
          return listRecords(
            invocation,
            "connection-capability",
            (record) =>
              (
                record.data as Extract<
                  PlatformRecord,
                  { readonly itemType: "connection-capability" }
                >["data"]
              ).connectionId === connectionId,
          );
        }
        case "createConnectionGrant":
          return createGrant(invocation);
        case "revokeConnectionGrant":
          return statusChange(invocation, "workspace-connection-authorization", "revoked");
        case "createToolPolicy":
          return createSimple(invocation, "tool-policy");
        case "updateToolPolicy":
          return updateMutable(invocation, "tool-policy");
        case "archiveToolPolicy":
          return statusChange(invocation, "tool-policy", "archived");
        case "createMcpServer":
          return createMcpServer(invocation);
        case "updateMcpServer":
          return updateMutable(invocation, "mcp-server");
        case "discoverMcpServer":
          return discoverMcpServer(invocation);
        case "archiveMcpServer":
          return statusChange(invocation, "mcp-server", "archived", "authSecretRef");
        case "createMcpConnection":
          return createSimple(invocation, "mcp-connection");
        case "revokeMcpConnection":
          return statusChange(invocation, "mcp-connection", "revoked");
        case "createHostedCodeArtifact":
          return createHostedCodeArtifact(invocation);
        case "getHostedCodeArtifact":
          return getHostedCodeArtifact(invocation);
        case "createExtensionTool":
          return createSimple(invocation, "tool-adapter");
        case "updateExtensionTool":
          return updateMutable(await adapterInvocation(invocation), "tool-adapter");
        case "archiveExtensionTool":
          return statusChange(
            await adapterInvocation(invocation),
            "tool-adapter",
            "archived",
            "authSecretRef",
          );
        default:
          throw new PersistenceError(
            "invalid-input",
            "unsupported_administration_route",
            `Unsupported administration route: ${routeName}.`,
          );
      }
    },
  };
}
