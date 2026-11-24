import { expect, test } from "bun:test";
import {
  addCredentialMaterial,
  assertNoCredentialLeak,
  definitiveProviderRejection,
  ProviderNativeHttpResponseError,
  retryableProviderRejection,
} from "./executor-request.ts";

test("keeps transient and conflict responses out of permanent mutation failures", () => {
  expect(definitiveProviderRejection(new ProviderNativeHttpResponseError("sendgrid", 400))).toBe(
    true,
  );
  for (const status of [408, 409, 425, 429]) {
    expect(
      definitiveProviderRejection(new ProviderNativeHttpResponseError("sendgrid", status)),
    ).toBe(false);
  }
  for (const status of [425, 429]) {
    expect(
      retryableProviderRejection(new ProviderNativeHttpResponseError("sendgrid", status)),
    ).toBe(true);
  }
  for (const status of [408, 500, 502, 503, 504]) {
    expect(
      retryableProviderRejection(
        new ProviderNativeHttpResponseError("sendgrid", status),
        [408, 425, 429, 500, 502, 503, 504],
      ),
    ).toBe(true);
  }
  for (const status of [402, 424, 426, 428, 431, 451]) {
    expect(
      definitiveProviderRejection(new ProviderNativeHttpResponseError("sendgrid", status)),
    ).toBe(true);
  }
});

test("tracks form and lowercase-percent credential serializations", () => {
  const materials = new Set<string>();
  addCredentialMaterial(materials, "sendgrid/secret+token-123456");

  expect(materials).toContain("sendgrid%2Fsecret%2Btoken-123456");
  expect(materials).toContain("sendgrid%2fsecret%2btoken-123456");
  expect(() => assertNoCredentialLeak("sendgrid%2fsecret%2Btoken-123456", materials)).toThrow(
    "contained credential material",
  );
  expect(() =>
    assertNoCredentialLeak(
      Array.from("sendgrid/secret+token-123456")
        .map((character) => `%${character.charCodeAt(0).toString(16).padStart(2, "0")}`)
        .join(""),
      materials,
    ),
  ).toThrow("contained credential material");
  expect(() =>
    assertNoCredentialLeak("%ZZ sendgrid%252Fsecret%252Btoken-123456", materials),
  ).toThrow("contained credential material");

  const formMaterials = new Set<string>();
  addCredentialMaterial(formMaterials, "sendgrid/secret token-123456");
  expect(formMaterials).toContain("sendgrid%2Fsecret+token-123456");
});
