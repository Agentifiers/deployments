import type {
  ResolveRuntimeProviderCredential,
  ResolveRuntimeToolAuthorizationContext,
} from "./runtime-tools.ts";
import { DatabaseError, RecordDecodeError, type DynamoDatabaseService } from "@deployments-ai/db";
import type {
  CredentialVaultReference,
  CredentialVaultSecretDocument,
} from "@deployments-ai/credential-vault";
import {
  CredentialVaultError,
  providerOAuthMaterialFromCredentialValues,
} from "@deployments-ai/credential-vault";
import { RuntimeToolExecutionKnownFailureError } from "@deployments-ai/agent-runtime";
import {
  providerCredentialPurpose,
  resolveProviderBinding,
  RuntimeProviderBindingValidationError,
  vaultReference,
  type ReadRuntimeCredential,
  type ResolvedProviderBinding,
} from "./runtime-provider-binding.ts";
import {
  refreshProviderConnectionIfDue,
  type RefreshProviderConnection,
} from "./oauth-refresh-runtime.ts";

export interface DynamoRuntimeToolResolverOptions {
  readonly database: DynamoDatabaseService;
  readonly now?: () => Date;
  readonly readCredential: ReadRuntimeCredential;
  /** Absent: connections that need an OAuth refresh fail as a known tool failure. */
  readonly refreshConnection?: RefreshProviderConnection;
}

export function createDynamoRuntimeToolResolvers(options: DynamoRuntimeToolResolverOptions): {
  readonly resolveAuthorizationContext: ResolveRuntimeToolAuthorizationContext;
  readonly resolveProviderCredential: ResolveRuntimeProviderCredential;
} {
  return {
    resolveAuthorizationContext: async (request, definition) => {
      try {
        const resolved = await resolveProviderBinding(options, request, definition);
        return {
          authorizationFingerprint: resolved.fingerprint,
          ...(resolved.toolAdapter && resolved.toolCredential
            ? {
                callbackControlSnapshot: {
                  connection: resolved.connection,
                  executionTarget: resolved.executionTarget,
                  providerUsesNoCredential: resolved.providerUsesNoCredential,
                  toolAdapter: resolved.toolAdapter,
                  toolCredential: resolved.toolCredential,
                  ...(resolved.policy ? { toolPolicy: resolved.policy } : {}),
                  workspaceAuthorization: resolved.authorization,
                },
              }
            : {}),
          connectionId: resolved.connection.data.id,
          connectorProvider: resolved.connection.data.providerKey,
          externalAccountId: resolved.authorization.data.externalAccountId,
          externalResourceConstraints: resolved.authorization.data.externalResourceConstraints,
          grantedScopes: resolved.grantedScopes,
          ...(resolved.policy ? { policyRules: resolved.policy.data.rules } : {}),
        };
      } catch (cause) {
        if (cause instanceof DatabaseError || cause instanceof RecordDecodeError) throw cause;
        if (!(cause instanceof Error)) throw cause;
        return undefined;
      }
    },
    resolveProviderCredential: async (request, definition) => {
      const pinnedBinding = async () => {
        try {
          const resolved = await resolveProviderBinding(options, request, definition);
          const pinned = request.decision.executionBinding;
          if (
            resolved.fingerprint !== pinned.authorizationFingerprint ||
            resolved.connection.data.id !== pinned.connectionId ||
            resolved.authorization.data.externalAccountId !== pinned.externalAccountId
          ) {
            throw new RuntimeProviderBindingValidationError(
              "Provider authorization changed after the tool policy decision.",
            );
          }
          return resolved;
        } catch (cause) {
          if (cause instanceof RuntimeProviderBindingValidationError) {
            throw new RuntimeToolExecutionKnownFailureError(request.toolName, cause);
          }
          throw cause;
        }
      };
      let resolved: ResolvedProviderBinding = await pinnedBinding();
      const refreshed = await refreshProviderConnectionIfDue({
        connection: resolved.connection,
        now: options.now?.() ?? new Date(),
        refresh: options.refreshConnection,
        scope: request,
        toolName: request.toolName,
      });
      if (refreshed) resolved = await pinnedBinding();
      let reference: CredentialVaultReference;
      try {
        reference = vaultReference(resolved.connection.data.credentialRef);
      } catch (cause) {
        throw new RuntimeToolExecutionKnownFailureError(request.toolName, cause);
      }
      let secret: CredentialVaultSecretDocument;
      try {
        secret = await options.readCredential({
          connectionId: resolved.connection.data.id,
          environmentId: request.environmentId,
          organizationId: request.organizationId,
          projectId: request.projectId,
          purpose: providerCredentialPurpose(resolved.connection),
          reference,
        });
      } catch (cause) {
        if (
          cause instanceof CredentialVaultError &&
          cause.code !== "crypto" &&
          cause.code !== "storage"
        ) {
          throw new RuntimeToolExecutionKnownFailureError(request.toolName, cause);
        }
        throw cause;
      }
      const credentialScopes = [
        ...new Set(
          secret.scopes ??
            resolved.connection.data.authorizationScopes ??
            resolved.connection.data.scopes,
        ),
      ].toSorted();
      const expectedCredentialScopes = [
        ...new Set(resolved.connection.data.authorizationScopes ?? resolved.connection.data.scopes),
      ].toSorted();
      const staticCredential = resolved.connection.data.authMethod.toLowerCase() === "static";
      const scopesMatch = staticCredential
        ? expectedCredentialScopes.every((scope) => credentialScopes.includes(scope))
        : JSON.stringify(credentialScopes) === JSON.stringify(expectedCredentialScopes);
      if (!scopesMatch) {
        throw new RuntimeToolExecutionKnownFailureError(
          request.toolName,
          new RuntimeProviderBindingValidationError(
            "Provider credential scopes do not match the pinned connection.",
          ),
        );
      }
      let credentialMaterial: ReturnType<typeof providerOAuthMaterialFromCredentialValues>;
      try {
        credentialMaterial = providerOAuthMaterialFromCredentialValues(secret.values);
      } catch (cause) {
        throw new RuntimeToolExecutionKnownFailureError(
          request.toolName,
          new RuntimeProviderBindingValidationError(
            "Provider credential request headers are invalid.",
            { cause },
          ),
        );
      }
      if (credentialMaterial.resource !== resolved.connection.data.oauthResource) {
        throw new RuntimeToolExecutionKnownFailureError(
          request.toolName,
          new RuntimeProviderBindingValidationError(
            "Provider credential resource does not match the pinned connection.",
          ),
        );
      }
      return {
        authorizationFingerprint: resolved.fingerprint,
        connectionId: resolved.connection.data.id,
        externalAccountId: resolved.authorization.data.externalAccountId,
        fields: credentialMaterial.fields,
        grantedScopes: [...new Set(resolved.grantedScopes)].toSorted(),
        provider: resolved.connection.data.providerKey,
        ...(credentialMaterial.requestHeaders
          ? { requestHeaders: credentialMaterial.requestHeaders }
          : {}),
        resourceBindings: resolved.authorization.data.externalResourceConstraints,
        ...(credentialMaterial.resource
          ? { resourceDefaults: { oauthResource: credentialMaterial.resource } }
          : {}),
      };
    },
  };
}
