import { Schema } from "effect";
import type { ULIDFactory } from "ulid";
import type { DynamoDatabaseService } from "./client-types.ts";
import { makeIdGenerator } from "./ids.ts";
import { withCanonicalRecordKeys } from "./records/index.ts";
import { ApiCredentialUsageRecord } from "./records/usage.ts";

export interface ApiCredentialUsageInput {
  readonly apiCredentialId: string;
  readonly environmentId: string;
  readonly organizationId: string;
  readonly outcome: "allowed" | "denied" | "error";
  readonly projectId: string;
  readonly requestMethod: string;
  readonly requestPath: string;
}

export type ApiCredentialUsageRecorder = (input: ApiCredentialUsageInput) => Promise<void>;
export const API_CREDENTIAL_USAGE_TIMEOUT_MILLISECONDS = 100;

export interface ApiCredentialUsageRecorderOptions {
  readonly database: DynamoDatabaseService;
  readonly idFactory?: ULIDFactory;
  readonly now?: () => Date;
}

export async function recordApiCredentialUsageBestEffort(
  recorder: ApiCredentialUsageRecorder | undefined,
  input: ApiCredentialUsageInput,
  reportFailure: (error: unknown) => void,
  timeoutMilliseconds = API_CREDENTIAL_USAGE_TIMEOUT_MILLISECONDS,
): Promise<void> {
  if (!recorder) return;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      recorder(input),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("API credential usage recording timed out.")),
          timeoutMilliseconds,
        );
      }),
    ]);
  } catch (error) {
    try {
      reportFailure(error);
    } catch {
      // Telemetry failure reporting must not become a request dependency either.
    }
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function createApiCredentialUsageRecorder(
  options: ApiCredentialUsageRecorderOptions,
): ApiCredentialUsageRecorder {
  const idGenerator = makeIdGenerator(options.idFactory);
  return async (input: ApiCredentialUsageInput): Promise<void> => {
    const id = idGenerator.generate();
    const record = Schema.decodeUnknownSync(ApiCredentialUsageRecord)(
      withCanonicalRecordKeys({
        data: {
          ...input,
          createdAt: (options.now?.() ?? new Date()).toISOString(),
          id,
        },
        itemType: "api-credential-usage",
      }),
    );
    await options.database.putRecord(
      record,
      "attribute_not_exists(pk) AND attribute_not_exists(sk)",
    );
  };
}
