import { createHash } from "node:crypto";
import type { TenancyRouteName } from "@deployments-ai/api-contract";
import type { ApiInvocation } from "./api-service-contracts.ts";

export function fingerprint(route: TenancyRouteName, invocation: ApiInvocation) {
  return createHash("sha256")
    .update(JSON.stringify([route, invocation.id, invocation.scope, invocation.body]))
    .digest("hex");
}
