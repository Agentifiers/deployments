import { Schema } from "effect";

export const REAUTHENTICATION_TOKEN_PARAMETER = "reauthentication_token";

const PLACEHOLDER_ORIGIN = "https://identity.invalid";

export const AuthorizeContinuation = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^\/oauth2\/authorize(?:[?#]|$)/u)),
  Schema.brand("AuthorizeContinuation"),
);
export type AuthorizeContinuation = typeof AuthorizeContinuation.Type;

const isAuthorizeContinuation = Schema.is(AuthorizeContinuation);

export function safeReturnTo(value: string | undefined): AuthorizeContinuation | undefined {
  if (!value) return undefined;
  const parsed = URL.parse(value, PLACEHOLDER_ORIGIN);
  if (parsed?.origin !== PLACEHOLDER_ORIGIN) return undefined;
  const continuation = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  return isAuthorizeContinuation(continuation) ? continuation : undefined;
}
