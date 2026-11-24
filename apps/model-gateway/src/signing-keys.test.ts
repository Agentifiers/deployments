import { describe, expect, test } from "bun:test";
import {
  makeTrustedPublicKeys,
  SigningKeyUnavailableError,
  type KmsPublicKey,
} from "./signing-keys.ts";
import { p256KeyPair, TRUSTED_KEY_ARN } from "./test-support.ts";

const keys = p256KeyPair();
const publicKeyDer = keys.publicKey.export({ format: "der", type: "spki" });

function fetcher(response: KmsPublicKey) {
  const calls: string[] = [];
  return {
    calls,
    fetch: async (keyArn: string) => {
      calls.push(keyArn);
      await Promise.resolve();
      return response;
    },
  };
}

describe("trusted signing keys", () => {
  test("fetches only trusted ARNs, once per process, sharing concurrent first lookups", async () => {
    const kms = fetcher({
      keySpec: "ECC_NIST_P256",
      keyUsage: "SIGN_VERIFY",
      publicKey: publicKeyDer,
    });
    const resolve = makeTrustedPublicKeys([TRUSTED_KEY_ARN], kms.fetch);

    const [first, second] = await Promise.all([resolve(TRUSTED_KEY_ARN), resolve(TRUSTED_KEY_ARN)]);
    expect(first?.equals(keys.publicKey)).toBe(true);
    expect(second).toBe(first);
    expect(await resolve(TRUSTED_KEY_ARN)).toBe(first);
    expect(await resolve(`${TRUSTED_KEY_ARN}-other`)).toBeUndefined();
    expect(await resolve("alias/model-gateway-token")).toBeUndefined();
    expect(kms.calls).toEqual([TRUSTED_KEY_ARN]);
  });

  test("rejects keys that are not P-256 signing keys without caching the failure", async () => {
    for (const response of [
      { keySpec: "RSA_2048", keyUsage: "SIGN_VERIFY", publicKey: publicKeyDer },
      { keySpec: "ECC_NIST_P256", keyUsage: "ENCRYPT_DECRYPT", publicKey: publicKeyDer },
      { keySpec: "ECC_NIST_P256", keyUsage: "SIGN_VERIFY", publicKey: undefined },
      { keySpec: "ECC_NIST_P256", keyUsage: "SIGN_VERIFY", publicKey: new Uint8Array([1, 2, 3]) },
    ]) {
      const kms = fetcher(response);
      const resolve = makeTrustedPublicKeys([TRUSTED_KEY_ARN], kms.fetch);
      expect(resolve(TRUSTED_KEY_ARN)).rejects.toBeInstanceOf(SigningKeyUnavailableError);
      expect(resolve(TRUSTED_KEY_ARN)).rejects.toBeInstanceOf(SigningKeyUnavailableError);
      expect(kms.calls).toHaveLength(2);
    }
  });
});
