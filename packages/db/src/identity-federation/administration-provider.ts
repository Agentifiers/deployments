import type { IdpMetadata } from "@deployments-ai/identity/saml";
import type { Ulid } from "../ids.ts";
import { key } from "../keys.ts";
import { PersistenceError } from "../persistence-types.ts";
import type { ProtectedEnvelope } from "../identity/record-builders.ts";
import {
  IDENTITY_PROVIDER_SLOT,
  type FederationJitPolicy,
  type IdentityProviderData,
  type IdentityProviderEnforcement,
  type IdentityProviderState,
  type OidcIdentityProvider,
  type OrganizationIdentityProviderRecord,
  type SamlSigningCertificate,
  type SamlUnsolicitedSignIn,
} from "../records/identity-federation.ts";
import { databaseValue } from "../tenancy-record-mapping.ts";
import { federatedGrantSatisfies } from "./access.ts";
import type { AdministrationContext, FederationAdministrator } from "./administration-context.ts";
import { identityProviderSecretBinding, type IdentityProviderSecretBinding } from "./operations.ts";
import { federationRecord, nextFederationRecord } from "./record-builders.ts";

const AGGREGATE_TYPE = "organization-identity-provider";
const CONFLICT = {
  code: "identity_provider_conflict",
  message: "The identity provider changed concurrently.",
} as const;
const UNPROVEN_CONNECTION_STATE = { enforcement: "optional", kind: "active" } as const;

type ProviderData = IdentityProviderData;

export interface OidcIdentityProviderSettings {
  readonly clientId: string;
  readonly discovered: Pick<
    OidcIdentityProvider,
    "endpoints" | "signingAlgorithms" | "tokenEndpointAuthMethod"
  >;
  readonly displayName: string;
  readonly issuer: string;
  readonly jit: FederationJitPolicy;
  readonly protocol: "oidc";
  readonly sealClientSecret?: (
    binding: IdentityProviderSecretBinding,
  ) => Promise<ProtectedEnvelope>;
}

export interface SamlIdentityProviderSettings {
  readonly displayName: string;
  readonly emailAttribute?: string;
  readonly jit: FederationJitPolicy;
  readonly metadata: IdpMetadata;
  readonly metadataUrl?: string;
  readonly protocol: "saml";
  readonly unsolicitedSignIn: SamlUnsolicitedSignIn;
}

export type IdentityProviderSettings = OidcIdentityProviderSettings | SamlIdentityProviderSettings;

/** The fields one configuration generation shares, whatever protocol it speaks. */
interface ProviderGeneration {
  readonly connectionId: Ulid;
  readonly createdAt: string;
  readonly organizationId: Ulid;
  readonly state: IdentityProviderState;
  readonly updatedAt: string;
  readonly version: number;
}

function sameFingerprints(
  current: readonly SamlSigningCertificate[],
  next: readonly SamlSigningCertificate[],
) {
  const sorted = (certificates: readonly SamlSigningCertificate[]) =>
    JSON.stringify(certificates.map(({ sha256Fingerprint }) => sha256Fingerprint).sort());
  return sorted(current) === sorted(next);
}

/**
 * Whether an update keeps the connection, and with it the links, sessions, grants and enforcement
 * proven through it. OIDC keys a connection on issuer and client ID, and discovery proves the
 * issuer. A SAML entity ID proves nothing, so its connection is the certificate set it trusts: new
 * certificates keep it only when they come from the same metadata URL, whose HTTPS origin vouches
 * for them as discovery does for OIDC. A protocol switch never keeps it.
 */
function keepsConnection(current: ProviderData, settings: IdentityProviderSettings) {
  switch (settings.protocol) {
    case "oidc":
      return (
        current.protocol !== "saml" &&
        current.issuer === settings.issuer &&
        current.clientId === settings.clientId
      );
    case "saml":
      return (
        current.protocol === "saml" &&
        current.issuer === settings.metadata.entityId &&
        (sameFingerprints(current.signingCertificates, settings.metadata.signingCertificates) ||
          (current.metadataUrl !== undefined && current.metadataUrl === settings.metadataUrl))
      );
    default: {
      const unhandled: never = settings;
      return unhandled;
    }
  }
}

