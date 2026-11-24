export interface TeamsBotCredentials {
  readonly appId: string;
  readonly appPassword: string;
  readonly appTenantId: string;
}

export class TeamsCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TeamsCredentialError";
  }
}

/** Tenant used by legacy multi-tenant bots; single-tenant bots use their home tenant GUID. */
export const TEAMS_MULTI_TENANT_APP_TENANT_ID = "botframework.com";

const APP_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/u;
const APP_TENANT_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,126}[A-Za-z0-9])?$/u;
const MAX_APP_PASSWORD_CHARACTERS = 1_024;

/**
 * Reads Bot Framework credentials from a binding's `channel-runtime` credential values.
 * `appTenantId` defaults to the legacy multi-tenant authority.
 */
export function teamsBotCredentials(values: Readonly<Record<string, string>>): TeamsBotCredentials {
  const appId = values.appId?.trim();
  if (!appId) throw new TeamsCredentialError("Teams credential appId is required.");
  if (!APP_ID_PATTERN.test(appId)) {
    throw new TeamsCredentialError("Teams credential appId is invalid.");
  }
  const appPassword = values.appPassword;
  if (typeof appPassword !== "string" || !appPassword.trim()) {
    throw new TeamsCredentialError("Teams credential appPassword is required.");
  }
  if (appPassword.length > MAX_APP_PASSWORD_CHARACTERS) {
    throw new TeamsCredentialError("Teams credential appPassword is too long.");
  }
  const appTenantId = values.appTenantId?.trim() || TEAMS_MULTI_TENANT_APP_TENANT_ID;
  if (!APP_TENANT_ID_PATTERN.test(appTenantId)) {
    throw new TeamsCredentialError("Teams credential appTenantId is invalid.");
  }
  return { appId, appPassword, appTenantId };
}
