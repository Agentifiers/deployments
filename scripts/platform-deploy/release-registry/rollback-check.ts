import { expiryReason, listPublishedRecords } from "./catalog.ts";
import type { CompatibilityReason, ReleaseRecord } from "./record.ts";
import { readSigningPublicKey, signatureStatus } from "./signing.ts";
import type { RegistryStore } from "./store.ts";
import { untrustedReason } from "./verify.ts";

export type RollbackDecision =
  | { readonly kind: "allowed"; readonly target: ReleaseRecord }
  | { readonly kind: "refused"; readonly reasons: readonly string[] };

function describeReason(reason: CompatibilityReason) {
  switch (reason.kind) {
    case "terraform-moved":
      return `${reason.count} moved blocks in ${reason.file}`;
    case "record-schema":
      return `record schema change in ${reason.file}`;
    case "deploy-migration":
      return `deploy migration ${reason.name}`;
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

function chainReasons(input: {
  readonly records: ReadonlyMap<string, ReleaseRecord>;
  readonly running: ReleaseRecord;
  readonly target: ReleaseRecord;
  readonly untrusted: ReadonlyMap<string, string>;
}) {
  const { records, target, untrusted } = input;
  const reasons: string[] = [];
  const unreachable = "so its chain never reaches the target";
  let link = input.running;
  while (link.releaseManifestSha256 !== target.releaseManifestSha256) {
    const name = `${link.label} (${link.releaseManifestSha256})`;
    if (link.compatibility.rollbackBarrier) {
      reasons.push(
        `Release ${name} is a rollback barrier: ${link.compatibility.reasons.map(describeReason).join("; ")}.`,
      );
    }
    const previous = link.compatibility.comparedWith;
    if (previous === null) {
      return [...reasons, `Release ${name} was compared with no earlier release, ${unreachable}.`];
    }
    const unknown = `so the barriers between ${link.label} and the target are unknown`;
    const record = records.get(previous);
    if (!record) return [...reasons, `Release ${previous} is not published, ${unknown}.`];
    const distrust = untrusted.get(previous);
    if (distrust) return [...reasons, `Release ${previous} ${distrust}, ${unknown}.`];
    if (record.builtAt >= link.builtAt || record.builtAt < target.builtAt) {
      return [
        ...reasons,
        `Release ${name} was compared with ${previous}, which was not built between the target and it, ${unreachable}.`,
      ];
    }
    link = record;
  }
  return reasons;
}

export async function checkRollback(input: {
  readonly from: string;
  readonly signingPublicKeyPath: string | undefined;
  readonly store: RegistryStore;
  readonly to: string;
}): Promise<RollbackDecision> {
  const published = await listPublishedRecords(input.store);
  const untrusted = new Map<string, string>();
  if (input.signingPublicKeyPath !== undefined) {
    const publicKey = await readSigningPublicKey(input.signingPublicKeyPath);
    for (const { bytes, record, unverifiedSignature } of published) {
      const status = signatureStatus({ publicKey, record: bytes, signature: unverifiedSignature });
      const reason = untrustedReason(status, input.signingPublicKeyPath);
      if (reason) untrusted.set(record.releaseManifestSha256, reason);
    }
  }
  const records = new Map(published.map(({ record }) => [record.releaseManifestSha256, record]));
  const running = records.get(input.from);
  const target = records.get(input.to);
  if (!target)
    return { kind: "refused", reasons: [`Target release ${input.to} is not published.`] };
  const untrustedTarget = untrusted.get(input.to);
  if (untrustedTarget) {
    return { kind: "refused", reasons: [`Target release ${input.to} ${untrustedTarget}.`] };
  }
  const reasons: string[] = [];
  const expiry = await expiryReason(input.store, target);
  if (expiry) reasons.push(`Target release ${target.label} ${expiry}.`);
  const untrustedRunning = untrusted.get(input.from);
  if (!running) {
    reasons.push(`Running release ${input.from} is not published, so its barriers are unknown.`);
  } else if (untrustedRunning) {
    reasons.push(`Running release ${input.from} ${untrustedRunning}, so its barriers are unknown.`);
  } else if (target.builtAt > running.builtAt) {
    reasons.push(`Target release ${target.label} is newer than the running ${running.label}.`);
  } else {
    reasons.push(...chainReasons({ records, running, target, untrusted }));
  }
  return reasons.length > 0 ? { kind: "refused", reasons } : { kind: "allowed", target };
}
