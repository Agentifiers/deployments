import { escapeXml } from "./xml.ts";

/** The only derivation of per-organization SP URLs; callers never concatenate `/saml/`. */
export interface SamlServiceProvider {
  /** `<issuer>/saml/<organizationId>`, the Audience the IdP must assert. */
  readonly entityId: string;
  /** `<issuer>/saml/<organizationId>/acs`, the HTTP-POST AssertionConsumerService. */
  readonly acsUrl: string;
  /** `<issuer>/saml/<organizationId>/metadata` */
  readonly metadataUrl: string;
}

export function samlServiceProvider(input: {
  readonly issuer: string;
  readonly organizationId: string;
}): SamlServiceProvider {
  const entityId = `${input.issuer.replace(/\/+$/u, "")}/saml/${input.organizationId}`;
  return { acsUrl: `${entityId}/acs`, entityId, metadataUrl: `${entityId}/metadata` };
}

/** Unsigned AuthnRequests and no encryption, so the SP publishes no KeyDescriptor. */
export function serviceProviderMetadataXml(serviceProvider: SamlServiceProvider): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${escapeXml(serviceProvider.entityId)}">` +
    `<md:SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">` +
    `<md:NameIDFormat>urn:oasis:names:tc:SAML:2.0:nameid-format:persistent</md:NameIDFormat>` +
    `<md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>` +
    `<md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${escapeXml(serviceProvider.acsUrl)}" index="0" isDefault="true"/>` +
    `</md:SPSSODescriptor></md:EntityDescriptor>`
  );
}
