import {
  AddLoginDomainRequest,
  IdentityProviderResponse,
  PutIdentityProviderRequest,
  SetIdentityProviderStateRequest,
  type IdentityFederationRouteName,
} from "@deployments-ai/api-contract";
import {
  loginDomainDnsRecord,
  type EnvelopeAdapter,
  type IdentityFederationAdministration,
  type IdentityProviderSettings,
  type OrganizationIdentityProviderRecord,
  type OrganizationLoginDomainRecord,
  type PrincipalIdentityRecord,
} from "@deployments-ai/db";
import { discoverProvider, requestText, type FederationHttp } from "@deployments-ai/identity";
import {
  parseIdpMetadata,
  SAML_ENTITY_ID_MAX_LENGTH,
  SAML_MAX_SIGNING_CERTIFICATES,
  samlServiceProvider,
  type IdpMetadataDefect,
} from "@deployments-ai/identity/saml";
import { Schema } from "effect";
import { txtObserver, type ResolveTxt } from "./dns-txt.ts";
import {
  OrganizationAdminProblem,
  requireOrganizationRole,
  requiredId,
  type OrganizationAdminInvocation,
} from "./organization-admin-api.ts";

export interface IdentityFederationOperationDependencies {
  readonly administration: IdentityFederationAdministration;
  readonly federationHttp: FederationHttp;
  readonly identityIssuer: string;
  readonly resolveTxt: ResolveTxt;
  readonly secrets: Pick<EnvelopeAdapter, "encrypt">;
}

export type IdentityFederationOperation = (
  routeName: IdentityFederationRouteName,
  invocation: OrganizationAdminInvocation,
) => Promise<unknown>;

const strict = { onExcessProperty: "error" } as const;

function loginDomainResponse({ data }: OrganizationLoginDomainRecord) {
  return {
    createdAt: data.createdAt,
    dnsRecord: loginDomainDnsRecord(data),
    domain: data.domain,
    id: data.id,
    state: data.state,
    updatedAt: data.updatedAt,
  };
}

function linkResponse({ data }: typeof PrincipalIdentityRecord.Type) {
  return {
    createdAt: data.createdAt,
    ...(data.email === undefined ? {} : { email: data.email }),
    id: data.id,
    issuer: data.issuer,
    principalId: data.principalId,
    subject: data.subject,
  };
}

const METADATA_DEFECTS: Readonly<Record<IdpMetadataDefect, string>> = {
  doctype_forbidden: "SAML metadata must not contain a DOCTYPE.",
  entities_descriptor_unsupported:
    "The SAML metadata is an EntitiesDescriptor; supply the identity provider's own EntityDescriptor.",
  entity_id_invalid: `The SAML metadata entityID must be an absolute URI of at most ${SAML_ENTITY_ID_MAX_LENGTH} characters.`,
  idp_descriptor_count: "The SAML metadata must contain exactly one SAML 2.0 IDPSSODescriptor.",
  not_entity_descriptor: "The SAML metadata root element must be an EntityDescriptor.",
  redirect_binding_missing: "The SAML metadata has no HTTP-Redirect SingleSignOnService.",
  signing_certificate_count: `The SAML metadata lists more than ${SAML_MAX_SIGNING_CERTIFICATES} signing certificates.`,
  signing_certificate_invalid:
    "A SAML metadata signing certificate is not a valid X.509 certificate.",
  signing_certificate_missing: "The SAML metadata has no signing certificate.",
  signing_certificate_unsupported: "SAML metadata signing certificates must use RSA keys.",
  sso_url_not_https: "The SAML metadata SingleSignOnService location must use https.",
  xml_malformed: "The SAML metadata is not well-formed XML.",
};

