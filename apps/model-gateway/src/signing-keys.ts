import { createPublicKey, type KeyObject } from "node:crypto";
import { GetPublicKeyCommand, type KMSClient } from "@aws-sdk/client-kms";

export interface KmsPublicKey {
  readonly keySpec: string | undefined;
  readonly keyUsage: string | undefined;
  readonly publicKey: Uint8Array | undefined;
}

/** Fetches the DER SPKI public key of a KMS key; the KMS adapter in production, a fake in tests. */
export type FetchPublicKey = (keyArn: string) => Promise<KmsPublicKey>;

/** Raised when a trusted key's public key cannot be fetched; the request fails without caching. */
export class SigningKeyUnavailableError extends Error {
  override readonly name = "SigningKeyUnavailableError";
}

export function kmsPublicKeyFetcher(client: KMSClient): FetchPublicKey {
  return async (keyArn) => {
    const response = await client.send(new GetPublicKeyCommand({ KeyId: keyArn }));
    return {
      keySpec: response.KeySpec,
      keyUsage: response.KeyUsage,
      publicKey: response.PublicKey,
    };
  };
}

/**
 * Resolves a token `kid` to a public key. Only the trusted ARNs are ever fetched; each is fetched
 * once per process (concurrent first requests share the call) and failures are not cached.
 */
export function makeTrustedPublicKeys(
  trustedKeyArns: readonly string[],
  fetchPublicKey: FetchPublicKey,
): (keyId: string) => Promise<KeyObject | undefined> {
  const trusted = new Set(trustedKeyArns);
  const cache = new Map<string, Promise<KeyObject>>();
  const load = async (keyArn: string) => {
    let response: KmsPublicKey;
    try {
      response = await fetchPublicKey(keyArn);
    } catch (cause) {
      throw new SigningKeyUnavailableError("The token signing key could not be fetched.", {
        cause,
      });
    }
    if (
      response.keySpec !== "ECC_NIST_P256" ||
      response.keyUsage !== "SIGN_VERIFY" ||
      !response.publicKey
    ) {
      throw new SigningKeyUnavailableError(
        "The token signing key is not an ECC_NIST_P256 SIGN_VERIFY key.",
      );
    }
    try {
      return createPublicKey({ format: "der", key: Buffer.from(response.publicKey), type: "spki" });
    } catch (cause) {
      throw new SigningKeyUnavailableError("The token signing key is not a DER SPKI key.", {
        cause,
      });
    }
  };
  return async (keyId) => {
    if (!trusted.has(keyId)) return undefined;
    let pending = cache.get(keyId);
    if (!pending) {
      pending = load(keyId);
      cache.set(keyId, pending);
      pending.catch(() => cache.delete(keyId));
    }
    return pending;
  };
}
