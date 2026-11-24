import type { FederationConnection } from "./discovery.ts";
import { FederationError } from "./errors.ts";
import { requestJsonObject, type FederationHttp } from "./http.ts";

/** RFC 6749 §2.3.1 form-urlencodes the client id and secret before joining them for Basic auth. */
function basicAuthorization(connection: FederationConnection): string {
  const [id, secret] = [connection.clientId, connection.clientSecret].map((value) =>
    new URLSearchParams([["", value]]).toString().slice(1),
  );
  return `Basic ${Buffer.from(`${id}:${secret}`, "utf8").toString("base64")}`;
}

export interface FederationTokens {
  readonly idToken: string;
  readonly bearerAccessToken?: string;
}

/** One attempt only: a replayed authorization code lets the provider revoke what it issued (RFC 6749 §4.1.2). */
export async function exchangeFederationCode(input: {
  readonly connection: FederationConnection;
  readonly code: string;
  readonly codeVerifier: string;
  readonly http: FederationHttp;
}): Promise<FederationTokens> {
  const { connection } = input;
  const basic = connection.tokenEndpointAuthMethod === "client_secret_basic";
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: connection.redirectUri,
    code_verifier: input.codeVerifier,
    ...(basic ? {} : { client_id: connection.clientId, client_secret: connection.clientSecret }),
  });
  const document = await requestJsonObject({
    failure: "token_exchange_failed",
    http: input.http,
    request: {
      body: body.toString(),
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        ...(basic ? { authorization: basicAuthorization(connection) } : {}),
      },
      method: "POST",
      url: connection.endpoints.token,
    },
  });
  const { access_token: accessToken, id_token: idToken, token_type: tokenType } = document;
  if (typeof idToken !== "string" || idToken === "") {
    throw new FederationError("token_exchange_failed");
  }
  const bearer =
    typeof accessToken === "string" &&
    accessToken !== "" &&
    typeof tokenType === "string" &&
    tokenType.toLowerCase() === "bearer";
  return { idToken, ...(bearer ? { bearerAccessToken: accessToken } : {}) };
}
