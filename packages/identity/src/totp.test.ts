import { describe, expect, test } from "bun:test";
import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  hotp,
  matchTotpStep,
  recoveryCodeHash,
  totpUri,
} from "./totp.ts";

// RFC 6238 appendix B and RFC 4226 appendix D share this SHA-1 seed.
const RFC_SEED = new TextEncoder().encode("12345678901234567890");
const RFC_SECRET = base32Encode(RFC_SEED);

describe("TOTP", () => {
  test("matches the RFC 4226 HOTP vectors", () => {
    expect(Array.from({ length: 10 }, (_, counter) => hotp(RFC_SEED, counter))).toEqual([
      "755224",
      "287082",
      "359152",
      "969429",
      "338314",
      "254676",
      "287922",
      "162583",
      "399871",
      "520489",
    ]);
  });

  test("matches the RFC 6238 SHA-1 vectors", () => {
    const vectors = [
      [59, "94287082"],
      [1_111_111_109, "07081804"],
      [1_111_111_111, "14050471"],
      [1_234_567_890, "89005924"],
      [2_000_000_000, "69279037"],
      [20_000_000_000, "65353130"],
    ] as const;
    for (const [seconds, code] of vectors) {
      expect(hotp(RFC_SEED, Math.floor(seconds / 30), 8)).toBe(code);
    }
  });

  test("accepts a code from one step either side and nothing further", () => {
    const at = new Date(1_111_111_109_000);
    const step = Math.floor(1_111_111_109 / 30);
    const code = (offset: number) => hotp(RFC_SEED, step + offset);
    expect(matchTotpStep({ at, code: code(0), secret: RFC_SECRET })).toBe(step);
    expect(matchTotpStep({ at, code: code(-1), secret: RFC_SECRET })).toBe(step - 1);
    expect(matchTotpStep({ at, code: code(1), secret: RFC_SECRET })).toBe(step + 1);
    expect(matchTotpStep({ at, code: code(2), secret: RFC_SECRET })).toBeUndefined();
    expect(matchTotpStep({ at, code: code(-2), secret: RFC_SECRET })).toBeUndefined();
    expect(matchTotpStep({ at, code: "12345", secret: RFC_SECRET })).toBeUndefined();
  });

  test("refuses a code from a step that was already used", () => {
    const at = new Date(1_111_111_109_000);
    const step = Math.floor(1_111_111_109 / 30);
    const current = hotp(RFC_SEED, step);
    expect(
      matchTotpStep({ at, code: current, notAfterStep: step, secret: RFC_SECRET }),
    ).toBeUndefined();
    expect(
      matchTotpStep({ at, code: hotp(RFC_SEED, step + 1), notAfterStep: step, secret: RFC_SECRET }),
    ).toBe(step + 1);
  });

  test("round-trips base32 and builds an authenticator URI", () => {
    expect(RFC_SECRET).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(base32Decode(RFC_SECRET)).toEqual(RFC_SEED);
    const uri = new URL(
      totpUri({ account: "user@example.com", issuer: "Deployments.ai", secret: RFC_SECRET }),
    );
    expect(uri.protocol).toBe("otpauth:");
    expect(uri.host).toBe("totp");
    expect(decodeURIComponent(uri.pathname)).toBe("/Deployments.ai:user@example.com");
    expect(Object.fromEntries(uri.searchParams)).toEqual({
      algorithm: "SHA1",
      digits: "6",
      issuer: "Deployments.ai",
      period: "30",
      secret: RFC_SECRET,
    });
  });

  test("issues ten distinct recovery codes whose hash ignores case and separators", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/u);
    const first = codes[0]!;
    expect(recoveryCodeHash(first.toLowerCase().replaceAll("-", " "))).toBe(
      recoveryCodeHash(first),
    );
    expect(recoveryCodeHash(codes[1]!)).not.toBe(recoveryCodeHash(first));
  });
});