export type IdentityProviderStateChange =
  | { readonly enforcement: IdentityProviderEnforcement; readonly kind: "active" }
  | { readonly kind: "disabled" };

export interface IdentityProviderAdministration {
  readonly getIdentityProvider: (
    organizationId: Ulid,
  ) => Promise<OrganizationIdentityProviderRecord>;
  readonly putIdentityProvider: (
    administrator: FederationAdministrator,
    settings: IdentityProviderSettings,
  ) => Promise<OrganizationIdentityProviderRecord>;
  readonly setIdentityProviderState: (
    administrator: FederationAdministrator,
    next: IdentityProviderStateChange,
  ) => Promise<OrganizationIdentityProviderRecord>;
  readonly deleteIdentityProvider: (
    administrator: FederationAdministrator,
  ) => Promise<OrganizationIdentityProviderRecord>;
}

function eventPayload(data: ProviderData) {
  return {
    ...(data.protocol === "saml"
      ? {
          metadataSource:
            data.metadataUrl === undefined
              ? { kind: "document" }
              : { kind: "url", url: data.metadataUrl },
          protocol: data.protocol,
          signingCertificateFingerprints: data.signingCertificates.map(
            ({ sha256Fingerprint }) => sha256Fingerprint,
          ),
          singleSignOnUrl: data.singleSignOnUrl,
          unsolicitedSignIn: data.unsolicitedSignIn,
        }
      : { clientId: data.clientId }),
    connectionId: data.connectionId,
    issuer: data.issuer,
    state: data.state.kind,
    ...(data.state.kind === "active" ? { enforcement: data.state.enforcement } : {}),
  };
}

