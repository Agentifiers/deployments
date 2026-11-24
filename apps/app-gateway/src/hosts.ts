import type { AppHost, AppRecord, Ulid } from "@deployments-ai/db";
import type { GatewayLookups } from "./lookups.ts";

export type HostStatus = "not-served" | "sign-in-here" | "sign-in-on-slug-host";

export async function hostStatus(
  lookups: Pick<GatewayLookups, "domain">,
  appId: Ulid,
  host: AppHost,
): Promise<HostStatus> {
  if (host.kind === "slug") return "sign-in-here";
  const domain = await lookups.domain(host.hostname);
  if (domain?.data.appId !== appId || domain.data.state.kind !== "active") return "not-served";
  return domain.data.attachedBy.type === "principal" ? "sign-in-here" : "sign-in-on-slug-host";
}

export function hostOrigin(appsDomain: string, app: AppRecord, host: AppHost) {
  return host.kind === "slug"
    ? `https://${app.data.slug}.${appsDomain}`
    : `https://${host.hostname}`;
}