export function makeIdentityFederationOperations(
  dependencies: IdentityFederationOperationDependencies,
): IdentityFederationOperation {
  const { administration } = dependencies;
  const issuer = dependencies.identityIssuer.replace(/\/+$/u, "");

  function providerResponse({
    data,
  }: OrganizationIdentityProviderRecord): typeof IdentityProviderResponse.Encoded {
    const common = {
      connectionId: data.connectionId,
      createdAt: data.createdAt,
      displayName: data.displayName,
      issuer: data.issuer,
      jit: data.jit,
      organizationId: data.organizationId,
      state: data.state,
      updatedAt: data.updatedAt,
    };
    switch (data.protocol) {
      case undefined:
      case "oidc":
        return {
          ...common,
          clientId: data.clientId,
          clientSecretSetAt: data.clientSecretSetAt,
          endpoints: data.endpoints,
          protocol: "oidc",
          redirectUri: `${issuer}/oauth2/federation/callback/${data.organizationId}`,
          signingAlgorithms: data.signingAlgorithms,
          tokenEndpointAuthMethod: data.tokenEndpointAuthMethod,
        };
      case "saml":
        return {
          ...common,
          ...(data.emailAttribute === undefined ? {} : { emailAttribute: data.emailAttribute }),
          ...(data.metadataUrl === undefined ? {} : { metadataUrl: data.metadataUrl }),
          protocol: "saml",
          serviceProvider: samlServiceProvider({ issuer, organizationId: data.organizationId }),
          signingCertificates: data.signingCertificates.map(({ notAfter, sha256Fingerprint }) => ({
            notAfter,
            sha256Fingerprint,
          })),
          singleSignOnUrl: data.singleSignOnUrl,
          unsolicitedSignIn: data.unsolicitedSignIn,
        };
      default: {
        const unhandled: never = data;
        return unhandled;
      }
    }
  }

  async function samlMetadata(
    source: Extract<PutIdentityProviderRequest, { readonly protocol: "saml" }>["metadata"],
  ) {
    const document =
      "url" in source
        ? await requestText({
            failure: "idp_request_failed",
            http: dependencies.federationHttp,
            request: {
              headers: { accept: "application/samlmetadata+xml, application/xml, text/xml" },
              method: "GET",
              url: source.url,
            },
          })
        : source.document;
    const parsed = parseIdpMetadata(document);
    if (parsed.kind === "rejected") {
      throw new OrganizationAdminProblem(
        422,
        `metadata_${parsed.defect}`,
        METADATA_DEFECTS[parsed.defect],
      );
    }
    return parsed.metadata;
  }

  async function providerSettings(
    body: PutIdentityProviderRequest,
  ): Promise<IdentityProviderSettings> {
    switch (body.protocol) {
      case undefined:
      case "oidc": {
        const { clientSecret } = body;
        return {
          clientId: body.clientId,
          discovered: await discoverProvider({
            http: dependencies.federationHttp,
            issuer: body.issuer,
          }),
          displayName: body.displayName,
          issuer: body.issuer,
          jit: body.jit,
          protocol: "oidc",
          ...(clientSecret === undefined
            ? {}
            : {
                sealClientSecret: (binding) => dependencies.secrets.encrypt(clientSecret, binding),
              }),
        };
      }
      case "saml":
        return {
          displayName: body.displayName,
          ...(body.emailAttribute === undefined ? {} : { emailAttribute: body.emailAttribute }),
          jit: body.jit,
          metadata: await samlMetadata(body.metadata),
          ...("url" in body.metadata ? { metadataUrl: body.metadata.url } : {}),
          protocol: "saml",
          unsolicitedSignIn: body.unsolicitedSignIn ?? "disabled",
        };
      default: {
        const unhandled: never = body;
        return unhandled;
      }
    }
  }

  const observeTxt = txtObserver(
    dependencies.resolveTxt,
    () =>
      new OrganizationAdminProblem(503, "dns_lookup_failed", "The DNS lookup failed; try again."),
  );

  return async (routeName, invocation) => {
    const { administrator } = invocation;
    switch (routeName) {
      case "listLoginDomains": {
        const page = await administration.listLoginDomains(
          administrator.organizationId,
          invocation.query,
        );
        return { items: page.items.map(loginDomainResponse), nextCursor: page.nextCursor };
      }
      case "addLoginDomain": {
        const body = Schema.decodeUnknownSync(AddLoginDomainRequest, strict)(invocation.body);
        return loginDomainResponse(await administration.addLoginDomain(administrator, body.domain));
      }
      case "verifyLoginDomain":
        return loginDomainResponse(
          await administration.verifyLoginDomain(administrator, requiredId(invocation), observeTxt),
        );
      case "removeLoginDomain":
        return loginDomainResponse(
          await administration.removeLoginDomain(administrator, requiredId(invocation)),
        );
      case "getIdentityProvider":
        return providerResponse(
          await administration.getIdentityProvider(administrator.organizationId),
        );
      case "putIdentityProvider": {
        const body = Schema.decodeUnknownSync(PutIdentityProviderRequest, strict)(invocation.body);
        return providerResponse(
          await administration.putIdentityProvider(administrator, await providerSettings(body)),
        );
      }
      case "setIdentityProviderState": {
        const next = Schema.decodeUnknownSync(
          SetIdentityProviderStateRequest,
          strict,
        )(invocation.body);
        if (next.kind === "active" && next.enforcement === "required") {
          requireOrganizationRole(
            invocation.identity,
            "identity.enforce",
            "Requiring sign-in through the identity provider",
          );
        }
        return providerResponse(await administration.setIdentityProviderState(administrator, next));
      }
      case "deleteIdentityProvider":
        return providerResponse(await administration.deleteIdentityProvider(administrator));
      case "listIdentityProviderLinks": {
        const page = await administration.listLinks(administrator.organizationId, invocation.query);
        return { items: page.items.map(linkResponse), nextCursor: page.nextCursor };
      }
      case "deleteIdentityProviderLink":
        return linkResponse(await administration.deleteLink(administrator, requiredId(invocation)));
      default: {
        const unhandled: never = routeName;
        throw new TypeError(`Unhandled identity federation route: ${String(unhandled)}`);
      }
    }
  };
}
