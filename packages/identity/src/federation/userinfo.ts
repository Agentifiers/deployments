import { FederationError } from "./errors.ts";
import { requestJsonObject, type FederationHttp } from "./http.ts";
import { federationProfile, type FederationProfile } from "./profile.ts";

export async function requestFederationUserinfo(input: {
  readonly bearerAccessToken: string;
  readonly endpoint: string;
  readonly http: FederationHttp;
  readonly subject: string;
}): Promise<FederationProfile> {
  const document = await requestJsonObject({
    failure: "userinfo_failed",
    http: input.http,
    request: {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${input.bearerAccessToken}`,
      },
      method: "GET",
      url: input.endpoint,
    },
  });
  if (typeof document.sub !== "string") throw new FederationError("userinfo_failed");
  if (document.sub !== input.subject) throw new FederationError("userinfo_subject_mismatch");
  return federationProfile(document);
}
