import {
  Keys,
  fromDatabase,
  uniqueClaimRequirements,
  sandboxHostPersistence,
} from "@deployments-ai/db";
import { isDeepStrictEqual } from "node:util";
import { Effect } from "effect";
import type { SandboxLease } from "../types.ts";
import {
  SandboxRecordError,
  type ManagedSandbox,
  type ManagerBase,
  type SandboxLeaseRecordValue,
} from "./contracts.ts";
import { validatedProviderLease } from "./leases.ts";

export function createStateRuntime(context: ManagerBase) {
  const { provider, database, now } = context;
  function providerRoutedLease(lease: SandboxLease) {
    if (lease.providerRouteKey || !provider.providerRouteKeyForLease) return lease;
    const providerRouteKey = provider.providerRouteKeyForLease(lease);
    return providerRouteKey ? { ...lease, providerRouteKey } : lease;
  }

  function providerIdentityOwnership(record: SandboxLeaseRecordValue) {
    const claim = uniqueClaimRequirements(record)[0];
    if (!claim) return Effect.succeed("available" as const);
    return fromDatabase(() =>
      sandboxHostPersistence.read(
        database,
        "control",
        Keys.control.uniqueClaim(claim.namespace, claim.value),
        true,
      ),
    ).pipe(
      Effect.map((existing) => {
        if (existing === undefined) return "available" as const;
        return existing.itemType === "unique-claim" &&
          existing.data.ownerId === claim.ownerId &&
          existing.data.ownerItemType === claim.ownerItemType &&
          existing.data.ownerPk === claim.ownerPk &&
          existing.data.ownerSk === claim.ownerSk &&
          existing.data.ownerTable === claim.ownerTable
          ? ("owned" as const)
          : ("conflicting" as const);
      }),
    );
  }

  function requireReady(sandbox: ManagedSandbox) {
    const validate = (record: SandboxLeaseRecordValue) =>
      Effect.try({
        catch: (cause) =>
          cause instanceof SandboxRecordError
            ? cause
            : new SandboxRecordError({
                cause,
                message: "Invalid managed sandbox state.",
              }),
        try: () => {
          if (!isDeepStrictEqual(record, sandbox.record)) {
            throw new SandboxRecordError({
              cause: record,
              message: "Sandbox state changed; reload the lease before a data-plane operation.",
            });
          }
          const expiresAt = record.data.leaseExpiresAt
            ? Date.parse(record.data.leaseExpiresAt)
            : undefined;
          if (expiresAt !== undefined && expiresAt <= now()) {
            throw new SandboxRecordError({
              cause: record,
              message: "Sandbox lease has expired.",
            });
          }
          validatedProviderLease(record, sandbox.lease, provider);
        },
      });

    if (sandbox.record.data.status !== "ready" || sandbox.lease.status !== "ready") {
      return Effect.fail(
        new SandboxRecordError({
          cause: sandbox.record,
          message: "Sandbox data-plane operations require a ready lease.",
        }),
      );
    }

    return fromDatabase(() =>
      sandboxHostPersistence.read(
        database,
        "execution",
        { pk: sandbox.record.pk, sk: sandbox.record.sk },
        true,
      ),
    ).pipe(
      Effect.flatMap((current) => {
        if (current === undefined || current.itemType !== "sandbox-lease") {
          return Effect.fail(
            new SandboxRecordError({
              cause: current,
              message: "Sandbox lease is no longer available.",
            }),
          );
        }
        return validate(current);
      }),
    );
  }

  function requireLifecycleState(
    sandbox: ManagedSandbox,
    operation: string,
    allowed: readonly SandboxLeaseRecordValue["data"]["status"][],
  ) {
    return Effect.try({
      catch: (cause) =>
        cause instanceof SandboxRecordError
          ? cause
          : new SandboxRecordError({
              cause,
              message: `Invalid sandbox ${operation} state.`,
            }),
      try: () => {
        if (!allowed.includes(sandbox.record.data.status)) {
          throw new SandboxRecordError({
            cause: sandbox.record,
            message: `Sandbox ${operation} requires state ${allowed.join(" or ")}.`,
          });
        }
        return validatedProviderLease(sandbox.record, sandbox.lease, provider);
      },
    });
  }
  return {
    providerIdentityOwnership,
    providerRoutedLease,
    requireLifecycleState,
    requireReady,
  };
}

export type StateRuntime = ReturnType<typeof createStateRuntime>;
