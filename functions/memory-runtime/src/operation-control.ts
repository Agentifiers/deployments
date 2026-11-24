import { makeIdGenerator } from "@deployments-ai/db";
import { makeMemorySearchControlPlane } from "@deployments-ai/memory";
import {
  runtimeCurrentMemoryMembershipDigest,
  runtimeMemoryMembershipDigests,
} from "./membership-keyring-secret.ts";
import { runtimeProvisioningEvidenceEmbedding } from "./provisioning-evidence-embedding.ts";
import { runtimeDatabase, runtimeMemorySearchRegistry } from "./runtime.ts";

let controlPromise: Promise<ReturnType<typeof makeMemorySearchControlPlane>> | undefined;

export async function runtimeMemorySearchControlPlane() {
  return (controlPromise ??= (async () => {
    const ids = makeIdGenerator();
    return makeMemorySearchControlPlane({
      database: runtimeDatabase(),
      embedProvisioningEvidence: runtimeProvisioningEvidenceEmbedding,
      generateId: async () => ids.generate(),
      membershipDigest: runtimeCurrentMemoryMembershipDigest,
      membershipDigests: runtimeMemoryMembershipDigests,
      registry: runtimeMemorySearchRegistry(),
    });
  })());
}
