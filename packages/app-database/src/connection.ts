import { Signer } from "@aws-sdk/rds-signer";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { fromPostgresError } from "./errors.ts";
import type { PgName } from "./names.ts";
import rdsCaBundle from "./rds-ca-bundle.pem" with { type: "text" };

export type CredentialSource = (user: PgName) => Promise<string>;

export type TlsPolicy =
  | { readonly kind: "verify-full"; readonly ca: string }
  | { readonly kind: "disabled" };

export interface ConnectionSettings {
  readonly host: string;
  readonly port: number;
  readonly tls: TlsPolicy;
  readonly credentials: CredentialSource;
  /**
   * An auto-paused Aurora cluster takes longer than one connect timeout to resume, and only a
   * login attempt wakes it.
   */
  readonly resumeWaitMs: number;
}

export interface SessionTarget {
  readonly database: PgName;
  readonly user: PgName;
}

export function rdsConnectionSettings(input: {
  readonly host: string;
  readonly port: number;
  readonly region: string;
  readonly resumeWaitMs: number;
}): ConnectionSettings {
  return {
    credentials: (user) =>
      new Signer({
        hostname: input.host,
        port: input.port,
        region: input.region,
        username: user,
      }).getAuthToken(),
    host: input.host,
    port: input.port,
    resumeWaitMs: input.resumeWaitMs,
    tls: { ca: rdsCaBundle, kind: "verify-full" },
  };
}

const FIRST_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 5_000;

export async function connectAwaitingResume<T>(
  waitMs: number,
  connect: () => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + waitMs;
  for (let delayMs = FIRST_RETRY_DELAY_MS; ; delayMs = Math.min(delayMs * 2, MAX_RETRY_DELAY_MS)) {
    try {
      return await connect();
    } catch (error) {
      const unavailable = fromPostgresError(error).code === "database_unavailable";
      if (!unavailable || Date.now() + delayMs > deadline) throw error;
    }
    await sleep(delayMs);
  }
}

export function clientConfig(settings: ConnectionSettings, target: SessionTarget): pg.ClientConfig {
  return {
    application_name: "deployments-apps",
    connectionTimeoutMillis: 10_000,
    database: target.database,
    host: settings.host,
    password: () => settings.credentials(target.user),
    port: settings.port,
    ssl:
      settings.tls.kind === "verify-full"
        ? { ca: settings.tls.ca, rejectUnauthorized: true }
        : false,
    user: target.user,
  };
}

export function openClient(
  settings: ConnectionSettings,
  target: SessionTarget,
): Promise<pg.Client> {
  return connectAwaitingResume(settings.resumeWaitMs, async () => {
    const client = new pg.Client(clientConfig(settings, target));
    // A dropped connection also rejects the pending or next query, which is where callers see it;
    // without a listener the emitted 'error' would crash the process.
    client.on("error", () => undefined);
    await client.connect();
    return client;
  });
}

export async function withClient<T>(
  settings: ConnectionSettings,
  target: SessionTarget,
  work: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = await openClient(settings, target);
  try {
    return await work(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}
