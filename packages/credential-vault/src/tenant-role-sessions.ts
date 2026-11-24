import { AssumeRoleCommand, type AssumeRoleCommandOutput } from "@aws-sdk/client-sts";

export interface TenantScope {
  readonly environmentId: string;
  readonly organizationId: string;
  readonly projectId: string;
}

export interface TenantRoleCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
}

export interface TenantRoleSessionTag {
  readonly Key: string;
  readonly Value: string;
}

export interface TenantRoleSts {
  readonly send: (command: AssumeRoleCommand) => Promise<AssumeRoleCommandOutput>;
}

export type TenantRoleSessions<Session> = (scope: TenantScope) => Promise<Session>;

interface CachedSession<Session> {
  readonly expiresAt: number;
  readonly session: Session;
}

const SESSION_DURATION_SECONDS = 900;
const SESSION_REFRESH_WINDOW_MS = 60_000;
const MAX_CACHED_SESSIONS = 128;
const MAX_SESSION_TAG_VALUE_LENGTH = 256;
const SCOPE_TAG_KEYS = ["environmentId", "organizationId", "projectId"] as const;

function scopeTags(scope: TenantScope): TenantRoleSessionTag[] {
  return SCOPE_TAG_KEYS.map((name) => {
    const value = scope[name].trim();
    if (!value) throw new Error(`Tenant session ${name} is required.`);
    if (value.length > MAX_SESSION_TAG_VALUE_LENGTH) {
      throw new Error(`Tenant session ${name} is too long.`);
    }
    return { Key: name, Value: value };
  });
}

/**
 * Opens `roleArn` sessions whose STS tags carry the tenant scope, so the role's policies can bind
 * resources to `${aws:PrincipalTag/...}`. A warm Lambda reuses each tenant's session until a minute
 * before it expires.
 */
export function makeTenantRoleSessions<Session>(options: {
  readonly open: (credentials: TenantRoleCredentials) => Session;
  readonly roleArn: string;
  readonly sessionName: string;
  readonly sts: TenantRoleSts;
  readonly tags?: readonly TenantRoleSessionTag[];
}): TenantRoleSessions<Session> {
  const sessions = new Map<string, Promise<CachedSession<Session>>>();

  async function assume(tags: readonly TenantRoleSessionTag[]): Promise<CachedSession<Session>> {
    const assumed = await options.sts.send(
      new AssumeRoleCommand({
        DurationSeconds: SESSION_DURATION_SECONDS,
        RoleArn: options.roleArn,
        RoleSessionName: options.sessionName,
        Tags: [...(options.tags ?? []), ...tags],
      }),
    );
    const credentials = assumed.Credentials;
    if (
      !credentials?.AccessKeyId ||
      !credentials.SecretAccessKey ||
      !credentials.SessionToken ||
      !credentials.Expiration
    ) {
      throw new Error(`STS did not return a complete ${options.sessionName} session.`);
    }
    return {
      expiresAt: credentials.Expiration.getTime(),
      session: options.open({
        accessKeyId: credentials.AccessKeyId,
        secretAccessKey: credentials.SecretAccessKey,
        sessionToken: credentials.SessionToken,
      }),
    };
  }

  return async (scope) => {
    const tags = scopeTags(scope);
    const key = tags.map(({ Value }) => Value).join("\u0000");
    const existing = sessions.get(key);
    if (existing) {
      const cached = await existing;
      if (cached.expiresAt > Date.now() + SESSION_REFRESH_WINDOW_MS) return cached.session;
      sessions.delete(key);
    }
    if (sessions.size >= MAX_CACHED_SESSIONS) {
      const oldestKey = sessions.keys().next().value;
      if (oldestKey !== undefined) sessions.delete(oldestKey);
    }
    const pending = assume(tags);
    sessions.set(key, pending);
    try {
      return (await pending).session;
    } catch (cause) {
      sessions.delete(key);
      throw cause;
    }
  };
}
