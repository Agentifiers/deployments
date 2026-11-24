import {
  SYSTEM_SERVICE_GRANTS,
  type SystemServiceGrant,
} from "@deployments-ai/api-contract/system";
import { ServiceName } from "@deployments-ai/db";
import { Schema } from "effect";
import {
  isSameRole,
  parseRoleArn,
  SYSTEM_ACCOUNT_ID_ENV,
  sessionRole,
  type IamRole,
} from "./iam-roles.ts";

export const SYSTEM_SERVICE_PRINCIPALS_ENV = "DEPLOYMENTS_AI_SYSTEM_SERVICE_PRINCIPALS";

/** A machine caller configured in `system_service_principals`. */
export interface SystemServicePrincipal {
  readonly grants: ReadonlySet<SystemServiceGrant>;
  readonly name: ServiceName;
  readonly role: IamRole;
}

export type SystemServicePrincipals =
  | { readonly kind: "configured"; readonly principals: readonly SystemServicePrincipal[] }
  | { readonly kind: "invalid"; readonly error: string };

const decodeConfiguration = Schema.decodeUnknownSync(
  Schema.Record(
    Schema.String,
    Schema.Struct({
      grants: Schema.Array(Schema.Literals(SYSTEM_SERVICE_GRANTS)),
      role_arn: Schema.String,
    }),
  ),
  { onExcessProperty: "error" },
);
const decodeServiceName = Schema.decodeUnknownSync(ServiceName);

function principals(encoded: string, ownAccount: string | undefined) {
  const parsed = Object.entries(decodeConfiguration(JSON.parse(encoded))).map(
    ([name, { grants, role_arn }]): SystemServicePrincipal => {
      const role = parseRoleArn(role_arn);
      if (!role || role.account !== ownAccount) {
        throw new Error(`${name}: role_arn must be an IAM role ARN in this install's account.`);
      }
      return { grants: new Set(grants), name: decodeServiceName(name), role };
    },
  );
  if (parsed.filter(({ grants }) => grants.has("organization-entitlements")).length > 1) {
    throw new Error("At most one service may hold organization-entitlements.");
  }
  const shared = parsed.find((principal, index) =>
    parsed.slice(0, index).some((earlier) => isSameRole(earlier.role, principal.role)),
  );
  if (shared) throw new Error(`${shared.name}: another service already uses its role.`);
  return parsed;
}

/**
 * Parses the OpenTofu-rendered principals once at start. An invalid value disables only the
 * service routes, which then answer 503 with the reason.
 */
export function parseSystemServicePrincipals(
  environment: NodeJS.ProcessEnv,
): SystemServicePrincipals {
  const encoded = environment[SYSTEM_SERVICE_PRINCIPALS_ENV];
  if (!encoded) return { kind: "configured", principals: [] };
  try {
    return {
      kind: "configured",
      principals: principals(encoded, environment[SYSTEM_ACCOUNT_ID_ENV]?.trim()),
    };
  } catch (cause) {
    return {
      error: `${SYSTEM_SERVICE_PRINCIPALS_ENV} is invalid: ${cause instanceof Error ? cause.message : "unreadable"}`,
      kind: "invalid",
    };
  }
}

/** The principal whose role signed the request, or undefined for any other caller. */
export function resolveSystemService(
  principals: readonly SystemServicePrincipal[],
  iamUserArn: string | undefined,
): SystemServicePrincipal | undefined {
  const role = sessionRole(iamUserArn);
  return role && principals.find((principal) => isSameRole(principal.role, role));
}
