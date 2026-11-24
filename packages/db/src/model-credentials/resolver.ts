import {
  OrganizationModelKeyUnavailableError,
  type OrganizationModelKeyRequest,
  type OrganizationModelKeyResolver,
} from "@deployments-ai/model-gateway";
import { Schema } from "effect";
import type { DynamoDatabaseService } from "../client-types.ts";
import type { EnvelopeAdapter } from "../identity/kms-envelope.ts";
import { Ulid } from "../ids.ts";
import {
  modelProviderCredentialBinding,
  readModelProviderCredentialRecord,
} from "./persistence.ts";

/** How long a resolved key is reused; a replaced or revoked key stops being served within it. */
export const ORGANIZATION_MODEL_KEY_CACHE_MS = 60_000;

const isUlid = Schema.is(Ulid);

/**
 * The model gateway's reader of organization provider keys. It serves exactly the credential and
 * key version a token names, so a missing, revoked, or replaced credential resolves to undefined.
 * Each credential version's result is reused for {@link ORGANIZATION_MODEL_KEY_CACHE_MS}; a failed
 * read or decrypt is not cached and throws {@link OrganizationModelKeyUnavailableError}.
 */
export function makeOrganizationModelKeyResolver(dependencies: {
  readonly database: DynamoDatabaseService;
  readonly envelope: Pick<EnvelopeAdapter, "decrypt">;
  readonly now?: () => number;
}): OrganizationModelKeyResolver {
  const { database, envelope } = dependencies;
  const now = dependencies.now ?? Date.now;
  const cache = new Map<
    string,
    { readonly apiKey: Promise<string | undefined>; readonly expiresAt: number }
  >();

  const read = async (request: OrganizationModelKeyRequest) => {
    if (!isUlid(request.organizationId)) return undefined;
    let record;
    try {
      record = await readModelProviderCredentialRecord(
        database,
        request.organizationId,
        request.provider,
      );
    } catch (cause) {
      throw new OrganizationModelKeyUnavailableError(
        "Organization model credentials could not be read.",
        { cause },
      );
    }
    const data = record?.data;
    if (
      data?.state.kind !== "active" ||
      data.credentialId !== request.credentialId ||
      data.keyVersion !== request.keyVersion
    ) {
      return undefined;
    }
    let apiKey: unknown;
    try {
      apiKey = await envelope.decrypt(data.state.envelope, modelProviderCredentialBinding(data));
    } catch (cause) {
      throw new OrganizationModelKeyUnavailableError(
        "The organization model credential could not be decrypted.",
        { cause },
      );
    }
    if (typeof apiKey !== "string") {
      throw new OrganizationModelKeyUnavailableError(
        "The organization model credential did not decrypt to a key.",
      );
    }
    return apiKey;
  };

  return {
    resolve: (request) => {
      const current = now();
      const cacheKey = [
        request.organizationId,
        request.provider,
        request.credentialId,
        request.keyVersion,
      ].join("\u0000");
      const cached = cache.get(cacheKey);
      if (cached && cached.expiresAt > current) return cached.apiKey;
      for (const [staleKey, entry] of cache) {
        if (entry.expiresAt <= current) cache.delete(staleKey);
      }
      const entry = { apiKey: read(request), expiresAt: current + ORGANIZATION_MODEL_KEY_CACHE_MS };
      cache.set(cacheKey, entry);
      entry.apiKey.catch(() => {
        if (cache.get(cacheKey) === entry) cache.delete(cacheKey);
      });
      return entry.apiKey;
    },
  };
}
