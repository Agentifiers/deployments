import { randomBytes } from "node:crypto";
import {
  acquireUniqueClaim,
  bffFenceRecord,
  type IdentityRepository,
  makeIdentitySecurityEventRecord,
  makeUniqueClaimRecord,
  passwordCredentialRecord,
  principalRecord,
  securityStateRecord,
  type Ulid,
  UniqueClaimRecord,
  uniqueClaimRequirements,
} from "@deployments-ai/db";
import { emailClaimValue, hashPassword, normalizeEmail } from "@deployments-ai/identity";
import { Schema } from "effect";

export interface AdministratorBootstrap {
  readonly outcome: "created" | "promoted" | "unchanged";
  readonly principalId: Ulid;
}

function unusablePasswordHash() {
  return hashPassword(randomBytes(32).toString("base64url"));
}

export async function bootstrapAdministrator(input: {
  readonly email: string;
  readonly generateId: () => Ulid;
  readonly now: Date;
  readonly repository: IdentityRepository;
}): Promise<AdministratorBootstrap> {
  const { generateId, repository } = input;
  const email = normalizeEmail(input.email);
  const now = input.now.toISOString();
  const existing = await repository.principalForEmailHash(emailClaimValue(email));

  if (!existing) {
    const principalId = generateId();
    const principal = principalRecord({
      createdAt: now,
      id: principalId,
      platformRole: "administrator",
      primaryEmail: email,
    });
    const [emailClaim] = uniqueClaimRequirements(principal);
    if (!emailClaim) throw new Error("A human principal derives an email uniqueness claim.");
    const passwordHash = await unusablePasswordHash();
    await repository.transact([
      { kind: "put", record: principal },
      acquireUniqueClaim(
        Schema.decodeUnknownSync(UniqueClaimRecord)(makeUniqueClaimRecord(emailClaim, now)),
      ),
      {
        kind: "put",
        record: passwordCredentialRecord({ createdAt: now, passwordHash, principalId, version: 1 }),
      },
      {
        kind: "put",
        record: securityStateRecord({
          createdAt: now,
          credentialVersion: 1,
          emailVerifiedAt: now,
          principalId,
          sessionEpoch: 0,
          version: 1,
        }),
      },
      {
        kind: "put",
        record: bffFenceRecord({
          createdAt: now,
          principalId,
          principalStatus: "active",
          sessionEpoch: 0,
          version: 1,
        }),
      },
      {
        kind: "put",
        record: makeIdentitySecurityEventRecord({
          aggregateId: principalId,
          aggregateType: "principal",
          aggregateVersion: 1,
          eventId: generateId(),
          eventType: "identity.principal-created",
          occurredAt: now,
          payload: { platformRole: "administrator" },
          principalId,
        }),
      },
    ]);
    return { outcome: "created", principalId };
  }

  const { data } = existing;
  if (data.kind !== "human" || data.status !== "active") {
    throw new Error(
      `${email} belongs to a ${data.status} ${data.kind} principal, not an active human.`,
    );
  }
  const [material, fence] = await Promise.all([
    repository.loadLoginMaterial(data.id),
    repository.bffFenceForPrincipal(data.id),
  ]);
  if (
    material.credential?.data.status !== "active" ||
    !material.securityState?.data.emailVerifiedAt ||
    !fence
  ) {
    throw new Error(
      `${email} has no complete password login; finish sign-up or reset the password, then run admin bootstrap again.`,
    );
  }
  if (data.platformRole === "administrator") return { outcome: "unchanged", principalId: data.id };

  const version = data.version + 1;
  await repository.transact([
    {
      kind: "put",
      previousRecord: existing,
      record: {
        ...existing,
        data: { ...data, platformRole: "administrator", updatedAt: now, version },
      },
    },
    {
      kind: "put",
      record: makeIdentitySecurityEventRecord({
        aggregateId: data.id,
        aggregateType: "principal",
        aggregateVersion: version,
        eventId: generateId(),
        eventType: "identity.platform-administrator-granted",
        occurredAt: now,
        principalId: data.id,
      }),
    },
  ]);
  return { outcome: "promoted", principalId: data.id };
}
