import type { JsonObject } from "./http.ts";

export interface EmailClaims {
  readonly email?: string;
  readonly emailVerified?: boolean;
  readonly hostedDomain?: string;
}

export interface FederationProfile {
  readonly emailClaims: EmailClaims;
  readonly name?: string;
}

export function federationProfile(document: JsonObject): FederationProfile {
  return {
    emailClaims: {
      ...(typeof document.email === "string" ? { email: document.email } : {}),
      ...(typeof document.email_verified === "boolean"
        ? { emailVerified: document.email_verified }
        : {}),
      ...(typeof document.hd === "string" ? { hostedDomain: document.hd } : {}),
    },
    ...(typeof document.name === "string" ? { name: document.name } : {}),
  };
}