export function makeIdentityProviderAdministration(
  context: AdministrationContext,
): IdentityProviderAdministration {
  async function stored(organizationId: Ulid) {
    const provider = await databaseValue(context.reads.provider(organizationId));
    if (!provider) {
      throw new PersistenceError(
        "not-found",
        "identity_provider_not_found",
        "The organization has no identity provider.",
      );
    }
    return provider;
  }

  async function sealRequired(
    settings: OidcIdentityProviderSettings,
    connection: Pick<ProviderData, "connectionId" | "organizationId">,
    message: string,
  ) {
    if (!settings.sealClientSecret) {
      throw new PersistenceError("unprocessable", "client_secret_required", message);
    }
    return settings.sealClientSecret(identityProviderSecretBinding(connection));
  }

  /** The whole row for `settings`; a protocol switch replaces it, never merging the old arm in. */
  async function providerData(
    settings: IdentityProviderSettings,
    generation: ProviderGeneration,
    kept: ProviderData | undefined,
    replacing: boolean,
  ): Promise<ProviderData> {
    const common = {
      ...generation,
      displayName: settings.displayName,
      id: IDENTITY_PROVIDER_SLOT,
      jit: settings.jit,
    } as const;
    switch (settings.protocol) {
      case "oidc": {
        const previous = kept?.protocol === "saml" ? undefined : kept;
        const secret =
          previous && !settings.sealClientSecret
            ? {
                clientSecret: previous.clientSecret,
                clientSecretSetAt: previous.clientSecretSetAt,
              }
            : {
                clientSecret: await sealRequired(
                  settings,
                  generation,
                  replacing
                    ? "Changing the issuer, client ID or protocol requires a new client secret."
                    : "A new identity provider requires a client secret.",
                ),
                clientSecretSetAt: generation.updatedAt,
              };
        return {
          ...common,
          ...secret,
          clientId: settings.clientId,
          endpoints: settings.discovered.endpoints,
          issuer: settings.issuer,
          signingAlgorithms: settings.discovered.signingAlgorithms,
          tokenEndpointAuthMethod: settings.discovered.tokenEndpointAuthMethod,
        };
      }
      case "saml":
        return {
          ...common,
          ...(settings.emailAttribute === undefined
            ? {}
            : { emailAttribute: settings.emailAttribute }),
          issuer: settings.metadata.entityId,
          ...(settings.metadataUrl === undefined ? {} : { metadataUrl: settings.metadataUrl }),
          protocol: "saml",
          signingCertificates: settings.metadata.signingCertificates,
          singleSignOnUrl: settings.metadata.singleSignOnRedirectUrl,
          unsolicitedSignIn: settings.unsolicitedSignIn,
        };
      default: {
        const unhandled: never = settings;
        return unhandled;
      }
    }
  }

  async function write(
    administrator: FederationAdministrator,
    previous: OrganizationIdentityProviderRecord | undefined,
    record: OrganizationIdentityProviderRecord,
    eventType: string,
  ) {
    await context.commit(
      administrator,
      [previous ? { kind: "put", previousRecord: previous, record } : { kind: "put", record }],
      {
        aggregateId: administrator.organizationId,
        aggregateType: AGGREGATE_TYPE,
        aggregateVersion: record.data.version,
        eventType,
        occurredAt: record.data.updatedAt,
        payload: eventPayload(record.data),
      },
      CONFLICT,
    );
    return record;
  }

  return {
    getIdentityProvider: stored,

    putIdentityProvider: async (administrator, settings) => {
      const { organizationId } = administrator;
      const current = await databaseValue(context.reads.provider(organizationId));
      const at = context.now().toISOString();
      if (!current) {
        const generation = {
          connectionId: context.generateId(),
          createdAt: at,
          organizationId,
          state: UNPROVEN_CONNECTION_STATE,
          updatedAt: at,
          version: await context.nextAggregateVersion(
            organizationId,
            AGGREGATE_TYPE,
            organizationId,
          ),
        };
        const record = federationRecord(
          "organization-identity-provider",
          await providerData(settings, generation, undefined, false),
        );
        return write(administrator, undefined, record, "organization-identity-provider.created");
      }
      const kept = keepsConnection(current.data, settings) ? current.data : undefined;
      const generation = {
        connectionId: kept?.connectionId ?? context.generateId(),
        createdAt: current.data.createdAt,
        organizationId,
        state:
          !kept && current.data.state.kind === "active"
            ? UNPROVEN_CONNECTION_STATE
            : current.data.state,
        updatedAt: at,
        version: current.data.version + 1,
      };
      const record = federationRecord(
        "organization-identity-provider",
        await providerData(settings, generation, kept, true),
      );
      return write(administrator, current, record, "organization-identity-provider.updated");
    },

    setIdentityProviderState: async (administrator, next) => {
      const current = await stored(administrator.organizationId);
      const state = current.data.state;
      if (
        state.kind === next.kind &&
        (state.kind === "disabled" ||
          (next.kind === "active" && state.enforcement === next.enforcement))
      ) {
        return current;
      }
      const now = context.now();
      if (next.kind === "active" && next.enforcement === "required") {
        const grant = administrator.tokenSessionId
          ? await databaseValue(
              context.database.getRecord(
                "control",
                {
                  pk: key("ORG", administrator.organizationId),
                  sk: key("ORGANIZATION-FEDERATED-GRANT", administrator.tokenSessionId),
                },
                true,
              ),
            )
          : undefined;
        if (
          !federatedGrantSatisfies({
            grant: grant?.itemType === "organization-federated-grant" ? grant.data : undefined,
            now,
            principalId: administrator.principalId,
            provider: current.data,
          })
        ) {
          throw new PersistenceError(
            "conflict",
            "enforcement_requires_federated_session",
            "Sign in through this organization's identity provider before requiring it.",
          );
        }
      }
      const at = now.toISOString();
      const record = nextFederationRecord(
        current,
        { state: next.kind === "active" ? next : { disabledAt: at, kind: "disabled" } },
        at,
      );
      return write(administrator, current, record, "organization-identity-provider.state-changed");
    },

    deleteIdentityProvider: async (administrator) => {
      const current = await stored(administrator.organizationId);
      await context.commit(
        administrator,
        [{ kind: "delete", record: current }],
        {
          aggregateId: administrator.organizationId,
          aggregateType: AGGREGATE_TYPE,
          aggregateVersion: current.data.version + 1,
          eventType: "organization-identity-provider.deleted",
          occurredAt: context.now().toISOString(),
          payload: eventPayload(current.data),
        },
        CONFLICT,
      );
      return current;
    },
  };
}
