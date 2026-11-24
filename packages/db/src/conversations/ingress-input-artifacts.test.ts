import { describe, expect, test } from "bun:test";
import {
  customerArtifactStorageKey,
  INGRESS_ATTACHMENT_OBJECT_NAME,
  ingressAttachmentObjectKey,
} from "../index.ts";

const scope = {
  environmentId: "01ARZ3NDEKTSV4RRFFQ69G5003",
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G5001",
  projectId: "01ARZ3NDEKTSV4RRFFQ69G5002",
};
const artifactId = "01ARZ3NDEKTSV4RRFFQ69G5FB4";
const sha256 = "a".repeat(64);
const prefix = `artifacts/organizations/${scope.organizationId}/projects/${scope.projectId}/environments/${scope.environmentId}/customer/${artifactId}/${sha256}`;

describe("ingress capture object key", () => {
  test("is a name that no uploaded file name encodes to", () => {
    const everyCharacter = Array.from({ length: 0x10000 }, (_, code) => code)
      .filter((code) => code < 0xd800 || code > 0xdfff)
      .map((code) => String.fromCharCode(code));
    const landing = [INGRESS_ATTACHMENT_OBJECT_NAME, "input", "%40input", "📈", ...everyCharacter]
      .map((name) => customerArtifactStorageKey(scope, artifactId, sha256, name))
      .filter((key) => key.includes("@"));

    expect(ingressAttachmentObjectKey(scope, artifactId, sha256)).toBe(`${prefix}/@input`);
    expect(customerArtifactStorageKey(scope, artifactId, sha256, "@input")).toBe(
      `${prefix}/%40input`,
    );
    expect(landing).toEqual([]);
  });
});
