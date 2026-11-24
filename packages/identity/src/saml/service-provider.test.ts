import { describe, expect, test } from "bun:test";

import { samlServiceProvider, serviceProviderMetadataXml } from "./service-provider.ts";

const serviceProvider = samlServiceProvider({
  issuer: "https://auth.platform.test/",
  organizationId: "01J8ORGANIZATION0000000000",
});

describe("samlServiceProvider", () => {
  test("derives the entity ID, ACS and metadata URLs under the issuer", () => {
    expect(serviceProvider).toEqual({
      acsUrl: "https://auth.platform.test/saml/01J8ORGANIZATION0000000000/acs",
      entityId: "https://auth.platform.test/saml/01J8ORGANIZATION0000000000",
      metadataUrl: "https://auth.platform.test/saml/01J8ORGANIZATION0000000000/metadata",
    });
  });
});

describe("serviceProviderMetadataXml", () => {
  test("publishes one HTTP-POST ACS, prefers persistent NameIDs and asks for signed assertions", () => {
    expect(serviceProviderMetadataXml(serviceProvider)).toBe(
      `<?xml version="1.0" encoding="UTF-8"?>` +
        `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://auth.platform.test/saml/01J8ORGANIZATION0000000000">` +
        `<md:SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">` +
        `<md:NameIDFormat>urn:oasis:names:tc:SAML:2.0:nameid-format:persistent</md:NameIDFormat>` +
        `<md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>` +
        `<md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://auth.platform.test/saml/01J8ORGANIZATION0000000000/acs" index="0" isDefault="true"/>` +
        `</md:SPSSODescriptor></md:EntityDescriptor>`,
    );
  });
});
