import { createHash } from "node:crypto";
import type { ArtifactResponse } from "@deployments-ai/api-contract/runtime";
import type { PlatformResponse, PlatformSdk } from "./index.ts";
import type { CreateArtifactUploadInput, RuntimeSdk } from "./runtime-sdk-client.ts";

export type UploadArtifactBytesInput = Omit<CreateArtifactUploadInput, "byteSize" | "sha256"> & {
  readonly bytes: Uint8Array;
};

export async function uploadArtifactBytes(
  sdk: Pick<PlatformSdk, "uploadPresigned">,
  artifacts: Pick<RuntimeSdk["artifacts"], "completeUpload" | "createUpload">,
  { bytes, ...input }: UploadArtifactBytesInput,
): Promise<PlatformResponse<ArtifactResponse>> {
  const created = await artifacts.createUpload({
    ...input,
    byteSize: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  await sdk.uploadPresigned(created.data.upload, bytes);
  return artifacts.completeUpload(created.data.artifact.artifactId);
}
