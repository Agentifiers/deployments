import { deflateRawSync } from "node:zlib";

import { escapeXml } from "./xml.ts";

/** SAML bindings 3.4.3: RelayState MUST NOT exceed 80 bytes. */
const RELAY_STATE_MAX_BYTES = 80;

/**
 * An unsigned AuthnRequest over the HTTP-Redirect binding (deflate, base64). The sign-on URL's own
 * query parameters are kept.
 */
export function samlAuthnRedirectUrl(input: {
  readonly singleSignOnUrl: string;
  /** An xs:ID, such as `federationBinding(token).samlRequestId`. */
  readonly requestId: string;
  readonly spEntityId: string;
  readonly acsUrl: string;
  readonly relayState: string;
  readonly forceAuthn: boolean;
  readonly now: Date;
}): string {
  if (Buffer.byteLength(input.relayState, "utf8") > RELAY_STATE_MAX_BYTES) {
    throw new RangeError(`SAML RelayState exceeds ${RELAY_STATE_MAX_BYTES} bytes`);
  }
  const request =
    `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"` +
    ` ID="${escapeXml(input.requestId)}" Version="2.0" IssueInstant="${input.now.toISOString()}"` +
    ` Destination="${escapeXml(input.singleSignOnUrl)}"` +
    ` ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"` +
    ` AssertionConsumerServiceURL="${escapeXml(input.acsUrl)}"${input.forceAuthn ? ' ForceAuthn="true"' : ""}>` +
    `<saml:Issuer>${escapeXml(input.spEntityId)}</saml:Issuer></samlp:AuthnRequest>`;
  const url = new URL(input.singleSignOnUrl);
  url.searchParams.set("SAMLRequest", deflateRawSync(request).toString("base64"));
  url.searchParams.set("RelayState", input.relayState);
  return url.href;
}
