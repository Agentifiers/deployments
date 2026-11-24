import type { PlatformRecord } from "@deployments-ai/db";
import { runtimeCredentialVault, vaultReference } from "./runtime.ts";

export type ChannelBinding = Extract<PlatformRecord, { readonly itemType: "channel-binding" }>;

export async function readChannelCredentialValues(binding: ChannelBinding) {
  const secret = await (
    await runtimeCredentialVault({
      environmentId: binding.data.environmentId,
      organizationId: binding.data.organizationId,
      projectId: binding.data.projectId,
    })
  ).read({
    environmentId: binding.data.environmentId,
    expectedIdentity: {
      ownerId: binding.data.id,
      ownerType: "channel-binding",
      projectId: binding.data.projectId,
      purpose: "channel-runtime",
    },
    organizationId: binding.data.organizationId,
    reference: vaultReference(binding.data.credentialRef),
  });
  return secret.values;
}
