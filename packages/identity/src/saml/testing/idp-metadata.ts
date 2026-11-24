/** Public certificates only (CN=spike-idp, CN=rotated-idp), so fingerprints are fixed literals. */
export const IDP_CERTIFICATE =
  "MIICpDCCAYwCCQDE632oc9RSuTANBgkqhkiG9w0BAQsFADAUMRIwEAYDVQQDDAlzcGlrZS1pZHAw" +
  "HhcNMjYxMDE4MDcyMjE0WhcNMzYxMDE1MDcyMjE0WjAUMRIwEAYDVQQDDAlzcGlrZS1pZHAwggEi" +
  "MA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDD3LO2PKNwXgwQ86TOM0ECVnQJv8hgFPngT/oc" +
  "cmcM+BE8IGHIEJgbcXynQTi/Gpc6nfAA76AW4PFSQrnN92TmC8yvf1TaAnVF+PKkRHieRYIiYZYx" +
  "ZKYTNV7ilCtLyIRbZRgPz3lD+YkpwA0fFy99dbqOaNXmmsZKnNg42JuqaxKSPAyUwgzQrWSheRUl" +
  "0hbfN92N+uELjnegpa/Uca6ek32s1w6X4riyOp3sO1EQEd5sn1NSKXRJC3h7S9U6mmOpF3w1P5WB" +
  "p7+BPxZZ8ZnwsWKwC/0h/de2hz2MXX6IBziyK1RPH+m8gTGTktdY5sDASKOYxqj6LH+8CgEtoCov" +
  "AgMBAAEwDQYJKoZIhvcNAQELBQADggEBAApF39f2cKsKAhJ4pYmiY//JIVFbYsnVrBPOIrIR74tR" +
  "F82HAwnJXvhTSO8+DPw6GB3iBmgMTSq++OQeQpo5yKllIiQc3WDo3RpXlRNZsdDcQEHmw/APjBp/" +
  "tsZIMQksmWHeZXHU3KEIsy/I+tkgAehHtNja9w8bTfGhPa/tuHKxesaJ0F9qd4ZcV/5YJrezp3rf" +
  "Fvat3TjhlQ2mcafE4UMe69lK41uRyDgtZCaR4iqQNsSRG+1/FRQwVsbRoWJqboC7heIZVT60wf+d" +
  "7Ynxat8nqZRpEHz2esG2gO3gw38yJbGCuMo2UOCR7GlKp0m1YH/Caos2Ok1R0UjvpBAh7vY=";
export const ROLLOVER_CERTIFICATE =
  "MIICqDCCAZACCQCmwvmr2tD4pDANBgkqhkiG9w0BAQsFADAWMRQwEgYDVQQDDAtyb3RhdGVkLWlk" +
  "cDAeFw0yNjEwMTgwNzIzMDVaFw0zNjEwMTUwNzIzMDVaMBYxFDASBgNVBAMMC3JvdGF0ZWQtaWRw" +
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAx8mT8sJSrW6oKz8Apr+hWJ0EURN6hKvs" +
  "HuphjODEoysArjzbfiK0AxF08KEHdlPsN2c1flm+WtU89BFBCfgISGh38WbPwTA6Yq5oJI1jEqul" +
  "fh7h3fMMLguquiUpRRFjUNBplz3Hl6qEYowUoNTMUdt8NajoB4rI2e3KtIAUQuIsPYbpxxzlzIn3" +
  "bbTSZ5wufzxNM6fX++n/532U9fHLmCsXxugo3g5hHieGHtN0MadggIHzhUfWvsoaNqsqKgaEFu9F" +
  "HUX+IJNeXIxqqQhaj+jYBKrhXuZ5IQRazVhISOhpNaM7xv/gDzZ9Z01Ykz3CN/mTsjEsdCmaRctg" +
  "YrWJsQIDAQABMA0GCSqGSIb3DQEBCwUAA4IBAQAvcNn0CzDCTg/Cpn85gjrOXf0FpX6hlou+uBkQ" +
  "wdunLdiFDg2DrfwbiprSgWw3/dmvsdbwJrQmj5+nRT5JwTPDWj4tqUjAZATxUkMNqTcTlT9bJATA" +
  "nzXfBkcBGHF1nJQJfsquv0RXG4oquodYbT03L4JE0bsbhCwf1gdcaQR3DiibgePrXKtfZMDpV3Np" +
  "Su7QXyDZIIu7z2HY6519rV2RgizFHA4OKjP1J8rpQJFaoa07qO4KBfkUnjl0T99FHUUU1JWM8RwW" +
  "+QS2zeu04tzuxbcCjhxu+gfTENzod4wyvdmfcKEcsFw9P4c3PElTMb3MFD+w1HLrcskkqQ7Gb/mr";

const wrapped = (certificate: string) => certificate.replace(/.{1,64}/gu, "$&\n");

export const oktaMetadata =
  `<?xml version="1.0" encoding="UTF-8"?><md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="http://www.okta.com/exk1a2b3c4d5e6f7g8h9">` +
  `<md:IDPSSODescriptor WantAuthnRequestsSigned="false" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">` +
  `<md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>\n${wrapped(IDP_CERTIFICATE)}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>` +
  `<md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified</md:NameIDFormat><md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>` +
  `<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://acme.okta.com/app/acme_platform/exk1a2b3c4d5e6f7g8h9/sso/saml"/>` +
  `<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://acme.okta.com/app/acme_platform/exk1a2b3c4d5e6f7g8h9/sso/saml"/>` +
  `</md:IDPSSODescriptor></md:EntityDescriptor>`;

const entraKey = (use: string, certificate: string) =>
  `<KeyDescriptor${use}><KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><X509Data><X509Certificate>${certificate}</X509Certificate></X509Data></KeyInfo></KeyDescriptor>`;

export const entraMetadata =
  `<?xml version="1.0" encoding="utf-8"?><EntityDescriptor ID="_6a7b" entityID="https://sts.windows.net/72f988bf-0000-0000-0000-2d7cd011db47/" xmlns="urn:oasis:names:tc:SAML:2.0:metadata">` +
  `<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"><SignedInfo><CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/><SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/><Reference URI="#_6a7b"><DigestValue>AAAA</DigestValue></Reference></SignedInfo><SignatureValue>AAAA</SignatureValue><KeyInfo><X509Data><X509Certificate>METADATA_SIGNATURE_CERTIFICATE</X509Certificate></X509Data></KeyInfo></Signature>` +
  `<RoleDescriptor xsi:type="fed:SecurityTokenServiceType" protocolSupportEnumeration="http://docs.oasis-open.org/wsfed/federation/200706" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:fed="http://docs.oasis-open.org/wsfed/federation/200706">${entraKey(' use="signing"', "WS_FEDERATION_CERTIFICATE")}</RoleDescriptor>` +
  `<IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">` +
  entraKey(' use="signing"', IDP_CERTIFICATE) +
  entraKey("", ROLLOVER_CERTIFICATE) +
  entraKey(' use="encryption"', "ENCRYPTION_CERTIFICATE") +
  `<SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://login.microsoftonline.com/72f988bf-0000-0000-0000-2d7cd011db47/saml2"/>` +
  `<SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://login.microsoftonline.com/72f988bf-0000-0000-0000-2d7cd011db47/saml2"/>` +
  `<SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://login.microsoftonline.com/72f988bf-0000-0000-0000-2d7cd011db47/saml2"/>` +
  `</IDPSSODescriptor></EntityDescriptor>`;
