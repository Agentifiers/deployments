import {
  AppSessionId,
  liveReleaseIdOf,
  sameAppHost,
  type AppAccessLevel,
  type AppGrantRole,
  type AppHost,
  type AppPersistence,
  type AppRecord,
  type Ulid,
} from "@deployments-ai/db";
import { sha256 } from "@deployments-ai/identity";
import { readCookie } from "@deployments-ai/web-bff-auth";
import { Schema } from "effect";
import type { GatewayLookups } from "./lookups.ts";

export const SESSION_COOKIE = "__Host-deployments-app";

type GatewayRole = AppGrantRole;

export type ServedRole = GatewayRole | "visitor";

export type Credential =
  | { readonly kind: "bearer"; readonly token: string }
  | { readonly kind: "cookie"; readonly token: string };

export type Caller =
  | {
      readonly email: string | null;
      readonly kind: "member";
      readonly principalId: Ulid;
      readonly role: GatewayRole;
    }
  | {
      readonly kind: "agent-dev";
      readonly role: "editor" | "viewer";
      readonly runId: Ulid;
    };

export type RefusalReason =
  | "no-role"
  | "not-a-member"
  | "other-app"
  | "other-host"
  | "sso-required";

export type Admission =
  | { readonly caller: Caller; readonly kind: "admitted" }
  | { readonly kind: "anonymous" }
  | { readonly kind: "refused"; readonly reason: RefusalReason };

const BEARER = /^Bearer ([A-Za-z0-9._~+/-]{16,512}=*)$/u;
const decodeSessionId = Schema.decodeUnknownSync(AppSessionId);

export function sessionIdOf(token: string): AppSessionId {
  return decodeSessionId(sha256(token));
}

export function credentialOf(request: Request): Credential | undefined {
  const authorization = request.headers.get("authorization");
  if (authorization !== null) {
    const token = BEARER.exec(authorization)?.[1];
    return token === undefined ? undefined : { kind: "bearer", token };
  }
  const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  return token === undefined ? undefined : { kind: "cookie", token };
}

export function memberRole(
  organizationMembers: AppAccessLevel,
  grant: AppGrantRole | undefined,
): GatewayRole | undefined {
  const fromAccess = organizationMembers === "none" ? undefined : organizationMembers;
  if (fromAccess === "editor" || grant === "editor") return "editor";
  return fromAccess ?? grant;
}

export async function admit(input: {
  readonly app: AppRecord;
  readonly credential: Credential | undefined;
  readonly host: AppHost;
  readonly lookups: GatewayLookups;
  readonly sessions: Pick<AppPersistence, "getSession">;
}): Promise<Admission> {
  const { app, credential } = input;
  if (!credential) return { kind: "anonymous" };
  const session = await input.sessions.getSession({ sessionId: sessionIdOf(credential.token) });
  if (!session) return { kind: "anonymous" };
  if (session.data.appId !== app.data.id) return { kind: "refused", reason: "other-app" };
  if (!sameAppHost(session.data.host, input.host)) return { kind: "refused", reason: "other-host" };
  const { subject } = session.data;
  if (subject.kind === "agent-dev") {
    if (credential.kind !== "bearer") return { kind: "anonymous" };
    const role = liveReleaseIdOf(app.data.lifecycle) === null ? subject.role : "viewer";
    return { caller: { kind: "agent-dev", role, runId: subject.runId }, kind: "admitted" };
  }
  if (credential.kind !== "cookie") return { kind: "anonymous" };
  const { principalId } = subject;
  const [access, grant, sessionEpoch] = await Promise.all([
    input.lookups.memberAccess({
      organizationId: app.data.organizationId,
      principalId,
      tokenSessionId: subject.tokenSessionId,
    }),
    input.lookups.grantRole({ app, principalId }),
    input.lookups.sessionEpoch(principalId),
  ]);
  if (sessionEpoch === undefined || sessionEpoch > subject.sessionEpoch) {
    return { kind: "anonymous" };
  }
  if (access.kind === "sso-required") return { kind: "refused", reason: "sso-required" };
  if (access.kind !== "member") return { kind: "refused", reason: "not-a-member" };
  const role = memberRole(app.data.access.organizationMembers, grant);
  if (role === undefined) return { kind: "refused", reason: "no-role" };
  return { caller: { email: subject.email, kind: "member", principalId, role }, kind: "admitted" };
}
